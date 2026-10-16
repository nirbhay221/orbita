/**
 * When it is not the sun.
 *
 * Everything else here asks whether space weather will break a fix. A receiver also loses its fix for reasons
 * that have nothing to do with the sun, and a crew that has been told "the sky is quiet" needs to hear those,
 * or it blames the forecast, or the dealer. Three of them are published:
 *
 *   Planned GPS interference tests. The military jams GPS on purpose in exercises, and the US Coast Guard
 *   Navigation Center publishes the schedule: where, from when to when, and how far the effect reaches at 50 feet
 *   above the ground, which is where a tractor is. In March 2026 exercises on the North Carolina coast took
 *   auto-steer down on farms that had no idea why. The schedule is a two-page PDF, read here every few hours.
 *     https://www.navcen.uscg.gov/sites/default/files/pdf/gps/gpsnotices/GPS_Interference.pdf
 *   When the Coast Guard refuses the read, as it does from cloud servers, the same tests come from the FAA's flight
 *   advisories on FAASafety.gov (see readFaaTests below).
 *
 *   GPS satellites out of service. The GPS control segment publishes every outage, past, current and scheduled,
 *   as the Satellite Outage File. One satellite out of about thirty rarely breaks a fix on a receiver that also
 *   tracks Galileo and GLONASS, so it is said as that: something to rule out, not something to stop for.
 *     https://www.navcen.uscg.gov/sites/default/files/gps/sof/current_sof.sof
 *   The Coast Guard's site answers automated reads from cloud servers, the deployed one included, with a 403, so
 *   when it does the same file is read from CelesTrak (T.S. Kelso), which has mirrored it for years: its
 *   current_sof.txt names the newest file, and that file is the control segment's own, byte for byte.
 *     https://celestrak.org/GPS/sof/current_sof.txt
 *
 *   Interference that aircraft reported. Every airliner broadcasts how much it trusts its own GPS. GPSJAM
 *   (John Wiseman) counts, for each day and each hexagon of the map, how many aircraft reported good and bad
 *   navigation accuracy, from airplanes.live and ADS-B Exchange, and colours a hexagon red when more than ten
 *   percent reported bad. It is a day behind, it is measured at altitude, and it does not say what caused it:
 *   it is said here as exactly that, a sign of interference in the area and not proof of it on the ground.
 *     https://gpsjam.org/faq   Turned off with ORBITA_GPSJAM=off.
 *
 * What is not published anywhere, and so is said as a thing to check and never as a finding: the correction
 * link. A dropped cellular connection to the RTK network looks exactly like a storm from the cab.
 *
 * As everywhere else here, a source that could not be read is "could not check", never "nothing there".
 */

import { gridDisk, latLngToCell } from 'h3-js';
import * as spoofing from './spoofing.js';

export type GpsTest = { name: string; id: string; place: string; lat: number; lon: number; groundNm: number; start: string; end: string; milesAway?: number };
export type SatOutage = { prn: number; start: string; end: string | null; scheduled: boolean };
export type Reported = { date: string; pct: number; aircraft: number; level: 'high' | 'some' };
export type Found = {
  tests: GpsTest[];
  satellites: SatOutage[];
  reported: Reported | null;
  /** Which of the three could not be read, so the answer can say so. */
  unchecked: string[];
  /** Too few aircraft crossed the area that day for their reports to say anything either way. */
  sparse?: boolean;
  /** A region the FAA or EASA lists for routine jamming and spoofing. See spoofing.ts. */
  zone?: spoofing.Zone | null;
  /** Outside the United States, where the Coast Guard's test schedule says nothing either way. */
  abroad?: boolean;
};

/*
 * The Coast Guard's schedule is for tests in the United States. Elsewhere planned military jamming is announced
 * too, but not in a form that can be read: the UK's CAA and Australia's Defence give notice by NOTAM a few days
 * ahead (CAA Skywise alert SW2026/262; AvSEF consultations), and their pages refuse automated reads. So outside
 * the United States a quiet schedule is never said as "no test was scheduled", and the answer says where to look.
 *   https://skywise.caa.co.uk/alerts/upcoming-jamming-activity-jul-aug-2026/
 *   https://www.avsef.gov.au/consultations/proposed-gnss-jamming-jervis-bay-airfield-yjby-nowra
 */
