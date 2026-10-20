/**
 * Putting a week's work into the hours the sky allows, and counting the hours it took away before.
 *
 * can_i_run answers one job now; watch_jobs waits for one job to clear; plan_season says which weeks are worth
 * booking. None of them answers the question a crew boss has on a Monday: I need twelve hours of planting and six of
 * spraying, where do they go. This does, from the same NOAA forecast and the same per-block test as clearWindows,
 * so a block it puts work in is one can_i_run would clear.
 *
 * The other half looks back. The GFZ Kp archive, the record what_happened already reads, gives every three-hour
 * block of the last week, month or year, and each is judged for this field and machine the way the forecast is:
 * the expected error against the job's tolerance, the storm margin, and near the magnetic equator the evening
 * plasma bubble hours. What comes out is how many working hours the sky would have cost, and when.
 */

import { TOLERANCE_M, clearWindows, expectedErrorM, equatorialEvening, stormMargin, type Equipment, type Field, type Operation, type Slot } from './domain.js';
import { spokenTime } from './timezone.js';

const HOUR = 3_600_000;

export type JobAsk = { operation: Operation; hours: number; eq: Equipment; field: Field };
export type Block = { start: string; end: string; hours: number };
export type Placed = { operation: Operation; machine: string; asked: number; placed: number; blocks: Block[] };

/** The hour of the day where the field is, 0 to 23. */
function localHour(ms: number, timeZone?: string): number {
  try {
    return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: timeZone || 'UTC' }).format(new Date(ms)));
  } catch {
    return new Date(ms).getUTCHours();
  }
}

const inWorkingHours = (hour: number, from?: number, to?: number): boolean => {
  if (from == null || to == null) return true;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
};

/** Hours next to each other, joined into the blocks a person would be told. */
function joinHours(starts: number[]): Block[] {
  const out: Block[] = [];
  for (const s of [...starts].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && Date.parse(last.end) === s) {
      last.end = new Date(s + HOUR).toISOString();
      last.hours += 1;
    } else {
      out.push({ start: new Date(s).toISOString(), end: new Date(s + HOUR).toISOString(), hours: 1 });
    }
  }
  return out;
}

/**
 * Each job into the earliest clear hours it can have. The tightest tolerance goes first, because it has the fewest
 * hours to choose from. One machine does one job at a time; two machines work side by side.
 */
export function scheduleJobs(
  slots: Slot[],
  jobs: JobAsk[],
  now: Date,
  opts: { fromHour?: number; toHour?: number; horizonHours?: number } = {},
): { placed: Placed[]; spoken: string; horizonEnds: string | null } {
  const horizon = opts.horizonHours ?? 72;
  const busy = new Map<string, Set<number>>();
  // Each job keeps its place in the ask, so two of the same job on one machine are told apart in the answer.
  const order = jobs.map((job, at) => ({ job, at })).sort((a, b) => TOLERANCE_M[a.job.operation] - TOLERANCE_M[b.job.operation]);
  const placed: (Placed & { at: number })[] = [];
  const lastSlot = slots.length ? Math.max(...slots.map((s) => Date.parse(s.time))) + 3 * HOUR : null;

  for (const { job, at } of order) {
    const windows = clearWindows(slots, job.eq, job.field, TOLERANCE_M[job.operation], now, horizon);
    const taken = busy.get(job.eq.id) ?? new Set<number>();
    const chosen: number[] = [];
    const want = Math.ceil(job.hours);
    for (const w of windows) {
      // Whole hours only, starting on the hour, so a crew is told "6 AM", not "6:17 AM".
      for (let t = Math.ceil(Date.parse(w.start) / HOUR) * HOUR; t + HOUR <= Date.parse(w.end) && chosen.length < want; t += HOUR) {
        if (taken.has(t)) continue;
        if (!inWorkingHours(localHour(t, job.field.timeZone), opts.fromHour, opts.toHour)) continue;
        chosen.push(t);
      }
      if (chosen.length >= want) break;
    }
    for (const t of chosen) taken.add(t);
    busy.set(job.eq.id, taken);
    placed.push({ at, operation: job.operation, machine: job.eq.name, asked: job.hours, placed: chosen.length, blocks: joinHours(chosen) });
  }

  // Said in the order they were asked for, not the order they were fitted.
  const said: Placed[] = [...placed].sort((a, b) => a.at - b.at).map(({ at: _at, ...p }) => p);
  const tz = jobs[0]?.field.timeZone;
  // "Tue 10 AM to 8 PM CDT", or "Tue 10 PM to Wed 2 AM CDT" across midnight: the zone once, the day only when it changes.
  const when = (b: Block) => {
    const from = spokenTime(b.start, tz).split(' ');
    const to = spokenTime(b.end, tz).split(' ');
    const zone = to[to.length - 1];
    const start = from.slice(0, -1).join(' ');
    const end = from[0] === to[0] ? to.slice(1, -1).join(' ') : to.slice(0, -1).join(' ');
    return `${start} to ${end} ${zone}`;
  };
  const parts: string[] = [];
  for (const p of said) {
    const job = p.operation.replace(/_/g, ' ');
    if (!p.placed) {
      parts.push(`${cap(job)} on the ${bare(p.machine)} has no clear hours in the next three days.`);
      continue;
    }
    const shown = p.blocks.slice(0, 3).map(when);
    const more = p.blocks.length > 3 ? `, and ${p.blocks.length - 3} more short stretches` : '';
    parts.push(
      `${cap(job)}, ${p.placed} ${p.placed === 1 ? 'hour' : 'hours'} on the ${bare(p.machine)}: ${andList(shown)}${more}.` +
        (p.placed < Math.ceil(p.asked) ? ` That is ${p.placed} of the ${Math.ceil(p.asked)} you need; the forecast runs out after that, so ask me which weeks are clear for the rest.` : ''),
    );
  }
  return { placed: said, spoken: parts.join(' '), horizonEnds: lastSlot ? new Date(lastSlot).toISOString() : null };
}

