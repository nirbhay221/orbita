/**
 * The rest of what NOAA publishes.
 *
 * Orbita began by reading four SWPC endpoints: the three hour Kp forecast, the
 * scales, and two solar wind summaries. That was enough to answer the question
 * it was built for, and it left most of the catalogue unread. Several of the
 * feeds it was not reading are written for people Orbita already claims to
 * serve, which is a poor position to defend.
 *
 * What is added here, and who each one is for.
 *
 * `Dst` is the ring current, measured, once a minute. It is the global companion
 * to the local magnetometer depression in geomag.ts, and the pair is more useful
 * than either: a deep Dst with a quiet local field means the storm is real but
 * has not reached this longitude, and a shallow Dst with a violent local field
 * means a substorm overhead rather than a global storm. Neither statement is
 * available from Kp.
 *
 * The Geospace model's predicted Kp updates every minute rather than every three
 * hours. The forecast blocks stay the decision-maker, because they run further
 * ahead, but a minute-cadence nowcast catches the turn earlier.
 *
 * The 45 day forecast of Ap and F10.7 is the only feed here that operates on the
 * timescale of the decision it informs. Planting is a season, not an afternoon,
 * and "the next three days are clear" is the wrong horizon for someone deciding
 * whether to book a custom crew. Ap is converted to a Kp-equivalent so the rest
 * of the system can reason about it in the units it already uses.
 *
 * Solar flare and proton probabilities are for the HF radio operator and the
 * airline dispatcher, who are told about R and S scale events today but nothing
 * about the chance of one tomorrow.
 *
 * Electron fluence is for the satellite operator. Deep dielectric charging is
 * the slow failure mode that follows a high speed stream, and it is forecast
 * four days out.
 *
 * ICAO space weather advisories are the formal product civil aviation actually
 * runs on, issued by the global centres for GNSS, HF communication and radiation
 * at flight level. Orbita has been answering an airline dispatcher out of the
 * generic NOAA scales while the purpose-built product sat unread. The feed is an
 * empty array on a quiet day, which is the normal case and not an error.
 *
 * Every accessor returns null rather than a default when the feed has not
 * loaded, so a caller can distinguish "no data" from "nothing happening". No
 * tool call ever reaches the network; a timer does.
 */

import { backoff } from './backoff.js';
import { setSolarFlux } from './domain.js';

const BASE = 'https://services.swpc.noaa.gov';

const PATHS = {
  dst: '/json/geospace/geospace_dst_1_hour.json',
  predKp: '/json/geospace/geospace_pred_est_kp_1_hour.json',
  fortyFive: '/json/45-day-forecast.json',
  probabilities: '/json/solar_probabilities.json',
  electrons: '/json/electron_fluence_forecast.json',
  icao: '/json/icao-space-weather-advisories.json',
  xray: '/json/goes/primary/xrays-6-hour.json',
  enlil: '/json/enlil_time_series.json',
} as const;

/**
 * WSA-Enlil, and the only feed here that gives days rather than minutes.
 *
 * solarwind.ts reads the spacecraft at L1 and converts the distance to an
 * arrival time, which buys about forty minutes. That is the difference between
 * being warned and being surprised, and it is not enough to move a crew.
 *
 * Enlil is a magnetohydrodynamic model of the whole inner heliosphere. When a
 * coronal mass ejection leaves the Sun it is inserted into the model and
 * propagated, so the series says what the solar wind at Earth is expected to do
 * for days ahead. For someone deciding whether to book a custom crew for
 * Thursday, that is the only forecast here on the right timescale.
 *
 * Two details about the feed that matter for reading it correctly.
 *
 * It is ordered newest first, which is to say furthest into the future first,
 * and runs backwards to about two days in the past. Indexing it as though it
 * were chronological gets the arrival time exactly wrong.
 *
 * The `cloud` field is a tracer, zero in ambient solar wind and rising towards
 * one inside ejected material. It is the cleanest arrival signal in the file,
 * cleaner than speed, because a fast stream can raise speed without any CME
 * being involved.
 */
