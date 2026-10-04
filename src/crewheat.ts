/**
 * The people on the machine.
 *
 * Everything else here answers whether the receiver will hold its line. The same morning decision has a
 * second half that no guidance display shows: whether the crew can stand to be out there for the hours the
 * job takes. A planting window that is clear of the sun's weather from eleven to seven is also, in July, the
 * eight hottest hours of the day, and the person deciding to send the crew is deciding both things at once.
 *
 * So when a job is judged, the heat over that field for the hours it would run is checked too, and said in
 * one sentence when it crosses a line. The lines are the two in the workplace heat rule OSHA proposed in
 * 2024: a heat index of 80, where water and shade are owed, and 90, where a fifteen minute rest break at
 * least every two hours is. Below 80 nothing is said, because a sentence about pleasant weather on every
 * answer is how the one that matters stops being heard.
 *
 * The forecast is Open-Meteo's hourly temperature and humidity, which needs no key, fetched in the
 * background per field and never inside a tool call. The heat index is the weather service's own formula,
 * the same one Sudor uses. What this does not know is anything about the people: not their age, not what
 * they take. That is Sudor's half. It is not advertised aloud; the structured answer names it for a screen.
 */

import { backoff } from './backoff.js';

export type HeatHour = { time: number; tempF: number; humidityPct: number };

export const INITIAL_F = 80;
export const HIGH_F = 90;
const STALE_MS = 6 * 60 * 60 * 1000;
const MAX_SITES = 2000;

