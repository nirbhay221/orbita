/**
 * NOAA Space Weather Prediction Center client.
 *
 * Free, no API key, no documented rate limit. Three products carry the whole product:
 *   noaa-planetary-k-index-forecast.json  3-hourly Kp, observed + forecast, ~3 days out
 *   alerts.json                            issued alerts / warnings / watches
 *   noaa-scales.json                       current and forecast G / S / R storm scales
 *
 * Alexa+ allows roughly 500 ms for a round trip, so nothing here is fetched
 * inside a tool call. A background refresh keeps a snapshot in memory and every
 * request reads that. If NOAA is unreachable we serve the last good snapshot and
 * say how old it is, silently serving stale space weather would be worse than
 * saying "I can't reach NOAA".
 */

import type { Slot } from './domain.js';
import type { DayOutlook, Levels } from './playbook.js';

const BASE = 'https://services.swpc.noaa.gov/products';
const REFRESH_MS = 15 * 60 * 1000;

export type Snapshot = {
  fetchedAt: string;
  slots: Slot[];
  alerts: { issued: string; code: string; summary: string }[];
  /**
   * NOAA scale levels as numbers, 0 when quiet, plus yesterday and the next
   * three days. The feed's Text field is a word ("moderate"), and reading that
   * word as if it were "G2" made every real storm look quiet downstream.
   */
  scales: Levels & { yesterday: Levels; days: DayOutlook[] };
  stale: boolean;
  error?: string;
};

let snapshot: Snapshot | null = null;
let timer: NodeJS.Timeout | null = null;

