/**
 * A machine judged by what it relies on, not by what kind of machine it is.
 *
 * position_trust answers for a GNSS fix. With dependsOn it also answers for a satellite link, HF radio, grid power,
 * electronics at altitude and a compass, each from data Orbita already reads, so a machine nobody has built yet gets
 * an answer without a new role. What matters as much as each verdict is its ceiling: the grid kept its lights on
 * through the G5 of May 2024, so grid power is never "do not trust", and a compass has no published storm line for
 * small machines, so it is never more than "verify". Without dependsOn the tool must answer exactly as before.
 *
 * Nothing here touches the network.
 */
import { mkdirSync, rmSync } from 'node:fs';

const DIR = './data/test-dependencies';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.ORBITA_DATA = `${DIR}/farms.json`;
delete process.env.ORBITA_DATA_KEY;
delete process.env.ORBITA_SCOPE;

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';

const swpc = await import('./dist/swpc.js');
const solarwind = await import('./dist/solarwind.js');
const particles = await import('./dist/particles.js');
const ground = await import('./dist/ground.js');
const geomag = await import('./dist/geomag.js');
const deps = await import('./dist/dependencies.js');
const { registerTools } = await import('./dist/tools.js');

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const HOUR = 3_600_000;
const sky = (kp, { g = 0, s = 0, r = 0 } = {}) => {
  const start = Math.floor(Date.now() / (3 * HOUR)) * 3 * HOUR;
  const slots = [];
  for (let i = -8; i < 24; i += 1) slots.push({ time: new Date(start + i * 3 * HOUR).toISOString(), kp, observed: i < 0 });
  swpc.seedForTest({ fetchedAt: new Date().toISOString(), slots, alerts: [], scales: { g, s, r, yesterday: { g: 0, s: 0, r: 0 }, days: [] }, stale: false });
  solarwind.seedForTest({ wind: null, kp: null });
};
const MINNEAPOLIS = { lat: 44.98, lon: -93.27 };
const FAIRBANKS = { lat: 64.84, lon: -147.72 };

