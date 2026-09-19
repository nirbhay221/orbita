/** Farm state: fields, equipment, watches, crew and a job log. Memory-resident, flushed to disk on write. */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Equipment, Field } from './domain.js';

export type NotifyReason = 'window_clear' | 'storm';

export type CrewContact = {
  name: string;
  email: string;
  role: string | null;
  notifyOn: NotifyReason[];
  addedAt: string;
  /** Null until the customer says to go ahead. Nothing is ever sent to an unconfirmed contact. */
  confirmedAt: string | null;
};

export type Watch = {
  id: string;
  operation: string;
  fieldId: string;
  equipmentId: string;
  since: string;
  /** When the crew was emailed that it cleared, so nobody hears it twice. */
  notifiedAt: string | null;
};

export type JobEntry = {
  id: string;
  /** When the job ran. */
  at: string;
  /** When it was recorded, which is not the same thing when a past job is logged. */
  loggedAt: string;
  operation: string;
  fieldId: string;
  fieldName: string;
  equipmentId: string;
  equipmentName: string;
  /** Kp for that three hour block, or null when it was not in memory. */
  kp: number | null;
  expectedErrorM: number | null;
  toleranceM: number;
  /** Whether that job was inside tolerance then; null when Kp was unknown. */
  go: boolean | null;
  limitedBy: 'clear' | 'space_weather' | 'equipment' | null;
  acres: number | null;
  note: string | null;
};

export type Farm = {
  fields: Field[];
  equipment: Equipment[];
  /** Jobs the customer asked us to watch for a clear window. */
  waiting: Watch[];
  /** What the customer looks after, so they need not repeat it every time. */
  role?: string;
  crew: CrewContact[];
  jobLog: JobEntry[];
  /** Alerts already sent, as "storm:2026-09-15", so a crew is never emailed twice for one storm day. */
  alertsSent: string[];
  /** When a fresh start was last asked for, so the second ask is the confirmation. */
  forgetAskedAt?: string | null;
};

const DATA_PATH = resolve(process.env.ORBITA_DATA ?? './data/farms.json');
const empty = (): Farm => ({ fields: [], equipment: [], waiting: [], crew: [], jobLog: [], alertsSent: [] });

let cache: Record<string, Farm> | null = null;

function load(): Record<string, Farm> {
  if (cache) return cache;
  if (existsSync(DATA_PATH)) {
    try {
      cache = JSON.parse(readFileSync(DATA_PATH, 'utf8')) as Record<string, Farm>;
      return cache;
    } catch {
      cache = {};
      return cache;
    }
  }
  cache = {};
  return cache;
}

