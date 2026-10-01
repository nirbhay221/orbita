/**
 * The thing that actually breaks the fix.
 *
 * Everything upstream of this file reasons about storms through Kp: a planetary
 * index, published in three hour blocks, that Orbita converts into an expected
 * positional error through a table built from what operators reported during
 * past storms. That table has served well, and it is still what answers when
 * this module has nothing. But it is a correlation, and the thing it correlates
 * with is not the thing that moves the tractor.
 *
 * What moves the tractor is electrons. A GNSS signal crossing the ionosphere is
 * delayed in proportion to the total electron content along its path, and at the
 * L1 carrier that delay works out at about 16 centimetres per TEC unit. NOAA's
 * GloTEC assimilates real observations into a global map of exactly that
 * quantity, on a 5 by 2.5 degree grid, every ten minutes, free and without a
 * key. So the number Orbita has been inferring can instead be measured.
 *
 * The important part is not absolute TEC. It is the gradient.
 *
 * RTK does not care how much ionosphere there is. It cancels the ionosphere by
 * differencing a rover against a base station, and that cancellation rests on
 * one assumption: that the sky over the base and the sky over the rover are the
 * same. What a storm does is make them different. The residual left behind after
 * differencing is the TEC difference across the baseline, which is the spatial
 * gradient multiplied by the baseline length. That is why RTK "degrades hardest
 * in a storm" and why long baselines lose it first, which the README has always
 * asserted and can now compute:
 *
 *   residual metres = |grad TEC| (TECU/km) x baseline (km) x 0.1624 (m/TECU)
 *
 * Orbita already records `baselineKm` on every registered field. This turns that
 * field from documentation into an input.
 *
 * Two honest limits, because they bound what this can claim.
 *
 * The grid is coarse. Five degrees of longitude is about 400 km at Nebraska's
 * latitude, so a gradient computed across it is a regional slope and not the
 * small-scale structure that actually causes cycle slips. Scintillation, the
 * fast fading that breaks carrier tracking outright, lives well below this
 * resolution and is not visible here at all. This is a floor on the error, not a
 * ceiling.
 *
 * And the map carries a per-cell quality flag. Zero means the assimilation had
 * real observations there; anything else means it is leaning on climatology. A
 * gradient computed across cells that are themselves modelled is not a
 * measurement, and is reported as such rather than quietly averaged in.
 *
 * Source: NOAA SWPC GloTEC, https://services.swpc.noaa.gov/products/glotec/
 */

const INDEX = 'https://services.swpc.noaa.gov/products/glotec/geojson_2d_urt.json';
const HOST = 'https://services.swpc.noaa.gov';

/**
 * Metres of L1 range delay per TEC unit.
 *
 * The ionospheric group delay is 40.308 * TEC / f^2 metres with TEC in
 * electrons per square metre. One TECU is 1e16 of those, and L1 is 1575.42 MHz,
 * which gives 40.308e16 / (1575.42e6)^2 = 0.1624 m.
 */
const METRES_PER_TECU = 0.1624;

/** Grid geometry, confirmed against the live product. */
const LON_STEP = 5.0;
const LAT_STEP = 2.5;

/** Kilometres per degree of latitude. */
const KM_PER_DEG_LAT = 111.132;

/** The map is published every ten minutes; older than this is not "now". */
const STALE_MS = 40 * 60 * 1000;

/**
 * Quality flags, from the product. 0 means the assimilation had observations in
 * that cell. Everything else means some degree of falling back on a model, and
 * this module will report a reading built from those cells but will not let it
 * override the Kp-based answer.
 */
const QUALITY_OBSERVED = 0;

export type Ionosphere = {
  /** Total electron content over the site, TECU, bilinearly interpolated. */
  tec: number;
  /** How far that sits from quiet-time climatology, as the product reports it. */
  anomaly: number;
  /** Magnitude of the horizontal TEC gradient, TECU per kilometre. */
  gradient: number;
  /** Compass bearing of steepest increase, degrees from true north. */
  bearing: number;
  /** Vertical L1 delay implied by the absolute TEC, metres. */
  verticalDelay: number;
  /** Worst quality flag among the cells the answer was built from. */
  quality: number;
  /** True when every cell used had real observations behind it. */
  observed: boolean;
  /** Timestamp of the map. */
  at: string;
};

