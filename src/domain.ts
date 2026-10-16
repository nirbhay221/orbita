/**
 * Turning a geomagnetic forecast into a go/no-go for a specific field operation.
 *
 * The whole product is this file. NOAA publishes Kp; nobody translates it into
 * "your planter will wander and you should wait until Thursday."
 *
 * Error figures are from the published literature on GNSS performance during
 * geomagnetic storms (3D RMS, dual-frequency, high latitude):
 *   quiet 0.163 m · moderate 0.393 m · intense 0.680 m · super 1.051 m,
 *   with short peaks to ~3 m during the disturbed hour.
 * RTK-fixed availability falls below 91% at high Kp, and cycle slips rise
 * 13% / 57% / 70% under moderate / intense / super conditions.
 */

export type Operation =
  // Agriculture
  | 'planting'
  | 'strip_till'
  | 'cultivating'
  | 'spraying'
  | 'harvest'
  | 'tillage'
  | 'scouting'
  // Everything else that stands on GNSS. Same sun, same ionosphere, same maths,
  // different number in the tolerance column.
  | 'surveying'
  | 'drone_survey'
  | 'drone_show'
  | 'machine_control';

export type Correction = 'rtk' | 'ppp' | 'sbas' | 'autonomous';

export type Field = {
  id: string;
  name: string;
  crop?: string;
  acres?: number;
  lat: number;
  lon: number;
  /** Distance to the RTK base or network reference, km. Longer baseline = more storm sensitivity. */
  baselineKm?: number;
  /** IANA timezone, looked up once when the field is added, so times are said where the field is. */
  timeZone?: string;
  /** ISO country code from the same lookup, "BR". Used only to tell the host which language the farm speaks. */
  countryCode?: string;
};

export type Equipment = {
  id: string;
  name: string;
  correction: Correction;
  /**
   * A receiver built to ride out scintillation: Trimble's IonoGuard on its NAV-900 and ProPoint base stations, or
   * a correction service with scintillation mitigation such as Hexagon's PPP. Only ever what the customer said.
   *
   * It changes one thing. Scintillation, the fast flicker that plasma bubbles and a disturbed sky put on the
   * signal, is what these products are built for, and the vendors report it working: Hexagon's field data on
   * strong scintillation days shows about 1 to 1.5 hours of outage against 5 hours for a competitor's RTK. So the
   * evening bubble hours and a measured disturbed sky become "watch the fix", not "hold off", for this machine.
   * A storm's own error is not scintillation, and is judged as for any other receiver. Vendor figures, said as
   * such.
   *   https://autonomoustuff.com/velocity-magazine/velocity-2024/mitigating-the-effects-of-ionospheric-scintillation-on-precision-ag
   *   https://www.farms.com/news/solar-events-disrupting-satellite-signals-trimble-has-a-solution-210775.aspx
   */
  hardened?: boolean;
};

/** What is said to a machine built to ride out scintillation, in the hours that would otherwise hold it. */
export const HARDENED_WATCH =
  'Your receiver is built to ride out scintillation, so this goes ahead, but keep an eye on the fix status: the makers report fewer and shorter dropouts, not none.';

/**
 * How much lateral error each job can absorb before it costs you money.
 * Planting is the tight one: rows have to be findable again at cultivation
 * and harvest, so an error today is an error for the whole season.
 */
export const TOLERANCE_M: Record<Operation, number> = {
  planting: 0.05,
  strip_till: 0.05,
  cultivating: 0.08,
  // Boom section control absorbs more than a planter row does; people spray on
  // WAAS every day, so a tolerance tighter than WAAS would blanket-ban it.
  spraying: 0.50,
  harvest: 0.50,
  tillage: 1.00,
  scouting: 3.00,
  // Cadastral and engineering survey report roughly 2 to 3 cm horizontal with
  // RTK or PPK and placed control. A boundary you set wrong is a legal problem,
  // not a yield problem, so this is the tightest tolerance here.
  surveying: 0.03,
  // Drone photogrammetry lands under 5 cm with a disciplined workflow, and the
  // aircraft is moving, so there is no second chance on a pass.
  drone_survey: 0.05,
  // A light show flies hundreds of drones a few metres apart on RTK. Geoscan's 2,198 drone show reports each drone
  // within about a centimetre of where it should be (the company's figure), and the Hong Kong shows of October 2024
  // were called off when that fix would not hold. A decimetre, ten times what the shows fly at, is this project's
  // line for when the formation stops being the picture; no published tolerance was found.
  //   https://insidegnss.com/two-thousand-simultaneous-drones-position-themselves-with-gps-and-glonass-rtk/
  drone_show: 0.10,
  // Dozers, graders and excavators cutting to design grade plan around 20 to
  // 50 mm horizontal. Past that you are moving dirt you have to move back.
  machine_control: 0.05,
};

