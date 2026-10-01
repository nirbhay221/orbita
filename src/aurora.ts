/**
 * Where the oval actually is, rather than where a straight line says it is.
 *
 * `auroralBoundaryDeg` in domain.ts puts the equatorward edge at 66.5
 * geomagnetic degrees at Kp 0 and walks it two degrees equatorward per Kp step.
 * That is a reasonable first approximation and it is the one the README
 * describes, but it is a straight line through a thing that is not straight.
 *
 * The real oval is not a circle centred on the geomagnetic pole, and it is not
 * the same width all the way round. It is offset towards the night side, which
 * means the same site at the same Kp is inside it at 2am and outside it at 2pm.
 * It also expands and contracts faster than the three hour Kp cadence can
 * express. A linear rule cannot represent any of that, and the case it gets
 * worst is exactly the case that matters: the sudden equatorward expansion
 * during a substorm, which is what put auroral precipitation over Florida in
 * November 2025 and GPS error over ten metres with it.
 *
 * NOAA's OVATION Prime model publishes the whole thing: an aurora probability
 * for every one degree cell on Earth, forecast about half an hour ahead, free
 * and without a key. That is the measurement this file substitutes for the line.
 *
 * The linear rule stays. It is the fallback when this feed is missing, and it is
 * still what the three day forecast has to use, because OVATION only publishes a
 * nowcast. So Orbita now answers from the model when the model is current and
 * from the approximation when it is not, and says which.
 *
 * Source: NOAA SWPC OVATION Prime aurora forecast,
 * https://services.swpc.noaa.gov/json/ovation_aurora_latest.json
 */

const URL = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';

/** The forecast is for roughly half an hour out; past this it is not a nowcast. */
const STALE_MS = 90 * 60 * 1000;

/**
 * Probability thresholds, percent.
 *
 * OVATION's value is the chance of visible aurora overhead. For Orbita the
 * interest is not the view, it is the precipitation: where electrons are coming
 * down into the ionosphere, the ionosphere is disturbed and GNSS corrections
 * degrade. A few percent is enough to mean "the oval is over you", which is why
 * the first threshold is low.
 */
const OVERHEAD = 3;
const STRONG = 20;

export type Aurora = {
  /** Chance of visible aurora at this site, percent, from the model. */
  probability: number;
  /** The highest probability found within 5 degrees, which is the oval nearby. */
  nearby: number;
  /** Degrees of latitude to the nearest cell at or above OVERHEAD, if any. */
  distanceDeg: number | null;
  /** True when the oval is over the site itself. */
  overhead: boolean;
  observedAt: string;
  forecastFor: string;
};

/** lon 0..359 and lat -90..90 packed into one integer key. */
const packed = (lon: number, lat: number) => (lon + 180) * 1000 + (lat + 90);

let grid = new Map<number, number>();
let observedAt = '';
let forecastFor = '';
let fetchedAt = 0;
let lastError = '';
let timer: ReturnType<typeof setInterval> | null = null;

let load: () => Promise<{ cells: Map<number, number>; observed: string; forecast: string } | null> = fetchOvation;

const wrapLon = (lon: number) => ((Math.round(lon) % 360) + 360) % 360;
const clampLat = (lat: number) => Math.max(-90, Math.min(90, Math.round(lat)));

function probabilityAt(lat: number, lon: number): number | null {
  const v = grid.get(packed(wrapLon(lon) - 180, clampLat(lat)));
  return v === undefined ? null : v;
}

/** The model's view of a site, or nothing when the feed is missing or stale. */
export function aurora(lat: number, lon: number): Aurora | null {
  if (!grid.size || Date.now() - fetchedAt > STALE_MS) return null;
  const here = probabilityAt(lat, lon);
  if (here === null) return null;

  // Look poleward and equatorward for the nearest cell the oval has reached.
  // Five degrees is about 550 km, which is the scale over which "the oval is
  // near you" stops being a useful thing to say.
  let nearby = here;
  let distance: number | null = here >= OVERHEAD ? 0 : null;
  for (let d = 1; d <= 5; d += 1) {
    for (const sign of [1, -1]) {
      const p = probabilityAt(lat + sign * d, lon);
      if (p === null) continue;
      if (p > nearby) nearby = p;
      if (distance === null && p >= OVERHEAD) distance = d;
    }
  }

  return {
    probability: here,
    nearby,
    distanceDeg: distance,
    overhead: here >= OVERHEAD,
    observedAt,
    forecastFor,
  };
}