type Cell = { tec: number; anomaly: number; quality: number };

/** The whole grid, 5184 small records, keyed by rounded lat/lon. */
let grid = new Map<string, Cell>();
let mapTime = '';
let fetchedAt = 0;
let lastError = '';
let timer: ReturnType<typeof setInterval> | null = null;

/** Sites that have asked, so /health can say whether anyone is using this. */
const sites = new Set<string>();

/** Test seam. */
let load: () => Promise<{ cells: Map<string, Cell>; at: string } | null> = fetchLatest;

const key = (lat: number, lon: number) => `${lat.toFixed(2)},${lon.toFixed(2)}`;

/** Snap a coordinate to the grid cell centre at or below it. */
function floorTo(value: number, step: number, offset: number): number {
  return Math.floor((value - offset) / step) * step + offset;
}

/** Longitude wrapped into [-180, 180). */
function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

function cellAt(lat: number, lon: number): Cell | undefined {
  const clamped = Math.max(-88.75, Math.min(88.75, lat));
  return grid.get(key(clamped, wrapLon(lon)));
}

/**
 * TEC at an arbitrary point, bilinear between the four surrounding centres.
 *
 * Returns the four cells used alongside the value, because the caller has to
 * know whether any of them were modelled rather than observed.
 */
function sample(lat: number, lon: number): { tec: number; anomaly: number; quality: number } | null {
  const lat0 = floorTo(Math.max(-88.75, Math.min(88.74, lat)), LAT_STEP, -88.75);
  const lon0 = floorTo(wrapLon(lon), LON_STEP, -177.5);
  const lat1 = Math.min(88.75, lat0 + LAT_STEP);
  const lon1 = wrapLon(lon0 + LON_STEP);

  const c00 = cellAt(lat0, lon0);
  const c01 = cellAt(lat0, lon1);
  const c10 = cellAt(lat1, lon0);
  const c11 = cellAt(lat1, lon1);
  if (!c00 || !c01 || !c10 || !c11) return null;

  const fLat = lat1 === lat0 ? 0 : (Math.max(-88.75, Math.min(88.75, lat)) - lat0) / LAT_STEP;
  let dLon = wrapLon(lon) - lon0;
  if (dLon < 0) dLon += 360;
  const fLon = Math.min(1, dLon / LON_STEP);

  const mix = (a: number, b: number, c: number, d: number) =>
    a * (1 - fLat) * (1 - fLon) + b * (1 - fLat) * fLon + c * fLat * (1 - fLon) + d * fLat * fLon;

  return {
    tec: mix(c00.tec, c01.tec, c10.tec, c11.tec),
    anomaly: mix(c00.anomaly, c01.anomaly, c10.anomaly, c11.anomaly),
    quality: Math.max(c00.quality, c01.quality, c10.quality, c11.quality),
  };
}

/**
 * The horizontal TEC gradient at a site, by central difference on the grid.
 *
 * North-south and east-west are converted to kilometres separately, because a
 * degree of longitude is a different distance at every latitude and treating
 * them as equal would exaggerate the gradient near the poles by a factor of
 * three or more.
 */
function gradientAt(lat: number, lon: number): { gradient: number; bearing: number } | null {
  const north = sample(lat + LAT_STEP, lon);
  const south = sample(lat - LAT_STEP, lon);
  const east = sample(lat, lon + LON_STEP);
  const west = sample(lat, lon - LON_STEP);
  if (!north || !south || !east || !west) return null;

  const kmLat = 2 * LAT_STEP * KM_PER_DEG_LAT;
  const kmLon = 2 * LON_STEP * KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  if (kmLon < 1) return null; // within a degree of the pole, east-west is meaningless

  const dN = (north.tec - south.tec) / kmLat;
  const dE = (east.tec - west.tec) / kmLon;

  const gradient = Math.hypot(dN, dE);
  const bearing = (((Math.atan2(dE, dN) * 180) / Math.PI) + 360) % 360;
  return { gradient, bearing };
}

/** Note that a site wants this, for /health and for future pre-fetching. */
export function watch(lat: number, lon: number): void {
  // Only counted for /health, but a caller can invent coordinates without end.
  if (sites.size < 5000) sites.add(key(lat, lon));
}

