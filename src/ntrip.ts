/**
 * The base station that is actually there.
 *
 * `baselineKm` is the single most consequential number this server holds. It sets
 * how much of the ionosphere an RTK correction can cancel, so it drives the
 * residual computed in glotec.ts, and through that the difference between "clear
 * for planting" and "hold off".
 *
 * Until now it was typed in. A field is registered with `baselineKm: 18` because
 * somebody remembered roughly how far the base station was, or left it out
 * entirely, and every metre of measured ionospheric gradient was then multiplied
 * by a guess.
 *
 * It does not have to be a guess. RTK corrections reach a rover over NTRIP, and
 * the casters that carry them publish a sourcetable: every mountpoint, with the
 * latitude and longitude of the station behind it. RTK2go is the free community
 * caster and carries over 700 stations worldwide. So the nearest real correction
 * source to a field, and the true distance to it, is a lookup rather than a
 * recollection.
 *
 * This is the closest thing Orbita has to a device integration, and it needs no
 * device. The hardware exists, deployed by other people, and the network says
 * where it is.
 *
 * Two things learned getting this working, both recorded because they are the
 * kind of thing that costs an afternoon:
 *
 * The caster answers 403 to an ordinary HTTP request. NTRIP requires a
 * protocol-shaped `User-Agent`, literally beginning with the word NTRIP, and
 * sends the sourcetable only to a client that identifies itself as one.
 *
 * And the distances are bad news, which is the useful part. The nearest community
 * base station to a Nebraska field is about 174 km away, and to central Iowa about
 * 137 km. RTK assumes the ionosphere is the same over the baseline, and over 150
 * km during a storm it very much is not. A farmer who thinks they are getting
 * centimetres from a base that far away is the exact person this add-on exists to
 * warn, and until now Orbita could not tell them because it believed whatever
 * number they typed.
 *
 * What this does not do. It does not connect to a caster, subscribe to a
 * mountpoint, or decode RTCM. It reads the public directory of where stations are.
 * Whether a given mountpoint is actually up, and whether its published position is
 * accurate, is not something the sourcetable can be trusted for: these are
 * volunteer stations and the caster guarantees neither. So this offers a distance
 * and names the station, and never claims the correction works.
 *
 * Source: RTK2go community NTRIP caster, http://rtk2go.com:2101/
 *
 * One caster was one country's answer. RTK2go lists 767 streams, 142 of them in the US, and 9 in France, 8 in
 * Italy, 28 in Australia; read on 18 October 2026, the national and community networks beside it list far more
 * where Alexa+ is sold: Centipede 751 in France, Geoscience Australia 732 in Australia, EUREF 53 in Italy and 35 in
 * Spain. A field near Lyon was told its nearest public base was a long way off when hundreds were closer, and the
 * distance is what an RTK error scales with. So four directories are read, and the nearest station from any of them
 * is named with the network it belongs to and what it takes to use it, from that network's own NET line: every one
 * of them asks for a login, Geoscience Australia and EUREF by registration, and some Australian streams charge.
 * Only the public directory is read; no stream is ever opened. Brazil's RBMC caster did not answer, and India has
 * one or two public stations, which is said as it is.
 *   http://caster.centipede.fr:2101/ (terms: https://www.centipede-rtk.org/terms-conditions)
 *   https://ntrip.data.gnss.ga.gov.au/ (https://gnss.ga.gov.au/stream)
 *   http://euref-ip.net:2101/ (http://register.rtcm-ntrip.org)
 */

import { backoff } from './backoff.js';

type Caster = { url: string; network: string; signup: string };
const CASTERS: Caster[] = process.env.ORBITA_NTRIP_CASTER
  ? [{ url: process.env.ORBITA_NTRIP_CASTER, network: 'the community caster', signup: 'a login from whoever runs it' }]
  : [
      { url: 'http://rtk2go.com:2101/', network: 'RTK2go', signup: 'a free RTK2go login' },
      { url: 'http://caster.centipede.fr:2101/', network: 'Centipede', signup: 'a free Centipede login' },
      { url: 'https://ntrip.data.gnss.ga.gov.au/', network: 'Geoscience Australia', signup: 'free registration with Geoscience Australia' },
      { url: 'http://euref-ip.net:2101/', network: 'EUREF', signup: 'free registration with EUREF' },
    ];

