/**
 * The hour of warning that the three hour forecast cannot give.
 *
 * NOAA's planetary Kp forecast comes in three hour blocks, which is the right
 * shape for planning a day and the wrong shape for the question "is it turning
 * right now". Two other feeds answer that:
 *
 *   planetary_k_index_1m   an estimated Kp, updated every minute
 *   the solar wind summary  what the field and the wind are doing at L1
 *
 * L1 sits about 1.5 million kilometres upstream of Earth, so whatever the
 * spacecraft there is measuring reaches us later: about 46 minutes at 540 km/s,
 * about half an hour when the wind is fast. That gap is the warning. Since June
 * 2026 the measurements come from NOAA's own SOLAR-1, the first spacecraft built
 * for this job rather than borrowed from a science mission.
 *
 * What makes a storm is a southward field. When Bz turns south it couples to
 * Earth's own field and energy pours in; a northward field mostly does not. So
 * a strongly negative Bz with the wind up is the thing worth saying out loud,
 * and it is said with its caveat: the field can turn back north before it gets
 * here, and then nothing happens at all.
 *
 * Sources:
 *   NOAA SWPC, real time solar wind   https://www.swpc.noaa.gov/products/real-time-solar-wind
 *   NOAA SWPC, planetary K index      https://www.swpc.noaa.gov/products/planetary-k-index
 *   NOAA SWPC, SOLAR-1 operational    https://www.swpc.noaa.gov/news/noaa-swfo-l1-update-january-5th-2026
 */

const SPEED = 'https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json';
const FIELD = 'https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json';
const KP_1M = 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json';

/** Distance from L1 to Earth, kilometres. */
const L1_KM = 1_500_000;

/** Below this the field is coupling hard enough to be worth interrupting someone for. */
const BZ_STRONG = -10;
/** Below this it is worth mentioning, not worth acting on. */
const BZ_LEANING = -5;

/** Anything older than this is not "right now" any more. */
const STALE_MS = 20 * 60 * 1000;

export type Wind = {
  /** Measured at L1, kilometres per second. */
  speedKms: number;
  /** North-south field component, nanotesla. Negative is southward, which is what drives storms. */
  bzNt: number;
  /** Total field strength, nanotesla. */
  btNt: number;
  at: string;
};

export type Estimated = { kp: number; at: string };

type State = { wind: Wind | null; kp: Estimated | null; fetchedAt: number; error?: string };
let state: State = { wind: null, kp: null, fetchedAt: 0 };
let timer: ReturnType<typeof setInterval> | null = null;

export function seedForTest(next: Partial<State>): void {
  state = { wind: null, kp: null, fetchedAt: Date.now(), ...next };
}

const fresh = (): boolean => state.fetchedAt > 0 && Date.now() - state.fetchedAt < STALE_MS;

export function wind(): Wind | null {
  return fresh() ? state.wind : null;
}

/** Kp estimated a minute ago, rather than averaged over a three hour block. */
export function estimatedKp(): Estimated | null {
  return fresh() ? state.kp : null;
}

/** How long what is being measured at L1 takes to arrive, at the speed it is travelling. */
export function travelMinutes(speedKms: number): number {
  if (!(speedKms > 0)) return 60;
  return Math.round(L1_KM / speedKms / 60);
}

export type Incoming = {
  level: 'quiet' | 'watch' | 'likely';
  minutes: number;
  say: string;
};

/**
 * What the wind is doing, in a sentence, or null when there is nothing to say.
 *
 * Deliberately refuses to promise a storm. The honest claim is that the
 * conditions that cause one are arriving, and roughly when.
 */
export function incoming(): Incoming | null {
  const w = wind();
  if (!w) return null;
  const minutes = travelMinutes(w.speedKms);
  if (w.bzNt <= BZ_STRONG) {
    return {
      level: 'likely',
      minutes,
      say:
        `The solar wind is turning: the field is ${Math.abs(Math.round(w.bzNt))} nanotesla south at ` +
        `${Math.round(w.speedKms)} kilometres a second, which is the shape that drives a storm. What the satellite is ` +
        `measuring now reaches Earth in about ${minutes} minutes. It can still turn back north before it gets here.`,
    };
  }
  if (w.bzNt <= BZ_LEANING) {
    return {
      level: 'watch',
      minutes,
      say:
        `The solar wind is leaning south, ${Math.abs(Math.round(w.bzNt))} nanotesla, about ${minutes} minutes ` +
        'upstream. Not a storm yet, but worth another look before you start something long.',
    };
  }
  return { level: 'quiet', minutes, say: '' };
}

async function fetchJson(url: string, timeoutMs = 6000): Promise<unknown> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${url} ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function refresh(): Promise<void> {
  try {
    const [speed, field, kp] = await Promise.all([fetchJson(SPEED), fetchJson(FIELD), fetchJson(KP_1M)]);
    const s = (speed as { proton_speed?: number; time_tag?: string }[])[0];
    const f = (field as { bz_gsm?: number; bt?: number; time_tag?: string }[])[0];
    const rows = kp as { time_tag?: string; estimated_kp?: number }[];
    const last = rows[rows.length - 1];

    state = {
      wind:
        s?.proton_speed != null && f?.bz_gsm != null
          ? { speedKms: s.proton_speed, bzNt: f.bz_gsm, btNt: f.bt ?? 0, at: f.time_tag ?? s.time_tag ?? '' }
          : null,
      kp: last?.estimated_kp != null ? { kp: last.estimated_kp, at: last.time_tag ?? '' } : null,
      fetchedAt: Date.now(),
    };
  } catch (err) {
    // The three hour forecast is still there, so a failure here costs the extra
    // warning and nothing else. Saying nothing is correct; guessing is not.
    state = { ...state, error: String(err) };
  }
}

export async function start(everyMs = 60_000): Promise<void> {
  await refresh();
  if (!timer) {
    timer = setInterval(() => void refresh(), everyMs);
    timer.unref?.();
  }
}

export function ageMinutes(): number | null {
  return state.fetchedAt ? Math.round((Date.now() - state.fetchedAt) / 60000) : null;
}