/** The National Weather Service heat index, as published: the simple form averaged with the temperature, and the regression from 80. */
export function heatIndexF(tempF: number, humidityPct: number): number {
  const T = tempF;
  const R = Math.min(100, Math.max(0, humidityPct));
  const simple = 0.5 * (T + 61 + (T - 68) * 1.2 + R * 0.094);
  const averaged = (simple + T) / 2;
  if (averaged < 80) return Number(averaged.toFixed(1));
  let hi =
    -42.379 +
    2.04901523 * T +
    10.14333127 * R -
    0.22475541 * T * R -
    0.00683783 * T * T -
    0.05481717 * R * R +
    0.00122874 * T * T * R +
    0.00085282 * T * R * R -
    0.00000199 * T * T * R * R;
  if (R < 13 && T >= 80 && T <= 112) hi -= ((13 - R) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
  else if (R > 85 && T >= 80 && T <= 87) hi += ((R - 85) / 10) * ((87 - T) / 5);
  return Number(hi.toFixed(1));
}

type Entry = { hours: HeatHour[]; fetchedAt: number };
const sites = new Map<string, { lat: number; lon: number }>();
const held = new Map<string, Entry>();
// A tenth of a degree is about seven miles, which is closer than the forecast grid resolves.
const key = (lat: number, lon: number) => `${lat.toFixed(1)},${lon.toFixed(1)}`;

type Loader = (lat: number, lon: number) => Promise<HeatHour[] | null>;

async function fetchForecast(lat: number, lon: number): Promise<HeatHour[] | null> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}` +
    '&hourly=temperature_2m,relative_humidity_2m&temperature_unit=fahrenheit&forecast_days=4&timeformat=unixtime';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return parse((await res.json()) as unknown);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Rows with a missing or impossible value are left out, never read as zero. */
export function parse(body: unknown): HeatHour[] | null {
  const h = (body as { hourly?: { time?: unknown[]; temperature_2m?: unknown[]; relative_humidity_2m?: unknown[] } } | null)?.hourly;
  if (!h || !Array.isArray(h.time) || !Array.isArray(h.temperature_2m) || !Array.isArray(h.relative_humidity_2m)) return null;
  const out: HeatHour[] = [];
  for (let i = 0; i < h.time.length; i += 1) {
    const time = h.time[i];
    const tempF = h.temperature_2m[i];
    const humidityPct = h.relative_humidity_2m[i];
    if (typeof time !== 'number' || typeof tempF !== 'number' || typeof humidityPct !== 'number') continue;
    if (!Number.isFinite(tempF) || tempF < -130 || tempF > 140 || humidityPct < 0 || humidityPct > 100) continue;
    out.push({ time: time * 1000, tempF, humidityPct });
  }
  return out.length ? out : null;
}

let load: Loader = fetchForecast;
const gate = backoff();
let timer: ReturnType<typeof setInterval> | null = null;
let refreshing = false;

/** Note that a field wants this. The background poll picks it up, so registering stays instant. */
export function watch(lat: number, lon: number): void {
  if (sites.size < MAX_SITES) sites.set(key(lat, lon), { lat, lon });
}

export async function refresh(): Promise<void> {
  if (refreshing || !gate.ready()) return;
  refreshing = true;
  try {
    for (const [k, site] of sites) {
      const entry = held.get(k);
      if (entry && Date.now() - entry.fetchedAt < 50 * 60_000) continue;
      const hours = await load(site.lat, site.lon);
      if (hours) {
        held.set(k, { hours, fetchedAt: Date.now() });
        gate.ok();
      } else {
        gate.fail();
        // A feed that is down is down for every field. Stop, and keep what was known.
        if (!gate.ready()) break;
      }
    }
  } finally {
    refreshing = false;
  }
}

/** Hourly: the forecast it reads is itself updated about that often. */
export async function start(everyMs = 60 * 60_000): Promise<void> {
  await refresh();
  if (!timer) {
    timer = setInterval(() => void refresh(), everyMs);
    timer.unref?.();
    // A field added after boot should not wait an hour for its first forecast.
    const soon = setInterval(() => {
      if ([...sites.keys()].some((k) => !held.has(k))) void refresh();
    }, 60_000);
    soon.unref?.();
  }
}

export type CrewHeat = {
  peakF: number;
  peakAt: string;
  /** First hour at or past 80, and at or past 90, as ISO, or null when the stretch never gets there. */
  initialFrom: string | null;
  highFrom: string | null;
  level: 'initial' | 'high';
};

/**
 * The heat over a field for the hours a job would run, or null when it stays under 80 or is not known.
 * Unknown is never spoken as fine: nothing is said either way, and the structured answer says it was not checked.
 */
export function during(lat: number, lon: number, from: Date, hours: number, now = Date.now()): CrewHeat | null {
  const entry = held.get(key(lat, lon));
  if (!entry || now - entry.fetchedAt > STALE_MS) return null;
  const start = from.getTime() - 30 * 60_000;
  const end = from.getTime() + Math.max(1, hours) * 3_600_000;
  const span = entry.hours.filter((h) => h.time >= start && h.time < end).map((h) => ({ time: h.time, hi: heatIndexF(h.tempF, h.humidityPct) }));
  if (!span.length) return null;
  const peak = span.reduce((a, b) => (b.hi > a.hi ? b : a));
  if (peak.hi < INITIAL_F) return null;
  const first = (line: number) => span.find((h) => h.hi >= line);
  const iso = (t: number | undefined) => (t == null ? null : new Date(t).toISOString());
  const high = first(HIGH_F);
  return {
    peakF: Math.round(peak.hi),
    peakAt: new Date(peak.time).toISOString(),
    initialFrom: iso(first(INITIAL_F)?.time),
    highFrom: iso(high?.time),
    level: high ? 'high' : 'initial',
  };
}

/** Whether a forecast is held for this field at all, so an answer can say the crew's side was not checked. */
export function known(lat: number, lon: number, now = Date.now()): boolean {
  const entry = held.get(key(lat, lon));
  return !!entry && now - entry.fetchedAt <= STALE_MS;
}

/**
 * One sentence for whoever is sending the crew out. `say` turns an ISO time into the field's local time.
 */
export function sentence(heat: CrewHeat, say: (iso: string) => string): string {
  if (heat.level === 'high') {
    return (
      `For the crew, the heat index reaches ${heat.peakF} and is past 90 from ${say(heat.highFrom as string)}: ` +
      'that is a 15 minute break in the shade at least every two hours, and nobody working alone.'
    );
  }
  return `For the crew, the heat index reaches ${heat.peakF}, so water on the machine and somewhere shaded to stop.`;
}

export function status(): { sites: number; held: number } {
  return { sites: sites.size, held: held.size };
}

export function seedForTest(lat: number, lon: number, hours: HeatHour[], fetchedAt = Date.now()): void {
  sites.set(key(lat, lon), { lat, lon });
  held.set(key(lat, lon), { hours, fetchedAt });
}

export function configureForTest(fn: Loader | null): void {
  load = fn ?? fetchForecast;
}

export function resetForTest(): void {
  sites.clear();
  held.clear();
  gate.reset();
  load = fetchForecast;
  refreshing = false;
}
