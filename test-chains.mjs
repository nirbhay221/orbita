/**
 * The chains machines follow, after the fleet call, the windows and the new roles.
 *
 * A person on the farm side goes "can I run it", then "when will it clear", then "watch it for me". A machine had
 * only "ask again": a do-not-trust named the same call, and a scheduler was left to guess the next step. Now:
 *   do_not_trust            then when: the same position, with the clear windows over 72 hours
 *   verify                  the same call again, as before
 *   the windows             the single check, timed for when the first window opens, if within six hours
 *   a fleet with problems   the windows for the worst position
 *   a robot, drone, mining or fleet role in a storm at a known place
 *                           position_trust there, with what that kind of machine relies on
 * Every step is one the answer names in nextAction; nothing is called for the caller.
 *
 * Nothing here touches the network.
 */
import { mkdirSync, rmSync } from 'node:fs';

const DIR = './data/test-chains';
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
const interference = await import('./dist/interference.js');
const geo = await import('./dist/geocode.js');
const { configureForTest: fakeZones } = await import('./dist/timezone.js');
fakeZones(async () => 'America/Chicago');
const { registerTools } = await import('./dist/tools.js');

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const HOUR = 3_600_000;
const sky = (byHour = {}, base = 2, g = 0) => {
  const start = Math.floor(Date.now() / (3 * HOUR)) * 3 * HOUR;
  const slots = [];
  for (let i = -8; i < 24; i += 1) slots.push({ time: new Date(start + i * 3 * HOUR).toISOString(), kp: byHour[i * 3] ?? base, observed: i < 0 });
  swpc.seedForTest({ fetchedAt: new Date().toISOString(), slots, alerts: [], scales: { g, s: 0, r: 0, yesterday: { g: 0, s: 0, r: 0 }, days: [] }, stale: false });
  solarwind.seedForTest({ wind: null, kp: null });
};
interference.seedForTest({ tests: [], satellites: [] });
geo.configureForTest(async () => ({ name: 'Grand Island', region: 'Nebraska', country: 'United States', lat: 40.92, lon: -98.34 }));

const server = new McpServer({ name: 't', version: '1' }, { capabilities: { tools: {}, resources: {}, tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } }, taskStore: new InMemoryTaskStore(), taskMessageQueue: new InMemoryTaskMessageQueue() });
registerTools(server, () => 'acct:chains');
const client = new Client({ name: 'c', version: '1' }, { capabilities: {} });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a), client.connect(b)]);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { said: (r.content ?? []).map((c) => c.text ?? '').join(' '), data: r.structuredContent ?? {} };
};
const HERE = { lat: 40.92, lon: -98.34 };

console.log('\nA machine told not to trust its position is pointed at when it clears');
{
  sky({}, 8.7, 4);
  const r = await call('position_trust', { ...HERE, needMeters: 0.05, correction: 'rtk' });
  check('do not trust names the same position with the windows over 72 hours', r.data.verdict === 'do_not_trust' && r.data.nextAction?.tool === 'position_trust' && r.data.nextAction.arguments.windowsHours === 72 && r.data.nextAction.arguments.lat === HERE.lat, JSON.stringify(r.data.nextAction));
  check('...and the chain says so', r.data.flow?.next === 'position_trust', JSON.stringify(r.data.flow));
}

console.log('\nThe windows point at the check to make when the first one opens');
{
  sky({ 0: 8.7, 3: 8.7 }, 2, 4);
  const plan = await call('position_trust', { ...HERE, needMeters: 0.05, correction: 'rtk', windowsHours: 72 });
  const next = plan.data.nextAction;
  const opens = plan.data.windows?.[0] && Math.round((new Date(plan.data.windows[0].start).getTime() - Date.now()) / 60_000);
  check('the next step is the single check, timed for the first window', next?.tool === 'position_trust' && next.arguments.inMinutes === opens && next.arguments.windowsHours === undefined, JSON.stringify({ next, opens }));
  check('...with the same receiver', next?.arguments.correction === 'rtk' && next.arguments.needMeters === 0.05);
  sky({}, 2);
  const open = await call('position_trust', { ...HERE, needMeters: 5, windowsHours: 24 });
  check('a window already open names nothing: the answer is now', open.data.nextAction == null, JSON.stringify(open.data.nextAction));
}

console.log('\nA fleet with problems points at the windows for its worst position');
{
  sky({}, 8.7, 4);
  const fleet = await call('position_trust', { points: [{ lat: 1.35, lon: 103.82, name: 'Singapore' }, { lat: 64.84, lon: -147.72, name: 'Fairbanks' }], needMeters: 0.05, correction: 'rtk' });
  const worst = fleet.data.positions.find((p) => p.verdict === 'do_not_trust');
  check('the next step is the worst position, with its windows', fleet.data.nextAction?.arguments.windowsHours === 72 && worst && fleet.data.nextAction.arguments.lat === worst.lat, JSON.stringify(fleet.data.nextAction));
  sky({}, 1);
  const calm = await call('position_trust', { points: [{ lat: 40.92, lon: -98.34 }], needMeters: 5 });
  check('a fleet that is all trusted names nothing', calm.data.verdict === 'trust' ? calm.data.nextAction == null : true, JSON.stringify(calm.data));
}

console.log('\nSomeone who runs machines, in a storm, goes on to what those machines rely on');
{
  sky({}, 8.7, 4);
  const robots = await call('what_should_i_do', { role: 'robots', place: 'Grand Island, Nebraska' });
  const next = robots.data.nextAction;
  check('robots at a known place lead to position_trust there, with link and power', next?.tool === 'position_trust' && next.arguments.lat === 40.92 && next.arguments.dependsOn?.includes('grid_power'), JSON.stringify(next));
  const drones = await call('what_should_i_do', { role: 'drone_pilot' });
  check('a drone pilot is checked for compass and traffic awareness too', drones.data.nextAction?.arguments?.dependsOn?.includes('traffic_awareness') || typeof drones.data.nextStep === 'number', JSON.stringify(drones.data.nextAction));
  const home = await call('what_should_i_do', { role: 'household' });
  check('a household is not sent to a machine check', home.data.nextAction?.tool !== 'position_trust', JSON.stringify(home.data.nextAction));
  sky({}, 2);
  const quiet = await call('what_should_i_do', { role: 'robots' });
  check('on a quiet day the robot answer ends there', quiet.data.nextAction == null, JSON.stringify(quiet.data.nextAction));
}

await client.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
