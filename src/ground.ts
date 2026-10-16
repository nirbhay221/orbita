/**
 * Two NOAA maps that answer "what is it doing where I am", for the people the playbook used to answer by storm level.
 *
 * playbook.ts says what a G3 does to a grid in general. A grid room, a pipeline crew and a railway care what it is
 * doing to their patch of ground, and a radio operator cares which frequencies are dead over their station. NOAA
 * publishes both, free and with no key, and Orbita was not reading either.
 *
 * D-RAP, the D region absorption prediction. A text grid, 2 degrees of latitude by 4 of longitude, of the highest
 * frequency losing at least 1 dB to absorption from solar X-rays or energetic protons. Anything below that number
 * is being eaten; above it is clear. The header carries NOAA's own estimate of when it recovers.
 *   https://www.spaceweather.gov/products/d-region-absorption-predictions-d-rap
 *
 * The geoelectric field, once a minute, in millivolts per kilometre, over the lower 48 and Canada up to 60 degrees.
 * Two models: a 1D one everywhere, and an empirical 3D one built from magnetotelluric surveys where those exist,
 * which NOAA recommends wherever it covers. This is the field that drives current into long conductors: power
 * lines, pipelines, rails. NOAA gives no line for when it matters and asks for caution in using the maps for
 * operational mitigation, so this never calls a number dangerous. It says the number, and next to it the one
 * published reference point there is: NERC TPL-007's once in a hundred years benchmark, 8 volts per kilometre at
 * its reference site.
 *   https://www.spaceweather.gov/products/geoelectric-field-models-1-minute
 *
 * Like every feed here, a timer reads them and a tool call never does, and every accessor returns null rather than a
 * default when there is nothing fresh, so "no data" is never mistaken for "nothing happening".
 */

import { backoff } from './backoff.js';

const BASE = 'https://services.swpc.noaa.gov';
const DRAP = '/text/drap_global_frequencies.txt';
const EFIELD_DIR = '/json/lists/rgeojson/';
const STALE_MS = 60 * 60 * 1000;

export type Absorption = {
  /** Highest frequency losing 1 dB or more at this spot, MHz. 0 means none. */
  mhz: number;
  /** The worst anywhere on the map, and where. */
  worst: { mhz: number; lat: number; lon: number };
  /** NOAA's estimate of recovery, as written, or null when it gives none. */
  recovery: string | null;
  /** NOAA's X-ray and proton messages, as written. */
  xray: string;
  protons: string;
  at: string;
};

export type Efield = {
  /** Field strength at the nearest grid point, mV/km. */
  mvPerKm: number;
  model: '3D empirical' | '1D';
  /** How far the grid point is from the site, km. */
  km: number;
  /** The strongest anywhere on the 1D map. */
  worst: number;
  at: string;
};

type Grid = { lats: number[]; lons: number[]; mhz: number[][] };
type Points = { at: string; pts: Float64Array }; // lon, lat, magnitude, repeated

type State = {
  drap: { grid: Grid; recovery: string | null; xray: string; protons: string; at: string } | null;
  oneD: Points | null;
  threeD: Points | null;
  fetchedAt: number;
};

let state: State = { drap: null, oneD: null, threeD: null, fetchedAt: 0 };
let timer: ReturnType<typeof setInterval> | null = null;
const gate = backoff();

