/**
 * Real storms, replayed: what Orbita would have told each person, against what actually happened to them.
 *
 * BACKTEST.md scores the GPS verdict against real receivers. This scores the rest, storm by storm. Each event has a
 * file, evals/<event>.json, of records: something an operator did, a user saw or NOAA told operators, with its
 * source and the hour. For that hour the sky is built only from what was known then: the archived Kp up to that
 * hour (evals/<event>-kp.json, GFZ Potsdam), the watch NOAA had issued, and the R and S levels of what was already
 * running. Later blocks are left out, so nothing Orbita says here could have come from hindsight.
 *
 * A record passes when the advice for that role and hour says the specific thing that mattered (`expect`), says
 * nothing it must not (`forbid`), and is not the quiet answer; a control record where nothing happened passes only
 * when the answer is quiet; a job record passes when the go or hold matches. The patterns were written from the
 * record, before the replay was run. The point is not a score to quote: it is to find where the advice and the
 * record part company, and the misses are printed with the advice in full.
 *
 * Free and offline. `node evals/storms.mjs` replays every event and writes evals/storms-last-run.json;
 * `node evals/storms.mjs may2024` replays one.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const { advise, gFromKp } = await import('../dist/playbook.js');
const { assess } = await import('../dist/domain.js');

const here = new URL('.', import.meta.url);
const HOUR = 3_600_000;
export const EVENTS = ['may2024', 'nov2025', 'jan2026'];

export function replay(event) {
  const spec = JSON.parse(readFileSync(new URL(`${event}.json`, here), 'utf8'));
  const archive = JSON.parse(readFileSync(new URL(`${event}-kp.json`, here), 'utf8'));
  /** The sky as it stood at a moment: observed blocks up to it, nothing after. */
  const skyAt = (name) => {
    const m = spec.moments[name];
    const now = new Date(m.at);
    const slots = archive.slots
      .filter((s) => new Date(s.time).getTime() <= now.getTime())
      .map((s) => ({ time: s.time, kp: s.kp, observed: true }));
    const dayBefore = archive.slots.filter((s) => {
      const t = new Date(s.time).getTime();
      return t <= now.getTime() - 24 * HOUR && t > now.getTime() - 48 * HOUR;
    });
    return {
      now,
      levels: m.levels,
      yesterday: { g: Math.max(0, ...dayBefore.map((s) => gFromKp(s.kp))), s: 0, r: 0 },
      days: m.days.map((d) => ({ rMinorProb: null, rMajorProb: null, sProb: null, ...d })),
      slots,
    };
  };
  const results = spec.records.map((r) => {
    const sky = skyAt(r.moment);
    const current = sky.slots.filter((s) => sky.now.getTime() - new Date(s.time).getTime() < 3 * HOUR).pop();
    let said, ok;
    if (r.job) {
      const v = assess(r.job.operation, current.kp, { id: 'e', name: 'rig', correction: r.job.correction }, { id: 'f', name: 'field', lat: r.job.lat, lon: r.job.lon }, sky.now);
      said = v.reason;
      ok = v.go === !r.expectHold;
    } else {
      const a = advise(r.who, sky, null, 0, r.orbit);
      said = a.actions.length ? `${a.situation} ${a.actions.map((x) => x.say).join(' ')}` : a.spoken;
      ok = r.expectQuiet
        ? a.phase === 'quiet'
        : a.phase !== 'quiet' && new RegExp(r.expect, 'i').test(said) && !(r.forbid && new RegExp(r.forbid, 'i').test(said));
    }
    return { event, who: r.who, moment: r.moment, at: spec.moments[r.moment].at, kp: current?.kp ?? null, ok, means: r.means, happened: r.happened, source: r.source, said };
  });
  return { event, title: spec.title ?? event, results, right: results.filter((x) => x.ok).length, notCovered: spec.notCovered ?? [] };
}

export function print(run) {
  console.log(`\n${run.title}, replayed hour by hour: ${run.right} of ${run.results.length} records matched\n`);
  for (const x of run.results) {
    console.log(`  ${x.ok ? 'ok  ' : 'MISS'}  ${x.who.padEnd(19)} ${x.at.slice(0, 16).replace('T', ' ')} UTC  Kp ${x.kp}  ${x.means}`);
    if (!x.ok) console.log(`        happened: ${x.happened}\n        said:     ${x.said}\n`);
  }
  if (run.notCovered.length) {
    console.log('\n  Not covered, said plainly:');
    for (const n of run.notCovered) console.log(`    ${n.what} ${n.why}`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const which = process.argv[2] ? [process.argv[2]] : EVENTS;
  const runs = which.map(replay);
  runs.forEach(print);
  const right = runs.reduce((a, r) => a + r.right, 0);
  const of = runs.reduce((a, r) => a + r.results.length, 0);
  console.log(`\nAll events: ${right} of ${of} records matched\n`);
  if (!process.env.STORMS_NO_WRITE && !process.argv[2]) {
    writeFileSync(new URL('storms-last-run.json', here), JSON.stringify({ right, of, runs }, null, 2) + '\n');
  }
}