const CLOUD_ARRIVAL = 0.1;

/**
 * GOES soft X-ray flux to the NOAA R scale.
 *
 * The scales summary Orbita already reads is a daily product. This is the
 * 0.1 to 0.8 nanometre channel at one minute cadence, which is the band the R
 * scale is defined on, so a flare shows up here while it is happening rather
 * than in tomorrow's summary. The thresholds are the class boundaries: M1 is
 * 1e-5 watts per square metre and each class is a factor of ten.
 */
const R_SCALE: [number, number][] = [[2e-3, 5], [1e-3, 4], [1e-4, 3], [5e-5, 2], [1e-5, 1]];

export function fluxToR(flux: number): number {
  if (!Number.isFinite(flux)) return 0;
  for (const [threshold, r] of R_SCALE) if (flux >= threshold) return r;
  return 0;
}

/** Flare class letter and magnitude, the way an operator says it: "X1.4". */
export function fluxToClass(flux: number): string {
  if (!Number.isFinite(flux) || flux < 1e-8) return 'A0.0';
  const bands: [number, string][] = [[1e-4, 'X'], [1e-5, 'M'], [1e-6, 'C'], [1e-7, 'B'], [1e-8, 'A']];
  for (const [base, letter] of bands) {
    if (flux >= base) return `${letter}${(flux / base).toFixed(1)}`;
  }
  return 'A0.0';
}

const STALE_MS = 3 * 60 * 60 * 1000;

/**
 * Ap to Kp, from the standard conversion table.
 *
 * Ap is a linear index and Kp is quasi-logarithmic, so this is a lookup with
 * interpolation between the published pairs rather than a formula. Used only for
 * the 45 day outlook, where the source publishes Ap and the rest of Orbita
 * thinks in Kp.
 */
const AP_TO_KP: [number, number][] = [
  [0, 0], [2, 0.33], [3, 0.67], [4, 1], [5, 1.33], [6, 1.67], [7, 2], [9, 2.33],
  [12, 2.67], [15, 3], [18, 3.33], [22, 3.67], [27, 4], [32, 4.33], [39, 4.67],
  [48, 5], [56, 5.33], [67, 5.67], [80, 6], [94, 6.33], [111, 6.67], [132, 7],
  [154, 7.33], [179, 7.67], [207, 8], [236, 8.33], [300, 8.67], [400, 9],
];

export function apToKp(ap: number): number {
  if (!Number.isFinite(ap) || ap <= 0) return 0;
  for (let i = 0; i < AP_TO_KP.length - 1; i += 1) {
    const [a0, k0] = AP_TO_KP[i];
    const [a1, k1] = AP_TO_KP[i + 1];
    if (ap >= a0 && ap <= a1) {
      const t = a1 === a0 ? 0 : (ap - a0) / (a1 - a0);
      return Math.round((k0 + t * (k1 - k0)) * 100) / 100;
    }
  }
  return 9;
}

export type Dst = {
  /** Disturbance storm time index, nanotesla. Negative is a storm. */
  now: number;
  /** The lowest value in the last hour, which is the storm's depth so far. */
  low: number;
  /** Change over the last twenty minutes. Negative means still deepening. */
  trend: number;
  at: string;
};

export type OutlookDay = { date: string; ap: number; kp: number; f107: number };

export type Cme = {
  /** When ejected material is first modelled to reach Earth, ISO. */
  arrives: string;
  /** Hours from now until that. Negative once it has started. */
  hours: number;
  /** Peak modelled speed during the passage, km/s. */
  peakSpeed: number;
  /** Peak modelled density, particles per cm3. */
  peakDensity: number;
  /** Ambient speed before it, for comparison. */
  ambientSpeed: number;
};

