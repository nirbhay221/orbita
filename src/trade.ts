/**
 * What a verdict means for the trade that asked.
 *
 * "Outside tolerance" is one fact and four different problems. A planter can wait, and is told to hold off already. A surveyor has points in
 * the book that may now be wrong and a closing date that does not move. A drone flight is twenty minutes that
 * cannot be had back, and a compass is upset by the same storm that upsets the receiver. A dozer that cut to
 * grade through a disturbance has moved dirt somebody will pour concrete on.
 *
 * So each trade gets the one sentence that is about its own risk, when there is one, and nothing when there
 * is not. These are working practice, written here from surveying, UAS and machine control guidance, not
 * measurements: re-observe, check in to control, calibrate, verify before you build on it.
 */

import type { Operation } from './domain.js';

const SURVEY: Operation[] = ['surveying'];
const FLIGHT: Operation[] = ['drone_survey', 'drone_show'];
const GRADE: Operation[] = ['machine_control'];
const ROWS: Operation[] = ['planting', 'strip_till', 'cultivating'];

/** For a question about running a job now or soon. */
export function adviceNow(operation: Operation, go: boolean, kp: number, limitedBy: string, equatorial = false): string {
  if (limitedBy === 'equipment') return '';
  // The evening plasma bubbles are not a storm, so the compass is not part of it.
  if (equatorial && FLIGHT.includes(operation)) return 'Do not fly a mapping mission tonight: a lost fix mid-flight cannot be repaired afterwards.';
  if (SURVEY.includes(operation)) {
    if (!go) return 'Anything you shoot now should be re-observed once it clears, and check in to a known control point before you trust the session.';
    if (kp >= 4) return 'It is unsettled, so check in to a control point at the start and the end of the session.';
    return '';
  }
  if (FLIGHT.includes(operation)) {
    if (!go) return 'Do not fly a mapping mission on this: a lost fix mid-flight cannot be repaired afterwards, and the compass is upset by the same storm.';
    if (kp >= 5) return 'The compass can be upset at this level as well as the receiver, so calibrate away from metal and be ready to fly it home by hand.';
    return '';
  }
  if (GRADE.includes(operation)) {
    if (!go) return 'Hold the blade off design grade until it clears, and check anything cut in the last few hours before you pour or pave on it.';
    return '';
  }
  return '';
}

/** For a look back at a time that has passed. `from` and `to` are already said in local time. */
export function adviceAfter(operation: Operation, affected: boolean, from: string, to: string): string {
  if (!affected) return '';
  if (SURVEY.includes(operation)) return `Re-observe any point shot between ${from} and ${to}, and do not close a traverse on it.`;
  if (FLIGHT.includes(operation)) return `Check the photo positions from any flight between ${from} and ${to} against your ground control before you process it.`;
  if (GRADE.includes(operation)) return `Check the grade on anything cut between ${from} and ${to} before you build on it.`;
  if (ROWS.includes(operation)) return `Passes made between ${from} and ${to} are the ones to look at for guess rows.`;
  return '';
}

/** What else to look at when the sky was quiet and the job still went wrong. */
export function notTheSun(correction: string): string {
  if (correction === 'rtk') return 'Look at the base station and the correction link first: a dropped radio or cellular link, a moved base, or the age of corrections climbing. Then trees, buildings and power lines near that pass.';
  if (correction === 'ppp') return 'Look at whether the receiver had finished converging, and at trees, buildings and power lines near that pass.';
  if (correction === 'sbas') return 'Look at whether the correction satellite was in view, low on the southern sky, and at trees and buildings near that pass.';
  return 'With no correction, a few metres of wander is normal on any day.';
}