const OPERATION_LABEL: Record<Operation, string> = {
  planting: 'planting',
  strip_till: 'strip-till',
  cultivating: 'cultivating',
  spraying: 'spraying',
  harvest: 'harvest',
  tillage: 'tillage',
  scouting: 'scouting',
  surveying: 'survey work',
  drone_survey: 'the drone survey',
  drone_show: 'the drone show',
  machine_control: 'grade work',
};

/** Baseline accuracy on a quiet day, metres. Typical achieved horizontal, not spec sheet. */
const QUIET_ERROR_M: Record<Correction, number> = {
  rtk: 0.02,
  ppp: 0.10,
  sbas: 0.35,
  autonomous: 2.50,
};

/**
 * Geomagnetic latitude, centred dipole approximation.
 *
 * Storms follow the magnetic field, not the map. The geomagnetic pole sits about
 * 80.65N 72.68W, roughly 11 degrees off the geographic one, so two sites at the
 * same geographic latitude are not equally exposed: Winnipeg at 50N is magnetically
 * closer to the auroral oval than Kyiv at the same 50N, and it takes the worse hit
 * from the same storm. Using geographic latitude quietly overstates the risk across
 * Eurasia and understates it across Canada.
 */
export function geomagneticLatitude(lat: number, lon: number): number {
  const POLE_LAT = (80.65 * Math.PI) / 180;
  const POLE_LON = (-72.68 * Math.PI) / 180;
  const p = (lat * Math.PI) / 180;
  const l = (lon * Math.PI) / 180;
  const s =
    Math.sin(p) * Math.sin(POLE_LAT) +
    Math.cos(p) * Math.cos(POLE_LAT) * Math.cos(l - POLE_LON);
  return (Math.asin(Math.max(-1, Math.min(1, s))) * 180) / Math.PI;
}

/**
 * The equatorward edge of the auroral oval, in geomagnetic degrees, for this Kp.
 *
 * The oval is not a fixed band. It widens and pushes south as the storm grows,
 * which is the whole reason a quiet mid-latitude farm can have a bad afternoon.
 * NOAA publishes the relationship as an aurora viewline that moves with Kp; the
 * working approximation is an edge near 66.5 degrees at Kp 0, travelling about
 * two degrees equatorward per Kp step, so Kp 9 reaches into the high forties.
 *
 * https://www.swpc.noaa.gov/content/tips-viewing-aurora
 */
export function auroralBoundaryDeg(kp: number): number {
  return 66.5 - 2 * Math.max(0, Math.min(9, kp));
}

/** Long RTK baselines lose the ionospheric-similarity assumption first. */
function baselineFactor(km: number | undefined, correction: Correction): number {
  if (correction !== 'rtk' || km == null) return 1;
  if (km <= 10) return 0.7;
  if (km <= 30) return 1.0;
  if (km <= 70) return 1.5;
  return 2.2;
}