/**
 * What the model says about a site, when it is worth saying.
 *
 * Kept to the two cases the linear rule gets wrong: the oval being overhead when
 * the Kp rule says it should not be, and the oval sitting just poleward and
 * moving, which is the hour before a field starts wandering.
 */
export function explain(lat: number, lon: number, boundaryMargin: number): string {
  const a = aurora(lat, lon);
  if (!a) return '';

  if (a.probability >= STRONG) {
    return (
      `The aurora model puts precipitation directly over you, ${a.probability} percent, forecast for ` +
      `${a.forecastFor.slice(11, 16)} UTC. That is the oval on top of the field, not near it, and it is ` +
      'where corrections degrade fastest.'
    );
  }

  // The interesting disagreement: the Kp rule says the site is clear of the
  // oval, and the model says otherwise.
  if (a.overhead && boundaryMargin > 0) {
    return (
      `Worth knowing: the Kp rule puts you ${Math.round(boundaryMargin)} degrees clear of the oval, but the ` +
      `aurora model has precipitation over you at ${a.probability} percent. The oval is offset towards the ` +
      'night side, so the planetary number can be clear while your longitude is not.'
    );
  }

  if (!a.overhead && a.distanceDeg !== null && a.distanceDeg <= 3 && a.nearby >= STRONG) {
    return (
      `The oval's edge is about ${a.distanceDeg} degrees poleward of you and running at ${a.nearby} percent. ` +
      'It expands equatorward when a substorm fires, so this can reach you inside the hour.'
    );
  }

  return '';
}

async function fetchOvation(): Promise<{ cells: Map<number, number>; observed: string; forecast: string } | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`ovation ${res.status}`);
    const body = (await res.json()) as {
      coordinates?: [number, number, number][];
      'Observation Time'?: string;
      'Forecast Time'?: string;
    };
    const rows = body.coordinates ?? [];
    if (!rows.length) return null;
    const cells = new Map<number, number>();
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 3) continue;
      // Published longitude runs 0..359; stored shifted so the key matches the
      // -180..180 the rest of Orbita uses.
      cells.set(packed(wrapLon(row[0]) - 180, clampLat(row[1])), row[2]);
    }
    return {
      cells,
      observed: String(body['Observation Time'] ?? ''),
      forecast: String(body['Forecast Time'] ?? ''),
    };
  } finally {
    clearTimeout(t);
  }
}


/** After a run of failures, stop asking a server that is not answering. See backoff.ts. */
import { backoff } from './backoff.js';

const gate = backoff();

export async function refresh(): Promise<void> {
  if (!gate.ready()) return;
  try {
    const next = await load();
    if (next) {
      grid = next.cells;
      observedAt = next.observed;
      forecastFor = next.forecast;
      fetchedAt = Date.now();
      lastError = '';
      gate.ok();
    } else {
      gate.fail();
    }
  } catch (err) {
    // The linear boundary rule in domain.ts still answers, so a failure here
    // costs the refinement and not the verdict.
    lastError = String(err);
    gate.fail();
  }
}

/** Five minutes; the model republishes about that often and the payload is ~1 MB. */
export async function start(everyMs = 5 * 60_000): Promise<void> {
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
  return fetchedAt ? Math.round((Date.now() - fetchedAt) / 60000) : null;
}

export function status(): Record<string, unknown> {
  return {
    cells: grid.size,
    forecastFor,
    ageMinutes: ageMinutes(),
    ...(lastError ? { error: lastError } : {}),
  };
}

export function seedForTest(next: {
  load?: () => Promise<{ cells: Map<number, number>; observed: string; forecast: string } | null>;
  cells?: [number, number, number][];
  forecast?: string;
}): void {
  if (next.load) load = next.load;
  if (next.cells) {
    grid = new Map(next.cells.map(([lo, la, p]) => [packed(wrapLon(lo) - 180, clampLat(la)), p]));
    observedAt = new Date().toISOString();
    forecastFor = next.forecast ?? new Date().toISOString();
    fetchedAt = Date.now();
  }
}

export function resetForTest(): void {
  gate.reset();
  grid = new Map();
  observedAt = '';
  forecastFor = '';
  fetchedAt = 0;
  lastError = '';
  load = fetchOvation;
}

export const thresholds = { OVERHEAD, STRONG };