console.log('\nEach dependency, and its ceiling');
{
  sky(2);
  particles.seedForTest(null);
  const lons0 = []; for (let lon = -178; lon <= 178; lon += 4) lons0.push(lon);
  const quietMap = ['# Product Valid At : 2026-10-16 01:02 UTC', '#  X-RAY Message : Normal X-ray Background', '#  Proton Message : Normal Proton Background', `     ${lons0.join(' ')}`];
  for (let lat = 89; lat >= -89; lat -= 2) quietMap.push(`${lat} | ${lons0.map(() => '0.0').join(' ')}`);
  ground.resetForTest();
  check('with no absorption map at all, HF is "verify", never "trust"', deps.judge('hf_radio', MINNEAPOLIS).verdict === 'verify');
  ground.seedForTest({ drapText: quietMap.join('\n') });
  for (const d of deps.DEPENDENCIES.filter((x) => x !== 'satellite_position' && x !== 'traffic_awareness')) {
    const j = deps.judge(d, MINNEAPOLIS, 10);
    check(`${d}: trusted on a quiet day, with a source`, j.verdict === 'trust' && /^https:\/\//.test(j.source), JSON.stringify(j));
  }

  sky(9, { g: 5, s: 4, r: 3 });
  particles.seedForTest({ electrons: 100, electronsDayMax: 100, protons10: 2e4, protons50: 10, protons100: 1, measuredAt: new Date().toISOString() });
  check('G5: a satellite link is checked, with Starlink in May 2024 behind it', deps.judge('satellite_link', MINNEAPOLIS).verdict === 'verify' && /Starlink/.test(deps.judge('satellite_link', MINNEAPOLIS).reason));
  const grid = deps.judge('grid_power', MINNEAPOLIS);
  check('G5: grid power is "verify", never "do not trust", and says the lights stayed on in 2024', grid.verdict === 'verify' && /kept its lights on/.test(grid.reason), JSON.stringify(grid));
  check('S4 at 11 km: electronics at altitude are checked', deps.judge('electronics_at_altitude', MINNEAPOLIS, 11).verdict === 'verify');
  check('...and on the ground they are not, because the atmosphere shields them', deps.judge('electronics_at_altitude', MINNEAPOLIS, 0.1).verdict === 'trust');
  check('R3: HF is checked even with no absorption map loaded', deps.judge('hf_radio', MINNEAPOLIS).verdict === 'verify');
  check('G5 with no magnetometer near: a compass is "verify", never more', deps.judge('compass', { lat: -15, lon: -60 }).verdict === 'verify');

  sky(7.3, { g: 4 });
  particles.seedForTest(null);
  check('G4 at high latitude: grid power is checked', deps.judge('grid_power', FAIRBANKS).verdict === 'verify');
  check('...and at mid latitude it is not', deps.judge('grid_power', MINNEAPOLIS).verdict === 'trust');

  ground.resetForTest();
  const lons = []; for (let lon = -178; lon <= 178; lon += 4) lons.push(lon);
  const rows = []; for (let lat = 89; lat >= -89; lat -= 2) rows.push(`${lat} | ${lons.map(() => (lat > 40 && lat < 50 ? '15.0' : '0.0')).join(' ')}`);
  ground.seedForTest({ drapText: ['# Product Valid At : 2026-10-16 01:02 UTC', '#  X-RAY Message : X-ray Event', '#  Proton Message : Normal', `     ${lons.join(' ')}`, ...rows].join('\n') });
  const hf = deps.judge('hf_radio', MINNEAPOLIS);
  check('absorption up to 15 MHz over the point: do not rely on HF, and it says up to what', hf.verdict === 'do_not_trust' && /15 megahertz/.test(hf.reason), JSON.stringify(hf));
  check('the worst of several is the answer', deps.worst(['trust', 'verify', 'do_not_trust', 'trust']) === 'do_not_trust' && deps.worst(['trust']) === 'trust');

  sky(2);
  geomag.resetForTest();
  const start = Date.now() - 180 * 60_000;
  const samples = [];
  for (let i = 0; i < 180; i += 1) samples.push({ at: new Date(start + i * 60_000).toISOString(), h: 20600 - (i > 170 ? 80 : 0) });
  geomag.seedForTest({ readings: [{ id: 'BOU', samples }] });
  const compass = deps.judge('compass', { lat: 39.74, lon: -104.99 });
  check('a disturbed magnetometer nearby moves a compass to "verify" even on a quiet forecast, by name', compass.verdict === 'verify' && /Boulder/.test(compass.reason), JSON.stringify(compass));
  geomag.resetForTest();
}

console.log('\nThrough position_trust');
{
  const server = new McpServer({ name: 't', version: '1' }, { capabilities: { tools: {}, resources: {}, tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } }, taskStore: new InMemoryTaskStore(), taskMessageQueue: new InMemoryTaskMessageQueue() });
  registerTools(server, () => 'acct:robot');
  const client = new Client({ name: 'c', version: '1' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (args) => {
    const r = await client.callTool({ name: 'position_trust', arguments: args });
    return { said: (r.content ?? []).map((c) => c.text ?? '').join(' '), data: r.structuredContent ?? {} };
  };

  sky(2);
  ground.resetForTest();
  const plain = await call({ ...MINNEAPOLIS });
  const same = await call({ ...MINNEAPOLIS, dependsOn: ['satellite_position'] });
  check('without dependsOn, the answer is exactly what it was', plain.said === same.said && plain.data.verdict === same.data.verdict && !plain.data.dependencies, plain.said);

  sky(9, { g: 5, s: 0, r: 0 });
  const robot = await call({ ...MINNEAPOLIS, needMeters: 0.05, correction: 'rtk', dependsOn: ['satellite_position', 'satellite_link', 'grid_power'] });
  check('a home robot on RTK, Starlink and the grid, at G5: one verdict, the worst of them', robot.data.verdict === 'do_not_trust', JSON.stringify(robot.data.verdict));
  check('...said first in one sentence: each thing and its verdict', /^Do not rely on all of it\. position: do not rely on it; satellite link: verify; grid power: verify\./.test(robot.said), robot.said);
  check('...then the worst reason first', robot.said.indexOf('Position:') < robot.said.indexOf('Satellite link:'), robot.said);
  check('...and each in the data with its source', robot.data.dependencies?.length === 2 && robot.data.dependencies.every((d) => d.source), JSON.stringify(robot.data.dependencies));
  check('...and the position\'s own verdict kept apart', robot.data.positionVerdict === 'do_not_trust');

  const radioOnly = await call({ dependsOn: ['satellite_link'] });
  check('a link alone needs no position', radioOnly.data.verdict === 'verify' && !/latitude/.test(radioOnly.said), radioOnly.said);
  await client.close();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