/**
 * How much worse RTK gets, from where the site is relative to the auroral oval.
 *
 * This replaced a table keyed on Kp alone. Replaying three real planting seasons of measured Kp
 * (evals/backtest.mjs) showed that table calling RTK planting outside tolerance in a quarter of all
 * three-hour blocks at Fargo in 2025, from Kp 4. Growers do not lose guidance a quarter of the time, and
 * measurements agree: RTK does not degrade with Kp as such. It degrades when the disturbed ionosphere is
 * overhead, which is a question of how far the oval has come.
 *
 * So the multiplier is set by depth: geomagnetic latitude minus the oval's equatorward edge at this Kp,
 * positive when the edge has passed over the site. Three published observations anchor it:
 *
 *   - Inside the oval, metres. A Norwegian network at 60 to 67 degrees saw RTK errors peak near 3 m as Kp went
 *     through 5 to 7 (Jacobsen and Schafer 2012, J. Space Weather Space Clim., doi:10.1051/swsc/2012013).
 *     Depth of 6 degrees or more is 50 times the quiet 2 cm, which is 1 m.
 *   - Far from the oval in a strong storm, centimetres. Network RTK through a Kp 7.3 storm at low latitude
 *     held about 8 cm horizontal (Sensors 2026, doi:10.3390/s26072198). That is the floor of 4 times from Kp 7.
 *   - In an extreme storm, nowhere in the middle latitudes is far from it. In May 2024 (Kp 9) positioning
 *     errors of metres were measured across the central United States (Remote Sensing 2025,
 *     doi:10.3390/rs17091492). That is the floor of 25 times from Kp 8 and 50 from Kp 9.
 *
 * Between those points the steps are this project's interpolation, not a measurement, and the numbers it
 * produces are an estimate of scale: "inches" or "feet", never a promise of a figure.
 */
const OVERHEAD_OFFSET_DEG = 4;

/**
 * How much further poleward the oval sits at this hour, in degrees.
 *
 * The oval is not a ring centred on the pole. It is pushed away from the sun: its equatorward edge sits near
 * 67 degrees at local midnight and near 75 at local noon on a quiet day (the Feldstein oval). Field work is
 * done in daylight, and a model that treats noon like midnight calls a Canadian field inside the oval at
 * lunchtime when the aurora is eight degrees north of it.
 *
 * Zero at local midnight, eight at local noon, by local solar time, which is close enough to magnetic local
 * time away from the poles. With no time given it is zero: the night-time, more cautious, answer.
 */
export function dayShiftDeg(at: Date | undefined, lon: number): number {
  if (!at || Number.isNaN(at.getTime())) return 0;
  const hour = (((at.getUTCHours() + at.getUTCMinutes() / 60 + lon / 15) % 24) + 24) % 24;
  return 4 * (1 + Math.cos((2 * Math.PI * (hour - 12)) / 24));
}

export function rtkMultiplier(kp: number, lat: number, lon: number, at?: Date): number {
  // auroralBoundaryDeg is NOAA's viewline: how far south the aurora can be SEEN, low on the horizon. The
  // disturbed ionosphere itself is overhead some four degrees poleward of that. Using the viewline as if it
  // were overhead had Saskatoon inside the oval at Kp 4, and outside tolerance in 38 to 62 percent of blocks.
  // The storm floors below do not move with the hour: the enhanced density that hurt the central United
  // States in May 2024 was a daytime and dusk effect.
  const depth = Math.abs(geomagneticLatitude(lat, lon)) - (auroralBoundaryDeg(kp) + OVERHEAD_OFFSET_DEG + dayShiftDeg(at, lon));
  const byDepth = depth >= 6 ? 50 : depth >= 3 ? 25 : depth >= 0 ? 10 : depth >= -2 ? 2 : depth >= -8 ? 1.4 : 1;
  // The storm's own floor. From Kp 8 it is graded by latitude, because the same extreme storm was worse in
  // the central United States than in the south-west; at Kp 7 the measured 8 cm was at low latitude, so
  // that floor applies everywhere.
  const a = Math.abs(geomagneticLatitude(lat, lon));
  const byStorm = kp >= 9 ? (a >= 35 ? 50 : 25) : kp >= 8 ? (a >= 45 ? 25 : a >= 35 ? 12 : 8) : kp >= 7 ? 4 : 1;
  return Math.max(byDepth, byStorm);
}

