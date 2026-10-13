/**
 * One request, several steps.
 *
 * Each tool here answers one question well. A job is not one question. "Can I plant" on a day the sky says no
 * leads to "then when", which leads to "watch it for me", which leads to "tell the crew", and when the job is
 * done to "log it" and "what did the week look like". Every one of those was already a tool, and most answers
 * named nothing after them, so the chain depended on the host guessing.
 *
 * So every answer now carries the chain it is on: what has just been done, the step that follows, and the steps
 * after that. A host can run them in order from one request, or offer them one at a time, and a screen can show
 * how far along it is. Nothing is called from here: this only says what comes next, and each tool still decides
 * from the farm's own state whether its step applies.
 *
 * What was just done is kept for a quarter of an hour, in memory, as tool names only: no arguments, no answers.
 */

type Next = { tool: string; arguments: Record<string, unknown> } | null;
export type Flow = {
  /** What this conversation is working through, in words a person would use. */
  about: string;
  /** Tools already answered in the last few minutes, oldest first, this one included. */
  done: string[];
  /** The step after this one, or null at the end of the chain. */
  next: string | null;
  /** What usually follows that, in order. */
  then: string[];
};

const WINDOW_MS = 15 * 60_000;
const MAX_HELD = 5000;
const trails = new Map<string, { tool: string; at: number }[]>();

/** What usually follows what, when the answer itself does not say. Setting up, a job, and looking back. */
const USUALLY: Record<string, string> = {
  my_farm: 'farm_status',
  register_field: 'farm_status',
  register_equipment: 'farm_status',
  farm_status: 'can_i_run',
  storm_status: 'farm_status',
  can_i_run: 'watch_jobs',
  watch_jobs: 'crew_contact',
  what_happened: 'log_job',
  log_job: 'job_report',
  what_should_i_do: 'storm_status',
};

const ABOUT: Record<string, string> = {
  my_farm: 'setting up, then the first job',
  register_field: 'setting up, then the first job',
  register_equipment: 'setting up, then the first job',
  farm_status: 'which job the sky is hurting',
  storm_status: 'the storm, and which job it is hurting',
  can_i_run: 'a job, from whether it can run to the record of it',
  watch_jobs: 'a job, from whether it can run to the record of it',
  crew_contact: 'a job, from whether it can run to the record of it',
  log_job: 'a job, from whether it can run to the record of it',
  job_report: 'a job, from whether it can run to the record of it',
  what_happened: 'a job that went badly, and the record of it',
  position_trust: 'a machine and its position',
  what_should_i_do: 'a storm, and what to do about it',
};

export function record(id: string, tool: string, now = Date.now()): string[] {
  const kept = (trails.get(id) ?? []).filter((t) => now - t.at <= WINDOW_MS && t.tool !== tool);
  kept.push({ tool, at: now });
  trails.delete(id);
  trails.set(id, kept.slice(-8));
  if (trails.size > MAX_HELD) trails.delete(trails.keys().next().value as string);
  return kept.map((t) => t.tool);
}

export const trail = (id: string, now = Date.now()): string[] => (trails.get(id) ?? []).filter((t) => now - t.at <= WINDOW_MS).map((t) => t.tool);

/**
 * The chain an answer is on. `next` is what the answer itself named; when it named nothing, nothing is invented:
 * the chain ends there, which is how "it is a fine day to be out" stays one answer and not the start of four.
 */
export function describe(id: string, tool: string, next: Next): Flow | null {
  const done = record(id, tool);
  if (!next && done.length < 2) return null;
  const then: string[] = [];
  let at = next?.tool ?? null;
  const seen = new Set<string>([tool, ...(at ? [at] : [])]);
  while (at && then.length < 3) {
    const after = USUALLY[at];
    if (!after || seen.has(after)) break;
    then.push(after);
    seen.add(after);
    at = after;
  }
  return { about: ABOUT[tool] ?? 'this conversation', done, next: next?.tool ?? null, then };
}

export function resetForTest(): void {
  trails.clear();
}
