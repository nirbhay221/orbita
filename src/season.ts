/**
 * The answer that does not fit in a turn.
 *
 * Every other tool here answers a question about now, or about the next three
 * days, and speaks the answer in a sentence. This one answers a question about a
 * season, and a season does not fit in a sentence.
 *
 * The 45 day Ap and F10.7 forecast makes it possible: it is the only NOAA feed
 * Orbita reads that operates on the timescale of the decision it informs.
 * "Should I book a custom crew for the week of the 12th" is not answerable from
 * a three day outlook, and it is the question that actually costs money.
 *
 * Why this is a task rather than an ordinary tool, stated honestly.
 *
 * It is not because the server needs minutes. Five fields against ten operations
 * across forty-five days is a few thousand evaluations and finishes in
 * milliseconds. It is because of the shape of the result. Tasks, new in spec
 * 2025-11-25, exist for "call now, fetch later": the host gets a handle
 * immediately, polls, and collects the result when it has somewhere to put it.
 * A season plan is a table with a row per field and per window. That belongs on
 * an Echo Show's screen, fetched when the panel is ready to render it, not read
 * aloud at a customer in one breath.
 *
 * It is also deliberately a *new* tool rather than a conversion of an existing
 * one. Task support is a host capability and Alexa+'s is unknown; registering a
 * working tool as task-only would break it on any host that cannot poll. Nothing
 * here can regress anything, which is the right trade three weeks from a
 * deadline.
 *
 * The case that genuinely needs tasks for latency rather than shape is the
 * companion add-on's geocoding, where a 740 to 1000 ms lookup runs against a
 * turn budget of roughly 500 and is currently handled by answering at once and
 * resolving in the background. That is the same problem tasks were added to
 * solve, and it is recorded in that project's friction log as an open question.
 */

import { assess, TOLERANCE_M, type Operation } from './domain.js';
import type { Equipment, Field } from './domain.js';
import * as swpcplus from './swpcplus.js';
import * as glotec from './glotec.js';

/** A run of consecutive days a job can hold accuracy through. */
export type Window = {
  from: string;
  to: string;
  days: number;
  /** The worst Kp-equivalent inside the run, which is what makes it the limit. */
  worstKp: number;
};

export type FieldPlan = {
  field: string;
  equipment: string;
  /** Operations this rig can hold on this field at all, on a quiet day. */
  feasible: Operation[];
  /** Operations it cannot hold even at Kp 0, which waiting will never fix. */
  neverHolds: Operation[];
  /** Per operation, the runs of clear days in the outlook. */
  windows: Record<string, Window[]>;
  /**
   * Metres of unmodelled ionospheric residual across this field's baseline right
   * now, when GloTEC has a reading. A season plan built while this is large is a
   * plan whose assumptions are already being violated.
   */
  residualNow: number | null;
};

export type SeasonPlan = {
  /** How far ahead the outlook reached, in days. */
  horizon: number;
  from: string;
  to: string;
  plans: FieldPlan[];
  /** Days in the outlook where no field can run anything. */
  writeOffDays: string[];
  notes: string[];
};

/** The minimum run worth calling a window. Below this nobody mobilises. */
const MIN_RUN_DAYS = 2;
const MAX_FIELDS = 25;
const MAX_MACHINES = 6;

/**
 * Consecutive days on which an operation holds, collapsed into runs.
 *
 * `assess` is the same function the go/no-go answer uses, so a season plan and a
 * "can I plant now" cannot disagree about the same field and the same Kp. That
 * matters more than it looks: two code paths computing tolerance separately is
 * how a product ends up telling somebody different things on Tuesday and Friday.
 */
function windowsFor(
  operation: Operation,
  days: { date: string; kp: number }[],
  eq: Equipment,
  field: Field,
): Window[] {
  const runs: Window[] = [];
  let start = -1;
  let worst = 0;

  const flush = (endIndex: number) => {
    if (start < 0) return;
    const length = endIndex - start + 1;
    if (length >= MIN_RUN_DAYS) {
      runs.push({
        from: days[start].date,
        to: days[endIndex].date,
        days: length,
        worstKp: Math.round(worst * 100) / 100,
      });
    }
    start = -1;
    worst = 0;
  };

  for (let i = 0; i < days.length; i += 1) {
    const holds = assess(operation, days[i].kp, eq, field).go;
    if (holds) {
      if (start < 0) start = i;
      if (days[i].kp > worst) worst = days[i].kp;
    } else {
      flush(i - 1);
    }
  }
  flush(days.length - 1);
  return runs;
}

/**
 * Build the plan.
 *
 * Synchronous and pure apart from reading the cached outlook and TEC grid, so it
 * can be called from a task handler without the handler having to care about
 * network timing. Everything it reads is already in memory on a background timer.
 */
