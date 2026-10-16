/**
 * Built for machines at the scale they come in: a fleet in one call, the clear windows over three days, two more
 * things a machine depends on, drone shows as a job, and an alert feed a scheduler polls.
 *
 * Nothing here touches the network.
 */
import { mkdirSync, rmSync } from 'node:fs';

const DIR = './data/test-fleet';
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
const domain = await import('./dist/domain.js');
const deps = await import('./dist/dependencies.js');
const machineAlerts = await import('./dist/machinealerts.js');
const store = await import('./dist/store.js');
const { registerTools } = await import('./dist/tools.js');

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const HOUR = 3_600_000;
/** Kp by three hour block from now: { 0: 2, 3: 8 } puts a G4 in the block starting three hours from now. */
const sky = (byHour = {}, base = 2, { g = 0 } = {}) => {
  const start = Math.floor(Date.now() / (3 * HOUR)) * 3 * HOUR;
  const slots = [];
  for (let i = -8; i < 24; i += 1) slots.push({ time: new Date(start + i * 3 * HOUR).toISOString(), kp: byHour[i * 3] ?? base, observed: i < 0 });
  swpc.seedForTest({ fetchedAt: new Date().toISOString(), slots, alerts: [], scales: { g, s: 0, r: 0, yesterday: { g: 0, s: 0, r: 0 }, days: [] }, stale: false });
  solarwind.seedForTest({ wind: null, kp: null });
  return slots;
};

const server = new McpServer({ name: 't', version: '1' }, { capabilities: { tools: {}, resources: {}, tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } }, taskStore: new InMemoryTaskStore(), taskMessageQueue: new InMemoryTaskMessageQueue() });
registerTools(server, () => 'acct:fleet');
const client = new Client({ name: 'c', version: '1' }, { capabilities: {} });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a), client.connect(b)]);
const call = async (args) => {
  const r = await client.callTool({ name: 'position_trust', arguments: args });
  return { said: (r.content ?? []).map((c) => c.text ?? '').join(' '), data: r.structuredContent ?? {} };
};

console.log('\nA fleet in one call');
{
  sky({}, 8.7, { g: 4 });
  const points = [
    { lat: 64.84, lon: -147.72, name: 'Fairbanks yard' },
    { lat: 44.98, lon: -93.27, name: 'Minneapolis depot' },
    { lat: 1.35, lon: 103.82, name: 'Singapore hub' },
  ];
  const r = await call({ points, needMeters: 0.05, correction: 'rtk' });
  check('one verdict for each position, counted', r.data.positions?.length === 3 && r.data.counts && Object.values(r.data.counts).reduce((x, y) => x + y, 0) === 3, JSON.stringify(r.data.counts));
  check('...the answer is the worst of them', r.data.verdict === 'do_not_trust', r.data.verdict);
  check('...said as counts first, then the ones not trusted by name', /^Of 3 positions, \d trust, \d verify and \d do not trust\./.test(r.said) && /Fairbanks yard/.test(r.said), r.said);
  check('...each judged as a single call would judge it', r.data.positions.every((p) => ['trust', 'verify', 'do_not_trust'].includes(p.verdict) && p.reasons));
  const one = await call({ lat: 64.84, lon: -147.72, needMeters: 0.05, correction: 'rtk' });
  check('...Fairbanks in the fleet has the verdict Fairbanks has alone', r.data.positions[0].verdict === one.data.verdict, `${r.data.positions[0].verdict} vs ${one.data.verdict}`);
  const unnamed = await call({ points: [{ lat: 10, lon: 10 }, { lat: 11, lon: 11 }] });
  check('unnamed points are numbered so they can be said back', unnamed.data.positions[1].name === 'position 2');
  const big = await call({ points: Array.from({ length: 1001 }, () => ({ lat: 0, lon: 0 })) });
  check('more than a thousand is refused, not quietly cut', /1000|too_big|at most/i.test(big.said) || big.data.isError !== undefined, big.said.slice(0, 120));
}

console.log('\nThe clear windows over three days');
{
  sky({ 12: 8.7, 15: 8.7 }, 2);
  const r = await call({ lat: 44.98, lon: -93.27, needMeters: 0.05, correction: 'rtk', windowsHours: 72 });
  check('a G4 twelve to eighteen hours out splits the clear time into two windows', r.data.windows?.length === 2, JSON.stringify(r.data.windows));
  check('...the first ends where the storm starts', r.data.windows && new Date(r.data.windows[0].end).getTime() - Date.now() <= 13 * HOUR, JSON.stringify(r.data.windows?.[0]));
  check('...it says it is a forecast, and to check again before acting', r.data.forecastOnly === true && /check position_trust again/.test(r.said), r.said);
  check('...and never claims more hours than the forecast holds', r.data.hoursSearched <= 72);
  sky({}, 2);
  const calm = await call({ lat: 44.98, lon: -93.27, needMeters: 5, windowsHours: 48 });
  check('a calm forecast for metre-level work is clear the whole way', /Clear for the whole 48 hours/.test(calm.said), calm.said);
  const hk = domain.clearWindows(sky({}, 1), { id: 'e', name: 'show', correction: 'rtk' }, { id: 'f', name: 'Victoria Harbour', lat: 22.29, lon: 114.17 }, 0.1, new Date(), 72);
  check('near the magnetic equator, RTK windows close every evening even on a quiet sky', hk.length >= 2, JSON.stringify(hk));
}

