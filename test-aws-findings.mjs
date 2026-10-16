/**
 * What a session against the deployed server found, October 2026, each pinned here.
 *
 *   "what happened on 2024-05-10"     answered about 9 May, a quiet day: a date with no zone was read as midnight in
 *                                     London, which in Iowa is the day before
 *   a drone show "in Hong Kong"       answered for the farmer's field in Iowa, because a town was only used when no
 *   by somebody with a field          field was saved
 *   a drone pilot in Hong Kong        told positioning should behave, at ten at night in October, in the evening
 *   at night                          bubble hours that called off the 2024 National Day shows
 *
 * Nothing here touches the network.
 */
import { mkdirSync, rmSync } from 'node:fs';

const DIR = './data/test-aws-findings';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.ORBITA_DATA = `${DIR}/farms.json`;
delete process.env.ORBITA_DATA_KEY;
delete process.env.ORBITA_SCOPE;

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const swpc = await import('./dist/swpc.js');
const solarwind = await import('./dist/solarwind.js');
const interference = await import('./dist/interference.js');
const geo = await import('./dist/geocode.js');
const history = await import('./dist/history.js');
const { equatorialEvening } = await import('./dist/domain.js');
const { configureForTest: fakeZones } = await import('./dist/timezone.js');
fakeZones(async () => 'America/Chicago');
const { registerTools } = await import('./dist/tools.js');

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const HOUR = 3_600_000;
const start = Math.floor(Date.now() / (3 * HOUR)) * 3 * HOUR;
const slots = [];
for (let i = -8; i < 24; i += 1) slots.push({ time: new Date(start + i * 3 * HOUR).toISOString(), kp: 1.7, observed: i < 0 });
swpc.seedForTest({ fetchedAt: new Date().toISOString(), slots, alerts: [], scales: { g: 0, s: 0, r: 0, yesterday: { g: 0, s: 0, r: 0 }, days: [] }, stale: false });
solarwind.seedForTest({ wind: null, kp: null });
interference.seedForTest({ tests: [], satellites: [] });

// A town near the magnetic equator where it is evening right now, if any longitude is in its bubble season this month.
const nowLon = Array.from({ length: 72 }, (_, i) => -180 + i * 5).find((lon) => equatorialEvening({ id: 'x', name: 'x', lat: 0, lon }, new Date()));
const PLACES = {
  'hong kong': { name: 'Hong Kong', country: 'Hong Kong', lat: 22.29, lon: 114.17, timeZone: 'Asia/Hong_Kong' },
  'evening town': nowLon == null ? null : { name: 'Evening Town', country: 'Somewhere', lat: 0, lon: nowLon },
};
geo.configureForTest(async (q) => PLACES[q.toLowerCase()] ?? { name: 'Ames', region: 'Iowa', country: 'United States', lat: 42.03, lon: -93.62 });

const server = new McpServer({ name: 't', version: '1' }, { capabilities: { tools: {}, resources: {} } });
registerTools(server, () => 'acct:aws-findings');
const client = new Client({ name: 'c', version: '1' }, { capabilities: {} });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a), client.connect(b)]);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { said: (r.content ?? []).map((c) => c.text ?? '').join(' '), data: r.structuredContent ?? {} };
};

console.log('\nA date with no zone is a day on the field\'s calendar');
{
  const now = new Date('2026-10-16T14:00:00Z');
  const d = history.parseWhen('2024-05-10', now, { prefer: 'past', timeZone: 'America/Chicago' });
  const local = d?.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  check('"2024-05-10" in Iowa is 10 May there, not the evening of the 9th', local === '2024-05-10', `${d?.toISOString()} = ${local}`);
  check('...the same day as "10 May 2024"', local === history.parseWhen('10 May 2024', now, { prefer: 'past', timeZone: 'America/Chicago' })?.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }));
  check('"2024-05-10T15:00" is three in the afternoon in Iowa', history.parseWhen('2024-05-10T15:00', now, { timeZone: 'America/Chicago' })?.toISOString() === '2024-05-10T20:00:00.000Z');
  check('a date with its zone is still taken as written', history.parseWhen('2024-05-10T15:00Z', now)?.toISOString() === '2024-05-10T15:00:00.000Z');
}

