/**
 * The sky over the field, measured a minute ago.
 *
 * Kp is one number for the whole planet every three hours. GloTEC (glotec.ts) is a map of the electron
 * content, too coarse to see the small, fast structure that actually breaks a fix. What breaks a fix is
 * that structure, and it is measured: the rate of TEC index, ROTI, is how fast the electron count along
 * one receiver-to-satellite path is changing, in TEC units per minute. Quiet sky is well under 0.2.
 *
 * The German Aerospace Center's Ionosphere Monitoring and Prediction Center (IMPC) publishes ROTI every
 * minute from about four thousand receiver-satellite links worldwide, on the order of fifteen hundred over
 * the United States, each placed where its path crosses the ionosphere. This reads the links whose paths
 * cross the sky within 400 km of the field. Free, no key; the licence allows free scientific use and asks
 * for written permission for commercial use, which a hackathon entry is not. Attributed wherever it is said.
 *
 * What a value means is taken from one published result, not tuned here. A 2025 study of network RTK
 * during ionospheric disturbances found that when 40 to 60 percent of satellites had ROTI above 0.2 TECU
 * per minute, the RTK fix rate fell to about 50 to 70 percent, with a correlation of -0.9 between the two.
 * So:
 *
 *   disturbed  40 percent or more of the links overhead above 0.2, with at least 30 links in view. RTK can be expected to lose its fix
 *              for a large share of the time, whatever the forecast says.
 *   quiet      under 10 percent above 0.2, with at least 30 links in view. Measured calm right now.
 *   between    said as what it is, and the forecast decides.
 *
 * Sources:
 *   https://impc.dlr.de/products/ionospheric-perturbations/rate-of-change-of-tec-index/one-minute-mean-roti-global
 *   https://impc.dlr.de/about/license-agreement
 *   https://link.springer.com/article/10.1186/s43020-025-00179-4
 */

import { backoff } from './backoff.js';

const URL =
  'https://data.impc.dlr.de/roti/DLR_GNSS_GCG_L3_ROTI-MEAN_NC_GLOBAL/latest/DLR_GNSS_GCG_L3_ROTI-MEAN_NC_GLOBAL_latest_D.json';

export const ACTIVE = 0.2;
export const DISTURBED_SHARE = 0.4;
export const QUIET_SHARE = 0.1;
export const MIN_LINKS = 30;
export const RADIUS_KM = 400;
/** A one-minute product older than this is not "right now" any more. */
const STALE_MS = 15 * 60_000;
export const SOURCE = 'German Aerospace Center (DLR) IMPC, one-minute ROTI';

type Link = { lat: number; lon: number; roti: number };
let links: Link[] = [];
let measuredAt = '';
let fetchedAt = 0;
let lastError = '';
let timer: ReturnType<typeof setInterval> | null = null;
const gate = backoff();

export type Sky = {
  state: 'disturbed' | 'quiet' | 'between';
  links: number;
  /** Share of the links overhead above 0.2 TECU per minute. */
  activeShare: number;
  medianRoti: number;
  measuredAt: string;
};

export function parse(body: unknown): { links: Link[]; at: string } | null {
  const b = body as {
    metadata?: { temporal_coverage?: { end_time?: string }; integrated_gnss_stations?: { features?: unknown[] } };
  } | null;
  const features = b?.metadata?.integrated_gnss_stations?.features;
  if (!Array.isArray(features)) return null;
  const out: Link[] = [];
  for (const f of features as { geometry?: { coordinates?: unknown }; properties?: { roti?: unknown } }[]) {
    const c = f.geometry?.coordinates;
    const r = f.properties?.roti;
    if (!Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number' || typeof r !== 'number' || !Number.isFinite(r) || r < 0) continue;
    out.push({ lon: c[0], lat: c[1], roti: r });
  }
  const end = b?.metadata?.temporal_coverage?.end_time;
  return out.length ? { links: out, at: end ? `${end.replace(/Z?$/, '')}Z` : new Date().toISOString() } : null;
}

const km = (aLat: number, aLon: number, bLat: number, bLon: number): number => {
  const r = Math.PI / 180;
  const h = Math.sin(((bLat - aLat) * r) / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(((bLon - aLon) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

/** The sky within 400 km of a place, from the last minute that was read. Null when there is nothing fresh. */
export function over(lat: number, lon: number, now = Date.now()): Sky | null {
  if (!links.length || now - fetchedAt > STALE_MS) return null;
  const near = links.filter((l) => Math.abs(l.lat - lat) < 5 && km(lat, lon, l.lat, l.lon) <= RADIUS_KM).map((l) => l.roti).sort((a, b) => a - b);
  if (!near.length) return null;
  const share = near.filter((r) => r > ACTIVE).length / near.length;
  const median = near[Math.floor(near.length / 2)];
  // Too few links overhead says nothing either way: three disturbed paths are not a disturbed sky.
  const enough = near.length >= MIN_LINKS;
  const state = !enough ? 'between' : share >= DISTURBED_SHARE ? 'disturbed' : share < QUIET_SHARE ? 'quiet' : 'between';
  return { state, links: near.length, activeShare: Number(share.toFixed(2)), medianRoti: Number(median.toFixed(3)), measuredAt };
}

/** One sentence for the spoken answer, or nothing when there is nothing worth saying. */
export function say(sky: Sky | null): string {
  if (!sky) return '';
  const pct = Math.round(sky.activeShare * 100);
  if (sky.state === 'disturbed') {
    return `Right now ${pct} percent of the satellite signals over the field are disturbed, which in published tests halves how long RTK holds a fix.`;
  }
  if (sky.state === 'quiet') return `Measured in the last few minutes, the sky over the field is calm: ${sky.links} satellite signals, almost none disturbed.`;
  return '';
}

async function load(): Promise<{ links: Link[]; at: string } | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(URL, { signal: ctrl.signal, headers: { 'user-agent': 'orbita (hackathon entry; non-commercial)' } });
    if (!res.ok) throw new Error(`IMPC: HTTP ${res.status}`);
    return parse(await res.json());
  } finally {
    clearTimeout(t);
  }
}

export async function refresh(): Promise<void> {
  if (!gate.ready()) return;
  try {
    const next = await load();
    if (!next) {
      lastError = 'no links in the file';
      gate.fail();
      return;
    }
    links = next.links;
    measuredAt = next.at;
    fetchedAt = Date.now();
    lastError = '';
    gate.ok();
  } catch (err) {
    // Keep the last minute and let it go stale. Nothing else depends on this.
    lastError = String(err);
    gate.fail();
  }
}

/** Every five minutes: the file is a minute old when written, and about a megabyte. */
export async function start(everyMs = 5 * 60_000): Promise<void> {
  await refresh();
  if (!timer) {
    timer = setInterval(() => void refresh(), everyMs);
    timer.unref?.();
  }
}

export function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function status(): { links: number; at: string; ageMinutes: number | null; error?: string } {
  return {
    links: links.length,
    at: measuredAt,
    ageMinutes: fetchedAt ? Math.round((Date.now() - fetchedAt) / 60000) : null,
    ...(lastError ? { error: lastError } : {}),
  };
}

export function seedForTest(next: { links: Link[]; at?: string; fetchedAt?: number }): void {
  links = next.links;
  measuredAt = next.at ?? new Date().toISOString();
  fetchedAt = next.fetchedAt ?? Date.now();
}

export function resetForTest(): void {
  links = [];
  measuredAt = '';
  fetchedAt = 0;
  lastError = '';
}