/**
 * How much of the disturbance each kind of correction feels.
 *
 * Every correction is judged from the same measure of how disturbed the sky is over the site (rtkMultiplier),
 * raised to a power. RTK feels all of it, because it depends on the ionosphere being the same over the base
 * and the rover. PPP models the ionosphere and loses that model in a storm. WAAS broadcasts a coarse
 * correction that degrades more slowly. A receiver with no correction is already carrying metres of error,
 * so a storm adds proportionally least.
 *
 * This replaced two tables: one keyed on Kp alone, and one that made every northern site 60 percent worse on
 * a quiet day. Replaying 2025 for every job, not only planting, showed what that did: it said a sprayer on
 * WAAS at Fargo could never hold spraying tolerance, on any day, and that walking a field with a phone was
 * impossible in Saskatchewan. People spray on WAAS at Fargo every day.
 *
 * The powers are chosen so the worst case (a disturbance of 50) lands near the figures the old tables gave
 * for an extreme storm, about 19 times for PPP, 5 for WAAS and 1.6 for none. They are this project's
 * estimate, not a measurement, and only the RTK row is anchored to published observations.
 */
const SENSITIVITY: Record<Correction, number> = { rtk: 1, ppp: 0.75, sbas: 0.4, autonomous: 0.12 };

export function expectedErrorM(kp: number, eq: Equipment, field: Field, at?: Date): number {
  const base = QUIET_ERROR_M[eq.correction];
  const disturbance = rtkMultiplier(kp, field.lat, field.lon, at);
  const err = base * disturbance ** SENSITIVITY[eq.correction] * baselineFactor(field.baselineKm, eq.correction);
  return Number(err.toFixed(3));
}

export const G_SCALE = (kp: number): string =>
  kp < 5 ? 'none' : kp < 6 ? 'G1 minor' : kp < 7 ? 'G2 moderate' : kp < 8 ? 'G3 strong' : kp < 9 ? 'G4 severe' : 'G5 extreme';

export type Verdict = {
  operation: Operation;
  go: boolean;
  kp: number;
  gScale: string;
  expectedErrorM: number;
  /** What this rig achieves on a quiet day, the honest comparison point. */
  quietErrorM: number;
  toleranceM: number;
  /**
   * Which constraint is actually binding. Distinguishing these two matters:
   * blaming the sun for a rig that never met the tolerance would send a farmer
   * out tomorrow expecting a different answer, and it would be the same answer.
   */
  limitedBy: 'clear' | 'space_weather' | 'equipment';
  reason: string;
  /** Held only by the evening plasma bubbles near the magnetic equator, not by a storm. */
  equatorial?: boolean;
};

/** Inches, but keep a decimal under 3" so a 1.5" difference doesn't round away. */
function inches(m: number): string {
  const v = m * 39.37;
  if (v < 3) return `${v.toFixed(1)} inches`;
  return `${Math.round(v)} inches`;
}

const distance = (m: number) => (m >= 1 ? `${m.toFixed(1)} metres` : inches(m));

/**
 * Near the magnetic equator, after dark: plasma bubbles.
 *
 * Everything else in this file is about the auroral zone, where storms push disturbance down from the pole.
 * A third of the world farms and surveys somewhere else: India, Southeast Asia, Brazil, most of Africa sit
 * within about 20 degrees of the magnetic equator, and there the damage comes from below. After sunset the
 * equatorial ionosphere becomes unstable and breaks into plasma bubbles, which scintillate GNSS signals hard
 * enough to break carrier-phase tracking. It is a nightly pattern, not a storm: it happens on quiet days, it is
 * strongest around the equinoxes and near solar maximum, and it dies away after midnight. Published
 * measurements put positioning errors above 40 metres between 21:00 and midnight local time, and RTK and PPP
 * lose their fix first.
 *
 * The season depends on longitude. Bubbles grow most when the sunset line lies along the magnetic field lines
 * (Tsunoda's alignment), and the field's tilt differs around the world. Over South America (90W to 30W), where
 * the declination tilts west, they peak around the December solstice and are rare in June: October to March.
 * Over Africa, India and Southeast Asia they peak at the equinoxes: February to April and August to October.
 * Over the Pacific the June solstice is active as well. Satellite climatologies (DMSP over a full solar cycle,
 * COSMIC radio occultation, ICON) all show this pattern.
 *
 * So for a field within 20 degrees of the geomagnetic equator, between 19:00 and 01:00 local solar time, in that
 * longitude's season, a carrier-phase job is a hold. Outside those hours and months it is not ruled out, only
 * much less common, and nothing is said. This is a climatology, not a measurement: where the measured sky in
 * roti.ts has enough links overhead, that decides instead.
 *
 * Sources:
 *   https://link.springer.com/article/10.1007/s12145-023-01070-z (scintillation over India)
 *   https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2024SW004217 (scintillation and precise positioning)
 *   https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2002JA009452 (DMSP bubbles over a solar cycle)
 *   https://angeo.copernicus.org/articles/38/611/2020/ (COSMIC bubble climatology by season and longitude)
 */
