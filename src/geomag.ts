/**
 * What the ground actually measured, against what the forecast said.
 *
 * Everything else in Orbita is a forecast. Kp is a planetary index published in
 * three hour blocks, and the NOAA scales are derived from it, so the whole
 * answer so far has been "here is what the planet is expected to do, and here is
 * how exposed your patch of it is". That is the right default, because it is
 * what exists ahead of time.
 *
 * It has one blind spot, and it is the same blind spot that made geomagnetic
 * latitude worth computing in the first place. A planetary number is an average
 * over a planet. A storm is not evenly distributed over a planet. The auroral
 * electrojet sits over the night side, so two places at the same geomagnetic
 * latitude and the same Kp can be having very different afternoons depending on
 * where local midnight is. Kp 6 with the disturbance on the far side of the
 * world is not Kp 6 overhead.
 *
 * INTERMAGNET observatories measure the field on the ground, once a minute, and
 * the USGS publishes theirs openly with no key. That is the ground truth this
 * has been missing: not a better forecast, but a check on whether the forecast
 * has actually arrived where the customer is standing.
 *
 * Two quantities come out of it.
 *
 * The horizontal component H, sqrt(X^2 + Y^2), drops during the main phase of a
 * storm as the ring current builds. How far it has dropped from its own quiet
 * level is the local equivalent of what Dst measures globally.
 *
 * The rate of change of H is the one that matters for anything induced, and it
 * is also the better substorm detector, because a substorm onset is fast rather
 * than deep. Kappenman's work on geomagnetically induced currents is the usual
 * source for the thresholds, and the numbers below are deliberately conservative
 * against it: this corroborates the forecast, it does not overrule it.
 *
 * Which is the rule for this whole module. It never upgrades a quiet forecast
 * into a warning on its own, and it never downgrades a storm warning into an all
 * clear. A magnetometer 200 km away is evidence about the customer's longitude,
 * not a measurement of their field. It is allowed to say "this has arrived" or
 * "this has not arrived yet", and nothing stronger.
 *
 * Source: USGS Geomagnetism Program web service, https://geomag.usgs.gov/ws/
 * INTERMAGNET adjusted 1-minute data, free and keyless.
 */

import { backoff } from './backoff.js';

/** An observatory that reports to the USGS web service. */
export type Observatory = {
  id: string;
  name: string;
  lat: number;
  lon: number;
};

/**
 * The observatories this service will actually return data for.
 *
 * Baked in rather than fetched, for the same reason the geomagnetic pole is:
 * the list changes on a timescale of years, and a server that cannot start
 * because a directory endpoint is down is worse than one running on a list that
 * is a year stale.
 *
 * This is deliberately shorter than the USGS observatory directory, which lists
 * 43 entries. Thirteen of those are partner observatories the USGS names but
 * does not serve: every Canadian one, Baker Lake through Yellowknife, plus
 * Hartland, answers the data endpoint with 422. Two more are duplicate or
 * mislabelled records. Keeping them in would mean routing a site to its nearest
 * observatory and then finding there is nothing behind it, which is the failure
 * that is hardest to notice, because it looks exactly like a quiet day.
 *
 * Every id below was checked against the data endpoint and returned 200.
 *
 * The practical consequence, stated plainly because it limits the feature:
 * ground truth here is the United States, with single stations at Guam,
 * Honolulu, San Juan, Kakioka and Hermanus. There is no Canadian coverage, so
 * the Winnipeg case in the README gets the forecast and no corroboration. The
 * distance gate below turns that into silence rather than a wrong answer.
 *
 * INTERMAGNET's global node at imag-data.bgs.ac.uk would cover Canada and
 * Europe, and was tested: it answers, but it failed two of four requests with a
 * dropped connection. That is not something to put behind a customer question.
 */
