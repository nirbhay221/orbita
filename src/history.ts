/**
 * Historical Kp, for answering "why were my rows crooked last Tuesday".
 *
 * NOAA's live products only reach back about seven days. GFZ Potsdam produce the
 * Kp index itself and publish the full archive, free and without a key, so deeper
 * lookbacks and the May 2024 replay both come from there.
 *
 * Looking backward matters as much as looking forward. A farmer who is told to
 * hold off and complies never sees what would have happened, so the forecast can
 * never prove itself. A farmer who asks what went wrong on Tuesday and gets a
 * number does not need convincing again.
 */

import type { Slot } from './domain.js';

const GFZ = 'https://kp.gfz.de/app/json/';

/** Small cache: the past does not change, so a fetched day is good forever. */
const cache = new Map<string, Slot[]>();
/** Any date can be asked about, so the cache is bounded and the oldest day goes first. */
const MAX_CACHED_DAYS = 400;
/** The Kp index begins in 1932. Asking the archive for anything earlier is a wasted request. */
export const EARLIEST = Date.UTC(1932, 0, 1);

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

export async function fetchRange(from: Date, to: Date): Promise<Slot[]> {
  const key = `${dayKey(from)}..${dayKey(to)}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const url = `${GFZ}?start=${from.toISOString().slice(0, 19)}Z&end=${to.toISOString().slice(0, 19)}Z&index=Kp`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`GFZ: HTTP ${res.status}`);
    const body = (await res.json()) as { datetime?: string[]; Kp?: number[] };
    const times = body.datetime ?? [];
    const kps = body.Kp ?? [];
    const slots: Slot[] = times
      .map((t, i) => ({ time: new Date(t).toISOString(), kp: Number(kps[i]), observed: true }))
      .filter((s) => Number.isFinite(s.kp));
    if (slots.length) {
      cache.set(key, slots);
      if (cache.size > MAX_CACHED_DAYS) cache.delete(cache.keys().next().value as string);
    }
    return slots;
  } finally {
    clearTimeout(timer);
  }
}

/** The day surrounding a moment, so we can report the peak rather than one block. */
export async function fetchDay(when: Date): Promise<Slot[]> {
  const from = new Date(when);
  from.setUTCHours(0, 0, 0, 0);
  // One minute short of the next midnight: a UTC day is eight 3-hour blocks,
  // and asking through midnight exactly returns the next day's first block too.
  const to = new Date(from.getTime() + 24 * 3600_000 - 60_000);
  return fetchRange(from, to);
}

/**
 * Resolve the dates people actually say.
 *
 * A farmer says "last Tuesday", "the tenth of May" or "tomorrow morning", and the model may pass that through
 * or turn it into an ISO timestamp first, so both have to work.
 *
 * This used to hand the string to `Date.parse` and trust whatever came back. V8's fallback parser is very
 * forgiving in exactly the wrong way: "field 12" parses as the first of December 2001, "May 10" as 2001,
 * "the tenth of May 2024" as the FIRST of May 2024, and a weekday alone parses as nothing. A wrong date here
 * is a confident answer about a day nobody asked about. So `Date.parse` is now used only for strings that are
 * unmistakably ISO, and everything else is read by the rules below, which return null rather than guess.
 *
 * `prefer` settles the ambiguous cases: "Tuesday" or "May 10" with no year means the last one when looking
 * back at what happened, and the next one when asking whether a job can run. `timeZone` is the field's own,
 * so that "tomorrow morning" means morning there and not morning in UTC.
 */
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const UNITS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  a: 1, an: 1, couple: 2,
};
const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30,
};
const DAY_MS = 86_400_000;

/** Minutes the zone is ahead of UTC at that instant. */
function offsetMinutes(at: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at);
    const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
    return Math.round((wall - at.getTime()) / 60_000);
  } catch {
    return 0;
  }
}

/** A day number written as "10", "10th" or "tenth", or "twenty first". */
function dayNumber(text: string): number | null {
  const digits = /^(\d{1,2})(st|nd|rd|th)?$/.exec(text);
  if (digits) return Number(digits[1]);
  if (text in ORDINALS) return ORDINALS[text];
  const compound = /^(twenty|thirty)[ -](first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)$/.exec(text);
  if (compound) return (compound[1] === 'twenty' ? 20 : 30) + ORDINALS[compound[2]];
  return null;
}

export function parseWhen(
  spoken: string,
  now = new Date(),
  opts: { prefer?: 'past' | 'future'; timeZone?: string | null } = {},
): Date | null {
  const prefer = opts.prefer ?? 'past';
  const raw = spoken.trim();
  const s = raw.toLowerCase().replace(/[,.]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;

  // Unmistakably ISO, and nothing else, goes to the built-in parser.
  if (/^\d{4}-\d{2}-\d{2}([t ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})?)?$/i.test(raw)) {
    const iso = Date.parse(raw);
    return Number.isFinite(iso) ? new Date(iso) : null;
  }

  const zone = opts.timeZone || 'UTC';
  const offset = offsetMinutes(now, zone) * 60_000;
  // "Local" here is a Date whose UTC fields read as the wall clock in the zone.
  const localNow = new Date(now.getTime() + offset);
  const startOfLocalDay = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate());

  // The time of day, if one was said. Otherwise the same clock time as now.
  let hour: number | null = null;
  const clock = /\b(?:at )?(\d{1,2})(?::(\d{2}))? ?(am|pm|a m|p m)\b/.exec(s) ?? /\b(\d{1,2}):(\d{2})\b/.exec(s);
  if (clock) {
    let h = Number(clock[1]);
    const half = (clock[3] ?? '').replace(' ', '');
    if (half === 'pm' && h < 12) h += 12;
    if (half === 'am' && h === 12) h = 0;
    if (h <= 23) hour = h + Number(clock[2] ?? 0) / 60;
  } else if (/\bnoon\b|\bmidday\b/.test(s)) hour = 12;
  else if (/\bmorning\b/.test(s)) hour = 8;
  else if (/\bafternoon\b/.test(s)) hour = 14;
  else if (/\bevening\b/.test(s)) hour = 18;
  else if (/\btonight\b|\bnight\b/.test(s)) hour = 21;

  const onDay = (dayStartLocal: number): Date => {
    const sinceMidnight = hour != null ? hour * 3_600_000 : localNow.getTime() - startOfLocalDay;
    return new Date(dayStartLocal + sinceMidnight - offset);
  };
  const daysFromToday = (n: number) => onDay(startOfLocalDay + n * DAY_MS);

  if (/\bday after tomorrow\b/.test(s)) return daysFromToday(2);
  if (/\bday before yesterday\b/.test(s)) return daysFromToday(-2);
  if (/\btomorrow\b/.test(s)) return daysFromToday(1);
  if (/\byesterday\b|\blast night\b/.test(s)) return daysFromToday(-1);
  const span = /\b(\d+|[a-z]+)(?: of)? (day|week)s?\b/.exec(s);
  const amount = span ? (/^\d+$/.test(span[1]) ? Number(span[1]) : UNITS[span[1]]) : undefined;
  if (span && amount && /\bago\b|\bback\b/.test(s)) return daysFromToday(-amount * (span[2] === 'week' ? 7 : 1));
  if (span && amount && /\bin\b|\bfrom now\b|\btime\b/.test(s)) return daysFromToday(amount * (span[2] === 'week' ? 7 : 1));
  if (/\blast week\b/.test(s)) return daysFromToday(-7);
  if (/\bnext week\b/.test(s)) return daysFromToday(7);

  if (/\b(today|tonight|now|right now)\b/.test(s) || /^this (morning|afternoon|evening)$/.test(s)) return hour != null ? daysFromToday(0) : now;


  const weekday = WEEKDAYS.findIndex((d) => new RegExp(`\\b${d}\\b`).test(s));
  if (weekday >= 0) {
    const today = localNow.getUTCDay();
    const back = (today - weekday + 7) % 7 || 7; // "Tuesday" means the last one, not today
    const ahead = (weekday - today + 7) % 7 || 7;
    const future = /\b(next|this|coming)\b/.test(s) ? true : /\blast\b/.test(s) ? false : prefer === 'future';
    return daysFromToday(future ? ahead : -back);
  }

  // A month and a day, in either order, with or without a year.
  const month = MONTHS.findIndex((m) => new RegExp(`\\b${m}\\b|\\b${m.slice(0, 3)}\\b`).test(s));
  if (month >= 0) {
    const year = /\b(19|20)\d{2}\b/.exec(s);
    const words = s.replace(/\b(19|20)\d{2}\b/, ' ').replace(/\b(the|of|on)\b/g, ' ').replace(/\s+/g, ' ').trim().split(' ');
    let day: number | null = null;
    for (let i = 0; i < words.length && day == null; i += 1) {
      day = (i + 1 < words.length ? dayNumber(`${words[i]} ${words[i + 1]}`) : null) ?? dayNumber(words[i]);
    }
    if (day == null || day < 1 || day > 31) return null;
    const build = (y: number) => Date.UTC(y, month, day as number);
    const real = (y: number) => new Date(build(y)).getUTCMonth() === month; // rejects the 31st of June
    if (year) return real(Number(year[0])) ? onDay(build(Number(year[0]))) : null;
    const thisYear = localNow.getUTCFullYear();
    if (!real(thisYear)) return null;
    const candidate = build(thisYear);
    if (prefer === 'past') return onDay(candidate > startOfLocalDay ? build(thisYear - 1) : candidate);
    return onDay(candidate < startOfLocalDay ? build(thisYear + 1) : candidate);
  }

  // A numeric date the American way round: month, day, year.
  const numeric = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (numeric) {
    const [m, d, y] = [Number(numeric[1]), Number(numeric[2]), Number(numeric[3])];
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const built = Date.UTC(y, m - 1, d);
    return new Date(built).getUTCMonth() === m - 1 ? onDay(built) : null;
  }

  return null;
}