/**
 * The directory changes as volunteers come and go, which is a timescale of days.
 * Once every six hours is generous and keeps a free community service out of a
 * polling loop it never agreed to.
 */
const EVERY_MS = 6 * 60 * 60 * 1000;
const STALE_MS = 48 * 60 * 60 * 1000;

/** Beyond this a "nearest base station" is not a useful thing to tell anybody. */
const MAX_USEFUL_KM = 500;

const EARTH_KM = 6371;

export type Station = {
  /** The caster mountpoint, which is what a receiver would be pointed at. */
  mountpoint: string;
  /** The human name the operator gave it. */
  name: string;
  country: string;
  lat: number;
  lon: number;
  /** RTCM version string as published, e.g. "RTCM 3.2". */
  format: string;
  /** Constellations the stream carries, e.g. "GPS+GLO+GAL+BeiDou". */
  systems: string;
  /** Whether the caster says the stream needs authentication or charges a fee. */
  open: boolean;
  /** Whether the caster marks the stream as charged for. */
  fee?: boolean;
  /** The network that publishes it, and what it takes to use it. See CASTERS. */
  network?: string;
  signup?: string;
};

export type Nearest = {
  station: Station;
  km: number;
  /** How many stations sit within MAX_USEFUL_KM, so a customer knows if there is a choice. */
  alternatives: number;
};

let stations: Station[] = [];
let fetchedAt = 0;
let lastError = '';
let timer: ReturnType<typeof setInterval> | null = null;

/** Test seam, so tests never reach the caster. */
let load: () => Promise<Station[]> = fetchAll;
/** Each directory's last good list, so one network being down never empties the others. */
const held = new Map<string, Station[]>();

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Parse an NTRIP sourcetable.
 *
 * Semicolon separated, one record per line, and only `STR` lines describe a
 * stream. Field order is fixed by the NTRIP specification: mountpoint, identifier,
 * format, format details, carrier, navigation systems, network, country, latitude,
 * longitude, then flags. A station with an unparseable position is dropped rather
 * than defaulted, because a base station at 0,0 in the Gulf of Guinea would
 * silently become the nearest one to nothing in particular.
 */
export function parseSourcetable(text: string): Station[] {
  const out: Station[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('STR;')) continue;
    const f = line.split(';');
    if (f.length < 11) continue;
    const lat = Number(f[9]);
    const lon = Number(f[10]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    // A station that reports exactly 0,0 has not reported a position.
    if (lat === 0 && lon === 0) continue;
    out.push({
      mountpoint: f[1],
      name: f[2] || f[1],
      country: f[8] || '',
      lat,
      lon,
      format: f[3] || '',
      systems: f[6] || '',
      // The caster publishes an auth flag ("N" none, "B" basic) and a fee flag.
      open: (f[15] ?? 'N') === 'N' && (f[16] ?? 'N') === 'N',
      fee: (f[16] ?? 'N') === 'Y',
    });
  }
  return out;
}

async function fetchAll(): Promise<Station[]> {
  const got = await Promise.allSettled(CASTERS.map((c) => fetchSourcetable(c)));
  got.forEach((r, i) => { if (r.status === 'fulfilled' && r.value.length) held.set(CASTERS[i].url, r.value); });
  if (!got.some((r) => r.status === 'fulfilled')) throw new Error(String((got[0] as PromiseRejectedResult).reason));
  return [...held.values()].flat();
}

async function fetchSourcetable(caster: Caster): Promise<Station[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(caster.url, {
      signal: ctrl.signal,
      headers: {
        // Not optional. The caster answers 403 to anything that does not identify
        // itself as an NTRIP client, and the word NTRIP has to come first.
        'User-Agent': 'NTRIP orbita/0.1',
        'Ntrip-Version': 'Ntrip/2.0',
      },
    });
    if (!res.ok) throw new Error(`caster ${res.status}`);
    return parseSourcetable(await res.text()).map((st) => ({ ...st, network: caster.network, signup: caster.signup }));
  } finally {
    clearTimeout(t);
  }
}