const OBSERVATORIES: Observatory[] = [
  { id: 'BOU', name: 'Boulder', lat: 40.137, lon: -105.237 },
  { id: 'BRW', name: 'Barrow', lat: 71.322, lon: -156.622 },
  { id: 'BSL', name: 'Stennis Space Center', lat: 30.35, lon: -89.635 },
  { id: 'CMO', name: 'College', lat: 64.874, lon: -147.86 },
  { id: 'DED', name: 'Deadhorse', lat: 70.355, lon: -148.793 },
  { id: 'FRD', name: 'Fredericksburg', lat: 38.205, lon: -77.373 },
  { id: 'FRN', name: 'Fresno', lat: 37.091, lon: -119.718 },
  { id: 'GUA', name: 'Guam', lat: 13.588, lon: 144.867 },
  { id: 'HER', name: 'Hermanus', lat: -34.4, lon: 19.2 },
  { id: 'HON', name: 'Honolulu', lat: 21.316, lon: -158.0 },
  { id: 'KAK', name: 'Kakioka', lat: 36.232, lon: 140.186 },
  { id: 'NEW', name: 'Newport', lat: 48.265, lon: -117.122 },
  { id: 'SHU', name: 'Shumagin', lat: 55.348, lon: -160.462 },
  { id: 'SIT', name: 'Sitka', lat: 57.058, lon: -135.325 },
  { id: 'SJG', name: 'San Juan', lat: 18.113, lon: -66.151 },
  { id: 'TUC', name: 'Tucson', lat: 32.174, lon: -110.733 },
];

const BASE = 'https://geomag.usgs.gov/ws/data/';

/** Three hours gives a quiet reference and a present, without a large download. */
const WINDOW_MINUTES = 180;

/** The first third of the window is the baseline H is measured against. */
const BASELINE_MINUTES = 60;

/** Anything older than this is not "now" any more, and is reported as nothing. */
const STALE_MS = 45 * 60 * 1000;

/**
 * Rate of change of H, nanotesla per minute.
 *
 * Kappenman puts the onset of operator-visible geomagnetically induced current
 * effects around 10 nT/min at mid latitude and severe effects well above 100.
 * These sit below those, because the job here is to notice that a disturbance
 * has reached this longitude, not to predict transformer heating.
 */
const RATE_DISTURBED = 6;
const RATE_STRONG = 20;

/**
 * Depression of H from its own quiet level, nanotesla.
 *
 * A mid latitude H depression tracks Dst reasonably well, and the NOAA G scale
 * begins around a Dst of -50 nT. Deliberately conservative for the same reason.
 */
const DEPRESSION_DISTURBED = 40;
const DEPRESSION_STRONG = 100;

/** Earth radius, kilometres. */
const EARTH_KM = 6371;

/**
 * How far an observatory can be and still be saying something about this site.
 *
 * This is the limit that keeps the module honest, and it is not one number,
 * because the two quantities do not travel equally far.
 *
 * The depression of H is the ring current, which is a planet-scale current
 * system. Its signature is coherent across thousands of kilometres, which is why
 * Dst is built from four stations for the whole Earth. Out to a couple of
 * thousand kilometres, "H is depressed here" is still evidence about there.
 *
 * The rate of change is the auroral electrojet and substorm wedge, which is a
 * local structure. Its coherence length is hundreds of kilometres, not
 * thousands, and this is the quantity that would otherwise let a magnetometer in
 * Japan pronounce on a field in Punjab.
 *
 * Beyond REGIONAL_KM the module says nothing at all. Orbita's whole claim is
 * that a site is judged on the field it is actually sitting in, and a reading
 * from 5,900 km away would contradict that claim rather than support it. The
 * USGS network is dense over North America and sparse everywhere else, so for
 * most of the world the correct output here is silence.
 */
export const NEAR_KM = 600;
const REGIONAL_KM = 2000;

export type Reading = {
  observatory: Observatory;
  /** Great circle distance from the site to the observatory, kilometres. */
  km: number;
  /** H now minus the quiet baseline, nanotesla. Negative is the storm signature. */
  deltaH: number;
  /** The largest one minute change in H across the window, nanotesla per minute. */
  rate: number;
  /** How disturbed the ground is, on this module's own three steps. */
  level: 'quiet' | 'disturbed' | 'strong';
  /** Timestamp of the last sample used. */
  at: string;
  /** How many minutes of data the answer rests on. */
  samples: number;
};

/** What is stored per observatory: the summary, with the site-relative parts left off. */
type Summary = Omit<Reading, 'km' | 'observatory'>;
type Cached = { reading: Summary | null; fetchedAt: number; error?: string };

/** Observatories some registered site actually needs, and their last reading. */
const held = new Map<string, Cached>();

let timer: ReturnType<typeof setInterval> | null = null;

/** Test seam, so tests never reach the USGS. */
let fetchWindow: (id: string) => Promise<Sample[] | null> = fetchFromUsgs;

type Sample = { at: string; h: number };

/** Great circle distance in kilometres. */
function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * The closest reporting observatory to a site.
 *
 * Closest on the ground rather than closest in geomagnetic latitude, because
 * what this checks is whether the disturbance has reached this longitude, and
 * longitude is where local time lives.
 */