console.log('\nA town asked about by somebody who already has a field');
{
  await call('my_farm', { fieldName: 'North 80', place: 'Ames, Iowa', machineName: '8R tractor', correction: 'rtk' });
  // Eight in the evening in Hong Kong, inside the three day forecast.
  const tomorrow = new Date(Date.now() + 24 * HOUR).toISOString().slice(0, 10);
  const at = new Date(`${tomorrow}T12:00:00Z`);
  const show = await call('can_i_run', { operation: 'drone_show', place: 'Hong Kong', when: at.toISOString() });
  check('the drone show in Hong Kong is judged in Hong Kong, not on the Iowa field', !/CDT|CST/.test(show.said) && !/North 80/.test(show.said), show.said);
  if (equatorialEvening({ id: 'hk', name: 'hk', lat: 22.29, lon: 114.17 }, new Date(at.getTime() + 90 * 60_000))) {
    check('...and at eight in the evening in this season it is a hold, for the bubbles', /Hold off the drone show/.test(show.said) && /plasma bubbles/.test(show.said), show.said);
    check('...with advice for a show, not a mapping flight', /formation/.test(show.said) && !/mapping mission/.test(show.said), show.said);
  } else console.log('  note  not bubble season in Hong Kong this month, so only the place is checked');
  const own = await call('can_i_run', { operation: 'planting', place: 'North 80' });
  check('a place that is the name of a saved field is that field', /Clear for planting|Hold off planting/.test(own.said) && !own.data.nextAction?.arguments?.fieldName, own.said);
  check('nothing about Hong Kong was saved', !/Hong Kong/.test((await call('farm_status', {})).said));
}

console.log('\nRoles that steer by a precise fix, in the evening bubble hours');
if (nowLon != null) {
  for (const role of ['drone_pilot', 'robots']) {
    const r = await call('what_should_i_do', { role, place: 'Evening Town' });
    check(`${role} near the magnetic equator in the evening hears about the bubbles, though Kp is low`, /evening plasma bubble hours/.test(r.said) && r.data.measuredHere?.equatorialEvening === true, r.said);
  }
  const grid = await call('what_should_i_do', { role: 'grid_operator', place: 'Evening Town' });
  check('a grid operator there does not, since bubbles do not reach a power line', !/plasma bubble/.test(grid.said), grid.said);
} else console.log('  note  no longitude is in its bubble season this month, so the role line is not checked');
const day = await call('what_should_i_do', { role: 'drone_pilot', place: 'Ames, Iowa' });
check('a drone pilot in Iowa hears nothing about bubbles', !/plasma bubble/.test(day.said), day.said);

console.log('\n"What else", after advice that reads its own steps');
{
  // Found by the model run, not the server: "and what else should I do" after the ship advice went to tell_me_more,
  // as its description says, and tell_me_more had nothing held for advice that pages itself.
  const storm = slots.map((s) => ({ ...s, kp: 8 }));
  swpc.seedForTest({ fetchedAt: new Date().toISOString(), slots: storm, alerts: [], scales: { g: 4, s: 2, r: 2, yesterday: { g: 4, s: 0, r: 0 }, days: [] }, stale: false });
  let found = null;
  for (const role of ['shipping', 'drone_pilot', 'field_crew', 'airline', 'grid_operator', 'satellite_operator']) {
    const first = await call('what_should_i_do', { role });
    if (first.data.nextStep != null) { found = { role, first }; break; }
  }
  if (found) {
    const direct = await call('what_should_i_do', { role: found.role, step: found.first.data.nextStep });
    await call('what_should_i_do', { role: found.role });
    const viaMore = await call('tell_me_more', {});
    check(`after ${found.role} advice with steps waiting, "go on" reads the next steps`, viaMore.said.length > 0 && viaMore.said === direct.said, `${viaMore.said} | ${direct.said}`);
    await call('storm_status', {});
    const after = await call('tell_me_more', {});
    check('...and once something else has been asked, it is not read out of turn', !after.said.includes(direct.said.slice(0, 40)), after.said);
  } else check('a role with more than one page of storm advice was found', false);
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
