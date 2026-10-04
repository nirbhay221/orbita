/** Farm state: fields, equipment, watches, crew and a job log. Memory-resident, flushed to disk on write. */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Equipment, Field } from './domain.js';
import * as vault from './vault.js';
import { createHash, randomInt } from 'node:crypto';

export type NotifyReason = 'window_clear' | 'storm';

export type CrewContact = {
  name: string;
  email: string;
  role: string | null;
  notifyOn: NotifyReason[];
  addedAt: string;
  /** Null until the customer says to go ahead. Nothing is ever sent to an unconfirmed contact. */
  confirmedAt: string | null;
  /** When the person who owns the address agreed to be emailed. See consent.ts. */
  acceptedAt?: string | null;
  /** A hash of the invitation they were sent. Cleared once it is used. */
  acceptHash?: string | null;
  /** What the stop link in every email carries. */
  stopId?: string | null;
  invitedAt?: string | null;
  /** The link to this person's working day on the heat safety server, once they have shared it. See crewday.ts. */
  dayLink?: string | null;
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
  /** Accounts invited to look at this farm. They can ask about it and change nothing. */
  sharedWith?: string[];
  /** A one-time code somebody can join with, kept as a hash, with the time it stops working. */
  invite?: { hash: string; expires: string } | null;
  /** The farm this account was invited to look at, if any. Checked against that farm's own list. */
  viewing?: string | null;
  /**
   * When this record was last written, as an ISO string on the record itself.
   *
   * It lived in a Map in memory first, which meant a restart forgot every one
   * of them, and since a deploy restarts the process the seven day expiry never
   * fired on anything that had been loaded from disk. A promise about deleting
   * data is worth nothing if a redeploy quietly resets the clock.
   */
  touchedAt?: string;
};

const DATA_PATH = resolve(process.env.ORBITA_DATA ?? './data/farms.json');
const empty = (): Farm => ({ fields: [], equipment: [], waiting: [], crew: [], jobLog: [], alertsSent: [] });

let cache: Record<string, Farm> | null = null;

/** Binds this file to its purpose, so a different sealed file cannot be swapped in. */
const PURPOSE = 'orbita:farms:v1';

/**
 * Set a damaged file aside instead of overwriting it.
 *
 * The loader used to end `catch { cache = {} }`. A file that would not parse became
 * an empty database, and the next ordinary write replaced the unreadable file with
 * the empty one, so corruption quietly deleted every farm and nothing said so. A
 * rename keeps every byte, and the server carries on with nothing rather than refusing
 * to start, and says loudly what happened and where the evidence is.
 */
function quarantine(why: string): void {
  const aside = `${DATA_PATH}.corrupt-${Date.now()}`;
  try {
    renameSync(DATA_PATH, aside);
    console.error(`[store] ${why} The file was set aside at ${aside} and this process is starting empty.`);
  } catch (err) {
    throw new Error(`[store] ${why} It could not be set aside either: ${String(err)}`);
  }
}

function load(): Record<string, Farm> {
  if (cache) return cache;
  if (!existsSync(DATA_PATH)) {
    cache = {};
    return cache;
  }

  const raw = readFileSync(DATA_PATH, 'utf8');
  try {
    const opened = vault.open(raw, PURPOSE);
    cache = JSON.parse(opened.plain) as Record<string, Farm>;
    // A key was configured after this was written in the clear, or it was sealed
    // under a key since rotated out: seal it under the current one now, not whenever
    // an unrelated write happens to come along.
    if (vault.encryptionOn() && (!opened.wasSealed || !vault.isCurrentKey(opened.keyId))) {
      flush();
      console.error(opened.wasSealed ? '[store] re-sealed the farms file under the current key.' : '[store] the farms file was plaintext and is now sealed.');
    }
    return cache;
  } catch (err) {
    if (err instanceof vault.VaultError) {
      // A wrong or missing key is a configuration mistake and the file is fine.
      // Touching it would turn a typo in an environment variable into data loss.
      if (err.code === 'no_key' || err.code === 'unknown_key') throw err;
      quarantine(`The farms file failed verification (${err.code}).`);
    } else {
      quarantine('The farms file could not be parsed.');
    }
    cache = {};
    return cache;
  }
}