export function nearest(lat: number, lon: number): { observatory: Observatory; km: number } {
  let best = OBSERVATORIES[0];
  let bestKm = Infinity;
  for (const o of OBSERVATORIES) {
    const km = haversineKm(lat, lon, o.lat, o.lon);
    if (km < bestKm) {
      best = o;
      bestKm = km;
    }
  }
  return { observatory: best, km: Math.round(bestKm) };
}

/** The list, for anything that wants to show its working. */
export function observatories(): readonly Observatory[] {
  return OBSERVATORIES;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Turn a window of H into a deviation and a rate.
 *
 * The baseline is the median of the oldest hour rather than the mean, because a
 * single spike in a quiet hour should not move the level everything else is
 * measured against.
 */
function summarise(samples: Sample[]): Omit<Reading, 'km' | 'observatory'> | null {
  if (samples.length < BASELINE_MINUTES + 10) return null;

  const baselineSlice = samples.slice(0, BASELINE_MINUTES).map((s) => s.h);
  const baseline = median(baselineSlice);

  const last = samples[samples.length - 1];
  const deltaH = last.h - baseline;

  // Nanotesla per minute, so only between samples that really are a minute apart. Missing minutes are
  // dropped before this point, and the step across a half hour gap used to be counted as one minute's change,
  // which turns a data outage into a "strong" disturbance.
  let rate = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const apart = Date.parse(samples[i].at) - Date.parse(samples[i - 1].at);
    if (!(apart > 0 && apart <= 90_000)) continue;
    const step = Math.abs(samples[i].h - samples[i - 1].h);
    if (step > rate) rate = step;
  }

  const depressed = -deltaH;
  const level: Reading['level'] =
    rate >= RATE_STRONG || depressed >= DEPRESSION_STRONG
      ? 'strong'
      : rate >= RATE_DISTURBED || depressed >= DEPRESSION_DISTURBED
        ? 'disturbed'
        : 'quiet';

  return {
    deltaH: Math.round(deltaH),
    rate: Math.round(rate * 10) / 10,
    level,
    at: last.at,
    samples: samples.length,
  };
}