type BubbleSeason = { months: number[]; words: string };
export function bubbleSeason(lon: number): BubbleSeason {
  const x = ((lon + 540) % 360) - 180;
  if (x >= -90 && x < -30) return { months: [10, 11, 12, 1, 2, 3], words: 'most of all from October to March over South America' };
  if (x >= -30 && x < 150) return { months: [2, 3, 4, 8, 9, 10], words: 'most of all around the equinoxes' };
  return { months: [2, 3, 4, 5, 6, 7, 8, 9, 10], words: 'most of all from the March equinox through the September one over the Pacific' };
}

/**
 * How active the sun is, which decides how often the bubbles come at all.
 *
 * Bubble occurrence follows the solar cycle. Over Hong Kong, GPS-detected bubbles from 2001 to 2012 tracked the
 * 10.7 cm solar flux with a correlation of about 0.92, strongest at the equinoxes; over Brazil, going from F10.7 210
 * in October 2001 to 70 in October 2008 brought a large fall in how often and how strongly they formed. So near the
 * bottom of the cycle the evening hours stop being a hold on their own. The line is F10.7 75, below which only the
 * deepest solar minimum sits; above it, which is every year from 2011 to now, nothing changes. The value is NOAA's,
 * from the 45 day forecast swpcplus.ts already reads, and until it has been read the rule stands as it always did.
 *   https://research.polyu.edu.hk/en/publications/effects-of-solar-and-geomagnetic-activity-on-the-occurrence-of-eq/
 *   https://bv.fapesp.br/en/publicacao/231042 (Abdu and others, 2020)
 */
export const QUIET_SUN_F107 = 75;
let solarFlux: number | null = null;
export function setSolarFlux(f107: number | null): void {
  solarFlux = f107 != null && Number.isFinite(f107) && f107 > 0 ? f107 : null;
}
export const quietSun = (): boolean => solarFlux != null && solarFlux < QUIET_SUN_F107;

export function equatorialEvening(field: Field, at: Date | undefined): boolean {
  if (!at || Number.isNaN(at.getTime())) return false;
  if (quietSun()) return false;
  if (Math.abs(geomagneticLatitude(field.lat, field.lon)) > 20) return false;
  const solarHour = (((at.getUTCHours() + at.getUTCMinutes() / 60 + field.lon / 15) % 24) + 24) % 24;
  const evening = solarHour >= 19 || solarHour < 1;
  const month = at.getUTCMonth() + 1;
  return evening && bubbleSeason(field.lon).months.includes(month);
}