/** The ionosphere over a site, or nothing if the map is missing or stale. */
export function ionosphere(lat: number, lon: number): Ionosphere | null {
  if (!grid.size) return null;
  if (Date.now() - fetchedAt > STALE_MS) return null;

  const point = sample(lat, lon);
  const grad = gradientAt(lat, lon);
  if (!point || !grad) return null;

  return {
    tec: Math.round(point.tec * 100) / 100,
    anomaly: Math.round(point.anomaly * 100) / 100,
    gradient: Math.round(grad.gradient * 1e5) / 1e5,
    bearing: Math.round(grad.bearing),
    verticalDelay: Math.round(point.tec * METRES_PER_TECU * 100) / 100,
    quality: point.quality,
    observed: point.quality === QUALITY_OBSERVED,
    at: mapTime,
  };
}

/**
 * The part of a differential fix the ionosphere will not let the base cancel.
 *
 * This is the whole point of the module. An RTK or network correction removes
 * the ionosphere only to the extent that it is the same over the base and the
 * rover, so what survives is the TEC difference across the baseline. A metre
 * here is a metre of real, unmodelled error, which is why a 2 inch planting
 * tolerance and a 30 km baseline are not always compatible.
 *
 * Returns nothing rather than zero when there is no map, so a caller can tell
 * "no data" from "no problem".
 */
export function residual(lat: number, lon: number, baselineKm: number): number | null {
  const iono = ionosphere(lat, lon);
  if (!iono || !Number.isFinite(baselineKm) || baselineKm <= 0) return null;
  return iono.gradient * baselineKm * METRES_PER_TECU;
}

/**
 * What to say about it, or nothing.
 *
 * Deliberately narrow. This never contradicts the Kp answer on its own, because
 * a coarse grid cannot see the small-scale structure that does much of the
 * damage, and a quiet gradient is therefore not evidence of a quiet sky. It
 * speaks when the measurement adds something the table could not know: that this
 * particular baseline is carrying a residual the job cannot absorb.
 */
export function explain(lat: number, lon: number, baselineKm: number | undefined, toleranceM: number): string {
  if (!baselineKm) return '';
  const iono = ionosphere(lat, lon);
  const r = residual(lat, lon, baselineKm);
  if (!iono || r == null) return '';

  const hedge = iono.observed ? '' : ' That cell is running on climatology rather than observations, so treat it as indicative.';

  if (r > toleranceM) {
    return (
      `Measured rather than forecast: the electron content across your ${Math.round(baselineKm)} km baseline is ` +
      `sloping at ${(iono.gradient * 1000).toFixed(1)} TECU per thousand kilometres, which leaves about ` +
      `${r < 1 ? `${Math.round(r * 100)} centimetres` : `${r.toFixed(1)} metres`} your base station cannot correct away. ` +
      `That alone is past the ${toleranceM < 1 ? `${Math.round(toleranceM * 100)} centimetre` : `${toleranceM} metre`} ` +
      `tolerance for this job.${hedge}`
    );
  }

  if (Math.abs(iono.anomaly) > 0.5 && r > toleranceM / 2) {
    return (
      `The ionosphere over you is ${iono.anomaly > 0 ? 'denser' : 'thinner'} than normal and the slope across your ` +
      `baseline is leaving roughly ${Math.round(r * 100)} centimetres uncorrected, which is over half your margin.` +
      `${hedge}`
    );
  }

  return '';
}

const DIR = '/products/glotec/geojson_2d_urt/';

/**
 * Read the tail of the index to find the newest map, without pulling 500 KB.
 *
 * The index is append-only and the server honours Range, so the last kilobyte
 * is normally all that is ever needed.
 *
 * It is not always enough. NOAA rotates this index, and while it does the file
 * is served as a literal empty array with the data files all still present and
 * current: 2 bytes of index against four thousand intact maps. Observed live.
 * Trusting the index alone would take the ionosphere offline for the length of
 * that rotation and, worse, would do it silently, because an empty index is a
 * 200 and parses cleanly. So when the index has nothing, the directory listing
 * is read instead, which is the thing the index is a summary of.
 */