async function fetchFromUsgs(id: string): Promise<Sample[] | null> {
  const end = new Date();
  const start = new Date(end.getTime() - WINDOW_MINUTES * 60_000);
  const url =
    `${BASE}?id=${encodeURIComponent(id)}&format=json&elements=X,Y` +
    `&sampling_period=60&starttime=${start.toISOString()}&endtime=${end.toISOString()}`;

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${id} ${res.status}`);
    const body = (await res.json()) as {
      times?: string[];
      values?: { metadata?: { element?: string }; values?: (number | null)[] }[];
    };
    const times = body.times ?? [];
    const x = body.values?.find((v) => v.metadata?.element === 'X')?.values ?? [];
    const y = body.values?.find((v) => v.metadata?.element === 'Y')?.values ?? [];
    if (!times.length || x.length !== times.length || y.length !== times.length) return null;

    const samples: Sample[] = [];
    for (let i = 0; i < times.length; i += 1) {
      const xi = x[i];
      const yi = y[i];
      // A gap in the record is dropped rather than interpolated. A rate computed
      // across a gap is an artefact, and this module exists to avoid artefacts.
      if (xi == null || yi == null) continue;
      samples.push({ at: times[i], h: Math.hypot(xi, yi) });
    }
    return samples;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Note that some registered site depends on this observatory.
 *
 * Nothing is fetched here. The background timer picks it up on its next pass, so
 * registering a field stays as fast as it was.
 */
export function watch(lat: number, lon: number): Observatory {
  const { observatory } = nearest(lat, lon);
  if (!held.has(observatory.id)) held.set(observatory.id, { reading: null, fetchedAt: 0 });
  return observatory;
}

/** What the ground near a site is doing, or nothing if it is not known. */
export function reading(lat: number, lon: number): Reading | null {
  const { observatory, km } = nearest(lat, lon);
  const cached = held.get(observatory.id);
  if (!cached?.reading) return null;
  if (Date.now() - cached.fetchedAt > STALE_MS) return null;
  return { ...cached.reading, observatory, km };
}

/**
 * Whether the forecast has actually shown up on the ground.
 *
 * Returns nothing unless it has something useful to say, which is the two cases
 * where measurement and forecast disagree in a direction a customer can act on.
 */
export function corroboration(lat: number, lon: number, forecastKp: number): string {
  const r = reading(lat, lon);
  if (!r) return '';

  // Too far to be evidence about this site at all. Most of the world lands here,
  // and silence is the correct answer rather than a weaker sentence.
  if (r.km > REGIONAL_KM) return '';

  // Between the two limits only the slow, large-scale part can be spoken about:
  // the ring current reaches this far, a substorm's rate of change does not.
  const rateIsLocal = r.km <= NEAR_KM;

  const where = `${r.observatory.name}, ${r.km} km away`;

  if (!rateIsLocal) {
    const depressed = -r.deltaH;
    if (forecastKp >= 5 && depressed >= DEPRESSION_DISTURBED) {
      return (
        `The nearest magnetometer, at ${where}, is ${Math.round(depressed)} nanotesla below its quiet ` +
        'level, which is the ring current and is regional rather than local. It supports the forecast ' +
        'without being a measurement of your own field.'
      );
    }
    return '';
  }

  if (forecastKp >= 5 && r.level === 'quiet') {
    return (
      `The ground has not felt it yet: the magnetometer at ${where} is still quiet, ` +
      `${Math.abs(r.deltaH)} nanotesla off its own baseline. A planetary index is an average over a ` +
      'planet, and this longitude is not in the disturbed part of it yet.'
    );
  }

  if (forecastKp < 5 && r.level === 'strong') {
    return (
      `The forecast is calm but the ground is not: ${where} is running ${r.rate} nanotesla a minute ` +
      `and sits ${Math.abs(r.deltaH)} nanotesla off baseline. Treat guidance as less reliable than the ` +
      'three hour number suggests until the next forecast catches up.'
    );
  }

  if (forecastKp >= 5 && r.level !== 'quiet') {
    return (
      `Confirmed on the ground: ${where} is ${Math.abs(r.deltaH)} nanotesla off baseline at ` +
      `${r.rate} nanotesla a minute. The storm is over this longitude now.`
    );
  }

  return '';
}

/** Refresh every observatory some site actually needs. */

/** After a run of failures, stop asking a server that is not answering. See backoff.ts. */

const gate = backoff();

export async function refresh(): Promise<void> {
  if (!gate.ready()) return;
  const ids = [...held.keys()];
  let good = 0;
  await Promise.all(
    ids.map(async (id) => {
      try {
        const samples = await fetchWindow(id);
        const summary = samples ? summarise(samples) : null;
        if (summary) {
          good++;
          held.set(id, { reading: summary, fetchedAt: Date.now() });
        }
        else held.set(id, { ...(held.get(id) ?? { reading: null, fetchedAt: 0 }), error: 'no usable samples' });
      } catch (err) {
        // Keep whatever was last known and let it go stale on its own. The
        // forecast still works without this; a wrong ground truth is worse than
        // none, so nothing is invented here.
        const prev = held.get(id) ?? { reading: null, fetchedAt: 0 };
        held.set(id, { ...prev, error: String(err) });
      }
    }),
  );
  if (ids.length) {
    if (good) gate.ok();
    else gate.fail();
  }
}

/**
 * Poll on a timer, never inside a tool call.
 *
 * Five minutes: the data is published once a minute, but the thing being
 * detected takes tens of minutes to develop, and this is a courtesy to a free
 * public service that has no key and no quota to hide behind.
 */
export async function start(everyMs = 5 * 60_000): Promise<void> {
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

/** How stale the freshest reading is, in minutes, or nothing if there is none. */
export function ageMinutes(): number | null {
  let newest = 0;
  for (const c of held.values()) if (c.fetchedAt > newest) newest = c.fetchedAt;
  return newest ? Math.round((Date.now() - newest) / 60000) : null;
}

/** How many observatories are being followed, for /health. */
export function watched(): number {
  return held.size;
}

/** Test seam: a fake transport, so tests never touch the USGS. */
export function seedForTest(next: {
  fetch?: (id: string) => Promise<Sample[] | null>;
  readings?: { id: string; samples: Sample[] }[];
}): void {
  if (next.fetch) fetchWindow = next.fetch;
  for (const r of next.readings ?? []) {
    const summary = summarise(r.samples);
    held.set(r.id, { reading: summary, fetchedAt: Date.now() });
  }
}

/** Test seam: forget everything, so cases do not leak into each other. */
export function resetForTest(): void {
  gate.reset();
  held.clear();
  fetchWindow = fetchFromUsgs;
}
