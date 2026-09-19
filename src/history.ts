/**
 * Historical Kp, for answering "why were my rows crooked last Tuesday".
 *
 * NOAA's live products only reach back about seven days. GFZ Potsdam produce the
 * Kp index itself and publish the full archive, free and without a key, so deeper
 * lookbacks and the May 2024 replay both come from there.
 *
 * Looking backward matters as much as looking forward. A farmer who is told to
 * hold off and complies never sees what would have happened, so the forecast can
 * never prove itself. A farmer who asks what went wrong on Tuesday and gets a
 * number does not need convincing again.
 */

import type { Slot } from './domain.js';

const GFZ = 'https://kp.gfz.de/app/json/';

/** Small cache: the past does not change, so a fetched day is good forever. */
const cache = new Map<string, Slot[]>();

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

export async function fetchRange(from: Date, to: Date): Promise<Slot[]> {
  const key = `${dayKey(from)}..${dayKey(to)}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const url = `${GFZ}?start=${from.toISOString().slice(0, 19)}Z&end=${to.toISOString().slice(0, 19)}Z&index=Kp`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`GFZ: HTTP ${res.status}`);
    const body = (await res.json()) as { datetime?: string[]; Kp?: number[] };
    const times = body.datetime ?? [];
    const kps = body.Kp ?? [];
    const slots: Slot[] = times
      .map((t, i) => ({ time: new Date(t).toISOString(), kp: Number(kps[i]), observed: true }))
      .filter((s) => Number.isFinite(s.kp));
    if (slots.length) cache.set(key, slots);
    return slots;
  } finally {
    clearTimeout(timer);
  }
}

/** The day surrounding a moment, so we can report the peak rather than one block. */
export async function fetchDay(when: Date): Promise<Slot[]> {
  const from = new Date(when);
  from.setUTCHours(0, 0, 0, 0);
  // One minute short of the next midnight: a UTC day is eight 3-hour blocks,
  // and asking through midnight exactly returns the next day's first block too.
  const to = new Date(from.getTime() + 24 * 3600_000 - 60_000);
  return fetchRange(from, to);
}

/**
 * Resolve casual spoken dates. A farmer says "last Tuesday" or "the tenth of May",
 * not an ISO timestamp, and the model may hand either through.
 */
export function parseWhen(spoken: string, now = new Date()): Date | null {
  const s = spoken.trim().toLowerCase();

  const iso = Date.parse(spoken);
  if (Number.isFinite(iso)) return new Date(iso);

  if (s === 'today') return now;
  if (s === 'yesterday') return new Date(now.getTime() - 86400_000);

  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const named = days.findIndex((d) => s.includes(d));
  if (named >= 0) {
    const back = (now.getUTCDay() - named + 7) % 7 || 7; // "tuesday" means the last one, not today
    return new Date(now.getTime() - back * 86400_000);
  }

  const ago = /(\d+)\s*(day|week)s?\s*ago/.exec(s);
  if (ago) {
    const n = Number(ago[1]) * (ago[2] === 'week' ? 7 : 1);
    return new Date(now.getTime() - n * 86400_000);
  }
  return null;
}