const US_BOXES = [
  { lat: [24.3, 49.5], lon: [-125.0, -66.8] }, // the lower 48
  { lat: [51.0, 71.6], lon: [-180.0, -129.0] }, // Alaska
  { lat: [18.8, 22.4], lon: [-160.5, -154.6] }, // Hawaii
  { lat: [17.8, 18.6], lon: [-67.4, -65.2] }, // Puerto Rico
];
export const inUS = (lat: number, lon: number): boolean => US_BOXES.some((b) => lat >= b.lat[0] && lat <= b.lat[1] && lon >= b.lon[0] && lon <= b.lon[1]);
export const ABROAD_NOTE =
  'Planned military GPS tests are published for the United States only; elsewhere they are announced to pilots by NOTAM a few days ahead, so ask your dealer or check the local NOTAMs.';

const AGENT = { 'User-Agent': 'orbita/0.1 (Alexa+ add-on; GNSS fieldwork)' };
const TESTS_URL = 'https://www.navcen.uscg.gov/sites/default/files/pdf/gps/gpsnotices/GPS_Interference.pdf';
const SOF_URL = 'https://www.navcen.uscg.gov/sites/default/files/gps/sof/current_sof.sof';
const JAM = 'https://gpsjam.org/data';
const EVERY_MS = 6 * 60 * 60 * 1000;
const STALE_MS = 3 * 24 * 60 * 60 * 1000;
const NM_TO_MILES = 1.15078;

let tests: { list: GpsTest[]; at: number; updated: string | null } | null = null;
let sats: { list: SatOutage[]; at: number } | null = null;
/** Aircraft counts by hexagon, by day. A few days are kept, for "what happened yesterday". */
const jamDays = new Map<string, Map<string, [number, number]>>();
let jamLatest: string | null = null;

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** The schedule's text, one test a line: "33-50-01N 080-29-28W31NM119NM17 Oct28 SepColumbia, SCGPS 26-01PECRSC". */
export function parseTests(text: string): { list: GpsTest[]; updated: string | null } {
  const year = Number(/NAVCEN\s+(\d{4})\s+GPS TESTING/i.exec(text)?.[1] ?? new Date().getUTCFullYear());
  const updated = /LAST UPDATE\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i.exec(text)?.[1] ?? null;
  const row = /(\d{2})-(\d{2})-(\d{2})([NS])\s+(\d{2,3})-(\d{2})-(\d{2})([EW])\s*(\d+)\s*NM\s*(\d+)\s*NM\s*(\d{1,2})\s*([A-Za-z]{3})\s*(\d{1,2})\s*([A-Za-z]{3})\s*(.+?)\s*GPS\s*(\d{2}-\d{2,3})\s*([A-Z0-9_]+)/g;
  const list: GpsTest[] = [];
  for (const m of text.matchAll(row)) {
    const lat = (Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600) * (m[4] === 'S' ? -1 : 1);
    const lon = (Number(m[5]) + Number(m[6]) / 60 + Number(m[7]) / 3600) * (m[8] === 'W' ? -1 : 1);
    const endM = MONTHS[m[12].toLowerCase()];
    const startM = MONTHS[m[14].toLowerCase()];
    if (endM == null || startM == null) continue;
    // A test listed as ending in January and starting in December started the year before.
    const start = new Date(Date.UTC(startM > endM ? year - 1 : year, startM, Number(m[13]), 0, 0, 0));
    const end = new Date(Date.UTC(year, endM, Number(m[11]), 23, 59, 59));
    list.push({ name: m[17], id: `GPS ${m[16]}`, place: m[15].trim(), lat, lon, groundNm: Number(m[9]), start: start.toISOString(), end: end.toISOString() });
  }
  return { list, updated };
}