console.log('\nGPS time and traffic awareness');
{
  sky({}, 2);
  check('GPS time is fine on a quiet day', deps.judge('gps_time', { lat: 44.98, lon: -93.27 }).verdict === 'trust');
  sky({}, 7.3, { g: 3 });
  const t = deps.judge('gps_time', { lat: 44.98, lon: -93.27 });
  check('at G3 a GPS clock is told to be ready for holdover, with how long a clock holds', t.verdict === 'verify' && /16.5 hours/.test(t.reason), t.reason);
  sky({}, 2);
  const interference = await import('./dist/interference.js');
  const unread = await call({ lat: 44.98, lon: -93.27, dependsOn: ['traffic_awareness'] });
  check('with the GPS test schedule unread, traffic awareness is "verify", and says what was not checked', unread.data.verdict === 'verify' && /could not check/.test(unread.said), unread.said);
  interference.seedForTest({ tests: [], satellites: [] });
  const seen = await call({ lat: 44.98, lon: -93.27, dependsOn: ['traffic_awareness'] });
  check('on a quiet day, what other aircraft see is inside what ADS-B asks for', seen.data.dependencies?.[0]?.dependency === 'traffic_awareness' && /92.6 metres/.test(seen.said + JSON.stringify(seen.data)), seen.said);
}

console.log('\nDrone shows');
{
  check('a drone show is a job, at a decimetre', domain.TOLERANCE_M.drone_show === 0.1);
  sky({}, 1);
  const evening = domain.assess('drone_show', 1, { id: 'e', name: 'show', correction: 'rtk' }, { id: 'f', name: 'Victoria Harbour', lat: 22.29, lon: 114.17 }, new Date('2024-10-01T12:00:00Z'));
  check('the Hong Kong evening is a hold for a drone show too', evening.go === false && /drone show/.test(evening.reason), evening.reason);
}

console.log('\nThe alert feed a scheduler polls');
{
  store.update('acct:fleet', (f) => {
    f.fields.push({ id: 'f1', name: 'North yard', lat: 44.98, lon: -93.27 });
    f.equipment.push({ id: 'e1', name: 'mower fleet', correction: 'rtk' });
  });
  sky({ 12: 8.7 }, 2);
  const now = new Date();
  const feed = machineAlerts.forFarm(store.get('acct:fleet'), now);
  check('a G4 twelve hours out is imminent for an RTK machine', feed.alerts[0]?.phase === 'imminent' && feed.alerts[0].blocked, JSON.stringify(feed.alerts[0]));
  check('...for its tightest job', feed.alerts[0].needM <= 0.05, String(feed.alerts[0].needM));
  check('the same forecast gives the same etag', machineAlerts.forFarm(store.get('acct:fleet'), now).etag === feed.etag);
  const soon = (new Date(feed.checkAgainAt).getTime() - now.getTime()) / 60_000;
  check('with a storm within a day, it says to check again within fifteen minutes', soon > 0 && soon <= 15, String(soon));
  sky({ 45: 8.7 }, 2);
  const later = machineAlerts.forFarm(store.get('acct:fleet'), now);
  check('the storm two days out is a watch, and the etag changes', later.alerts[0].phase === 'watch' && later.etag !== feed.etag, `${later.alerts[0].phase} ${later.etag}`);
  sky({}, 2);
  const calmFeed = machineAlerts.forFarm(store.get('acct:fleet'), now);
  check('a calm forecast is clear', calmFeed.alerts[0].phase === 'clear');
  const calmWait = (new Date(calmFeed.checkAgainAt).getTime() - now.getTime()) / 60_000;
  check('...and says to check again no later than the next forecast block, and no sooner than fifteen minutes', calmWait >= 15 && calmWait <= 180, String(calmWait));
  swpc.seedForTest({ fetchedAt: new Date().toISOString(), slots: [], alerts: [], scales: { g: 0, s: 0, r: 0, yesterday: { g: 0, s: 0, r: 0 }, days: [] }, stale: false });
  const none = machineAlerts.forFarm(store.get('acct:fleet'), now);
  check('with no forecast it says so, and is not an all clear', none.alerts.length === 0 && /not an all clear/.test(none.note ?? ''));
}

await client.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
