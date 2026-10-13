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
    case 'watch_jobs': {
      // A watch just started with nobody to tell: adding somebody is the step that makes it worth having.
      if (sc.watching === true) {
        const crew = (sc.crewToEmail as unknown[] | undefined) ?? [];
        return crew.length ? { tool: 'watch_jobs', arguments: { action: 'check' } } : { tool: 'crew_contact', arguments: { action: 'add' } };
      }
      // Something cleared: the question now is that job, asked properly.
      const clear = (sc.clear as { operation?: string; field?: string }[] | undefined) ?? [];
      return clear[0]?.operation ? { tool: 'can_i_run', arguments: { operation: clear[0].operation, field: clear[0].field } } : null;
    }
    case 'can_i_run':
      // A job the sky allows, on a registered field and machine: when it is done, it is logged. Said nowhere
      // aloud, because "shall I log it" before the planter has moved is noise.
      return sc.go === true && typeof sc.fieldId === 'string' && typeof sc.operation === 'string'
        ? { tool: 'log_job', arguments: { operation: sc.operation, field: sc.fieldId, equipment: sc.equipmentId } }
        : null;
    case 'what_happened': {
      // Something caused it, the sun or a GPS test: that belongs in the record of the job, with the cause.
      const other = sc.otherCauses as { gpsTests?: unknown[]; aircraftReports?: unknown } | undefined;
      const cause = sc.wasTheSun === true ? 'space weather' : other?.gpsTests?.length ? 'a military GPS interference test' : other?.aircraftReports ? 'GPS interference reported by aircraft' : null;
      return cause && typeof args.operation === 'string' && typeof sc.at === 'string'
        ? { tool: 'log_job', arguments: { operation: args.operation, ...(typeof sc.field === 'string' ? { field: sc.field } : {}), when: sc.at, note: `Accuracy lost to ${cause}` } }
        : null;
    }
    case 'storm_status': {
      // A storm running or on its way: which of this farm's jobs it is hurting is the next question.
      const g = (sc.scales as { g?: number } | undefined)?.g ?? 0;
      return g >= 1 || sc.incoming ? { tool: 'farm_status', arguments: {} } : null;
    }
    case 'position_trust':
      // Anything short of trust is asked again, with the same position, when the answer says to.
      return sc.verdict && sc.verdict !== 'trust' && !sc.unavailable ? { tool: 'position_trust', arguments: { ...args } } : null;
    case 'what_should_i_do':
      return typeof sc.nextStep === 'number' ? { tool: 'what_should_i_do', arguments: { ...(typeof sc.role === 'string' ? { role: sc.role } : {}), step: sc.nextStep } } : null;
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
  if (out.nextAction == null) {
    const next = nextFor(name, (args ?? {}) as Record<string, unknown>, out);
    if (next) out.nextAction = next;
  }
  return { ...result, structuredContent: out };
}
