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
};

export type Equipment = {
  id: string;
  name: string;
  correction: Correction;
};

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
 * Degradation multiplier by storm severity. RTK suffers most in relative terms
 * because it depends on the ionosphere being similar over the baseline, and that
 * assumption is exactly what a storm breaks.
 */
function severityMultiplier(kp: number, correction: Correction): number {
  const band = kp < 4 ? 0 : kp < 5 ? 1 : kp < 6 ? 2 : kp < 7 ? 3 : kp < 8 ? 4 : 5;
  const table: Record<Correction, number[]> = {
    //        quiet unsettled  G1    G2    G3   G4+
    rtk: [1, 2.5, 8, 20, 34, 52],
    ppp: [1, 1.8, 3.9, 6.8, 8.5, 10.5],
    sbas: [1, 1.4, 2.2, 3.0, 3.6, 4.2],
    autonomous: [1, 1.1, 1.3, 1.5, 1.7, 2.0],
  };
  return table[correction][band];
}

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

/**
 * How exposed this site is, which is two different things added together.
 *
 * The first is climatological: an auroral-zone field is a harder place to hold
 * centimetres than a Gulf Coast one, on any day. The second only appears during
 * a storm, when the oval arrives overhead. The November 2025 superstorm put
 * positioning errors over ten metres across most of the continental United
 * States, as far south as Florida, on ground that is entirely unremarkable at
 * Kp 4, because auroral precipitation had expanded that far down. A model with
 * fixed latitude bands cannot say that, and would have called that day mild in
 * Iowa.
 *
 * Yizengaw et al. 2026, Geophysical Research Letters, "Impacts of Mid-Latitude
 * Ionospheric Dynamics on RF Applications During the November 2025 Superstorm
 * Event", https://doi.org/10.1029/2026GL124645
 */
function latitudeFactor(lat: number, lon: number, kp: number): number {
  const a = Math.abs(geomagneticLatitude(lat, lon));
  const climatological = a >= 55 ? 1.6 : a >= 45 ? 1.25 : a >= 35 ? 1.0 : 0.8;

  // How far inside the oval this site sits today. Positive means the edge has
  // already passed over it.
  const margin = a - auroralBoundaryDeg(kp);
  const reach = margin >= 0 ? 1.35 : margin >= -5 ? 1.15 : margin >= -12 ? 1.05 : 1;

  return climatological * reach;
}

/** Long RTK baselines lose the ionospheric-similarity assumption first. */
function baselineFactor(km: number | undefined, correction: Correction): number {
  if (correction !== 'rtk' || km == null) return 1;
  if (km <= 10) return 0.7;
  if (km <= 30) return 1.0;
  if (km <= 70) return 1.5;
  return 2.2;
}

export function expectedErrorM(kp: number, eq: Equipment, field: Field): number {
  const base = QUIET_ERROR_M[eq.correction];
  const err =
    base *
    severityMultiplier(kp, eq.correction) *
    latitudeFactor(field.lat, field.lon, kp) *
    baselineFactor(field.baselineKm, eq.correction);
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
};

/** Inches, but keep a decimal under 3" so a 1.5" difference doesn't round away. */
function inches(m: number): string {
  const v = m * 39.37;
  if (v < 3) return `${v.toFixed(1)} inches`;
  return `${Math.round(v)} inches`;
}

const distance = (m: number) => (m >= 1 ? `${m.toFixed(1)} metres` : inches(m));

export function assess(
  operation: Operation,
  kp: number,
  eq: Equipment,
  field: Field,
): Verdict {
  const err = expectedErrorM(kp, eq, field);
  const quiet = expectedErrorM(2, eq, field);
  const tol = TOLERANCE_M[operation];
  const go = err <= tol;
  const g = G_SCALE(kp);
  const label = OPERATION_LABEL[operation];

  let limitedBy: Verdict['limitedBy'];
  let reason: string;

  if (go) {
    limitedBy = 'clear';
    reason = `Clear for ${label}. Kp ${kp.toFixed(1)}${g === 'none' ? '' : ` (${g})`}, expected drift about ${inches(err)} against a ${inches(tol)} tolerance.`;
  } else if (quiet > tol) {
    // Not the sun. This rig cannot hit that tolerance on its best day.
    limitedBy = 'equipment';
    reason =
      `That's not the space weather. ${eq.name} on ${eq.correction.toUpperCase()} runs about ${inches(quiet)} even on a quiet day, ` +
      `and ${label} needs it inside ${inches(tol)}. Waiting for the storm to pass won't change that.`;
  } else {
    limitedBy = 'space_weather';
    const factor = err / quiet;
    reason =
      `Hold off ${label}. Kp ${kp.toFixed(1)} (${g}) puts expected drift near ${distance(err)}, ` +
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
    const ok = expectedErrorM(s.kp, eq, field) <= tol;
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
