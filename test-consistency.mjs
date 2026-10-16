/**
 * One engine, three doors: the same question gets the same answer whichever tool a model picks.
 *
 * can_i_run answers a person about a job on a field, position_trust answers a machine about a point, and
 * what_should_i_do hands a field crew back to can_i_run. They are separate tools because the people and the words
 * differ, and a model choosing between them can pick either for a borderline question. What must never happen is
 * that the choice changes the answer. So for the same place, the same receiver, the same accuracy and the same sky,
 * a go from can_i_run is a trust from position_trust, a hold is not a trust, and the fleet and planning forms of
 * position_trust agree with the single one.
 *
 * Nothing here touches the network.
 */
import { mkdirSync, rmSync } from 'node:fs';

const DIR = './data/test-consistency';
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
const store = await import('./dist/store.js');
const { TOLERANCE_M } = await import('./dist/domain.js');
const { configureForTest: fakeZones } = await import('./dist/timezone.js');
fakeZones(async () => 'America/Chicago');
const { registerTools } = await import('./dist/tools.js');

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const HOUR = 3_600_000;
const sky = (kp, g) => {
  const start = Math.floor(Date.now() / (3 * HOUR)) * 3 * HOUR;
  const slots = [];
  for (let i = -8; i < 24; i += 1) slots.push({ time: new Date(start + i * 3 * HOUR).toISOString(), kp, observed: i < 0 });
  swpc.seedForTest({ fetchedAt: new Date().toISOString(), slots, alerts: [], scales: { g, s: 0, r: 0, yesterday: { g: 0, s: 0, r: 0 }, days: [] }, stale: false });
  solarwind.seedForTest({ wind: null, kp: null });
};
interference.seedForTest({ tests: [], satellites: [] });

const server = new McpServer({ name: 't', version: '1' }, { capabilities: { tools: {}, resources: {}, tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } }, taskStore: new InMemoryTaskStore(), taskMessageQueue: new InMemoryTaskMessageQueue() });
registerTools(server, () => 'acct:same');
const client = new Client({ name: 'c', version: '1' }, { capabilities: {} });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a), client.connect(b)]);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { said: (r.content ?? []).map((c) => c.text ?? '').join(' '), data: r.structuredContent ?? {} };
};

// A field in Nebraska and one near the magnetic equator, after dark there.
const FIELDS = [
  { name: 'North 40', lat: 40.92, lon: -98.34 },
  { name: 'Fairbanks plot', lat: 64.84, lon: -147.72 },
];
store.update('acct:same', (f) => {
  FIELDS.forEach((x, i) => f.fields.push({ id: `f${i}`, ...x, timeZone: 'America/Chicago' }));
  f.equipment.push({ id: 'e0', name: 'planter', correction: 'rtk' });
  f.equipment.push({ id: 'e1', name: 'sprayer', correction: 'sbas' });
});

console.log('\ncan_i_run and position_trust agree, for the same place, receiver, accuracy and sky');
const cases = [];
for (const [kp, g] of [[2, 0], [6.3, 2], [8.7, 4]]) {
  sky(kp, g);
  for (const field of FIELDS) {
    for (const [operation, equipment, correction] of [['planting', 'planter', 'rtk'], ['spraying', 'sprayer', 'sbas']]) {
      const person = await call('can_i_run', { operation, field: field.name, equipment });
      const machine = await call('position_trust', { lat: field.lat, lon: field.lon, correction, needMeters: TOLERANCE_M[operation] });
      const go = person.data.go;
      const agree = go === true ? machine.data.verdict === 'trust' || machine.data.verdict === 'verify' : machine.data.verdict !== 'trust';
      cases.push({ kp, field: field.name, operation, go, verdict: machine.data.verdict, agree });
      check(`Kp ${kp}, ${operation} on ${field.name}: ${go ? 'go' : 'hold'} for a person, ${machine.data.verdict} for a machine`, agree && typeof go === 'boolean',
        `${person.said} || ${machine.said}`);
    }
  }
}
check('the sweep covered both a go and a hold', cases.some((c) => c.go) && cases.some((c) => !c.go), JSON.stringify(cases.map((c) => c.go)));

console.log('\nThe fleet and planning forms agree with the single form');
sky(8.7, 4);
const single = await Promise.all(FIELDS.map((f) => call('position_trust', { lat: f.lat, lon: f.lon, correction: 'rtk', needMeters: 0.05 })));
const fleet = await call('position_trust', { points: FIELDS.map((f) => ({ lat: f.lat, lon: f.lon, name: f.name })), correction: 'rtk', needMeters: 0.05 });
check('each point in a fleet call has the verdict it has alone', fleet.data.positions.every((p, i) => p.verdict === single[i].data.verdict),
  JSON.stringify([fleet.data.positions.map((p) => p.verdict), single.map((s) => s.data.verdict)]));
sky(2, 0);
const now = await call('position_trust', { lat: 40.92, lon: -98.34, correction: 'rtk', needMeters: 0.05 });
const plan = await call('position_trust', { lat: 40.92, lon: -98.34, correction: 'rtk', needMeters: 0.05, windowsHours: 24 });
const openNow = plan.data.windows?.[0] && new Date(plan.data.windows[0].start).getTime() <= Date.now() + 60_000;
check('a position trusted now is inside a window that is open now', now.data.verdict === 'trust' ? openNow : true, `${now.data.verdict} ${JSON.stringify(plan.data.windows?.[0])}`);

console.log('\nwhat_should_i_do hands a field crew to the job tool rather than answering for it');
sky(8.7, 4);
const crew = await call('what_should_i_do', { role: 'field_crew' });
check('a field crew in a storm is pointed at the go or hold for their own field', /can run the job|Ask me whether you can run/.test(crew.said), crew.said);

await client.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