export function assess(
  operation: Operation,
  kp: number,
  eq: Equipment,
  field: Field,
  /** When the job would run. Left out, the answer is the night-time one, which is the more cautious. */
  at?: Date,
): Verdict {
  const err = expectedErrorM(kp, eq, field, at);
  // What this rig does on its best day: the better of a quiet sky and a dead calm one, so that a site the
  // oval sits over on an ordinary night is not told its equipment is the problem.
  const quiet = Math.min(expectedErrorM(2, eq, field, at), expectedErrorM(0, eq, field, at));
  const tol = TOLERANCE_M[operation];
  // Carrier-phase work near the magnetic equator after dark, whatever Kp says. See equatorialEvening.
  const bubbleHours = (eq.correction === 'rtk' || eq.correction === 'ppp') && tol < 0.3 && equatorialEvening(field, at);
  // A receiver built for scintillation is not held by it. See Equipment.hardened.
  const bubbles = bubbleHours && !eq.hardened;
  const go = err <= tol && !bubbles;
  const g = G_SCALE(kp);
  const label = OPERATION_LABEL[operation];

  let limitedBy: Verdict['limitedBy'];
  let reason: string;

  if (bubbles && err <= tol) {
    limitedBy = 'space_weather';
    reason =
      `Hold off ${label} until after midnight or the morning. Near the magnetic equator the hours after sunset bring plasma bubbles ` +
      `that break up satellite signals, ${bubbleSeason(field.lon).words}, and ${eq.correction.toUpperCase()} loses its fix first. ` +
      `That happens on quiet days too, so Kp ${kp.toFixed(1)} does not rule it out.`;
  } else if (go) {
    limitedBy = 'clear';
    // The verdict, then the one number that backs it, in the job's own terms; Kp last, for whoever tracks it.
    reason = `Clear for ${label}. Expected drift is about ${inches(err)}, inside the ${inches(tol)} it needs, at Kp ${kp.toFixed(1)}${g === 'none' ? '' : ` (${g})`}.`;
    if (bubbleHours) reason += ` It is the evening plasma bubble hours near the magnetic equator. ${HARDENED_WATCH}`;
  } else if (quiet > tol) {
    // Not the sun. This rig cannot hit that tolerance on its best day.
    limitedBy = 'equipment';
    reason =
      `That's not the space weather. ${eq.name} on ${eq.correction.toUpperCase()} runs about ${inches(quiet)} even on a quiet day, ` +
      `and ${label} needs it inside ${inches(tol)}. Waiting for the storm to pass won't change that.`;
  } else {
    limitedBy = 'space_weather';
    const factor = err / quiet;
    // In a severe storm a receiver does not wander by a neat number of inches. It loses its fix. Permanent
    // stations at Saskatoon, Fargo, Grand Island and Lubbock all lost precise positioning for twelve hours or
    // more on 10 and 11 May 2024 (evals/receivers.mjs), so at that level the answer says that and gives no figure.
    const lost = eq.correction === 'rtk' && rtkMultiplier(kp, field.lat, field.lon, at) >= 25;
    reason = lost
      ? `Hold off ${label}. Kp ${kp.toFixed(1)} (${g}) is strong enough that receivers here lose their precise fix altogether, as they did in May 2024, and ${label} needs it inside ${inches(tol)}.`
      : `Hold off ${label}. Kp ${kp.toFixed(1)} (${g}) puts expected drift near ${distance(err)}, ` +
        `about ${factor.toFixed(factor < 10 ? 1 : 0)} times your normal ${inches(quiet)}, and ${label} needs it inside ${inches(tol)}.`;
  }

  return {
    operation,
    go,
    kp: Number(kp.toFixed(2)),
    gScale: g,
    expectedErrorM: err,
    quietErrorM: quiet,
    toleranceM: tol,
    limitedBy,
    reason,
    ...(bubbles && err <= tol ? { equatorial: true } : {}),
  };
}

/**
 * The Kp at which this job stops being runnable on this rig and field.
 *
 * Found by scanning, not by dividing: error is a step function of Kp (the severity
 * bands), so a linear back-calculation lands in the wrong place, which is exactly
 * the bug that painted every bar as blocked in the first Echo Show render.
 * Returns null if the rig clears the tolerance at every Kp, or at none.
 */
export function thresholdKp(
  operation: Operation,
  eq: Equipment,
  field: Field,
): number | null {
  const tol = TOLERANCE_M[operation];
  if (expectedErrorM(0, eq, field) > tol) return null; // never runnable
  if (expectedErrorM(9, eq, field) <= tol) return null; // always runnable
  for (let kp = 0; kp <= 9; kp += 0.1) {
    if (expectedErrorM(kp, eq, field) > tol) return Number(kp.toFixed(1));
  }
  return null;
}

export type Slot = { time: string; kp: number; observed: boolean };

/**
 * The answer a farmer actually wants is not "is it bad now" but
 * "when is my next clean window, and how long is it".
 */
