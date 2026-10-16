/**
 * The May 2024 storm, replayed. This was the first event replayed; the runner now lives in storms.mjs, which
 * replays every event, and this keeps the May run and its saved result where they were.
 *
 * Free and offline. `node evals/may2024.mjs` prints the table and writes evals/may2024-last-run.json.
 */
import { writeFileSync } from 'node:fs';
import { replay, print } from './storms.mjs';

const run = replay('may2024');
const { results, right } = run;
if (process.argv[1]?.replace(/\\/g, '/').endsWith('evals/may2024.mjs')) {
  print(run);
  if (!process.env.MAY2024_NO_WRITE) {
    writeFileSync(new URL('may2024-last-run.json', import.meta.url), JSON.stringify({ right, of: results.length, results, notCovered: run.notCovered }, null, 2) + '\n');
  }
}
export { results, right };