export type Xray = {
  /** Watts per square metre, 0.1 to 0.8 nm. */
  flux: number;
  /** Flare class as spoken, e.g. "C2.1". */
  klass: string;
  /** NOAA R scale right now, 0 when below M1. */
  r: number;
  /** The strongest class seen in the last six hours. */
  peakClass: string;
  peakR: number;
  at: string;
};

export type FlareRisk = {
  date: string;
  /** Percentage chance, next 24 hours. */
  cClass: number;
  mClass: number;
  xClass: number;
  /** Chance of a 10 MeV proton event, which is the S scale. */
  protons: number;
};

export type ElectronFluence = {
  date: string;
  /** Solar wind speed forecast, km/s. */
  speed: number;
  /** Greater than 2 MeV electron fluence, electrons per cm2 per day. */
  today: number;
  ahead: number[];
};

type State = {
  dst: Dst | null;
  predictedKp: { kp: number; at: string } | null;
  outlook: OutlookDay[];
  flares: FlareRisk | null;
  electrons: ElectronFluence | null;
  advisories: unknown[];
  xray: Xray | null;
  cme: Cme | null;
  fetchedAt: number;
  errors: string[];
};

let state: State = {
  dst: null, predictedKp: null, outlook: [], flares: null,
  electrons: null, advisories: [], xray: null, cme: null, fetchedAt: 0, errors: [],
};

function parseEnlil(raw: unknown): Cme | null {
  const rows = (raw as { time_tag?: string; v_r?: number; cloud?: number; earth_particles_per_cm3?: number }[]) ?? [];
  const usable = rows
    .filter((r) => r.time_tag && typeof r.v_r === 'number' && typeof r.cloud === 'number')
    // Published newest first; sorted forward so "the next arrival" means what it says.
    .sort((a, b) => String(a.time_tag).localeCompare(String(b.time_tag)));
  if (usable.length < 10) return null;

  const nowIso = new Date().toISOString().slice(0, 19);
  const future = usable.filter((r) => String(r.time_tag) >= nowIso);
  if (!future.length) return null;

  const first = future.findIndex((r) => (r.cloud as number) >= CLOUD_ARRIVAL);
  if (first < 0) return null;

  // Ambient has to be the quiet wind, and the obvious way to measure it is
  // wrong. The region immediately ahead of an ejection is a compressed sheath
  // that is already moving faster than the wind it is ploughing into, so
  // averaging the hours just before the front measures the CME's own bow wave.
  // On the live feed that read 408 km/s where the true ambient was 330, which
  // turned a 92 km/s jump into a 14 km/s one and silenced a real arrival.
  //
  // The median of every cloud-free point in the forecast is used instead. A
  // median rather than a mean, because the sheath is still in that set and a
  // mean would let it pull the baseline up again.
  const quiet = future.filter((r) => (r.cloud as number) < CLOUD_ARRIVAL / 2).map((r) => r.v_r as number);
  const ambient = quiet.length
    ? [...quiet].sort((a, b) => a - b)[Math.floor(quiet.length / 2)]
    : (future[0].v_r as number);

  const passage = future.slice(first).filter((r) => (r.cloud as number) >= CLOUD_ARRIVAL / 2);
  const arrives = String(future[first].time_tag);
  return {
    arrives,
    hours: Math.round((new Date(`${arrives}Z`).getTime() - Date.now()) / 3.6e6),
    peakSpeed: Math.round(Math.max(...passage.map((r) => r.v_r as number))),
    peakDensity: Math.round(Math.max(...passage.map((r) => r.earth_particles_per_cm3 ?? 0)) * 10) / 10,
    ambientSpeed: Math.round(ambient),
  };
}

function parseXray(raw: unknown): Xray | null {
  const rows = (raw as { time_tag?: string; flux?: number; energy?: string }[]) ?? [];
  // Both channels arrive in one file; the R scale is defined on the long one.
  const long = rows.filter((r) => r.energy === '0.1-0.8nm' && typeof r.flux === 'number');
  if (!long.length) return null;
  const last = long[long.length - 1];
  const peak = Math.max(...long.map((r) => r.flux as number));
  return {
    flux: last.flux as number,
    klass: fluxToClass(last.flux as number),
    r: fluxToR(last.flux as number),
    peakClass: fluxToClass(peak),
    peakR: fluxToR(peak),
    at: String(last.time_tag ?? ''),
  };
}

