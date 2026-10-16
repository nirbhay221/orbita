/**
 * The storm replays, kept passing. evals/storms.mjs replays May 2024, November 2025 and January 2026 hour by hour
 * against what operators did, what users saw and what NOAA warned; this runs them without writing and checks every
 * record still matches, every record has a source, and the README quotes the result. (It began with May 2024 alone,
 * which is why it has this name.)
 */
process.env.MAY2024_NO_WRITE = '1';
process.env.STORMS_NO_WRITE = '1';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const { replay, EVENTS } = await import('./evals/storms.mjs');
let right = 0, of = 0;
for (const event of EVENTS) {
  const run = replay(event);
  const spec = JSON.parse(readFileSync(`./evals/${event}.json`, 'utf8'));
  console.log(`\n${run.title}: every record still matches what Orbita says at that hour`);
  for (const r of run.results) check(`${r.who} at ${r.at}: ${r.means}`, r.ok, r.said);
  check('every record has a source', spec.records.every((r) => /^https:\/\//.test(r.source)));
  right += run.right;
  of += run.results.length;
}
console.log('\nAcross the storms');
check('there is at least one control where the right answer is to stay quiet', EVENTS.some((e) => JSON.parse(readFileSync(`./evals/${e}.json`, 'utf8')).records.some((r) => r.expectQuiet)));
check('the README quotes the same result', new RegExp(`${right} of ${of} records`).test(readFileSync('./README.md', 'utf8')), `${right} of ${of}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