/** "the planter" is said "the planter", not "the the planter". */
const bare = (name: string) => name.replace(/^(the|my|our)\s+/i, '');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const andList = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/* ------------------------------------------------------------------ the hours already lost */

export type Period = 'week' | 'month' | 'year';
export const PERIOD_DAYS: Record<Period, number> = { week: 7, month: 30, year: 365 };

export type Lost = {
  operation: Operation;
  machine: string;
  lostHours: number;
  lostDays: number;
  worst: { day: string; hours: number; peakKp: number } | null;
  /** Hours lost by calendar month, for a year; by week starting date for a month; by day for a week. */
  by: { key: string; hours: number }[];
  /** Of the hours lost, how many were the evening bubble hours rather than a storm. */
  bubbleHours: number;
};

/** One block judged: whether the job held, and if not, whether a storm or the evening bubbles stopped it. */
function blockLost(s: Slot, eq: Equipment, field: Field, op: Operation): 'ok' | 'storm' | 'bubbles' {
  const tol = TOLERANCE_M[op];
  const begins = Date.parse(s.time);
  const mid = new Date(begins + 90 * 60_000);
  const err = expectedErrorM(s.kp, eq, field, mid);
  if (err > tol || stormMargin(s.kp, eq.correction, err, tol)) return 'storm';
  const carrier = (eq.correction === 'rtk' || eq.correction === 'ppp') && tol < 0.3 && !eq.hardened;
  if (carrier && [begins + 30 * 60_000, begins + 150 * 60_000].some((t) => equatorialEvening(field, new Date(t)))) return 'bubbles';
  return 'ok';
}

/** The field's own calendar date for a moment. */
function localDate(ms: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: timeZone || 'UTC' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

export function lostHours(slots: Slot[], jobs: { operation: Operation; eq: Equipment }[], field: Field, period: Period, now: Date): Lost[] {
  const since = now.getTime() - PERIOD_DAYS[period] * 86_400_000;
  const inRange = slots.filter((s) => Date.parse(s.time) >= since && Date.parse(s.time) + 3 * HOUR <= now.getTime());
  return jobs.map(({ operation, eq }) => {
    const days = new Map<string, { hours: number; peakKp: number }>();
    const by = new Map<string, number>();
    let lost = 0;
    let bubbleHours = 0;
    for (const s of inRange) {
      const verdict = blockLost(s, eq, field, operation);
      if (verdict === 'ok') continue;
      lost += 3;
      if (verdict === 'bubbles') bubbleHours += 3;
      const day = localDate(Date.parse(s.time) + 90 * 60_000, field.timeZone);
      const d = days.get(day) ?? { hours: 0, peakKp: 0 };
      d.hours += 3;
      d.peakKp = Math.max(d.peakKp, s.kp);
      days.set(day, d);
      const key = period === 'year' ? day.slice(0, 7) : day;
      by.set(key, (by.get(key) ?? 0) + 3);
    }
    const worstEntry = [...days.entries()].sort((a, b) => b[1].hours - a[1].hours || b[1].peakKp - a[1].peakKp)[0];
    return {
      operation,
      machine: eq.name,
      lostHours: lost,
      lostDays: days.size,
      worst: worstEntry ? { day: worstEntry[0], hours: worstEntry[1].hours, peakKp: worstEntry[1].peakKp } : null,
      by: [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, hours]) => ({ key, hours })),
      bubbleHours,
    };
  });
}

const monthName = (ym: string) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayName = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

export function speakLost(lost: Lost[], fieldName: string, period: Period): string {
  const span = period === 'week' ? 'the last 7 days' : period === 'month' ? 'the last 30 days' : 'the last year';
  const parts: string[] = [];
  for (const l of lost) {
    const job = l.operation.replace(/_/g, ' ');
    if (!l.lostHours) {
      parts.push(`Over ${span} at ${fieldName}, space weather would not have stopped ${job} on the ${bare(l.machine)} for a single hour.`);
      continue;
    }
    let s = `Over ${span} at ${fieldName}, ${job} on the ${bare(l.machine)} would have been held for about ${l.lostHours} hours, on ${l.lostDays} ${l.lostDays === 1 ? 'day' : 'days'}.`;
    if (l.bubbleHours) s += ` ${l.bubbleHours === l.lostHours ? 'All' : `${l.bubbleHours}`} of those were the evening plasma bubble hours, not storms.`;
    if (l.worst) s += ` The worst was ${dayName(l.worst.day)}, ${l.worst.hours} hours${l.worst.peakKp >= 5 ? `, with Kp reaching ${l.worst.peakKp.toFixed(1)}` : ''}.`;
    if (period === 'year' && l.by.length) {
      const top = [...l.by].sort((a, b) => b.hours - a.hours)[0];
      s += ` ${monthName(top.key)} cost the most, ${top.hours} hours.`;
    }
    parts.push(s);
  }
  return parts.join(' ');
}