async function get(path: string, timeoutMs = 15_000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

const header = (text: string, label: string): string =>
  new RegExp(`^#\\s*${label}\\s*:\\s*(.*)$`, 'm').exec(text)?.[1].trim() ?? '';

export function parseDrap(text: string): State['drap'] {
  const lines = text.split(/\r?\n/);
  const head = lines.find((l) => /^\s+-?\d+(\s+-?\d+){10,}\s*$/.test(l));
  if (!head) return null;
  const lons = head.trim().split(/\s+/).map(Number);
  const lats: number[] = [];
  const mhz: number[][] = [];
  for (const l of lines) {
    const m = /^\s*(-?\d+)\s*\|\s*(.*)$/.exec(l);
    if (!m) continue;
    const row = m[2].trim().split(/\s+/).map(Number);
    if (row.length !== lons.length || row.some((v) => !Number.isFinite(v))) continue;
    lats.push(Number(m[1]));
    mhz.push(row);
  }
  if (lats.length < 20) return null;
  const recovery = header(text, 'Estimated Recovery Time');
  return {
    grid: { lats, lons, mhz },
    recovery: recovery && !/no estimate/i.test(recovery) ? recovery : null,
    xray: header(text, 'X-RAY Message'),
    protons: header(text, 'Proton Message'),
    at: header(text, 'Product Valid At'),
  };
}

export function parseEfield(raw: unknown): Points | null {
  const j = raw as { time_tag?: string; features?: { geometry?: { coordinates?: number[] }; properties?: { Ex?: number; Ey?: number } }[] };
  const fs = j?.features ?? [];
  const out: number[] = [];
  for (const f of fs) {
    const [lon, lat] = f.geometry?.coordinates ?? [];
    const { Ex, Ey } = f.properties ?? {};
    if (![lon, lat, Ex, Ey].every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
    out.push(lon as number, lat as number, Math.hypot(Ex as number, Ey as number));
  }
  return out.length >= 300 ? { at: String(j.time_tag ?? ''), pts: Float64Array.from(out) } : null;
}

/** The newest file of each model in NOAA's directory listing. */
export function newestFiles(listing: string): { oneD: string | null; threeD: string | null } {
  const names = [...listing.matchAll(/href="([^"]+\.json)"/g)].map((m) => m[1]).sort();
  const last = (re: RegExp) => names.filter((n) => re.test(n)).pop() ?? null;
  return { oneD: last(/Efield-US-Canada\.json$/), threeD: last(/Efield-empirical-EMTF/) };
}

export async function refresh(): Promise<void> {
  if (!gate.ready()) return;
  const [drapR, oneDirR, threeDirR] = await Promise.allSettled([
    get(DRAP),
    get(`${EFIELD_DIR}US-Canada-1D/`),
    get(`${EFIELD_DIR}InterMagEarthScope/`),
  ]);
  const drap = drapR.status === 'fulfilled' ? parseDrap(drapR.value) : null;
  const pick = async (dir: string, r: PromiseSettledResult<string>, which: 'oneD' | 'threeD') => {
    if (r.status !== 'fulfilled') return null;
    const name = newestFiles(r.value)[which];
    if (!name) return null;
    try {
      return parseEfield(JSON.parse(await get(`${EFIELD_DIR}${dir}/${name}`)));
    } catch {
      return null;
    }
  };
  const [oneD, threeD] = await Promise.all([
    pick('US-Canada-1D', oneDirR, 'oneD'),
    pick('InterMagEarthScope', threeDirR, 'threeD'),
  ]);
  const any = drap || oneD || threeD;
  state = {
    drap: drap ?? state.drap,
    oneD: oneD ?? state.oneD,
    threeD: threeD ?? state.threeD,
    fetchedAt: any ? Date.now() : state.fetchedAt,
  };
  if (any) gate.ok();
  else gate.fail();
}

const fresh = () => state.fetchedAt > 0 && Date.now() - state.fetchedAt < STALE_MS;
const nearestIndex = (xs: number[], x: number) => xs.reduce((best, v, i) => (Math.abs(v - x) < Math.abs(xs[best] - x) ? i : best), 0);
const wrap = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

/** Absorption over a spot right now, or null when the map is not loaded. */
export function absorption(lat: number, lon: number): Absorption | null {
  const d = fresh() ? state.drap : null;
  if (!d) return null;
  const { lats, lons, mhz } = d.grid;
  const here = mhz[nearestIndex(lats, lat)][nearestIndex(lons, wrap(lon))];
  let worst = { mhz: 0, lat: 0, lon: 0 };
  mhz.forEach((row, i) => row.forEach((v, j) => { if (v > worst.mhz) worst = { mhz: v, lat: lats[i], lon: lons[j] }; }));
  return { mhz: here, worst, recovery: d.recovery, xray: d.xray, protons: d.protons, at: d.at };
}

function nearestPoint(p: Points, lat: number, lon: number): { v: number; km: number } {
  let best = Infinity, v = 0;
  const cos = Math.cos((lat * Math.PI) / 180);
  for (let i = 0; i < p.pts.length; i += 3) {
    const dx = (p.pts[i] - lon) * cos, dy = p.pts[i + 1] - lat;
    const d = dx * dx + dy * dy;
    if (d < best) { best = d; v = p.pts[i + 2]; }
  }
  return { v, km: Math.round(Math.sqrt(best) * 111) };
}

/** Within this the nearest grid point is a reading for the site; the grids are half a degree. */
const GRID_KM = 60;

/** The modelled ground electric field at a site, or null outside the map or when it is not loaded. */
export function efield(lat: number, lon: number): Efield | null {
  if (!fresh() || !state.oneD) return null;
  const three = state.threeD ? nearestPoint(state.threeD, lat, lon) : null;
  const one = nearestPoint(state.oneD, lat, lon);
  const use = three && three.km <= GRID_KM ? { ...three, model: '3D empirical' as const } : { ...one, model: '1D' as const };
  if (use.km > GRID_KM) return null;
  let worst = 0;
  for (let i = 2; i < state.oneD.pts.length; i += 3) worst = Math.max(worst, state.oneD.pts[i]);
  return { mvPerKm: Math.round(use.v * 10) / 10, model: use.model, km: use.km, worst: Math.round(worst), at: state.oneD.at };
}

/**
 * On a quiet day the field is a few millivolts everywhere, and reading that out is noise. Above this, or whenever a
 * storm phase is on, it is said; it is always in the data. A floor for speech, not a line for harm.
 */
export const SAY_FROM_MV = 100;

/** The once in a hundred years benchmark NERC TPL-007 plans for, at its reference site, mV/km. */
export const NERC_BENCHMARK_MV = 8000;

const fieldWords = (mv: number) =>
  mv >= 1000 ? `${(mv / 1000).toFixed(1)} volts per kilometre` : `${Math.round(mv)} millivolts per kilometre`;

/** For anyone with a long conductor in the ground or on poles. */
export function sayEfield(e: Efield): string {
  return (
    `NOAA's model puts the ground electric field near you at ${fieldWords(e.mvPerKm)} right now. ` +
    "NERC's once in a hundred years planning case is 8 volts per kilometre at its reference site. It is a model, " +
    'and NOAA asks for caution in acting on it alone.'
  );
}

/**
 * Below this the map is showing the ordinary daytime absorption at the bottom of the band, which every HF operator
 * already works with. NOAA's own map scale starts here.
 */
export const SAY_FROM_MHZ = 5;

/** For anyone on HF. Says nothing over a spot with no real absorption, unless a flare or proton event is running. */
export function sayAbsorption(a: Absorption): string {
  const event = !/normal/i.test(a.xray) || !/normal/i.test(a.protons);
  const recovery = a.recovery ? ` NOAA expects recovery in ${a.recovery}.` : '';
  if (a.mhz >= SAY_FROM_MHZ) {
    return `NOAA's absorption map has frequencies up to ${a.mhz.toFixed(0)} megahertz losing signal over you right now, so work above that.${recovery}`;
  }
  if (event && a.worst.mhz >= SAY_FROM_MHZ) {
    return `Nothing is being absorbed over you right now. The worst is up to ${a.worst.mhz.toFixed(0)} megahertz near ${Math.abs(a.worst.lat)} degrees ${a.worst.lat >= 0 ? 'north' : 'south'}.${recovery}`;
  }
  return '';
}

export async function start(everyMs = 15 * 60_000): Promise<void> {
  await refresh();
  if (!timer) {
    timer = setInterval(() => void refresh(), everyMs);
    timer.unref?.();
  }
}

export function stop(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

export function ageMinutes(): number | null {
  return state.fetchedAt ? Math.round((Date.now() - state.fetchedAt) / 60000) : null;
}

export function seedForTest(next: { drapText?: string; oneD?: unknown; threeD?: unknown; fetchedAt?: number }): void {
  state = {
    drap: next.drapText ? parseDrap(next.drapText) : state.drap,
    oneD: next.oneD ? parseEfield(next.oneD) : state.oneD,
    threeD: next.threeD ? parseEfield(next.threeD) : state.threeD,
    fetchedAt: next.fetchedAt ?? Date.now(),
  };
}

export function resetForTest(): void {
  gate.reset();
  state = { drap: null, oneD: null, threeD: null, fetchedAt: 0 };
}