/** The closest published base station to a site, or nothing useful nearby. */
export function nearest(lat: number, lon: number): Nearest | null {
  if (!stations.length || Date.now() - fetchedAt > STALE_MS) return null;
  let best: Station | null = null;
  let bestKm = Infinity;
  let within = 0;
  for (const s of stations) {
    const km = haversineKm(lat, lon, s.lat, s.lon);
    if (km <= MAX_USEFUL_KM) within += 1;
    if (km < bestKm) {
      bestKm = km;
      best = s;
    }
  }
  if (!best || bestKm > MAX_USEFUL_KM) return null;
  return { station: best, km: Math.round(bestKm), alternatives: Math.max(0, within - 1) };
}

/**
 * What to say about where the corrections actually come from, or nothing.
 *
 * This only speaks when no baseline was given. That is a deliberate narrowing of
 * what it first tried to do.
 *
 * The first version also second-guessed a stored baseline that looked optimistic
 * next to the public network: a field recorded at 18 km when the nearest community
 * stream is 174 km away. That is wrong, and it is wrong in a way that would have
 * cost trust. A base station on a grain bin 18 km from a field is an ordinary
 * thing for a farm to own, and network RTK subscriptions give short effective
 * baselines too. The customer knows where their base is; this knows where other
 * people's are. When they have told us, believe them.
 *
 * What it can say usefully is what happens when they have not told us, because the
 * alternative is a default, and the default was silently driving the residual
 * arithmetic in glotec.ts.
 */
export function explain(lat: number, lon: number, storedKm: number | undefined): string {
  // They told us. Their own base is their own base.
  if (storedKm !== undefined) return '';

  const n = nearest(lat, lon);
  if (!n) {
    if (!stations.length) return '';
    return (
      'You have not told me your baseline, and there is no public correction stream within 500 km of ' +
      'this field on the public networks I read. If you are not running your own base station, that is worth ' +
      'knowing before trusting a centimetre-level tolerance.'
    );
  }

  const auth = n.station.fee
    ? ` That stream is charged for, through ${n.station.network ?? 'whoever runs it'}.`
    : n.station.open ? '' : ` That stream needs ${n.station.signup ?? 'credentials from whoever runs it'}.`;
  const on = n.station.network ? `, on the ${n.station.network} network` : '';
  return (
    `You have not told me your baseline. The nearest public correction stream is ${n.station.name}${on}, ` +
    `about ${n.km} km away, with ${n.alternatives} other stations inside 500 km.${auth} If you run your ` +
    `own base station the distance to that is what matters. If you rely on a public stream, ${n.km} km ` +
    'is a long way for RTK to assume the ionosphere is the same at both ends, and it is the distance ' +
    'the expected error scales with.'
  );
}


const gate = backoff();

export async function refresh(): Promise<void> {
  if (!gate.ready()) return;
  try {
    const next = await load();
    if (next.length) {
      stations = next;
      fetchedAt = Date.now();
      lastError = '';
      gate.ok();
    } else {
      lastError = 'sourcetable had no usable stations';
      gate.fail();
    }
  } catch (err) {
    // The stored baseline still answers, so a failure costs the refinement and
    // nothing else.
    lastError = String(err);
    gate.fail();
  }
}

export async function start(everyMs = EVERY_MS): Promise<void> {
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

export function status(): { stations: number; ageHours: number | null; error?: string } {
  return {
    stations: stations.length,
    ageHours: fetchedAt ? Math.round((Date.now() - fetchedAt) / 3.6e6) : null,
    ...(lastError ? { error: lastError } : {}),
  };
}

export function seedForTest(next: { load?: () => Promise<Station[]>; stations?: Station[] }): void {
  if (next.load) load = next.load;
  if (next.stations) {
    stations = next.stations;
    fetchedAt = Date.now();
  }
}

export function resetForTest(): void {
  gate.reset();
  stations = [];
  fetchedAt = 0;
  lastError = '';
  load = fetchAll;
  held.clear();
}

export const limits = { MAX_USEFUL_KM };
