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
import { NOAA_QUARTERS } from './noaa-archive.js';

const GFZ = 'https://kp.gfz.de/app/json/';

/** Small cache: the past does not change, so a fetched day is good forever. */
const cache = new Map<string, Slot[]>();
/** Any date can be asked about, so the cache is bounded and the oldest day goes first. */
const MAX_CACHED_DAYS = 400;
/** The Kp index begins in 1932. Asking the archive for anything earlier is a wasted request. */
export const EARLIEST = Date.UTC(1932, 0, 1);

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/**
 * When GFZ is down. NOAA publishes the same planetary Kp, eight three-hour values a day: the last thirty days in a
 * live text file, and older days in quarterly files kept in noaa-archive.ts. On 22 October 2026 every GFZ address
 * timed out from here and from AWS while NOAA answered in milliseconds, so a look back that NOAA covers is read
 * from NOAA instead. After a failure GFZ is left alone for five minutes, so each question does not wait ten
 * seconds to find out again.
 */
const NOAA_30_DAYS = 'https://services.swpc.noaa.gov/text/daily-geomagnetic-indices.txt';
const NOAA_30_DAYS_REACH = 30 * 86_400_000;
let gfzDownUntil = 0;
/** Slots that came from NOAA rather than the GFZ archive, so the answer can name its source. */
export const fromNoaa = new WeakSet<Slot[]>();

/** One line per day: the date, then the planetary Kp as the only decimals on the line; -1.00 is not measured yet. */
export function parseNoaaDays(text: string): Slot[] {
  const out: Slot[] = [];
  for (const line of text.split('\n')) {
    const date = /^(\d{4}) (\d\d) (\d\d)\s/.exec(line);
    if (!date) continue;
    const kps = line.match(/-?\d+\.\d+/g) ?? [];
    if (kps.length !== 8) continue;
    kps.forEach((v, i) => {
      const kp = Number(v);
      if (kp < 0) return;
      out.push({ time: new Date(Date.UTC(+date[1], +date[2] - 1, +date[3], i * 3)).toISOString(), kp, observed: true });
    });
  }
  return out;
}

const archived = parseNoaaDays(Object.values(NOAA_QUARTERS).join('\n'));

/** The NOAA days for a range: the stored quarters, and the live thirty days when the range reaches into them. */
async function fetchNoaaRange(from: Date, to: Date): Promise<Slot[]> {
  // From the three-hour block the start falls in, as GFZ answers.
  const first = Math.floor(from.getTime() / (3 * 3_600_000)) * 3 * 3_600_000;
  const inRange = (x: Slot) => {
    const t = Date.parse(x.time);
    return t >= first && t <= to.getTime();
  };
  const byTime = new Map(archived.filter(inRange).map((x) => [x.time, x]));
  if (to.getTime() >= Date.now() - NOAA_30_DAYS_REACH) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(NOAA_30_DAYS, { signal: ctrl.signal });
      if (res.ok) for (const x of parseNoaaDays(await res.text()).filter(inRange)) byTime.set(x.time, x);
    } catch {
      /* the stored quarters may still cover it */
    } finally {
      clearTimeout(timer);
    }
  }
  const slots = [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time));
  // Only an answer when NOAA has the day the range starts on: a range NOAA does not cover is not answered from a part of it.
  if (!slots.length || slots[0].time.slice(0, 10) !== new Date(first).toISOString().slice(0, 10)) throw new Error('Not in the NOAA days either');
  fromNoaa.add(slots);
  return slots;
}