function flush(): void {
  if (!cache) return;
  mkdirSync(dirname(DATA_PATH), { recursive: true, mode: 0o700 });
  // Written beside the file and renamed over it, which is atomic on one
  // filesystem. A crash partway through a direct write leaves a truncated file,
  // and half a record is worse than none: it still parses, so nothing complains.
  const text = vault.encryptionOn() ? JSON.stringify(cache) : JSON.stringify(cache, null, 2);
  const tmp = `${DATA_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, vault.sealIfConfigured(text, PURPOSE), { mode: 0o600 });
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

/**
 * The sandbox has its own, much smaller, ceiling.
 *
 * Every farm with a field in it is polled for ground magnetometer and ionosphere
 * data, and every crew address on a demo farm is somewhere an email could go. So the
 * number of demo records is, through a side door, the load this server puts on free
 * public services on behalf of strangers. Three hundred is far more than anyone
 * clicking through a demo reaches, and when it is full the least recently touched
 * sandbox goes, so a newcomer is never refused.
 */
const MAX_DEMO_RECORDS = Number(process.env.ORBITA_MAX_DEMO_RECORDS ?? 300);
const touched = new Map<string, number>();

const isDemo = (id: string) => id.startsWith('demo:');

function evictOldestDemo(all: Record<string, Farm>): boolean {
  const demo = Object.keys(all).filter(isDemo);
  if (!demo.length) return false;
  // After a restart nothing has been touched in memory yet, so fall back to the time of the last write.
  const last = (id: string) => touched.get(id) ?? (Date.parse(String(all[id]?.touchedAt ?? '')) || 0);
  const oldest = demo.reduce((a, b) => (last(a) <= last(b) ? a : b));
  delete all[oldest];
  touched.delete(oldest);
  return true;
}

function makeRoom(forId: string): void {
  const all = load();
  if (isDemo(forId)) {
    while (Object.keys(all).filter(isDemo).length >= MAX_DEMO_RECORDS) if (!evictOldestDemo(all)) break;
    return;
  }
  // A linked account is never refused and never evicted. If the total is full the
  // sandbox pays for it.
  if (Object.keys(all).length >= MAX_RECORDS) evictOldestDemo(all);
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

/**
 * Drop the in-memory cache and read the file again, the way a restart does.
 * Exported for tests: the expiry clock has to live in the file, and the only
 * honest way to check that is to throw away everything memory is holding.
 */
export function reloadForTest(): void {
  cache = null;
  touched.clear();
}

export function expireDemoRecords(now = Date.now()): number {
  const all = load();
  let gone = 0;
  for (const id of Object.keys(all)) {
    if (!id.startsWith('demo:')) continue;
    // The record's own timestamp first, because that one survives a restart.
    // The in-memory map is only a faster answer for records touched since boot.
    const written = all[id]?.touchedAt ? Date.parse(String(all[id].touchedAt)) : null;
    const last = touched.get(id) ?? (Number.isFinite(written) ? (written as number) : null);
    if (last != null && now - last <= DEMO_TTL_MS) continue;
    // Written before this field existed: give it one TTL from first sight, then
    // it goes. Stamping it here means the clock starts rather than never runs.
    if (last == null) {
      all[id].touchedAt = new Date(now).toISOString();
      continue;
    }
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
  // Deleted, not blanked: an empty record with an id is still a record of somebody having been here.
  delete all[farmId];
  touched.delete(farmId);
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

/**
 * What one farm can hold, in two sizes.
 *
 * flush() rewrites the whole file, synchronously, on every update, so one record with
 * a hundred thousand fields does not just sit there: it makes every write for every
 * other farm slow, and on a single threaded server slow means stopped. Nothing bounded
 * these.
 *
 * The obvious fix, one flat number, is wrong for this product. A real operation has
 * hundreds of fields, and a limit of sixty would silently drop a genuine farm's data
 * while protecting nobody. A linked account had to set a passphrase and is given room;
 * the public sandbox is where a stranger can grow a record for free, and gets very
 * little, because nobody tries a demo with fifty combines.
 *
 * The tools refuse politely before these are reached, and this is the backstop that
 * guarantees a bound.
 */
export const LIMITS = {
  account: { fields: 500, equipment: 100, waiting: 200, crew: 30 },
  demo: { fields: 20, equipment: 10, waiting: 10, crew: 3 },
} as const;

export const limitsFor = (id: string) => (isDemo(id) ? LIMITS.demo : LIMITS.account);

function prune(f: Farm, id: string): void {
  const lim = limitsFor(id);
  if (f.fields.length > lim.fields) f.fields = f.fields.slice(-lim.fields);
  if (f.equipment.length > lim.equipment) f.equipment = f.equipment.slice(-lim.equipment);
  if (f.waiting.length > lim.waiting) f.waiting = f.waiting.slice(-lim.waiting);
  if (f.crew.length > lim.crew) f.crew = f.crew.slice(-lim.crew);
  if (f.jobLog.length > MAX_JOB_LOG) f.jobLog = f.jobLog.slice(-MAX_JOB_LOG);
  if (f.alertsSent.length > MAX_ALERTS_REMEMBERED) f.alertsSent = f.alertsSent.slice(-MAX_ALERTS_REMEMBERED);
}

export function update(farmId: string, fn: (f: Farm) => void): Farm {
  const all = load();
  if (!all[farmId]) makeRoom(farmId);
  const f = { ...empty(), ...(all[farmId] ?? {}) };
  f.waiting = f.waiting.map((w, i) => ({ ...w, id: w.id ?? `watch-legacy-${i}`, notifiedAt: w.notifiedAt ?? null }));
  all[farmId] = f;
  touched.set(farmId, Date.now());
  f.touchedAt = new Date().toISOString();
  fn(f);
  prune(f, farmId);
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
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\b(the|field|place|acres?)\b/g, '').replace(/\s+/g, ' ').trim();
  const want = norm(spoken);
  if (!want) return farm.fields[0];
  // A name that normalises to nothing (one written in another script, or just "the field") used to match
  // every question, because every string contains the empty string.
  const named = farm.fields.filter((f) => norm(f.name));
  return (
    farm.fields.find((f) => f.name.trim().toLowerCase() === spoken.trim().toLowerCase()) ??
    named.find((f) => norm(f.name) === want) ??
    named.find((f) => norm(f.name).includes(want) || want.includes(norm(f.name))) ??
    null
  );
}

/** The machine that was actually named, or null. findEquipment falls back to the first one; this does not. */
export function equipmentNamed(farm: Farm, spoken: string): Equipment | null {
  const want = spoken.trim().toLowerCase();
  if (!want) return null;
  return (
    farm.equipment.find((e) => e.name.toLowerCase() === want) ??
    farm.equipment.find((e) => e.name && (e.name.toLowerCase().includes(want) || want.includes(e.name.toLowerCase()))) ??
    null
  );
}

export function findEquipment(farm: Farm, spoken?: string): Equipment | null {
  if (!farm.equipment.length) return null;
  if (!spoken) return farm.equipment[0];
  return equipmentNamed(farm, spoken) ?? farm.equipment[0];
}

/* ------------------------------------------------------------------ *
 * A second person.
 *
 * The crew used to be people who received an email and nothing more. The person the answer matters to most
 * is often not the account holder: it is the operator in the cab, who wants to ask "is it clear yet" for
 * himself. The owner asks for a code, reads it to them, and they join with it from their own account. From
 * then on their questions are answered about the owner's fields. They can read and cannot change anything:
 * every tool that writes still writes to their own record.
 *
 * A code is eight digits, works once, lasts a day and is stored as a hash. The link is held on both sides and
 * checked on the owner's, so it ends the moment the owner removes them.
 * ------------------------------------------------------------------ */
const INVITE_MS = 24 * 60 * 60 * 1000;
const MAX_SHARED = 20;
const hashCode = (code: string) => createHash('sha256').update(`orbita-invite:${code}`).digest('hex');
export const normaliseCode = (spoken: string): string => String(spoken ?? '').replace(/\D/g, '');

export function createInvite(farmId: string, now = Date.now()): string {
  const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
  update(farmId, (f) => void (f.invite = { hash: hashCode(code), expires: new Date(now + INVITE_MS).toISOString() }));
  return code;
}

export type Joined = { ok: true; farmId: string } | { ok: false; why: 'unknown' | 'own' | 'full' };

export function joinWithCode(memberId: string, spoken: string, now = Date.now()): Joined {
  const code = normaliseCode(spoken);
  if (code.length !== 8) return { ok: false, why: 'unknown' };
  const hash = hashCode(code);
  const all = load();
  const farmId = Object.keys(all).find((id) => all[id].invite?.hash === hash && Date.parse(all[id].invite!.expires) > now);
  if (!farmId) return { ok: false, why: 'unknown' };
  if (farmId === memberId) return { ok: false, why: 'own' };
  if ((all[farmId].sharedWith ?? []).length >= MAX_SHARED) return { ok: false, why: 'full' };
  update(farmId, (f) => {
    f.invite = null; // one use
    f.sharedWith = [...new Set([...(f.sharedWith ?? []), memberId])];
  });
  update(memberId, (f) => void (f.viewing = farmId));
  return { ok: true, farmId };
}

/** The farm this account may look at, or null. True only while the owner still lists them. */
export function viewedBy(memberId: string): string | null {
  const all = load();
  const farmId = all[memberId]?.viewing;
  if (!farmId || !all[farmId]) return null;
  return (all[farmId].sharedWith ?? []).includes(memberId) ? farmId : null;
}

export function leave(memberId: string): boolean {
  const farmId = load()[memberId]?.viewing;
  if (!farmId) return false;
  update(memberId, (f) => void (f.viewing = null));
  if (load()[farmId]) update(farmId, (f) => void (f.sharedWith = (f.sharedWith ?? []).filter((m) => m !== memberId)));
  return true;
}

/** End sharing from the owner's side. Returns how many people lost access. */
export function stopSharing(farmId: string): number {
  const n = (load()[farmId]?.sharedWith ?? []).length;
  if (load()[farmId]) update(farmId, (f) => { f.sharedWith = []; f.invite = null; });
  return n;
}
