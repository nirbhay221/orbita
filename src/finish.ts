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

/** For the roles that run machines, what those machines usually rely on, for the position_trust that follows. */
const MACHINE_ROLES: Record<string, Record<string, unknown>> = {
  robots: { needMeters: 0.05, correction: 'rtk', dependsOn: ['satellite_position', 'satellite_link', 'grid_power'] },
  drone_pilot: { dependsOn: ['satellite_position', 'compass', 'traffic_awareness'] },
  mining: { needMeters: 0.05, correction: 'rtk', dependsOn: ['satellite_position', 'satellite_link'] },
  fleet: { dependsOn: ['satellite_position', 'satellite_link'] },
};

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
    case 'position_trust': {
      if (sc.unavailable) return null;
      const receiver = Object.fromEntries(Object.entries(args).filter(([k]) => ['needMeters', 'correction', 'hardened'].includes(k)));
      // The windows were the question: check the position itself again just before the first one opens, when that
      // is close enough to judge from the forecast. Further off, the alerts feed is the thing to watch.
      if (Array.isArray(sc.windows)) {
        const first = (sc.windows as { start: string }[])[0];
        const pos = sc.position as { lat?: number; lon?: number } | undefined;
        const minutes = first ? Math.round((new Date(first.start).getTime() - Date.now()) / 60_000) : -1;
        return first && pos?.lat != null && minutes >= 5 && minutes <= 360
          ? { tool: 'position_trust', arguments: { lat: pos.lat, lon: pos.lon, ...receiver, inMinutes: minutes } }
          : null;
      }
      // A fleet with any position short of trust: when the worst of them clears is what to plan around.
      if (Array.isArray(sc.positions)) {
        const rank = { do_not_trust: 2, verify: 1, trust: 0 } as Record<string, number>;
        const worst = [...(sc.positions as { lat: number; lon: number; verdict: string }[])].sort((x, y) => rank[y.verdict] - rank[x.verdict])[0];
        return worst && worst.verdict !== 'trust' ? { tool: 'position_trust', arguments: { lat: worst.lat, lon: worst.lon, ...receiver, windowsHours: 72 } } : null;
      }
      // Do not trust: then when. The machine's version of "can I run it, then when will it clear".
      if (sc.verdict === 'do_not_trust') return { tool: 'position_trust', arguments: { ...args, windowsHours: 72 } };
      // Verify: asked again, with the same position, when the answer says to.
      return sc.verdict === 'verify' ? { tool: 'position_trust', arguments: { ...args } } : null;
    }
    case 'what_should_i_do': {
      if (typeof sc.nextStep === 'number') return { tool: 'what_should_i_do', arguments: { ...(typeof sc.role === 'string' ? { role: sc.role } : {}), step: sc.nextStep } };
      // Someone who runs machines, in a storm, at a known place: what those machines rely on is the next question.
      const deps = MACHINE_ROLES[String(sc.role ?? args.role ?? '')];
      const pos = sc.position as { lat?: number; lon?: number } | undefined;
      return deps && sc.phase && sc.phase !== 'quiet' && pos?.lat != null
        ? { tool: 'position_trust', arguments: { lat: pos.lat, lon: pos.lon, ...deps } }
        : null;
    }
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
