/**
 * What is measured in orbit right now: energetic electrons and protons at geostationary altitude.
 *
 * The NOAA scales say what a storm of a given size does. For somebody running a spacecraft, or a crew in one,
 * three numbers from the GOES satellites say what is happening this minute, and each has a published line:
 *
 *   Electrons above 2 MeV. They pass through a satellite's skin and build charge inside its insulation until it
 *   discharges (deep dielectric charging), the cause NOAA names for its alert, which it issues when the flux at
 *   GOES passes 1,000. This is the geostationary operator's number; drag is the low orbit operator's.
 *     https://www.swpc.noaa.gov/products/goes-electron-flux
 *
 *   Protons above 10 MeV. The S scale: 10 is S1, 100 is S2, 1,000 is S3, where NOAA recommends astronauts outside
 *   the vehicle avoid the radiation, and 10,000 is S4, where it calls that hazard unavoidable. NASA's radiation
 *   group puts 10 MeV as roughly what gets inside a spacesuit.
 *     https://www.swpc.noaa.gov/noaa-scales-explanation
 *
 *   Protons above 50 and 100 MeV. Roughly 100 MeV is what gets inside a spacecraft, and these are the ones that
 *   upset avionics on the way up. The published example of a launch rule is the James Webb telescope's: no go
 *   from twelve hours to ten minutes before launch with a warning out for protons above 100 MeV, or with the
 *   flux above 50 MeV past 5.
 *     https://ntrs.nasa.gov/api/citations/20230013623/downloads/Minow_etal_ASEC_2023_presentation.pdf
 *
 * Read every few minutes in the background, never inside a turn. A reading that is old or missing is not said.
 */

const BASE = 'https://services.swpc.noaa.gov';
const ELECTRONS = '/json/goes/primary/integral-electrons-1-day.json';
const PROTONS = '/json/goes/primary/integral-protons-1-day.json';
const EVERY_MS = 10 * 60_000;
const STALE_MS = 60 * 60_000;

export const ELECTRON_ALERT = 1000;
export const WEBB_50MEV_LIMIT = 5;

export type Particles = {
  /** Electrons above 2 MeV, now, and the most in the last day. */
  electrons: number | null;
  electronsDayMax: number | null;
  protons10: number | null;
  protons50: number | null;
  protons100: number | null;
  measuredAt: string;
};

let held: { p: Particles; at: number } | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

type Row = { time_tag?: string; flux?: number; energy?: string };

/** The newest reading for each energy, from the feed's rows. */
export function parse(electrons: Row[], protons: Row[]): Particles | null {
  const latest = (rows: Row[], energy: string): Row | null => {
    const mine = rows.filter((r) => r.energy === energy && Number.isFinite(r.flux) && typeof r.time_tag === 'string');
    return mine.length ? mine.reduce((a, b) => (String(b.time_tag) > String(a.time_tag) ? b : a)) : null;
  };
  const e = latest(electrons, '>=2 MeV');
  const p10 = latest(protons, '>=10 MeV');
  if (!e && !p10) return null;
  const eAll = electrons.filter((r) => r.energy === '>=2 MeV' && Number.isFinite(r.flux)).map((r) => r.flux as number);
  return {
    electrons: e?.flux ?? null,
    electronsDayMax: eAll.length ? Math.max(...eAll) : null,
    protons10: p10?.flux ?? null,
    protons50: latest(protons, '>=50 MeV')?.flux ?? null,
    protons100: latest(protons, '>=100 MeV')?.flux ?? null,
    measuredAt: String((e ?? p10)!.time_tag),
  };
}

async function getJson(path: string): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${BASE}${path}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function refresh(): Promise<void> {
  try {
    const [e, p] = await Promise.all([getJson(ELECTRONS), getJson(PROTONS)]);
    const parsed = parse(Array.isArray(e) ? (e as Row[]) : [], Array.isArray(p) ? (p as Row[]) : []);
    if (parsed) held = { p: parsed, at: Date.now() };
  } catch (err) {
    console.error('[particles] could not read the GOES particle feeds:', err instanceof Error ? err.message : err);
  }
}

export async function start(): Promise<void> {
  await refresh();
  if (!timer) {
    timer = setInterval(() => void refresh(), EVERY_MS);
    timer.unref?.();
  }
}

/** The reading, or null when there is none or it is over an hour old. */
export function now(): Particles | null {
  if (!held || Date.now() - held.at > STALE_MS) return null;
  return held.p;
}

const round = (n: number): string => (n >= 100 ? Math.round(n).toLocaleString('en-US') : n >= 10 ? n.toFixed(0) : n.toFixed(1));

/** For a geostationary operator: charging, with the number against NOAA's alert line. */
export function sayHighOrbit(p: Particles | null = now()): string {
  if (!p || p.electrons == null) return '';
  const over = p.electrons >= ELECTRON_ALERT;
  const wasOver = !over && (p.electronsDayMax ?? 0) >= ELECTRON_ALERT;
  if (over) {
    return `Measured now at geostationary orbit, electrons above 2 MeV are at ${round(p.electrons)}, past the 1,000 where NOAA alerts for charging building up inside spacecraft. Hold commanding that can wait, and treat any odd behaviour as a possible discharge.`;
  }
  if (wasOver) {
    return `Measured now at geostationary orbit, electrons above 2 MeV are at ${round(p.electrons)}, back under NOAA's alert line of 1,000 after passing it in the last day, so charge built up inside spacecraft may still discharge.`;
  }
  return `Measured now at geostationary orbit, electrons above 2 MeV are at ${round(p.electrons)}, under the 1,000 where NOAA alerts for charging building up inside spacecraft.`;
}

/** For a launch: the measured protons against the rule the Webb telescope's launch used. */
export function sayLaunch(p: Particles | null = now()): string {
  if (!p || p.protons50 == null) return '';
  return p.protons50 >= WEBB_50MEV_LIMIT
    ? `For a launch: protons above 50 MeV are at ${round(p.protons50)} now, past the 5 that was a no go for the Webb telescope's launch, because they upset avionics on the way up.`
    : `For a launch: protons above 50 MeV are at ${round(p.protons50)} now, under the 5 that was a no go for the Webb telescope's launch.`;
}

/** For a crew: the protons that get into a suit, and the ones that get into the vehicle. */
export function sayCrew(p: Particles | null = now()): string {
  if (!p || p.protons10 == null) return '';
  const s = p.protons10 >= 10_000 ? 4 : p.protons10 >= 1000 ? 3 : p.protons10 >= 100 ? 2 : p.protons10 >= 10 ? 1 : 0;
  const suit =
    s === 0
      ? `Measured now, protons above 10 MeV, the ones that get through a spacesuit, are at ${round(p.protons10)}, under the 10 where a radiation storm begins.`
      : `Measured now, protons above 10 MeV, the ones that get through a spacesuit, are at ${round(p.protons10)}, an S${s} radiation storm.`;
  const hull =
    p.protons100 == null ? '' : p.protons100 >= 1
      ? ` Protons above 100 MeV, the ones that get inside a spacecraft, are at ${round(p.protons100)}, which is raised.`
      : ' Protons above 100 MeV, the ones that get inside a spacecraft, are at background.';
  return `${suit}${hull}`;
}

export function seedForTest(p: Particles | null): void {
  held = p ? { p, at: Date.now() } : null;
}