/** The Satellite Outage File: outages that are current, scheduled, or ended in the last few weeks. */
export function parseSof(xml: string, now = Date.now()): SatOutage[] {
  const out: SatOutage[] = [];
  const when = (a: Record<string, string>, p: 'START' | 'END'): string | null => {
    const y = Number(a[`${p}_YEAR`]);
    const d = Number(a[`${p}_DOY`]);
    if (!Number.isFinite(y) || !Number.isFinite(d) || !y) return null;
    return new Date(Date.UTC(y, 0, d, Number(a[`${p}_HR`] ?? 0), Number(a[`${p}_MIN`] ?? 0), Number(a[`${p}_SEC`] ?? 0))).toISOString();
  };
  for (const m of xml.matchAll(/<(HISTORICAL|CURRENT|PREDICTED)\s+([^>]*?)\/>/g)) {
    const a = Object.fromEntries([...m[2].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    const start = when(a, 'START');
    if (!start) continue;
    const end = when(a, 'END');
    // History is thirty years long; only what could explain a recent bad day is kept.
    if (m[1] === 'HISTORICAL' && (!end || Date.parse(end) < now - 21 * 86_400_000)) continue;
    out.push({ prn: Number(a.SVID), start, end, scheduled: m[1] === 'PREDICTED' });
  }
  return out;
}

async function get(url: string, timeoutMs = 15_000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: AGENT });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/*
 * The same tests, from the FAA, when the Coast Guard refuses.
 *
 * The Coast Guard's site answers automated reads from cloud servers with a 403, the deployed one included, and the
 * schedule has no mirror. The FAA announces every one of these tests to pilots as a flight advisory on FAASafety.gov,
 * whose public notice list a server can read: each "GPS Interference Testing" notice links a one-page PDF with the
 * test's name, its centre, the radius it reaches at 50 feet above the ground, and its dates in UTC.
 *   https://www.faasafety.gov/SPANS/notices_public.aspx
 */
const FAA = 'https://www.faasafety.gov';
const advisories = new Map<string, GpsTest[]>();

/**
 * One FAA flight advisory for a GPS interference test, read from its text: one entry per window the test is
 * scheduled in, so a test counts only during its own hours. Empty when the text is not such an advisory.
 *
 *   B. Dates and times (Dates and times are based on GMT (Z).):
 *   20 OCT 26 1630Z - 2229Z                 one window
 *   24 - 31 OCT 26 DLY 0600Z - 1259Z        the same hours on each day
 *   28 SEP - 05 OCT 26 DLY 1100Z - 1600Z    across a month end
 *   13 - 16 OCT 26 0600Z - 1200Z            without DLY, one window from the first time to the last
 */
export function parseAdvisory(text: string): GpsTest[] {
  const flat = text.replace(/[–—]/g, '-').replace(/\s+/g, ' ');
  const id = /\b([A-Z][A-Z0-9_]{1,15}) GPS (\d{2}-\d{2,3})\b/.exec(flat);
  const centre = /Centered at (\d{2})(\d{2})(\d{2})([NS])(\d{3})(\d{2})(\d{2})([EW])/i.exec(flat);
  const ground = /(\d+)\s*NM RADIUS AT 50\s*FT AGL/i.exec(flat);
  const section = /Dates and times(.*?)\bC\.\s*Duration/i.exec(flat)?.[1] ?? '';
  if (!id || !centre || !ground || !section) return [];
  const lat = (Number(centre[1]) + Number(centre[2]) / 60 + Number(centre[3]) / 3600) * (centre[4].toUpperCase() === 'S' ? -1 : 1);
  const lon = (Number(centre[5]) + Number(centre[6]) / 60 + Number(centre[7]) / 3600) * (centre[8].toUpperCase() === 'W' ? -1 : 1);
  // The place is the line under the title's dates: "FORT IRWIN, CA", "POINSETT ELECTRONIC COMBAT RANGE, SC".
  const line = text.replace(/[–—]/g, '-').split(/\r?\n/).map((l) => l.trim()).find((l) => /^[A-Z][A-Z .'()/-]+,\s*[A-Z]{2}$/.test(l)) ?? '';
  const place = line.replace(/\b([A-Z])([A-Z]+)\b/g, (_, a: string, b: string) => a + b.toLowerCase()).replace(/, ([A-Za-z]{2})$/, (_, s: string) => `, ${s.toUpperCase()}`);
  const base = { name: id[1], id: `GPS ${id[2]}`, place, lat, lon, groundNm: Number(ground[1]) };
  const at = (y: number, m: number, d: number, hhmm: string) => Date.UTC(y, m, d, Number(hhmm.slice(0, 2)), Number(hhmm.slice(2)), 0);
  const out: GpsTest[] = [];
  const row = /(\d{1,2})(?:\s+([A-Z]{3}))?(?:\s*-\s*(\d{1,2})\s+([A-Z]{3}))?\s+(\d{2})\s+(DLY\s+)?(\d{4})Z\s*-\s*(\d{4})Z/gi;
  for (const m of section.matchAll(row)) {
    const year = 2000 + Number(m[5]);
    const lastM = MONTHS[(m[4] ?? m[2] ?? '').toLowerCase()];
    const firstM = m[2] && m[4] ? MONTHS[m[2].toLowerCase()] : lastM;
    if (lastM == null || firstM == null) continue;
    const firstY = firstM > lastM ? year - 1 : year;
    const first = Date.UTC(firstY, firstM, Number(m[1]));
    const last = Date.UTC(year, lastM, Number(m[3] ?? m[1]));
    // Hours that run past midnight end the next day.
    const overnight = Number(m[8]) <= Number(m[7]) ? 86_400_000 : 0;
    const window = (dayStart: number, dayEnd: number) => {
      const d0 = new Date(dayStart), d1 = new Date(dayEnd);
      out.push({ ...base, start: new Date(at(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate(), m[7])).toISOString(), end: new Date(at(d1.getUTCFullYear(), d1.getUTCMonth(), d1.getUTCDate(), m[8]) + overnight - 1000 + 60_000).toISOString() });
    };
    if (m[6] || first === last) {
      for (let d = first; d <= last && out.length < 500; d += 86_400_000) window(d, d);
    } else window(first, last);
  }
  return out;
}

/** The GPS test notices on the FAA's public list: their ids, newest first. */
export function noticeIds(html: string): string[] {
  return [...new Set([...html.matchAll(/noticeView\.aspx\?nid=(\d+)["'][^>]*>\s*GPS Interference Testing/gi)].map((m) => m[1]))];
}

/** The advisory PDF a notice page links, as a path on FAASafety.gov. Its file name is not always spelled the same. */
export function advisoryPath(html: string): string | null {
  return /href="(?:https?:\/\/www\.faasafety\.gov)?(\/files\/notices\/[^"]+\.pdf)"/i.exec(html)?.[1] ?? null;
}

async function readFaaTests(): Promise<{ list: GpsTest[]; updated: string | null }> {
  const ids = noticeIds(await (await get(`${FAA}/SPANS/notices_public.aspx`)).text()).slice(0, 25);
  if (!ids.length) throw new Error('no GPS notices on the FAA list');
  const { extractText } = await import('unpdf');
  const list: GpsTest[] = [];
  for (const nid of ids) {
    if (!advisories.has(nid)) {
      try {
        const path = advisoryPath(await (await get(`${FAA}/SPANS/noticeView.aspx?nid=${nid}`)).text());
        if (!path) { advisories.set(nid, []); continue; }
        const { text } = await extractText(new Uint8Array(await (await get(`${FAA}${path}`)).arrayBuffer()), { mergePages: true });
        advisories.set(nid, parseAdvisory(text));
      } catch {
        continue; // tried again on the next read
      }
    }
    list.push(...(advisories.get(nid) ?? []));
  }
  if (!list.length) throw new Error('no FAA advisory could be read');
  return { list, updated: null };
}

async function readTests(): Promise<void> {
  try {
    let parsed: { list: GpsTest[]; updated: string | null };
    try {
      const bytes = new Uint8Array(await (await get(TESTS_URL)).arrayBuffer());
      const { extractText } = await import('unpdf');
      const { text } = await extractText(bytes, { mergePages: true });
      parsed = parseTests(text);
      // A PDF that parsed to nothing has changed its layout: that is "could not read", not "no tests".
      if (!parsed.list.length && !/GPS TESTING/i.test(text)) throw new Error('unrecognised schedule');
    } catch (first) {
      try {
        parsed = await readFaaTests();
      } catch (second) {
        throw new Error(`Coast Guard: ${first instanceof Error ? first.message : first}; FAA: ${second instanceof Error ? second.message : second}`);
      }
    }
    tests = { ...parsed, at: Date.now() };
  } catch (err) {
    console.error('[interference] could not read the GPS testing schedule:', err instanceof Error ? err.message : err);
    if (tests && Date.now() - tests.at > STALE_MS) tests = null;
  }
}

const MIRROR = 'https://celestrak.org/GPS/sof';

/** The newest outage file's name, as CelesTrak's pointer gives it: "2026_288_202325_v01.sof". */
export function mirrorName(pointer: string): string | null {
  const name = pointer.trim().split(/\s+/)[0] ?? '';
  return /^\d{4}_\d{3}_\d{6}_v\d{2}\.sof$/.test(name) ? name : null;
}

async function sofXml(): Promise<string> {
  const valid = (xml: string): string => {
    if (!/<GPSISFILE/.test(xml)) throw new Error('not a satellite outage file');
    return xml;
  };
  try {
    return valid(await (await get(SOF_URL)).text());
  } catch (first) {
    const name = mirrorName(await (await get(`${MIRROR}/current_sof.txt`)).text());
    if (!name) throw new Error(`Coast Guard: ${first instanceof Error ? first.message : first}; mirror: no file named`);
    return valid(await (await get(`${MIRROR}/${name}`)).text());
  }
}

async function readSats(): Promise<void> {
  try {
    sats = { list: parseSof(await sofXml()), at: Date.now() };
  } catch (err) {
    console.error('[interference] could not read the satellite outage file:', err instanceof Error ? err.message : err);
    if (sats && Date.now() - sats.at > STALE_MS) sats = null;
  }
}

const jamOn = (): boolean => (process.env.ORBITA_GPSJAM ?? 'off').toLowerCase() === 'on';

/** One day's counts, "hex,count_good_aircraft,count_bad_aircraft". */
export function parseJam(csv: string): Map<string, [number, number]> {
  const day = new Map<string, [number, number]>();
  for (const line of csv.split('\n').slice(1)) {
    const [hex, good, bad] = line.trim().split(',');
    if (hex && good != null && bad != null) day.set(hex, [Number(good) || 0, Number(bad) || 0]);
  }
  return day;
}

async function readJamDay(date: string): Promise<boolean> {
  if (jamDays.has(date)) return true;
  try {
    const day = parseJam(await (await get(`${JAM}/${date}-h3_4.csv`, 20_000)).text());
    if (!day.size) throw new Error('empty day');
    jamDays.set(date, day);
    while (jamDays.size > 6) jamDays.delete([...jamDays.keys()].sort()[0]);
    return true;
  } catch (err) {
    console.error(`[interference] could not read aircraft reports for ${date}:`, err instanceof Error ? err.message : err);
    return false;
  }
}

async function readJam(): Promise<void> {
  if (!jamOn()) return;
  try {
    const manifest = await (await get(`${JAM}/manifest.csv`)).text();
    const dates = manifest.split('\n').map((l) => l.split(',')[0]).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    const latest = dates[dates.length - 1];
    if (!latest) throw new Error('no dates in the manifest');
    if (await readJamDay(latest)) jamLatest = latest;
  } catch (err) {
    console.error('[interference] could not read the aircraft report list:', err instanceof Error ? err.message : err);
  }
}

/** Set once the timers are running. Until then nothing here reaches the network, which keeps the unit tests offline. */
let started = false;

export async function start(): Promise<void> {
  started = true;
  await Promise.all([readTests(), readSats(), readJam()]);
  const timer = setInterval(() => void Promise.all([readTests(), readSats(), readJam()]), EVERY_MS);
  timer.unref?.();
}

function milesBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(bLat - aLat) / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLon - aLon) / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Aircraft reports over a point on a day. GPSJAM's own rule: one bad aircraft is taken off, as a guard against
 * a single faulty transponder; more than ten percent bad is its red, two to ten its yellow. The point's own
 * hexagon is used when enough aircraft crossed it, and it with its six neighbours when not.
 */
export function reportedOver(lat: number, lon: number, date: string): Reported | null {
  const day = jamDays.get(date);
  if (!day) return null;
  const cell = latLngToCell(lat, lon, 4);
  const sum = (cells: string[]): [number, number] => cells.reduce<[number, number]>((t, c) => { const v = day.get(c); return v ? [t[0] + v[0], t[1] + v[1]] : t; }, [0, 0]);
  let [good, bad] = sum([cell]);
  if (good + bad < 20) [good, bad] = sum(gridDisk(cell, 1));
  const total = good + bad;
  if (total < 20) return null;
  const pct = (Math.max(0, bad - 1) / total) * 100;
  if (pct <= 2) return null;
  return { date, pct: Math.round(pct), aircraft: total, level: pct > 10 ? 'high' : 'some' };
}

/** How many aircraft crossed the point's hexagon and its neighbours that day. */
function aircraftOver(lat: number, lon: number, date: string): number {
  const day = jamDays.get(date);
  if (!day) return 0;
  return gridDisk(latLngToCell(lat, lon, 4), 1).reduce((t, c) => { const v = day.get(c); return v ? t + v[0] + v[1] : t; }, 0);
}

/** Everything published that could explain a lost fix at this place and time, other than the sun. */
export function near(lat: number, lon: number, at: Date = new Date()): Found {
  const t = at.getTime();
  const unchecked: string[] = [];
  if (!tests) unchecked.push('the GPS testing schedule');
  if (!sats) unchecked.push('the satellite outage list');
  const active = (tests?.list ?? [])
    .filter((x) => t >= Date.parse(x.start) && t <= Date.parse(x.end))
    .map((x) => ({ ...x, milesAway: milesBetween(lat, lon, x.lat, x.lon) }))
    .filter((x) => x.milesAway <= x.groundNm * NM_TO_MILES)
    .sort((a, b) => a.milesAway - b.milesAway);
  const out = (sats?.list ?? []).filter((s) => t >= Date.parse(s.start) && (s.end == null || t <= Date.parse(s.end)));
  // The day asked about when that day is held, otherwise the newest day there is, which is yesterday's.
  const asked = at.toISOString().slice(0, 10);
  const reported = jamOn() ? reportedOver(lat, lon, jamDays.has(asked) ? asked : jamLatest ?? '') : null;
  if (jamOn() && !jamLatest) unchecked.push('aircraft interference reports');
  const sparse = jamOn() && !!jamLatest && aircraftOver(lat, lon, jamDays.has(asked) ? asked : jamLatest) < 20;
  return { tests: active, satellites: out, reported, unchecked, sparse, zone: spoofing.zoneAt(lat, lon), abroad: !inUS(lat, lon) };
}

/** For a question about a past day: that day's aircraft reports, fetched if they are not held. */
export async function nearThen(lat: number, lon: number, at: Date): Promise<Found> {
  const date = at.toISOString().slice(0, 10);
  if (started && jamOn() && !jamDays.has(date)) await readJamDay(date);
  const found = near(lat, lon, at);
  const held = jamDays.has(date);
  return {
    ...found,
    reported: jamOn() ? reportedOver(lat, lon, date) : null,
    sparse: jamOn() && held && aircraftOver(lat, lon, date) < 20,
    unchecked: jamOn() && !held ? [...new Set([...found.unchecked, 'aircraft interference reports'])] : found.unchecked,
  };
}

const dayMonth = (iso: string): string => new Date(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const miles = (n: number): string => (n < 1 ? 'under a mile' : `about ${Math.round(n)} ${Math.round(n) === 1 ? 'mile' : 'miles'}`);

/**
 * What to say with an answer about now or a time ahead. A planned test over the field and a red hexagon are
 * said; one satellite out is not, because it does not break a fix. Empty when there is nothing to say.
 */
export function sayAhead(found: Found): string {
  const parts: string[] = [];
  const test = found.tests[0];
  if (test) {
    parts.push(
      `One thing that is not the sun: a military GPS interference test near ${test.place} is scheduled through ${dayMonth(test.end)} and can reach receivers on the ground ` +
        `out to ${miles(test.groundNm * NM_TO_MILES)}; this field is ${miles(test.milesAway ?? 0)} from its centre, so expect dropouts while it runs.`,
    );
  }
  if (found.reported?.level === 'high') {
    parts.push(`${test ? 'And aircraft' : 'One thing that is not the sun: aircraft'} over this area reported degraded GPS on ${dayMonth(`${found.reported.date}T12:00:00Z`)}, ${found.reported.pct} percent of them, which is a sign of jamming or interference nearby.`);
  }
  if (found.satellites.length >= 3) parts.push(`${found.satellites.length} GPS satellites are out of service at once, which is unusual and thins the sky for a receiver that tracks GPS alone.`);
  if (found.zone) parts.push(parts.length ? `And ${spoofing.reason(found.zone).replace(/^the /, 'the ')}: check your line against a marker you know before you trust it.` : spoofing.sayAhead(found.zone));
  return parts.join(' ');
}

/**
 * What to say about a past time, when somebody asks what went wrong: whatever was found. `sunToo` is whether
 * space weather was already found to be outside tolerance then, so a test is "the likeliest cause" only when
 * the sun was quiet.
 */
export function sayThen(found: Found, sunToo: boolean): string {
  const parts: string[] = [];
  const test = found.tests[0];
  if (test) {
    parts.push(
      `A military GPS interference test near ${test.place} was scheduled then, reaching the ground out to ${miles(test.groundNm * NM_TO_MILES)}, and this field is ${miles(test.milesAway ?? 0)} from its centre` +
        (sunToo ? ', so that may have added to it.' : ': that is the likeliest cause.'),
    );
  }
  if (found.reported) {
    parts.push(`Aircraft over the area reported degraded GPS that day, ${found.reported.pct} percent of them, ${found.reported.level === 'high' ? 'which points to jamming or interference nearby' : 'a little more than usual'}.`);
  }
  if (found.zone) {
    parts.push(`${spoofing.whoSays(found.zone)} ${found.zone.name} as an area where GPS is regularly jammed and spoofed, so that may explain it, and spoofing leaves no trace a receiver reports.`);
  }
  if (found.satellites.length) {
    const prns = found.satellites.map((s) => s.prn).sort((a, b) => a - b);
    parts.push(`GPS satellite${prns.length === 1 ? '' : 's'} ${prns.join(' and ')} ${prns.length === 1 ? 'was' : 'were'} out of service then, which a receiver that also tracks Galileo or GLONASS would not notice.`);
  }
  return parts.join(' ');
}

/** When nothing was found: what was looked at and ruled out, and what could not be looked at. */
export function ruledOut(found: Found): string {
  if (found.tests.length || found.reported || found.satellites.length || found.zone) return '';
  const checked = [
    found.unchecked.includes('the GPS testing schedule') || found.abroad ? '' : 'no military GPS test was scheduled over the field',
    found.unchecked.includes('the satellite outage list') ? '' : 'no GPS satellite was out',
    found.unchecked.includes('aircraft interference reports') || !jamOn() || found.sparse ? '' : 'aircraft reported nothing unusual',
  ].filter(Boolean);
  const said = checked.length ? `I checked the other published causes: ${checked.join(', ').replace(/, ([^,]*)$/, ' and $1')}.` : '';
  const not = found.unchecked.length ? ` I could not check ${found.unchecked.join(' or ')}.` : '';
  const abroad = found.abroad ? ` ${ABROAD_NOTE}` : '';
  return `${said}${not}${abroad}`.trim();
}

export const SOURCES = [
  'https://www.navcen.uscg.gov/sites/default/files/pdf/gps/gpsnotices/GPS_Interference.pdf',
  'https://www.navcen.uscg.gov/sites/default/files/gps/sof/current_sof.sof',
  'https://gpsjam.org (John Wiseman; data from airplanes.live and ADS-B Exchange)',
  ...spoofing.SOURCES,
];

export const status = () => ({ tests: tests ? tests.list.length : null, testsUpdated: tests?.updated ?? null, satelliteOutages: sats ? sats.list.length : null, aircraftReportsFor: jamLatest });

export function seedForTest(seed: { tests?: GpsTest[] | null; satellites?: SatOutage[] | null; jam?: Record<string, Record<string, [number, number]>> | null }): void {
  if (seed.tests !== undefined) tests = seed.tests ? { list: seed.tests, at: Date.now(), updated: null } : null;
  if (seed.satellites !== undefined) sats = seed.satellites ? { list: seed.satellites, at: Date.now() } : null;
  if (seed.jam !== undefined) {
    jamDays.clear();
    jamLatest = null;
    for (const [date, cells] of Object.entries(seed.jam ?? {})) {
      jamDays.set(date, new Map(Object.entries(cells)));
      if (!jamLatest || date > jamLatest) jamLatest = date;
    }
  }
}
export const cellOf = (lat: number, lon: number): string => latLngToCell(lat, lon, 4);