let timer: ReturnType<typeof setInterval> | null = null;

async function getJson(path: string, timeoutMs = 10_000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function parseDst(raw: unknown): Dst | null {
  const rows = (raw as { time_tag?: string; dst?: number }[]) ?? [];
  const usable = rows.filter((r) => typeof r.dst === 'number' && r.time_tag);
  if (usable.length < 2) return null;
  const last = usable[usable.length - 1];
  const twentyBack = usable[Math.max(0, usable.length - 21)];
  const low = Math.min(...usable.map((r) => r.dst as number));
  return {
    now: Math.round((last.dst as number) * 10) / 10,
    low: Math.round(low * 10) / 10,
    trend: Math.round(((last.dst as number) - (twentyBack.dst as number)) * 10) / 10,
    at: String(last.time_tag),
  };
}

function parsePredictedKp(raw: unknown): { kp: number; at: string } | null {
  const rows = (raw as { model_prediction_time?: string; k?: number }[]) ?? [];
  const usable = rows.filter((r) => typeof r.k === 'number');
  if (!usable.length) return null;
  const last = usable[usable.length - 1];
  return { kp: Math.round((last.k as number) * 100) / 100, at: String(last.model_prediction_time ?? '') };
}

function parseOutlook(raw: unknown): OutlookDay[] {
  const body = raw as { data?: { time?: string; metric?: string; value?: number }[] };
  const byDate = new Map<string, { ap?: number; f107?: number }>();
  for (const row of body?.data ?? []) {
    if (!row.time || typeof row.value !== 'number') continue;
    const date = row.time.slice(0, 10);
    const entry = byDate.get(date) ?? {};
    if (row.metric === 'ap') entry.ap = row.value;
    if (row.metric === 'f107') entry.f107 = row.value;
    byDate.set(date, entry);
  }
  return [...byDate.entries()]
    .filter(([, v]) => typeof v.ap === 'number')
    .map(([date, v]) => ({ date, ap: v.ap as number, kp: apToKp(v.ap as number), f107: v.f107 ?? 0 }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function parseFlares(raw: unknown): FlareRisk | null {
  const rows = (raw as Record<string, unknown>[]) ?? [];
  if (!rows.length) return null;
  const r = rows[0];
  const num = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0);
  return {
    date: String(r.date ?? ''),
    cClass: num('c_class_1_day'),
    mClass: num('m_class_1_day'),
    xClass: num('x_class_1_day'),
    protons: num('10mev_protons_1_day'),
  };
}

function parseElectrons(raw: unknown): ElectronFluence | null {
  const rows = (raw as Record<string, unknown>[]) ?? [];
  if (!rows.length) return null;
  const r = rows[rows.length - 1];
  const num = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0);
  return {
    date: String(r.date ?? ''),
    speed: num('speed'),
    today: num('fluence'),
    ahead: [num('fluence_day_two'), num('fluence_day_three'), num('fluence_day_four')],
  };
}


/** After a run of failures, stop asking a server that is not answering. See backoff.ts. */

const gate = backoff();

export async function refresh(): Promise<void> {
  if (!gate.ready()) return;
  const errors: string[] = [];
  const settled = await Promise.allSettled([
    getJson(PATHS.dst), getJson(PATHS.predKp), getJson(PATHS.fortyFive),
    getJson(PATHS.probabilities), getJson(PATHS.electrons), getJson(PATHS.icao),
    getJson(PATHS.xray), getJson(PATHS.enlil),
  ]);
  const value = (i: number, name: string): unknown => {
    const s = settled[i];
    if (s.status === 'fulfilled') return s.value;
    errors.push(`${name}: ${String(s.reason)}`);
    return null;
  };

  // Each feed is independent, so one failing must not discard the other five.
  const dst = value(0, 'dst');
  const predKp = value(1, 'predKp');
  const fortyFive = value(2, '45day');
  const prob = value(3, 'probabilities');
  const elec = value(4, 'electrons');
  const icao = value(5, 'icao');
  const xray = value(6, 'xray');
  const enlil = value(7, 'enlil');

  state = {
    dst: dst ? (parseDst(dst) ?? state.dst) : state.dst,
    predictedKp: predKp ? (parsePredictedKp(predKp) ?? state.predictedKp) : state.predictedKp,
    outlook: fortyFive ? (parseOutlook(fortyFive).length ? parseOutlook(fortyFive) : state.outlook) : state.outlook,
    flares: prob ? (parseFlares(prob) ?? state.flares) : state.flares,
    electrons: elec ? (parseElectrons(elec) ?? state.electrons) : state.electrons,
    // An empty array is the normal quiet-day answer, not a failure, so it
    // replaces the previous list rather than being treated as "no data".
    advisories: Array.isArray(icao) ? icao : state.advisories,
    xray: xray ? (parseXray(xray) ?? state.xray) : state.xray,
    // A null here is the normal answer: most days have no CME on the way, so it
    // replaces the previous value rather than being treated as a failed parse.
    cme: enlil ? parseEnlil(enlil) : state.cme,
    fetchedAt: errors.length === 8 ? state.fetchedAt : Date.now(),
    errors,
  };
  if (errors.length === 8) gate.fail();
  else gate.ok();
  // The solar flux decides how often the equatorial bubbles come at all. See domain.quietSun.
  setSolarFlux(state.outlook[0]?.f107 ?? null);
}

const fresh = () => state.fetchedAt > 0 && Date.now() - state.fetchedAt < STALE_MS;

export const dst = (): Dst | null => (fresh() ? state.dst : null);
export const predictedKp = (): { kp: number; at: string } | null => (fresh() ? state.predictedKp : null);
export const flareRisk = (): FlareRisk | null => (fresh() ? state.flares : null);
export const electronFluence = (): ElectronFluence | null => (fresh() ? state.electrons : null);
export const advisories = (): unknown[] => (fresh() ? state.advisories : []);
export const cme = (): Cme | null => (fresh() ? state.cme : null);
export const xray = (): Xray | null => (fresh() ? state.xray : null);
export const outlook = (): OutlookDay[] => (fresh() ? state.outlook : []);

/**
 * The next stretch of quiet days long enough to be worth planning around.
 *
 * This is what the 45 day feed is for. A three day forecast answers "should I go
 * out this afternoon"; a season needs "when does the next settled week start".
 * Quiet here means a Kp-equivalent below the threshold on every day of the run.
 */
export function nextQuietRun(minDays = 5, maxKp = 4): { from: string; to: string; days: number } | null {
  const days = outlook();
  if (days.length < minDays) return null;
  const today = new Date().toISOString().slice(0, 10);
  let start = -1;
  for (let i = 0; i < days.length; i += 1) {
    if (days[i].date < today) continue;
    if (days[i].kp < maxKp) {
      if (start < 0) start = i;
      const length = i - start + 1;
      const last = i === days.length - 1 || days[i + 1].kp >= maxKp;
      if (last && length >= minDays) {
        return { from: days[start].date, to: days[i].date, days: length };
      }
    } else {
      start = -1;
    }
  }
  return null;
}

/**
 * Where the disturbance is, by comparing the global ring current with what the
 * ground nearby is doing. Returns nothing unless the two disagree usefully.
 */
export function whereIsIt(localLevel: 'quiet' | 'disturbed' | 'strong' | null): string {
  const d = dst();
  if (!d || !localLevel) return '';
  if (d.now <= -50 && localLevel === 'quiet') {
    return (
      `Globally this is a real storm, Dst ${d.now} nanotesla, but the ground near you is quiet. ` +
      'The ring current is planet-wide and the disturbance has not reached your longitude yet.'
    );
  }
  if (d.now > -20 && localLevel === 'strong') {
    return (
      `The global index is calm, Dst ${d.now} nanotesla, so this is a substorm overhead rather than a ` +
      'planetary storm. It is local, and it can pass quickly.'
    );
  }
  if (d.now <= -50 && d.trend < -5) {
    return `Dst is ${d.now} nanotesla and still falling, ${d.trend} in the last twenty minutes. The storm has not bottomed out.`;
  }
  return '';
}

/**
 * A modelled CME arrival, in a sentence, when it is far enough ahead to act on.
 *
 * This is the only thing in Orbita that can say "Thursday" rather than "in forty
 * minutes", so the wording leads with the day. It hedges deliberately: Enlil's
 * arrival times are routinely several hours out, and an ejection can miss, so
 * this is worth planning around and not worth cancelling on.
 */
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Friday" rather than "the 02th", which is what slicing the ISO string gives. */
function dayName(iso: string): string {
  const d = new Date(`${iso.slice(0, 19)}Z`);
  return Number.isNaN(d.getTime()) ? 'soon' : DAYS[d.getUTCDay()];
}

export function cmeSentence(): string {
  const held = cme();
  if (!held) return '';
  // Counted now, not when the feed was read: the model output is kept for up to three hours, and "in about
  // six hours" has to still be true when it is said.
  const arrival = Date.parse(`${held.arrives.slice(0, 19)}Z`);
  const c = { ...held, hours: Number.isFinite(arrival) ? Math.round((arrival - Date.now()) / 3.6e6) : held.hours };
  if (c.hours < 0) return '';

  const faster = c.peakSpeed - c.ambientSpeed;
  const when = c.hours < 36
    ? `in about ${c.hours} hours`
    : `in about ${Math.round(c.hours / 24)} days, ${dayName(c.arrives)} around ${c.arrives.slice(11, 16)} UTC`;

  // A cloud that is barely faster than the wind it is arriving into is not going
  // to do much, and saying so would cost credibility for the ones that will.
  if (faster < 40 && c.peakSpeed < 500) return '';

  return (
    `There is a coronal mass ejection modelled to reach Earth ${when}, at up to ${c.peakSpeed} kilometres a second ` +
    `against ${c.ambientSpeed} now. Enlil's arrival times run a few hours either way and a cloud can still miss, ` +
    'so this is worth planning around rather than cancelling on.'
  );
}

/** Flare and proton risk, in a sentence, for the radio and aviation roles. */
export function flareSentence(): string {
  const f = flareRisk();
  if (!f) return '';
  if (f.xClass >= 10 || f.protons >= 15) {
    return (
      `Tomorrow carries a ${f.xClass} percent chance of an X class flare and ${f.protons} percent of a proton event. ` +
      'An X flare takes HF out on the daylit side within minutes of the flash, with no warning.'
    );
  }
  if (f.mClass >= 40) {
    return `An M class flare is ${f.mClass} percent likely in the next day, which is short HF fadeouts on the sunlit side.`;
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

export function status(): Record<string, unknown> {
  return {
    ageMinutes: ageMinutes(),
    dst: state.dst?.now ?? null,
    predictedKp: state.predictedKp?.kp ?? null,
    outlookDays: state.outlook.length,
    xray: state.xray?.klass ?? null,
    cme: state.cme ? `${state.cme.hours}h` : null,
    advisories: state.advisories.length,
    ...(state.errors.length ? { errors: state.errors } : {}),
  };
}

export function seedForTest(next: Partial<State>): void {
  state = { ...state, ...next, fetchedAt: next.fetchedAt ?? Date.now() };
}

export function resetForTest(): void {
  gate.reset();
  state = { dst: null, predictedKp: null, outlook: [], flares: null, electrons: null, advisories: [], xray: null, cme: null, fetchedAt: 0, errors: [] };
}
