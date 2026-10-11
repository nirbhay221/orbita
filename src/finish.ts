/**
 * The last thing done to every answer before it leaves: say nothing twice, and say what comes next.
 *
 * Measured across thirteen ordinary calls, the structured half of an answer was three times the size of the
 * spoken half, and most of the difference was repetition. A shortened answer carried its sentences three
 * times: as the text, again as `full`, and the leftover again as `more`. Notes that tools leave for the
 * shortening code (`mustSay`, `fullAnswer`, `offer`) went out to the host as if they were data. A host that
 * hands its model the structured half was reading every answer twice and paying for it in time.
 *
 * So `full` is dropped, because the text and `more` together are the whole answer, and the internal notes
 * are dropped, because the text already reflects them. `spoken` stays: it is the one field the declared
 * output schema promises, and a host that reads only structured data needs it.
 *
 * And every answer that has an obvious next step names it as `nextAction`, a tool and its arguments, so a
 * host can chain to it without having to work out the call from the sentence. Amazon's design guidance asks
 * for exactly this: the output of one tool should feed the next.
 */

type Result = { content?: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
type Next = { tool: string; arguments: Record<string, unknown> } | null;

const INTERNAL = ['full', 'mustSay', 'fullAnswer', 'offer'];

/** What naturally follows each answer, or null. Only where there is one obvious step. */
export function nextFor(name: string, args: Record<string, unknown>, sc: Record<string, unknown>): Next {
  switch (name) {
    case 'register_equipment':
      return sc.added === false || sc.needs ? null : { tool: 'farm_status', arguments: {} };
    case 'crew_contact':
      return sc.staged === true && typeof sc.name === 'string' ? { tool: 'crew_contact', arguments: { action: 'confirm', name: sc.name } } : null;
    case 'log_job':
      return sc.logged && sc.logged !== false ? { tool: 'job_report', arguments: {} } : null;
    case 'watch_jobs':
      return sc.watching === true ? { tool: 'watch_jobs', arguments: { action: 'check' } } : null;
    case 'farm_status': {
      // The job the storm is hurting most is the one worth asking about by itself.
      const rows = (sc.rows as { go?: boolean; limitedBy?: string; operation?: string; field?: string; equipment?: string }[] | undefined) ?? [];
      const worst = rows.find((r) => r.go === false && r.limitedBy === 'space_weather');
      return worst?.operation ? { tool: 'can_i_run', arguments: { operation: worst.operation, field: worst.field, equipment: worst.equipment } } : null;
    }
    default:
      return null;
  }
}

export function finish(name: string, args: unknown, result: Result): Result {
  const sc = result?.structuredContent;
  if (!sc || result.isError) return result;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sc)) if (!INTERNAL.includes(k)) out[k] = v;
  // A tool that already named its next step knows better than this table does.
  if (out.nextAction === undefined) {
    const next = nextFor(name, (args ?? {}) as Record<string, unknown>, out);
    if (next) out.nextAction = next;
  }
  return { ...result, structuredContent: out };
}