export function plan(fields: Field[], equipment: Equipment[], operations: Operation[]): SeasonPlan | null {
  const outlook = swpcplus.outlook();
  if (!outlook.length || !fields.length || !equipment.length) return null;

  const today = new Date().toISOString().slice(0, 10);
  const days = outlook.filter((d) => d.date >= today).map((d) => ({ date: d.date, kp: d.kp }));
  if (!days.length) return null;

  // The sweep is fields times machines times jobs times days, on the request path. An account may hold
  // five hundred fields and a hundred machines, which is over twenty million assessments and a process that
  // answers nobody while it works. A season plan for the first of each is still a season plan.
  const truncated = fields.length > MAX_FIELDS || equipment.length > MAX_MACHINES;
  fields = fields.slice(0, MAX_FIELDS);
  equipment = equipment.slice(0, MAX_MACHINES);

  const plans: FieldPlan[] = [];
  const pairs: { field: Field; eq: Equipment; feasible: Operation[] }[] = [];
  for (const field of fields) {
    for (const eq of equipment) {
      const feasible: Operation[] = [];
      const neverHolds: Operation[] = [];
      const windows: Record<string, Window[]> = {};

      for (const operation of operations) {
        // Kp 0 is the best the sky ever gets. An operation that fails there is
        // limited by the rig, not the sun, and no amount of waiting helps. Saying
        // that plainly is more useful than an empty window list.
        if (!assess(operation, 0, eq, field).go) {
          neverHolds.push(operation);
          continue;
        }
        feasible.push(operation);
        const runs = windowsFor(operation, days, eq, field);
        if (runs.length) windows[operation] = runs;
      }

      plans.push({
        field: field.name,
        equipment: eq.name,
        feasible,
        neverHolds,
        windows,
        residualNow: field.baselineKm ? glotec.residual(field.lat, field.lon, field.baselineKm) : null,
      });
      pairs.push({ field, eq, feasible });
    }
  }

  // A day nothing can run on is worth naming separately: it is the day to
  // schedule maintenance rather than discover a problem in the field.
  // A day is a write-off when nothing that can ever run does run. Each job is judged on its own field and
  // machine; this used to judge every plan's jobs against the first field and the first machine only.
  const writeOffDays = days
    .filter((d) => !pairs.some((p) => p.feasible.some((op) => assess(op, d.kp, p.eq, p.field).go)))
    .map((d) => d.date);

  const notes: string[] = [];
  notes.push(
    'Built from the NOAA 45 day Ap forecast, converted to a Kp equivalent. A 45 day geomagnetic forecast is ' +
    'a statistical outlook, not a prediction of individual storms: use it to choose between weeks, not to ' +
    'commit to a morning.',
  );
  const anyNever = plans.some((p) => p.neverHolds.length);
  if (anyNever) {
    notes.push(
      'Some operations are listed as never holding. Those are limited by the correction the machine runs and ' +
      'the baseline it sits on, not by space weather, so waiting for a quiet week will not change them.',
    );
  }
  const stressed = plans.filter((p) => p.residualNow != null && p.residualNow > 0.02);
  if (stressed.length) {
    notes.push(
      `The ionosphere is currently leaving more than two centimetres uncorrected across ${stressed.length} ` +
      'of these baselines, measured rather than forecast. That is today, not the season, but it is worth ' +
      'knowing before trusting a plan built on quiet assumptions.',
    );
  }

  if (truncated) {
    notes.push(`This covers the first ${MAX_FIELDS} fields and ${MAX_MACHINES} machines. Ask about a particular field or machine for the rest.`);
  }

  return { horizon: days.length, from: days[0].date, to: days[days.length - 1].date, plans, writeOffDays, notes };
}

/** One spoken line, because a host without a screen still has to say something. */
export function summarise(p: SeasonPlan): string {
  const best = p.plans
    .flatMap((fp) => Object.entries(fp.windows).map(([op, runs]) => ({ field: fp.field, op, run: runs[0] })))
    .filter((x) => x.run)
    .sort((a, b) => b.run.days - a.run.days)[0];

  if (!best) {
    return `Nothing in the next ${p.horizon} days holds accuracy for these machines on these fields.`;
  }
  const offs = p.writeOffDays.length
    ? ` ${p.writeOffDays.length === 1 ? '1 day in that span is a write-off' : `${p.writeOffDays.length} days in that span are write-offs`} for everything.`
    : '';
  // Nothing here points at a screen: the same sentence is spoken on a device that has none, and the
  // certification rules say never to refer to one there. A date is said as a date, not as 2026-10-07.
  const starting = new Date(`${best.run.from}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  return (
    `Across the next ${p.horizon} days the longest clear run is ${best.run.days} days for ${best.op.replace(/_/g, ' ')} ` +
    `on ${best.field}, starting ${starting}.${offs} Ask about a field or a job and I will give you its windows.`
  );
}
