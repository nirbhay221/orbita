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
    /(?:ALERT|WARNING|WATCH|SUMMARY):\s*([^]*?)(?:\s*(?:Valid|Threshold|Continuation|NOAA Space Weather Scale)|$)/
      .exec(msg)?.[1]
      ?.trim() ?? msg.slice(0, 160);
  return { issued: raw.issue_datetime, code, summary: summary.slice(0, 200) };
}

export async function refresh(): Promise<Snapshot> {
  try {
    const [kpRaw, alertsRaw, scalesRaw] = await Promise.all([
      getJson('noaa-planetary-k-index-forecast.json'),
      getJson('alerts.json'),
      getJson('noaa-scales.json'),
    ]);

    const slots: Slot[] = (kpRaw as { time_tag: string; kp: number; observed: string }[])
      .filter((r) => r && r.time_tag != null && r.kp != null)
      .map((r) => ({
        time: new Date(`${r.time_tag}Z`).toISOString(),
        kp: Number(r.kp),
        observed: r.observed === 'observed',
      }));

    const alerts = (alertsRaw as { issue_datetime: string; message: string }[])
      .slice(0, 8)
      .map(parseAlert);

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
    const sc = scalesRaw as Record<string, Row>;
    const num = (v: unknown): number | null =>
      v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
    const levels = (row?: Row): Levels => ({
      g: num(row?.G?.Scale) ?? 0,
      s: num(row?.S?.Scale) ?? 0,
      r: num(row?.R?.Scale) ?? 0,
    });
    // Key "0" is today, "-1" yesterday, "1" to "3" the outlook, where R and S
    // are day ahead probabilities rather than levels.
    const scales = {
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
  let best = snap.slots[0];
  let bestGap = Infinity;
  for (const s of snap.slots) {
    const gap = Math.abs(new Date(s.time).getTime() - t);
    if (gap < bestGap) {
      bestGap = gap;
      best = s;
    }
  }
  return { kp: best.kp, observed: best.observed };
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
