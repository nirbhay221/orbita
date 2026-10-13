/**
 * For a spacecraft: can it trust where it thinks it is?
 *
 * On the ground the question is whether a receiver's fix is good. In orbit there are two positions to doubt, and
 * they fail for different reasons at different heights:
 *
 *   The orbit that was predicted. In low orbit a storm heats and swells the upper atmosphere, drag rises, and a
 *   prediction made before the storm goes stale: errors reach several kilometres within a day, and after the May
 *   2024 storm the UK's space operations centre took about two days to be confident in predictions again. NOAA
 *   names drag on orbit predictions from G2. Above low orbit there is no drag.
 *
 *   The fix from the satellite's own GNSS receiver. ESA's Swarm satellites, at 450 to 500 kilometres, lost their
 *   GPS signal almost only in two places: over the magnetic equator in the hours after sunset, where practically
 *   every low latitude loss was a plasma irregularity, and near the poles during auroral activity. A strong storm
 *   alone did not do it: none was lost in the August 2018 storm.
 *
 * And for everything on board, the particles. Protons from S2 upset memory (NOAA). In medium and high orbit the
 * outer radiation belt's electrons build charge inside components; NOAA alerts for it at 1,000 above 2 MeV,
 * measured at geostationary orbit, which is the nearest reading there is for medium orbit and is said as that.
 *
 * The answer is one of the same three words the ground check gives. A reading that is missing moves it to
 * verify, never to trust.
 *
 * Sources:
 *   https://www.swpc.noaa.gov/noaa-scales-explanation
 *   https://arxiv.org/html/2406.08617v1 (satellite drag in the May 2024 storm)
 *   https://doi.org/10.1098/rsos.251943 (the May 2024 storm, the UK experience)
 *   https://www.esa.int/Applications/Observing_the_Earth/FutureEO/Swarm/Swarm_reveals_why_satellites_lose_track
 *   https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2022SW003129 (Swarm loss of lock and turbulence)
 *   https://www.swpc.noaa.gov/products/goes-electron-flux
 */

import { geomagneticLatitude } from './domain.js';
import { ELECTRON_ALERT, type Particles } from './particles.js';

export type Regime = 'low' | 'medium' | 'high';
export type Verdict = 'trust' | 'verify' | 'do_not_trust';

/** Low Earth orbit ends at about 2,000 km; geostationary orbit is at 35,786. */
export const regimeOf = (altitudeKm: number): Regime => (altitudeKm < 2000 ? 'low' : altitudeKm < 30_000 ? 'medium' : 'high');

export type Judged = {
  verdict: Verdict;
  regime: Regime;
  against: string[];
  caution: string[];
  unchecked: string[];
  spoken: string;
};

export function judge(input: {
  altitudeKm: number;
  /** The point on the ground below the spacecraft, when the caller gave one. */
  lat?: number;
  lon?: number;
  /** The NOAA scales right now. */
  g: number;
  s: number;
  particles: Particles | null;
  now?: Date;
}): Judged {
  const { altitudeKm, lat, lon, g, s, particles } = input;
  const now = input.now ?? new Date();
  const regime = regimeOf(altitudeKm);
  const against: string[] = [];
  const caution: string[] = [];
  const unchecked: string[] = [];

  if (regime === 'low') {
    // The predicted orbit: drag.
    if (g >= 4) {
      against.push(`a G${g} storm is running: an orbit predicted before it is stale, with errors of several kilometres within a day, and after May 2024 it took about two days before predictions could be trusted again`);
    } else if (g >= 2) {
      caution.push(`a G${g} storm is running, the level from which NOAA says drag changes orbit predictions, so a prediction made before it is drifting`);
    }
    // The onboard fix: where Swarm lost its signal.
    if (lat != null && lon != null) {
      const gm = Math.abs(geomagneticLatitude(lat, lon));
      const solarHour = (((now.getUTCHours() + now.getUTCMinutes() / 60 + lon / 15) % 24) + 24) % 24;
      if (gm <= 20 && solarHour >= 19 && solarHour < 22) {
        caution.push('it is over the magnetic equator in the hours after sunset, where ESA\'s Swarm satellites lost their GPS signal to plasma irregularities, so the onboard fix may drop out on this pass');
      }
      if (gm >= 60 && g >= 1) {
        caution.push('it is at high latitude during geomagnetic activity, the other place Swarm lost its GPS signal');
      }
    } else {
      unchecked.push('where the spacecraft is over the ground, which decides whether its own GPS receiver is at risk');
    }
  } else {
    // No drag up here. Charging, from the outer radiation belt.
    const e = particles?.electrons ?? null;
    const where = regime === 'medium' ? 'measured at geostationary orbit, the nearest reading there is for medium orbit' : 'measured at geostationary orbit';
    if (e == null) unchecked.push('the electron flux at geostationary orbit');
    else if (e >= ELECTRON_ALERT) {
      caution.push(`electrons above 2 MeV are at ${Math.round(e).toLocaleString('en-US')}, ${where}, past the 1,000 where NOAA alerts for charge building up inside components`);
    } else if ((particles?.electronsDayMax ?? 0) >= ELECTRON_ALERT) {
      caution.push(`electrons above 2 MeV passed NOAA's alert line of 1,000 in the last day, ${where}, so charge built up inside components may still discharge`);
    }
    if (regime === 'high' && g >= 3) caution.push(`a G${g} storm is running, the level from which NOAA expects surface charging on spacecraft`);
  }
  // Protons, at any height.
  // NOAA's own steps: upsets possible from S2 and likely at S3; at S4, memory problems and star trackers that
  // lose the stars, which is when what the spacecraft reports about itself stops being reliable.
  if (s >= 4) against.push(`an S${s} radiation storm is running: NOAA expects memory problems and star tracker problems that can throw off a spacecraft's orientation`);
  else if (s >= 2) caution.push(`an S${s} radiation storm is running, the level from which NOAA expects single event upsets in memory`);
  if (!particles) unchecked.push('the particle readings from the GOES satellites');
  const notRead = [...new Set(unchecked)];
  if (notRead.length) caution.push(`I could not check ${notRead.join(', or ')}`);

  const verdict: Verdict = against.length ? 'do_not_trust' : caution.length ? 'verify' : 'trust';
  const orbit = regime === 'low' ? 'low orbit' : regime === 'medium' ? 'medium orbit' : 'high orbit';
  const what = regime === 'low' ? 'the predicted orbit and the onboard fix' : 'the spacecraft\'s state';
  const cap = (t: string) => t.replace(/^./, (c) => c.toUpperCase());
  const spoken =
    verdict === 'trust'
      ? `Trust it. At ${Math.round(altitudeKm).toLocaleString('en-US')} kilometres, in ${orbit}, nothing measured or forecast right now argues against ${what}: geomagnetic activity is at G${g} and radiation at S${s}.`
      : verdict === 'verify'
        ? `Verify before acting. In ${orbit}, ${caution.join('; ')}. ${regime === 'low' ? 'Run fresh orbit determination before a manoeuvre or a conjunction decision, and cross-check the onboard fix against ground tracking.' : 'Hold commanding that can wait, and treat odd behaviour as a possible discharge or upset before acting on it.'}`
        : `Do not trust it. ${cap(against.join('; '))}.${caution.length ? ` Also, ${caution.join('; ')}.` : ''} ${regime === 'low' ? 'Do not act on an orbit predicted before the storm: get fresh tracking first.' : 'Check memory and attitude health before acting on what the spacecraft reports.'}`;
  return { verdict, regime, against, caution, unchecked: notRead, spoken };
}