async function getJson(path: string, timeoutMs = 8000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/${path}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** The alert feed is fixed-format text; pull out the code and the human sentence. */
function parseAlert(raw: { issue_datetime: string; message: string }) {
  const msg = raw.message.replace(/\s+/g, ' ').trim();
  const code = /Space Weather Message Code:\s*(\S+)/.exec(msg)?.[1] ?? 'UNKNOWN';
  const summary =
    /(?:ALERT|WARNING|WATCH|SUMMARY):\s*([^]*?)(?:\s*(?:Valid|Threshold|Continuation|NOAA Space Weather Scale|Highest Storm Level|Predicted by Day|THIS SUPERSEDES|Potential Impacts|Issue Time|Comment|Observed|Begin Time|Station|Warning Condition|Extension to Serial|Original Issue|Active Warning|Synoptic Period|Estimated Velocity|Description|Deviation|IP Shock|Maximum Time|End Time|Duration|Peak Flux|Yesterday Maximum)\b|$)/
      .exec(msg)?.[1]
      ?.trim() ?? msg.slice(0, 160);
  // A title, not a bulletin: said aloud, so it ends at a word and is short.
  const words = summary.split(' ');
  const short = words.length > 14 ? `${words.slice(0, 14).join(' ')}` : summary;
  return { issued: raw.issue_datetime, code, summary: short.replace(/[\s.]+$/, '') };
}

export async function refresh(): Promise<Snapshot> {
  try {
    // The Kp forecast is the answer; the alerts and the scales add to it. One of those two failing used to
    // throw the new forecast away with it, so a slow alerts file made every answer stale.
    const [kpRaw, alertsGot, scalesGot] = await Promise.all([
      getJson('noaa-planetary-k-index-forecast.json'),
      getJson('alerts.json').then((v) => ({ ok: true as const, v }), () => ({ ok: false as const })),
      getJson('noaa-scales.json').then((v) => ({ ok: true as const, v }), () => ({ ok: false as const })),
    ]);
    const prior = snapshot;

    const slots: Slot[] = (kpRaw as { time_tag: string; kp: number; observed: string }[])
      .filter((r) => r && r.time_tag != null && r.kp != null)
      // One malformed row used to throw out of toISOString and discard the whole forecast.
      .filter((r) => Number.isFinite(Date.parse(`${String(r.time_tag).replace(/Z$/, '')}Z`)) && Number.isFinite(Number(r.kp)))
      .map((r) => ({
        time: new Date(`${String(r.time_tag).replace(/Z$/, '')}Z`).toISOString(),
        kp: Number(r.kp),
        observed: r.observed === 'observed',
      }));

    const alerts = alertsGot.ok
      ? (alertsGot.v as { issue_datetime: string; message: string }[]).slice(0, 8).map(parseAlert)
      : prior?.alerts ?? [];

    // All three scales arrive in one file. G breaks GPS; R absorbs HF on the
    // sunlit side and takes low-frequency navigation with it; S is a polar
    // radiation problem. Only G changes a tractor's answer, but reporting the
    // other two costs nothing and they are already here.
    type Row = {
      DateStamp?: string;
      G?: { Scale: string | null };
      S?: { Scale: string | null; Prob?: string | null };
      R?: { Scale: string | null; MinorProb?: string | null; MajorProb?: string | null };
    };
    const sc = (scalesGot.ok ? scalesGot.v : {}) as Record<string, Row>;
    const num = (v: unknown): number | null =>
      v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
    const levels = (row?: Row): Levels => ({
      g: num(row?.G?.Scale) ?? 0,
      s: num(row?.S?.Scale) ?? 0,
      r: num(row?.R?.Scale) ?? 0,
    });
    // Key "0" is today, "-1" yesterday, "1" to "3" the outlook, where R and S
    // are day ahead probabilities rather than levels.
    const scales = !scalesGot.ok && prior ? prior.scales : {
      ...levels(sc['0']),
      yesterday: levels(sc['-1']),
      days: ['1', '2', '3']
        .filter((k) => sc[k])
        .map((k) => ({
          date: sc[k].DateStamp ?? '',
          g: num(sc[k].G?.Scale),
          rMinorProb: num(sc[k].R?.MinorProb),
          rMajorProb: num(sc[k].R?.MajorProb),
          sProb: num(sc[k].S?.Prob),
        })),
    };

    // A forecast file that parsed to nothing is not a forecast, and must not replace the last one that was.
    if (!slots.length) throw new Error('noaa-planetary-k-index-forecast.json: no usable rows');
    snapshot = { fetchedAt: new Date().toISOString(), slots, alerts, scales, stale: false };
    return snapshot;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (snapshot) {
      snapshot = { ...snapshot, stale: true, error: message };
      return snapshot;
    }
    snapshot = {
      fetchedAt: new Date().toISOString(),
      slots: [],
      alerts: [],
      scales: { g: 0, s: 0, r: 0, yesterday: { g: 0, s: 0, r: 0 }, days: [] },
      stale: true,
      error: message,
    };
    return snapshot;
  }
}

export function current(): Snapshot | null {
  return snapshot;
}

/** Kp for the 3-hour block containing `when`, else the nearest published block. */
export function kpAt(when: Date): { kp: number; observed: boolean } | null {
  const snap = snapshot;
  if (!snap?.slots.length) return null;
  const t = when.getTime();
  const containing = snap.slots.find((s) => {
    const start = new Date(s.time).getTime();
    return t >= start && t < start + 3 * 3_600_000;
  });
  if (containing) return { kp: containing.kp, observed: containing.observed };
  // Nearest start alone picked the next block for the last hour and a half of every block.
  // Outside every block. The nearest one is only an answer when it is the neighbouring block, across a small
  // gap in the file. This used to return the nearest block however far away it was, so a question about next
  // week was answered with the last forecast block, an invalid date with the first block in the file (a week
  // old), and a feed that had been down for days kept answering with its final number.
  let best: Slot | null = null;
  let bestGap = Infinity;
  for (const s of snap.slots) {
    const start = new Date(s.time).getTime();
    const gap = t < start ? start - t : t - (start + 3 * 3_600_000);
    if (gap < bestGap) {
      bestGap = gap;
      best = s;
    }
  }
  if (!best || !(bestGap <= 3 * 3_600_000)) return null;
  return { kp: best.kp, observed: best.observed };
}

/** The last instant the forecast covers, or null when there is no forecast. */
export function horizon(): Date | null {
  const slots = snapshot?.slots ?? [];
  if (!slots.length) return null;
  return new Date(Math.max(...slots.map((s) => new Date(s.time).getTime())) + 3 * 3_600_000);
}

export async function start(): Promise<void> {
  await refresh();
  if (!timer) {
    timer = setInterval(() => {
      void refresh();
    }, REFRESH_MS);
    timer.unref?.();
  }
}

export function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** How old the snapshot is, in minutes. Surfaced to the farmer when it matters. */
export function ageMinutes(): number | null {
  if (!snapshot) return null;
  return Math.round((Date.now() - new Date(snapshot.fetchedAt).getTime()) / 60000);
}

/** Test seam: put a snapshot in memory without touching NOAA. */
export function seedForTest(s: Snapshot): void {
  snapshot = s;
}

/** Test seam: the alert parser by itself. */
export const parseAlertForTest = parseAlert;
