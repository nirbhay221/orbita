/**
 * The alert a machine reads, rather than the email a person does.
 *
 * alerts.ts tells crew contacts by email, once, when a storm will put one of their jobs out of tolerance. A
 * scheduler for a robot fleet or a drone operation cannot read an email, and should not have to ask each machine's
 * position every few minutes to find out a storm is coming. So every account has one resource, orbita://alerts,
 * with a line for each saved site and machine: whether the coming three days put that machine's tightest job out
 * of tolerance, when, and the clear windows around it. A scheduler polls it; `etag` changes only when the alert
 * does, so polling costs nothing until there is something to re-plan.
 *
 * It is a feed to poll rather than a push, on purpose. Pushing would mean this server calling addresses its users
 * give it, which is how a server gets turned against other people's machines, and the deployed one answers each
 * request on its own rather than holding a stream open per client.
 *
 * Built from the same forecast blocks and the same window test as everything else (domain.clearWindows), so it
 * cannot disagree with position_trust about a block.
 */

import { createHash } from 'node:crypto';
import * as swpc from './swpc.js';
import { clearWindows, TOLERANCE_M, type Operation } from './domain.js';
import { statusOperations } from './tools/shared.js';
import type { Farm } from './store.js';

const HOUR = 3_600_000;
export const HORIZON_HOURS = 72;

export type SiteAlert = {
  site: string;
  machine: string;
  correction: string;
  /** The tightest job this machine is judged for, and its tolerance. */
  job: string;
  needM: number;
  /** imminent: out of tolerance within a day; watch: within three; clear: not in the forecast. */
  phase: 'imminent' | 'watch' | 'clear';
  /** The first stretch out of tolerance, when there is one. */
  blocked: { from: string; to: string } | null;
  windows: { start: string; end: string; hours: number }[];
};

export type MachineAlerts = {
  generatedAt: string;
  forecastThrough: string | null;
  horizonHours: number;
  alerts: SiteAlert[];
  /** Changes only when an alert does. */
  etag: string;
  /**
   * When to read this again. Push would need a stream held open per client, and the deployed server answers each
   * request on its own, so the feed says how soon instead: fifteen minutes when a storm is within a day, an hour
   * when one is within three, three hours when it is clear, and never later than the next forecast block.
   */
  checkAgainAt: string;
  note?: string;
};

export function forFarm(farm: Farm, now = new Date()): MachineAlerts {
  const snap = swpc.current();
  const base = { generatedAt: now.toISOString(), horizonHours: HORIZON_HOURS };
  if (!snap?.slots.length) {
    return { ...base, forecastThrough: null, alerts: [], etag: 'no-forecast', checkAgainAt: new Date(now.getTime() + 15 * 60_000).toISOString(), note: 'NOAA could not be read; this is not an all clear.' };
  }
  const last = Math.max(...snap.slots.map((s) => new Date(s.time).getTime())) + 3 * HOUR;
  const hours = Math.max(0, Math.min(HORIZON_HOURS, Math.floor((last - now.getTime()) / HOUR)));
  const end = now.getTime() + hours * HOUR;
  const alerts: SiteAlert[] = [];
  for (const f of farm.fields) {
    for (const eq of farm.equipment) {
      const ops = statusOperations(eq.correction) as Operation[];
      const job = ops.reduce((a, b) => (TOLERANCE_M[b] < TOLERANCE_M[a] ? b : a));
      const needM = TOLERANCE_M[job];
      const windows = clearWindows(snap.slots, eq, f, needM, now, hours);
      // The first gap between now and the end of the search that no window covers.
      let cursor = now.getTime();
      let blocked: SiteAlert['blocked'] = null;
      for (const w of [...windows, { start: new Date(end).toISOString(), end: new Date(end).toISOString(), hours: 0 }]) {
        const s = new Date(w.start).getTime();
        if (s - cursor >= HOUR) { blocked = { from: new Date(cursor).toISOString(), to: new Date(s).toISOString() }; break; }
        cursor = Math.max(cursor, new Date(w.end).getTime());
      }
      const lead = blocked ? (new Date(blocked.from).getTime() - now.getTime()) / HOUR : Infinity;
      alerts.push({
        site: f.name, machine: eq.name, correction: eq.correction, job, needM,
        phase: lead <= 24 ? 'imminent' : lead <= HORIZON_HOURS ? 'watch' : 'clear',
        blocked, windows,
      });
    }
  }
  const etag = createHash('sha256').update(JSON.stringify(alerts.map((a) => [a.site, a.machine, a.phase, a.blocked]))).digest('hex').slice(0, 16);
  const minutes = alerts.some((a) => a.phase === 'imminent') ? 15 : alerts.some((a) => a.phase === 'watch') ? 60 : 180;
  const nextBlock = Math.ceil(now.getTime() / (3 * HOUR)) * 3 * HOUR;
  const checkAgainAt = new Date(Math.min(now.getTime() + minutes * 60_000, Math.max(nextBlock, now.getTime() + 15 * 60_000))).toISOString();
  return { ...base, forecastThrough: new Date(last).toISOString(), alerts, etag, checkAgainAt };
}
