/**
 * The voice budget, measured rather than asserted.
 *
 * A voice turn is roughly half a second end to end, and the add-on is only one
 * part of that: the host has to hear, route, call us, and speak. The whole
 * design rests on one claim, that answers are arithmetic over a forecast held
 * in memory rather than a call to NOAA, so this measures it and fails the build
 * if it stops being true.
 *
 * Two budgets, because two different things are being promised:
 *   - tools answered from memory:      p95 under 50 ms
 *   - tools that reach a live archive: p95 under 3 s, and they say so in advance
 *
 * Numbers from the last run are written to LATENCY.md, so the claim in the
 * README is a measurement someone can re-run, not a boast.
 */
import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 8795;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = './data/test-latency.json';
const ROUNDS = Number(process.env.ROUNDS ?? 20);
// A shared CI runner is slower and noisier than a laptop, so the budget is
// overridable there. The number in LATENCY.md is always the one measured on
// the machine that ran it, not the budget it was checked against.
const MEMORY_BUDGET_MS = Number(process.env.LATENCY_BUDGET_MS ?? 50);
const ARCHIVE_BUDGET_MS = 3000;
rmSync(DATA, { force: true });

const server = spawn(process.execPath, ['dist/server.js'], {
  env: { ...process.env, PORT: String(PORT), ORBITA_DATA: DATA, ORBITA_AUTH: 'off' },
  stdio: 'ignore',
});
const stop = () => { try { server.kill(); } catch { /* already gone */ } };
process.on('exit', stop);

let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch(`${BASE}/health`)).ok; } catch { await wait(500); }
}
if (!up) { console.log('  FAIL  the server never came up'); stop(); process.exit(1); }
// The background NOAA poll has to have landed, or this measures an empty cache.
await wait(2000);

let rpcId = 0;
async function call(name, args = {}) {
  const started = process.hrtime.bigint();
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-orbita-demo': '2d22c53a3dc7b9fead2dab7f2b602f67',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const line = raw.split('\n').find((l) => l.startsWith('data: '));
  const body = JSON.parse(line ? line.slice(6) : raw);
  return { ms, ok: !body.error && !!body.result?.content?.[0]?.text };
}

/** From memory, or from a live archive: the promise is different for each. */
const MEMORY = {
  storm_status: {},
  farm_status: {},
  can_i_run: { operation: 'planting', field: 'north', equipment: 'planter' },
  what_should_i_do: { role: 'grid_operator' },
  what_else_is_affected: {},
  what_can_you_do: {},
  watch_jobs: { action: 'check' },
  job_report: { days: 7 },
  log_job: { operation: 'planting', field: 'north', equipment: 'planter' },
};
const ARCHIVE = {
  what_happened: { when: '10 May 2024', operation: 'planting' },
};

await call('register_field', { name: 'North 40', lat: 42.03, lon: -93.62, baselineKm: 18 });
await call('register_equipment', { name: 'the planter', correction: 'rtk' });

const pct = (xs, p) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))];
const rows = [];

async function measure(name, args, budget, kind) {
  const times = [];
  for (let i = 0; i < ROUNDS; i++) times.push((await call(name, args)).ms);
  const row = { name, kind, p50: pct(times, 50), p95: pct(times, 95), max: Math.max(...times), budget };
  rows.push(row);
  check(`${name} p95 ${row.p95.toFixed(1)} ms, under ${budget} ms`, row.p95 < budget,
    `p50 ${row.p50.toFixed(1)} p95 ${row.p95.toFixed(1)} max ${row.max.toFixed(1)}`);
}

console.log(`\nAnswers held in memory, ${ROUNDS} calls each`);
for (const [name, args] of Object.entries(MEMORY)) await measure(name, args, MEMORY_BUDGET_MS, 'memory');

console.log('\nAnswers that reach a live archive, which say so before they are called');
for (const [name, args] of Object.entries(ARCHIVE)) await measure(name, args, ARCHIVE_BUDGET_MS, 'archive');

console.log('\nThe whole turn, one after another');
const sequence = ['storm_status', 'can_i_run', 'what_should_i_do'];
const wholeTurn = [];
for (let i = 0; i < ROUNDS; i++) {
  const started = process.hrtime.bigint();
  for (const name of sequence) await call(name, MEMORY[name]);
  wholeTurn.push(Number(process.hrtime.bigint() - started) / 1e6);
}
check(`three tools in one turn, p95 ${pct(wholeTurn, 95).toFixed(1)} ms, under 150 ms`, pct(wholeTurn, 95) < 150,
  `p50 ${pct(wholeTurn, 50).toFixed(1)}`);

const memory = rows.filter((r) => r.kind === 'memory');
const worst = memory.reduce((a, b) => (a.p95 > b.p95 ? a : b));
writeFileSync(
  'LATENCY.md',
  `# Latency\n\n` +
    `Measured by \`node test-latency.mjs\`, ${ROUNDS} calls per tool, over HTTP against the built\n` +
    `server on this machine, with the NOAA forecast already in memory. Node ${process.version}.\n` +
    `Last run ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.\n\n` +
    `A voice turn is roughly half a second in total, and the add-on is one part of that.\n` +
    `Everything below is the server's own share, from request received to response written.\n\n` +
    `| tool | source | p50 ms | p95 ms | max ms | budget |\n|---|---|---|---|---|---|\n` +
    rows
      .map((r) => `| \`${r.name}\` | ${r.kind} | ${r.p50.toFixed(1)} | ${r.p95.toFixed(1)} | ${r.max.toFixed(1)} | ${r.budget} |`)
      .join('\n') +
    `\n\nThree tools called one after another, as a single turn might: p50 ` +
    `${pct(wholeTurn, 50).toFixed(1)} ms, p95 ${pct(wholeTurn, 95).toFixed(1)} ms.\n\n` +
    `The slowest in-memory answer is \`${worst.name}\` at ${worst.p95.toFixed(1)} ms p95. ` +
    `\`what_happened\` is the one tool that leaves the process: it reads the GFZ Kp archive for a\n` +
    `day older than the seven days NOAA keeps live, which is why it has its own budget.\n`,
);
console.log('\nwrote LATENCY.md');

stop();
rmSync(DATA, { force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