async function latestUrl(): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(INDEX, { headers: { Range: 'bytes=-1024' }, signal: ctrl.signal });
    if (!res.ok && res.status !== 206) throw new Error(`index ${res.status}`);
    const tail = await res.text();
    const urls = [...tail.matchAll(/"url":\s*"([^"]+)"/g)].map((m) => m[1]);
    if (urls.length) return urls[urls.length - 1];
  } finally {
    clearTimeout(t);
  }
  return latestFromListing();
}

/** Fallback: the newest file the directory itself admits to having. */
async function latestFromListing(): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(`${HOST}${DIR}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`listing ${res.status}`);
    const html = await res.text();
    const names = [...html.matchAll(/glotec_icao_(\d{8}T\d{6}Z)\.geojson/g)].map((m) => m[0]);
    if (!names.length) throw new Error('index empty and listing has no maps');
    // Lexical order is chronological for this timestamp format.
    names.sort();
    return `${DIR}${names[names.length - 1]}`;
  } finally {
    clearTimeout(t);
  }
}

async function fetchLatest(): Promise<{ cells: Map<string, Cell>; at: string } | null> {
  const url = await latestUrl();
  if (!url) return null;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch(`${HOST}${url}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`map ${res.status}`);
    const body = (await res.json()) as {
      time_tag?: string;
      features?: { geometry?: { coordinates?: number[] }; properties?: Record<string, number> }[];
    };
    const cells = new Map<string, Cell>();
    for (const f of body.features ?? []) {
      const c = f.geometry?.coordinates;
      const p = f.properties;
      if (!c || c.length < 2 || !p || typeof p.tec !== 'number') continue;
      cells.set(key(c[1], c[0]), {
        tec: p.tec,
        anomaly: typeof p.anomaly === 'number' ? p.anomaly : 0,
        quality: typeof p.quality_flag === 'number' ? p.quality_flag : 9,
      });
    }
    // The parsed body is 2.5 MB and is dropped here; only the 5184 small
    // records survive, which is a few hundred kilobytes.
    return cells.size ? { cells, at: body.time_tag ?? '' } : null;
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
      mapTime = next.at;
      fetchedAt = Date.now();
      lastError = '';
      gate.ok();
    } else {
      gate.fail();
      // Nothing thrown and nothing returned. Record it, because a silent
      // nothing here is indistinguishable from a quiet ionosphere.
      lastError = 'no map available';
    }
  } catch (err) {
    // Keep the previous map and let it age out. The Kp path is unaffected, so a
    // failure here costs the measured refinement and nothing else.
    lastError = String(err);
    gate.fail();
  }
}

/**
 * Poll on a timer, never inside a tool call.
 *
 * Twelve minutes against a ten minute product: slightly slower than the source
 * so a run of polls does not sit in lockstep with publication and fetch the same
 * map twice, and because each pull is 2.5 MB and this runs on a small instance.
 */
export async function start(everyMs = 12 * 60_000): Promise<void> {
  await refresh();
  if (!timer) {
    timer = setInterval(() => void refresh(), everyMs);
    timer.unref?.();
  }
}

export function stop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function ageMinutes(): number | null {
  return fetchedAt ? Math.round((Date.now() - fetchedAt) / 60000) : null;
}

/** For /health: grid size, map time, and whether the last pull failed. */
export function status(): { cells: number; at: string; ageMinutes: number | null; sites: number; error?: string } {
  return {
    cells: grid.size,
    at: mapTime,
    ageMinutes: ageMinutes(),
    sites: sites.size,
    ...(lastError ? { error: lastError } : {}),
  };
}

/** Test seam: a fake loader, or a grid seeded directly. */
export function seedForTest(next: {
  load?: () => Promise<{ cells: Map<string, Cell>; at: string } | null>;
  cells?: [number, number, Cell][];
  at?: string;
}): void {
  if (next.load) load = next.load;
  if (next.cells) {
    grid = new Map(next.cells.map(([la, lo, c]) => [key(la, lo), c]));
    mapTime = next.at ?? new Date().toISOString();
    fetchedAt = Date.now();
  }
}

export function resetForTest(): void {
  gate.reset();
  grid = new Map();
  mapTime = '';
  fetchedAt = 0;
  lastError = '';
  sites.clear();
  load = fetchLatest;
}

/** Exposed so a test can assert the constant rather than copy it. */
export const constants = { METRES_PER_TECU, LON_STEP, LAT_STEP };
