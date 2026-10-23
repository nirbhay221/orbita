#!/usr/bin/env node
/**
 * The deployed demo, checked the way a judge would use it, with no language model and no cost.
 *
 * Judging runs weeks after the last code change, so the tests that run on a push never run while anybody is looking.
 * This calls the live server's tools directly over MCP, as a throwaway demo visitor, and fails if an answer is wrong
 * or missing: fresh NOAA data, the May 2024 storm replayed as the sun, a position check in Fargo, the demo page and the
 * code behind the README's links. Run on a schedule by .github/workflows/live-check.yml.
 *
 *   node scripts/live-check.mjs [https://host]
 */
import { randomBytes } from 'node:crypto';

const BASE = (process.argv[2] ?? process.env.ORBITA_URL ?? 'https://ct5ae538t6.execute-api.us-east-1.amazonaws.com').replace(/\/$/, '');
const demo = randomBytes(16).toString('hex');
let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : `  ${String(detail).slice(0, 300)}`}`);
  if (!ok) failed += 1;
};

let id = 0;
async function tool(name, args) {
  const started = Date.now();
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orbita-demo': demo },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const line = raw.split('\n').find((l) => l.startsWith('data: '));
  const json = JSON.parse(line ? line.slice(6) : raw);
  return { ms: Date.now() - started, text: json.result?.content?.[0]?.text ?? '', data: json.result?.structuredContent ?? {}, error: json.error };
}

try {
  const health = await (await fetch(`${BASE}/health`)).json();
  check('the server is up', health.ok === true, JSON.stringify(health).slice(0, 200));
  check('NOAA data is under an hour old', health.noaa && health.noaa.ageMinutes != null && health.noaa.ageMinutes < 60 && !health.noaa.stale, JSON.stringify(health.noaa));
  check('the measured sky is being read', (health.skyLinks?.links ?? 0) > 100, JSON.stringify(health.skyLinks));

  const page = await fetch(`${BASE}/echo.html`);
  check('the demo page is served', page.ok && /Echo Show/.test(await page.text()));
  const script = await (await fetch(`${BASE}/echo.js`)).text();
  check("the code behind the README's links is served", /playFromLink/.test(script));

  const now = await tool('storm_status', {});
  check('storm_status answers with the Kp', /Kp is \d/.test(now.text), now.text || now.error?.message);

  const setup = await tool('my_farm', { fieldName: 'North 40', place: 'Grand Island, Nebraska', machineName: 'planter', correction: 'rtk' });
  check('a field is saved by its town', /North 40/.test(setup.text), setup.text || setup.error?.message);

  const may = await tool('what_happened', { when: 'May 10, 2024', operation: 'planting' });
  check('May 10, 2024 is replayed as the sun, at Kp 9', may.data.wasTheSun === true && (may.data.peak?.kp ?? 0) >= 8.9, may.text || may.error?.message);

  const run = await tool('can_i_run', { operation: 'planting' });
  check('can_i_run gives a go or a hold for the saved field', typeof run.data.go === 'boolean' && /planting/i.test(run.text), run.text || run.error?.message);
  check('...inside the voice budget', run.ms < 2000, `${run.ms} ms`);

  const robots = await tool('position_trust', { place: 'Fargo, North Dakota' });
  check('a machine in Fargo gets trust, verify or do not trust', ['trust', 'verify', 'do_not_trust'].includes(robots.data.verdict), robots.text || robots.error?.message);
} catch (err) {
  check('the live server could be reached', false, err instanceof Error ? err.message : err);
}

console.log(failed ? `\n${failed} failed against ${BASE}` : `\nall passed against ${BASE}`);
process.exit(failed ? 1 : 0);