export function nextWindow(
  slots: Slot[],
  operation: Operation,
  eq: Equipment,
  field: Field,
  now: Date,
): { start: string; end: string; hours: number } | null {
  // The block already under way counts. At 8 pm a block that began at 7 pm is now, not the past,
  // and skipping it said "clear from 10 pm" about a job that was clear already.
  const future = slots.filter((s) => new Date(s.time).getTime() + 3 * 3_600_000 > now.getTime());
  const tol = TOLERANCE_M[operation];

  let start: string | null = null;
  let last: string | null = null;
  for (const s of future) {
    // The block under way is judged at this moment, so it agrees with the verdict just given; later ones at their middle.
    const begins = new Date(s.time).getTime();
    const when = begins <= now.getTime() ? now : new Date(begins + 90 * 60_000);
    // The evening plasma bubbles near the magnetic equator close a window as surely as a storm. Checked at both
    // ends of the block, because a three-hour block can straddle sunset.
    const carrier = (eq.correction === 'rtk' || eq.correction === 'ppp') && tol < 0.3 && !eq.hardened;
    const bubbles = carrier && [begins + 30 * 60_000, begins + 150 * 60_000].some((t) => equatorialEvening(field, new Date(Math.max(t, now.getTime()))));
    const ok = expectedErrorM(s.kp, eq, field, when) <= tol && !bubbles;
    if (ok) {
      if (!start) start = s.time;
      last = s.time;
    } else if (start) {
      break; // first contiguous window only
    }
  }
  if (!start || !last) return null;
  // SWPC publishes 3-hour blocks, so the window runs to the end of the last good one.
  const end = new Date(new Date(last).getTime() + 3 * 3_600_000).toISOString();
  // A window that is already open starts now, not when its block began.
  const from = new Date(start).getTime() < now.getTime() ? now.toISOString() : start;
  const hours = (new Date(end).getTime() - new Date(from).getTime()) / 3_600_000;
  return { start: from, end, hours };
}

/**
 * Every clear window over the forecast, for a machine with its own accuracy need rather than a farm job.
 *
 * nextWindow answers a person: the first window, for a job with a fixed tolerance. A scheduler planning a fleet, or a
 * drone show with a fixed date, needs all of them across the forecast, for whatever accuracy it said. The test for
 * each block is the same one nextWindow uses: the expected error for that Kp at that place against the need, and
 * for carrier-phase work tighter than 30 cm on an unhardened receiver, the evening bubble hours near the magnetic
 * equator checked at both ends of the block.
 */
export function clearWindows(
  slots: Slot[],
  eq: Equipment,
  field: Field,
  needM: number,
  now: Date,
  hours = 72,
): { start: string; end: string; hours: number }[] {
  const until = now.getTime() + hours * 3_600_000;
  const blocks = slots.filter((s) => {
    const t = new Date(s.time).getTime();
    return t + 3 * 3_600_000 > now.getTime() && t < until;
  });
  const carrier = (eq.correction === 'rtk' || eq.correction === 'ppp') && needM < 0.3 && !eq.hardened;
  const out: { start: string; end: string; hours: number }[] = [];
  let open: number | null = null;
  let close = 0;
  for (const s of blocks) {
    const begins = new Date(s.time).getTime();
    const when = begins <= now.getTime() ? now : new Date(begins + 90 * 60_000);
    const bubbles = carrier && [begins + 30 * 60_000, begins + 150 * 60_000].some((t) => equatorialEvening(field, new Date(Math.max(t, now.getTime()))));
    const ok = expectedErrorM(s.kp, eq, field, when) <= needM && !bubbles;
    if (ok) {
      if (open == null) open = Math.max(begins, now.getTime());
      close = Math.min(begins + 3 * 3_600_000, until);
    } else if (open != null) {
      out.push({ start: new Date(open).toISOString(), end: new Date(close).toISOString(), hours: (close - open) / 3_600_000 });
      open = null;
    }
  }
  if (open != null) out.push({ start: new Date(open).toISOString(), end: new Date(close).toISOString(), hours: (close - open) / 3_600_000 });
  return out.map((w) => ({ ...w, hours: Math.round(w.hours * 10) / 10 }));
}

/* ------------------------------------------------------------------ *
 * Working anyway.
 *
 * "Hold off" assumes waiting is free. It is not. A planter has a crop
 * insurance date on it and a yield curve behind it, and past a point the
 * cost of waiting overtakes the cost of drift. The honest product does not
 * pretend that decision is the machine's to make, but it must not hide the
 * trade either.
 * ------------------------------------------------------------------ */