export async function fetchRange(from: Date, to: Date): Promise<Slot[]> {
  const key = `${dayKey(from)}..${dayKey(to)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (Date.now() < gfzDownUntil) return fetchNoaaRange(from, to);
  try {
    return await fetchGfz(from, to, key);
  } catch {
    gfzDownUntil = Date.now() + 5 * 60_000;
    return fetchNoaaRange(from, to);
  }
}

async function fetchGfz(from: Date, to: Date, key: string): Promise<Slot[]> {
  const url = `${GFZ}?start=${from.toISOString().slice(0, 19)}Z&end=${to.toISOString().slice(0, 19)}Z&index=Kp`;
  const ctrl = new AbortController();
  // Two and a half seconds: a voice turn cannot wait longer, and NOAA's days answer when GFZ does not.
  const timer = setTimeout(() => ctrl.abort(), 2500);
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
/** Where a numeric date is written month first. Canada writes both; it is read the American way, as before. */
const MONTH_FIRST = new Set(['US', 'PR', 'GU', 'VI', 'AS', 'MP', 'CA']);

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
  /** country: the field's, so a numeric date is read the way it is written there. */
  opts: { prefer?: 'past' | 'future'; timeZone?: string | null; country?: string | null } = {},
): Date | null {
  const prefer = opts.prefer ?? 'past';
  let raw = spoken.trim();
  // An ISO date with no zone is a day on the field's own calendar, the same as "10 May 2024". The built-in parser
  // reads "2024-05-10" as midnight in London, which in Iowa is still the 9th: asked about the storm of 10 May 2024,
  // the answer was about the quiet day before it.
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/i.exec(raw);
  if (local && Number(local[2]) >= 1 && Number(local[2]) <= 12) {
    raw = `${MONTHS[Number(local[2]) - 1]} ${Number(local[3])} ${local[1]}${local[4] ? ` at ${local[4]}:${local[5]}` : ''}`;
  }
  // A date written with dots is day first everywhere it is written that way: "10.05.2024" is 10 May.
  const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(raw);
  if (dotted) raw = `${MONTHS[Number(dotted[2]) - 1] ?? 'x'} ${Number(dotted[1])} ${dotted[3]}`;
  let s = raw.toLowerCase().replace(/[,.]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;

  /*
   * Hours said the way people say them. "In two hours" and "three hours ago" were not understood at all, "3 o'clock
   * tomorrow" and "half past three tomorrow" kept the day and dropped the hour, and "midnight" and "this weekend" came
   * back as nothing. Found by running everyday phrases through this function, 22 October 2026.
   */
  const NUM = (w: string): number | null => (/^\d+$/.test(w) ? Number(w) : UNITS[w] ?? (w === 'half' ? 0.5 : null));
  const rel = /\b(?:in (?:about |around )?)?(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple(?: of)?|half an?) (hours?|minutes?|mins?)(?: (ago|from now))?\b/.exec(s);
  if (rel && (/\bin\b/.test(s.slice(0, rel.index + 4)) || rel[3])) {
    const n = /^half/.test(rel[1]) ? 0.5 : NUM(rel[1].replace(/ of$/, '')) ?? null;
    if (n != null) {
      const ms = n * (/^h/.test(rel[2]) ? 3_600_000 : 60_000);
      return new Date(now.getTime() + (rel[3] === 'ago' ? -ms : ms));
    }
  }
  // Words for the hour, and the half and quarter hours, as a clock time.
  const HOURS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  const hourOf = (w: string): number | null => (/^\d{1,2}$/.test(w) ? Number(w) : HOURS[w] ?? null);
  s = s.replace(/\b(half|quarter) (past|to|after) (\d{1,2}|[a-z]+)\b/g, (all, part, dir, w) => {
    const h = hourOf(w);
    if (h == null) return all;
    if (dir === 'to') return `${h === 1 ? 12 : h - 1}:45`;
    return `${h}:${part === 'half' ? '30' : '15'}`;
  });
  s = s.replace(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) ?o ?'? ?clock\b/g, (all, w) => (hourOf(w) != null ? `${hourOf(w)}:00` : all));
  s = s.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) ?(am|pm|a m|p m)\b/g, (_all, w, m) => `${HOURS[w]} ${m}`);
  // The weekend is its Saturday, or today when it is already the weekend.
  if (/\bweekend\b/.test(s)) {
    const dow = new Date(now.getTime() + offsetMinutes(now, opts.timeZone || 'UTC') * 60_000).getUTCDay();
    s = /\b(last|next)\b/.test(s) || (dow !== 0 && dow !== 6) ? s.replace(/\b(the )?weekend\b/, 'saturday') : s.replace(/\b(this |the )?weekend\b/, 'today');
  }

  // Unmistakably ISO with its zone, and nothing else, goes to the built-in parser.
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
  const clock = /\b(?:at )?(\d{1,2})(?::(\d{2}))? ?(am|pm|a m|p m)\b/.exec(s) ?? /\b(\d{1,2}):(\d{2})\b/.exec(s) ??
    // "Yesterday at 3": an hour after "at", not followed by a unit or a year.
    /\bat (\d{1,2})()()(?! ?(?:minutes?|hours?|days?|weeks?|\d))\b/.exec(s);
  if (clock) {
    let h = Number(clock[1]);
    const half = (clock[3] ?? '').replace(' ', '');
    if (half === 'pm' && h < 12) h += 12;
    if (half === 'am' && h === 12) h = 0;
    // "At 3" or "3 o'clock" with no am or pm, about field work, is the afternoon: from 1 to 6 it is pm. Written with a
    // leading zero, "03:00", it is a 24 hour clock and left alone.
    if (!half && h >= 1 && h <= 6 && !/^0/.test(clock[1])) h += 12;
    // "Nine o'clock tonight" is in the evening.
    else if (!half && h < 12 && /\b(tonight|evening|night)\b/.test(s)) h += 12;
    if (h <= 23) hour = h + Number(clock[2] ?? 0) / 60;
  } else if (/\bmidnight\b/.test(s)) hour = prefer === 'future' ? 24 : 0;
  else if (/\bnoon\b|\bmidday\b/.test(s)) hour = 12;
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

  if (/\b(today|tonight|now|right now)\b/.test(s) || /\bthis (morning|afternoon|evening)\b/.test(s)) return hour != null ? daysFromToday(0) : now;


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

  // A numeric date. Month first in the United States; day first everywhere else Alexa+ is sold (Mexico, Brazil, the UK,
  // Europe, India, Australia), so "10/05/2024" from a field in Punjab is 10 May and not 5 October. A number above 12
  // settles it either way.
  const numeric = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (numeric) {
    const [a, b2, y] = [Number(numeric[1]), Number(numeric[2]), Number(numeric[3])];
    const monthFirst = a > 12 ? false : b2 > 12 ? true : !opts.country || MONTH_FIRST.has(opts.country.toUpperCase());
    const [m, d] = monthFirst ? [a, b2] : [b2, a];
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const built = Date.UTC(y, m - 1, d);
    return new Date(built).getUTCMonth() === m - 1 ? onDay(built) : null;
  }

  // A time with no day, "at 3 o'clock" or "midnight": the next one coming, or the last one gone.
  if (hour != null) {
    const today = daysFromToday(0);
    if (prefer === 'future') return today.getTime() >= now.getTime() - 15 * 60_000 ? today : daysFromToday(1);
    return today.getTime() <= now.getTime() ? today : daysFromToday(-1);
  }

  return null;
}