function flush(): void {
  if (!cache) return;
  mkdirSync(dirname(DATA_PATH), { recursive: true });
  // Written beside the file and renamed over it, which is atomic on one
  // filesystem. A crash partway through a direct write leaves a truncated file,
  // and half a record is worse than none: it still parses, so nothing complains.
  const tmp = `${DATA_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  renameSync(tmp, DATA_PATH);
}


/**
 * How many records this process will hold, and which ones it gives up first.
 *
 * Any string can arrive as a demo id, so a read that creates a record is a tap
 * a stranger can leave running. Reads no longer create anything, and when the
 * cap is reached the least recently touched demo record goes. A record belonging
 * to a linked account is never evicted: that one was asked for.
 */
const MAX_RECORDS = Number(process.env.ORBITA_MAX_RECORDS ?? 5000);
const touched = new Map<string, number>();
const startedAt = Date.now();

function makeRoom(): void {
  const all = load();
  const ids = Object.keys(all);
  if (ids.length < MAX_RECORDS) return;
  const demo = ids.filter((id) => id.startsWith('demo:'));
  if (!demo.length) return;
  const oldest = demo.reduce((a, b) => ((touched.get(a) ?? 0) <= (touched.get(b) ?? 0) ? a : b));
  delete all[oldest];
  touched.delete(oldest);
}

/** What we hold for this farm, or an empty one. Reading never creates a record. */

/**
 * Demo records do not live forever.
 *
 * A profile made by a stranger on the demo page holds fields, machines and a job log, and there is no
 * reason to keep it once they have gone. Anything with a demo id and no write
 * for seven days is deleted on the next sweep. A record belonging to a linked
 * account is left alone: that one was asked for, and the customer can clear it
 * themselves whenever they like.
 */
const DEMO_TTL_MS = Number(process.env.ORBITA_DEMO_TTL_DAYS ?? 7) * 24 * 60 * 60 * 1000;

export function expireDemoRecords(now = Date.now()): number {
  const all = load();
  let gone = 0;
  for (const id of Object.keys(all)) {
    if (!id.startsWith('demo:')) continue;
    const last = touched.get(id);
    // Nothing touched since this process started, and nothing written since:
    // treat the file's own age as the clock rather than keeping it forever.
    if (last != null && now - last <= DEMO_TTL_MS) continue;
    if (last == null && now - startedAt <= DEMO_TTL_MS) continue;
    delete all[id];
    touched.delete(id);
    gone += 1;
  }
  if (gone) flush();
  return gone;
}

export function get(farmId: string): Farm {
  const all = load();
  const held = all[farmId];
  if (!held) return empty();
  // Records written before crew, the job log and watch ids existed get them filled in.
  const farm = { ...empty(), ...held };
  farm.waiting = farm.waiting.map((w, i) => ({ ...w, id: w.id ?? `watch-legacy-${i}`, notifiedAt: w.notifiedAt ?? null }));
  all[farmId] = farm;
  touched.set(farmId, Date.now());
  return farm;
}

/**
 * Everything, gone.
 *
 * The record is replaced rather than emptied one list at a time, so nothing
 * survives a fresh start because a field was added later and nobody remembered
 * to clear it here.
 */
export function forget(farmId: string): void {
  const all = load();
  all[farmId] = empty();
  flush();
}

/**
 * Lists that would otherwise grow for as long as the process lives.
 *
 * A job log is genuinely useful history and a customer may want a year of it,
 * so this is generous rather than tidy: the cap is well past what a season
 * produces, and it exists so that one automated caller cannot grow a record
 * without limit. The oldest entries go first. alertsSent only needs to remember
 * far enough back to avoid emailing twice about the same storm.
 */
const MAX_JOB_LOG = Number(process.env.ORBITA_MAX_JOB_LOG ?? 2000);
const MAX_ALERTS_REMEMBERED = 400;

function prune(f: Farm): void {
  if (f.jobLog.length > MAX_JOB_LOG) f.jobLog = f.jobLog.slice(-MAX_JOB_LOG);
  if (f.alertsSent.length > MAX_ALERTS_REMEMBERED) f.alertsSent = f.alertsSent.slice(-MAX_ALERTS_REMEMBERED);
}

export function update(farmId: string, fn: (f: Farm) => void): Farm {
  const all = load();
  if (!all[farmId]) makeRoom();
  const f = { ...empty(), ...(all[farmId] ?? {}) };
  f.waiting = f.waiting.map((w, i) => ({ ...w, id: w.id ?? `watch-legacy-${i}`, notifiedAt: w.notifiedAt ?? null }));
  all[farmId] = f;
  touched.set(farmId, Date.now());
  fn(f);
  prune(f);
  flush();
  return f;
}

/** Every farm, so the alert check can look at all of them. */
export function allEntries(): [string, Farm][] {
  return Object.keys(load()).map((id) => [id, get(id)]);
}

/** Resolve a spoken field name loosely, "the north field" should find "North 40". */
export function findField(farm: Farm, spoken: string): Field | null {
  if (!farm.fields.length) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\b(the|field|place|acres?)\b/g, '').trim();
  const want = norm(spoken);
  if (!want) return farm.fields[0];
  return (
    farm.fields.find((f) => norm(f.name) === want) ??
    farm.fields.find((f) => norm(f.name).includes(want) || want.includes(norm(f.name))) ??
    null
  );
}

export function findEquipment(farm: Farm, spoken?: string): Equipment | null {
  if (!farm.equipment.length) return null;
  if (!spoken) return farm.equipment[0];
  const want = spoken.toLowerCase();
  return (
    farm.equipment.find((e) => e.name.toLowerCase() === want) ??
    farm.equipment.find((e) => e.name.toLowerCase().includes(want)) ??
    farm.equipment[0]
  );
}