/**
 * The advice circulating after May 2024 was to switch off RTK and drop to a
 * lower correction tier. That is not reliably safe, and this is the one thing
 * here worth getting right.
 *
 * A dealer bulletin from the storm put it plainly: the lower tiers can also be
 * severely degraded, because the base station is transmitting corrections that
 * are themselves computed through a disturbed ionosphere, which can produce a
 * sudden shift in the field rather than a graceful loss of precision. A quiet
 * wrong answer is worse than a loud one.
 *
 * So this never recommends a tier change. It reports which jobs still clear on
 * the rig you already have, which is a claim the model can actually support.
 */
export function degradedOptions(
  kp: number,
  eq: Equipment,
  field: Field,
  blocked: Operation,
): { stillRunnable: Operation[]; spoken: string; advice: string } {
  // Tightest first, so the closest substitute to the blocked job comes first
  // rather than the loosest. Capped when spoken: certification asks for at most
  // five options read aloud, and nobody holds nine in their head anyway.
  const stillRunnable = (Object.keys(TOLERANCE_M) as Operation[])
    .filter((op) => op !== blocked && expectedErrorM(kp, eq, field) <= TOLERANCE_M[op])
    .sort((a, b) => TOLERANCE_M[a] - TOLERANCE_M[b]);

  const spoken = stillRunnable.length
    ? `${stillRunnable.slice(0, 3).map((o) => OPERATION_LABEL[o]).join(', ')} ${stillRunnable.length === 1 ? 'is' : 'are'} still inside tolerance on this rig, if the day is worth using.`
    : 'Nothing on this rig clears its tolerance at this Kp, so there is no job to switch to.';

  return {
    stillRunnable,
    spoken,
    // Kept out of the spoken line deliberately. It matters, but it is a
    // paragraph, and it belongs on a screen or in a follow-up question.
    advice:
      'Do not drop to a lower correction tier to ride it out. That advice went round after May 2024 and it is not ' +
      'safe: the base station is sending corrections worked out through the same disturbed ionosphere, so the ' +
      'coarser tiers can shift suddenly rather than degrade gently. A wrong position you trust is worse than one ' +
      'you know is wrong.',
  };
}

export type Pressure = {
  /** Whole days from now until the deadline. Negative once it has passed. */
  daysLeft: number;
  /** Is there any forecast window that clears before the deadline? */
  windowBeforeDeadline: boolean;
  verdict: 'wait' | 'no_window_left' | 'deadline_passed';
  reason: string;
};

/**
 * Whether waiting is actually an option, given a date the job has to be done by.
 *
 * Deliberately does not price the decision in money. Doing that properly needs
 * the operation's input cost, the implement width and the yield curve for that
 * crop in that county, and inventing those numbers to sound authoritative would
 * be exactly the kind of confident wrongness this project exists to avoid.
 * It answers the part it can stand behind: is there a clear window left at all.
 */
export function deadlinePressure(
  slots: Slot[],
  operation: Operation,
  eq: Equipment,
  field: Field,
  now: Date,
  deadline: Date,
): Pressure {
  const msDay = 86_400_000;
  const daysLeft = Math.floor((deadline.getTime() - now.getTime()) / msDay);
  const label = OPERATION_LABEL[operation];

  if (daysLeft < 0) {
    return {
      daysLeft,
      windowBeforeDeadline: false,
      verdict: 'deadline_passed',
      reason: `That date has gone. I can still tell you whether ${label} holds accuracy today.`,
    };
  }

  const w = nextWindow(slots, operation, eq, field, now);
  const clears = w !== null && new Date(w.start) <= deadline;

  if (clears && w) {
    return {
      daysLeft,
      windowBeforeDeadline: true,
      verdict: 'wait',
      reason:
        `You have ${daysLeft === 0 ? 'until the end of today' : `${daysLeft} day${daysLeft === 1 ? '' : 's'}`}, ` +
        `and accuracy comes back before then. Waiting costs you nothing here.`,
    };
  }

  // Either no window at all, or the first one lands after the date that matters.
  const horizonNote =
    'NOAA forecasts Kp about three days out, so beyond that I genuinely do not know rather than being pessimistic.';
  return {
    daysLeft,
    windowBeforeDeadline: false,
    verdict: 'no_window_left',
    reason:
      `No clear window for ${label} before then. ${horizonNote} ` +
      `This is the case where waiting stops being free, and it is your call rather than mine: ` +
      `I can tell you what the error will be, not what missing the date costs you.`,
  };
}
