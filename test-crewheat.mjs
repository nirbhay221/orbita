/**
 * The people on the machine.
 *
 * A go for the receiver is not a go for the crew, and this checks the second half of the same answer: the
 * heat over the field for the hours the job would run. What must hold: nothing is said below 80, because a
 * line about pleasant weather on every answer buries the one that matters; past 90 it is heard with the
 * verdict and never held back; an unknown forecast is never spoken as a cool day; and a job the rig can
 * never hold gets no advice about a day nobody will be working.
 * It runs with the DEFAULT scope, the tools a customer actually gets.
 */
import { mkdirSync, rmSync } from 'node:fs';

const DIR = './data/test-crewheat';
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
const crewheat = await import('./dist/crewheat.js');
const { registerTools } = await import('./dist/tools.js');
const { speakErrorsPlainly } = await import('./dist/plainly.js');
const { configureForTest: fakeZones } = await import('./dist/timezone.js');
fakeZones(async () => 'America/Chicago');
globalThis.fetch = async () => { throw new Error('network is off for this test'); };

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};
const HOUR = 3_600_000;

async function connect(id) {
  const server = new McpServer(
    { name: 't', version: '1' },
    { capabilities: { tools: {}, resources: {}, tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } }, taskStore: new InMemoryTaskStore(), taskMessageQueue: new InMemoryTaskMessageQueue() },
  );
  registerTools(server, () => id);
  speakErrorsPlainly(server);
  const client = new Client({ name: 'c', version: '1' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { said: (r.content ?? []).map((c) => c.text ?? '').join(' '), data: r.structuredContent ?? {}, isError: r.isError };
  };
}

const now = Date.now();
const top = Math.floor(now / HOUR) * HOUR;
const start = Math.floor(now / (3 * HOUR)) * 3 * HOUR;
const forecast = (kpNow, kpLater) => {
  const slots = [];
  for (let i = -8; i < 24; i += 1) slots.push({ time: new Date(start + i * 3 * HOUR).toISOString(), kp: i < 4 ? kpNow : kpLater, observed: i < 0 });
  swpc.seedForTest({ fetchedAt: new Date().toISOString(), slots, alerts: [], scales: { g: 0, s: 0, r: 0, yesterday: { g: 0, s: 0, r: 0 }, days: [] }, stale: false });
};
solarwind.seedForTest({ wind: null, kp: null });
/** A forecast for the next three days where hour i from now has the temperature temp(i). */
const hours = (temp, humidity = 45) => Array.from({ length: 72 }, (_, i) => ({ time: top + i * HOUR, tempF: temp(i), humidityPct: humidity }));

console.log('\nThe heat index is the weather service formula');
{
  check('96 degrees at 65 percent is 121', Math.round(crewheat.heatIndexF(96, 65)) === 121, String(crewheat.heatIndexF(96, 65)));
  check('90 degrees at 40 percent is 91', Math.round(crewheat.heatIndexF(90, 40)) === 91, String(crewheat.heatIndexF(90, 40)));
  check('a cool day is close to the air temperature', Math.abs(crewheat.heatIndexF(70, 50) - 70) < 2, String(crewheat.heatIndexF(70, 50)));
  check('the lines are 80 and 90', crewheat.INITIAL_F === 80 && crewheat.HIGH_F === 90);
}

console.log('\nReading the forecast feed');
{
  const parsed = crewheat.parse({ hourly: { time: [1000, 2000, 3000, 4000], temperature_2m: [88, null, 999, 91], relative_humidity_2m: [40, 50, 50, 120] } });
  check('a missing reading is left out, not read as zero', parsed.length === 1 && parsed[0].tempF === 88, JSON.stringify(parsed));
  check('times are turned into milliseconds', parsed[0].time === 1_000_000);
  check('a body with no hourly block is no forecast', crewheat.parse({}) === null && crewheat.parse(null) === null && crewheat.parse({ hourly: { time: [] } }) === null);
}

console.log('\nWhich hours are judged');
const lat = 40.92, lon = -98.34;
{
  crewheat.resetForTest();
  check('with no forecast held, nothing is claimed either way', crewheat.during(lat, lon, new Date(), 8) === null && crewheat.known(lat, lon) === false);
  // Cool for four hours, then 86, then 97 from the eighth hour.
  crewheat.seedForTest(lat, lon, hours((i) => (i < 4 ? 74 : i < 8 ? 86 : 97)));
  check('a forecast that is held is known', crewheat.known(lat, lon) === true);
  check('a short job in the cool hours gets nothing', crewheat.during(lat, lon, new Date(top), 3) === null);
  const warm = crewheat.during(lat, lon, new Date(top), 7);
  check('a job that reaches 80 and not 90 is the lower line', warm?.level === 'initial' && warm.highFrom === null && warm.initialFrom === new Date(top + 4 * HOUR).toISOString(), JSON.stringify(warm));
  const hot = crewheat.during(lat, lon, new Date(top), 12);
  check('a job that reaches 90 is the higher line, with the hour it starts', hot?.level === 'high' && hot.highFrom === new Date(top + 8 * HOUR).toISOString(), JSON.stringify(hot));
  check('the peak is the hottest hour inside the job, rounded', hot.peakF === Math.round(crewheat.heatIndexF(97, 45)), String(hot.peakF));
  check('hours after the job ends are not counted', crewheat.during(lat, lon, new Date(top), 4) === null);
  check('a forecast six hours old is not used', crewheat.during(lat, lon, new Date(top), 12, Date.now() + 7 * HOUR) === null && crewheat.known(lat, lon, Date.now() + 7 * HOUR) === false);
  const said = crewheat.sentence(hot, () => 'Tue 2 PM CDT');
  check('past 90 names the break and the hour', /past 90 from Tue 2 PM CDT/.test(said) && /15 minute break in the shade at least every two hours/.test(said) && /nobody working alone/.test(said), said);
  check('past 80 names water and shade, and no break schedule', /water on the machine/.test(crewheat.sentence(warm, () => 'x')) && !/15 minute/.test(crewheat.sentence(warm, () => 'x')));
}

console.log('\nFetching in the background');
{
  crewheat.resetForTest();
  let calls = 0;
  crewheat.configureForTest(async () => { calls += 1; return hours(() => 95); });
  crewheat.watch(lat, lon);
  crewheat.watch(lat + 0.01, lon + 0.01);
  await crewheat.refresh();
  check('two fields a mile apart share one forecast', calls === 1 && crewheat.status().sites === 1, `${calls} ${JSON.stringify(crewheat.status())}`);
  await crewheat.refresh();
  check('a fresh forecast is not fetched again', calls === 1, String(calls));
  crewheat.resetForTest();
  crewheat.configureForTest(async () => null);
  crewheat.watch(lat, lon);
  await crewheat.refresh();
  check('a feed that is down leaves nothing held and does not throw', crewheat.known(lat, lon) === false);
  crewheat.resetForTest();
}

console.log('\nInside the answer to "can I run"');
const farm = await connect('acct:crew');
await farm('register_field', { name: 'North 40', lat, lon });
await farm('register_equipment', { name: 'planter', correction: 'rtk' });
{
  forecast(2, 2);
  crewheat.resetForTest();
  const blind = await farm('can_i_run', { operation: 'planting' });
  check('with no forecast held, the crew is not mentioned', !/For the crew/.test(blind.said), blind.said);
  check('...and the answer says the crew side was not checked', blind.data.crewHeatChecked === false && blind.data.crewHeat === null);

  crewheat.seedForTest(lat, lon, hours(() => 72));
  const cool = await farm('can_i_run', { operation: 'planting' });
  check('on a cool day nothing is said about the crew', !/For the crew/.test(cool.said) && cool.data.crewHeat === null && cool.data.crewHeatChecked === true, cool.said);

  crewheat.seedForTest(lat, lon, hours((i) => (i < 2 ? 78 : 86)));
  const warm = await farm('can_i_run', { operation: 'planting' });
  check('past 80 it is in the answer for a screen', warm.data.go === true && warm.data.crewHeat?.level === 'initial', JSON.stringify(warm.data.crewHeat));
  const all = [warm.said, ...(warm.data.more ?? [])].join(' ');
  check('...and spoken, at once or when asked for more', /For the crew, the heat index reaches/.test(all), all);

  crewheat.seedForTest(lat, lon, hours((i) => (i < 3 ? 84 : 98)));
  const hot = await farm('can_i_run', { operation: 'planting' });
  check('past 90 it is heard with the go, never held back', hot.data.go === true && /For the crew, the heat index reaches \d+ and is past 90 from/.test(hot.said), hot.said);
  check('...in the field\'s own time', /past 90 from \w{3} \d{1,2}(:\d\d)? [AP]M C[DS]T/.test(hot.said), hot.said);
  check('...with the break rule', /15 minute break in the shade at least every two hours/.test(hot.said), hot.said);
  check('...and the go itself is still the first thing said', hot.said.indexOf('For the crew') > 40, hot.said);
  check('the structured answer carries the level and where the rule comes from', hot.data.crewHeat.level === 'high' && /osha\.gov/.test(hot.data.crewHeat.rule));
}

console.log('\nWhen the job is blocked');
{
  // A storm now that clears in twelve hours, and a hot stretch only after it clears.
  forecast(8, 1);
  crewheat.seedForTest(lat, lon, hours((i) => (i < 10 ? 70 : 99)));
  const blocked = await farm('can_i_run', { operation: 'planting' });
  check('a job blocked by the storm is still a no', blocked.data.go === false && blocked.data.limitedBy === 'space_weather', JSON.stringify({ go: blocked.data.go, by: blocked.data.limitedBy }));
  check('...and the heat is judged for the window it will clear into, not for now', blocked.data.window != null && blocked.data.crewHeat?.level === 'high' && /For the crew/.test(blocked.said), blocked.said);

  crewheat.seedForTest(lat, lon, hours((i) => (i < 10 ? 99 : 70)));
  const coolLater = await farm('can_i_run', { operation: 'planting' });
  check('heat during hours nobody will be working is not mentioned', coolLater.data.go === false && coolLater.data.crewHeat === null && !/For the crew/.test(coolLater.said), coolLater.said);
}

console.log('\nA job the machine can never hold');
{
  forecast(2, 2);
  const basic = await connect('acct:basic');
  await basic('register_field', { name: 'Home', lat, lon });
  await basic('register_equipment', { name: 'old tractor', correction: 'autonomous' });
  crewheat.seedForTest(lat, lon, hours(() => 99));
  const never = await basic('can_i_run', { operation: 'planting' });
  check('gets no advice about a day nobody will be out', never.data.limitedBy === 'equipment' && never.data.crewHeat === null && !/For the crew/.test(never.said), never.said);
}

console.log('\nAcross the whole farm');
{
  forecast(2, 2);
  crewheat.resetForTest();
  await farm('register_field', { name: 'River Bottom', lat: 41.6, lon: -99.4 });
  crewheat.seedForTest(lat, lon, hours(() => 84));
  crewheat.seedForTest(41.6, -99.4, hours(() => 99));
  const status = await farm('farm_status');
  check('the hottest field is the one named', status.data.crewHeat?.field === 'River Bottom' && /For the crew on River Bottom, the heat index reaches/.test(status.said), status.said);
  check('...and past 90 it is not held back', /past 90 from/.test(status.said), status.said);
  crewheat.seedForTest(lat, lon, hours(() => 70));
  crewheat.seedForTest(41.6, -99.4, hours(() => 70));
  const mild = await farm('farm_status');
  check('on a mild day the overview says nothing about heat', mild.data.crewHeat === null && !/For the crew/.test(mild.said), mild.said);
}

console.log('\nWhat is measured over the field outranks a forecast that says clear');
{
  const glotec = await import('./dist/glotec.js');
  const who = await connect('acct:measured');
  await who('register_field', { name: 'Long Baseline', lat: 40, lon: -100, baselineKm: 60 });
  await who('register_equipment', { name: 'planter', correction: 'rtk' });
  forecast(2, 2);
  crewheat.resetForTest();
  // A map with a steep slope across the field: 0 TECU to the south and west, 40 to the north and east.
  // Cells sit on NOAA's grid: every 2.5 degrees of latitude from 88.75 south, every 5 of longitude from 177.5 west.
  // Quality 0 is an observed cell; anything else was filled in from climatology.
  const cell = (tec, quality = 0) => ({ tec, anomaly: 1, quality });
  const LATS = [31.25, 33.75, 36.25, 38.75, 41.25, 43.75, 46.25, 48.75];
  const LONS = [-112.5, -107.5, -102.5, -97.5, -92.5, -87.5];
  const cells = [];
  for (const la of LATS) for (const lo of LONS) cells.push([la, lo, cell((la - 31.25) * 3 + 10)]);
  glotec.seedForTest({ cells, at: new Date().toISOString() });
  const left = glotec.residual(40, -100, 60);
  const blocked = await who('can_i_run', { operation: 'planting' });
  check('a steep measured slope blocks a job the forecast alone would clear', left > 0.05 && blocked.data.go === false && blocked.data.decidedBy === 'measured' && blocked.data.limitedBy === 'space_weather', `${left} ${blocked.said}`);
  check('...and the answer says it is a measurement, and that the forecast said clear', /forecast alone would call it clear/.test(blocked.said) && /measured over the field/.test(blocked.said) && /centimetres your base station cannot correct/.test(blocked.said), blocked.said);
  check('...and does not say the same thing twice', (blocked.said.match(/base station cannot correct/g) ?? []).length === 1, blocked.said);
  const later = await who('can_i_run', { operation: 'planting', when: 'tomorrow afternoon' });
  check('a measurement of now says nothing about tomorrow', later.data.decidedBy === 'forecast' && later.data.go === true, later.said);
  glotec.seedForTest({ cells: cells.map(([la, lo, c]) => [la, lo, { ...c, quality: 1 }]), at: new Date().toISOString() });
  const filled = await who('can_i_run', { operation: 'planting' });
  check('a cell filled in from climatology does not block anything', filled.data.go === true && filled.data.decidedBy === 'forecast', filled.said);
  const flat = [];
  for (const la of LATS) for (const lo of LONS) flat.push([la, lo, cell(12)]);
  glotec.seedForTest({ cells: flat, at: new Date().toISOString() });
  forecast(8.5, 8.5);
  const storm = await who('can_i_run', { operation: 'planting' });
  check('a calm map never clears a job the forecast has blocked', storm.data.go === false && storm.data.decidedBy === 'forecast', storm.said);
  forecast(2, 2);
  glotec.resetForTest();
}

console.log('\nThe people by name, asked of the heat safety server');
{
  const crewday = await import('./dist/crewday.js');
  const store = await import('./dist/store.js');
  const answer = (over = {}) => ({ sharing: true, crew: { label: '7 am to 5 pm', peakHeatIndexF: 101, peakAt: '3 pm', highFrom: '10 am', riskyFrom: null, acclimatization: null, timezone: 'America/Chicago', ...over } });
  check('only the fields a foreman needs are kept, whatever else arrives', Object.keys(crewday.parse({ ...answer(), medications: ['x'], crew: { ...answer().crew, diagnosis: 'y' } })).sort().join() === 'acclimatization,fetchedAt,highFrom,label,peakAt,peakHeatIndexF,riskyFrom');
  check('an answer that is not about a shared day is nothing', crewday.parse({ sharing: false }) === null && crewday.parse(null) === null && crewday.parse({ sharing: true }) === null);
  check('a malformed acclimatization block is dropped, not trusted', crewday.parse(answer({ acclimatization: { kind: 'expert', day: 'two' } })).acclimatization === null);

  const calls = [];
  const days = { linkDana: answer({ acclimatization: { kind: 'new', day: 2, heatHoursAllowed: 4, doneBy: '11 am' } }), linkLee: answer({ riskyFrom: '10 am' }), linkSam: answer() };
  crewday.configureForTest(async (name, args) => {
    calls.push([name, args]);
    if (name === 'share_my_day') return args.code === '12345678' ? { joined: true, crewLink: 'linkDana' } : { joined: false, reason: 'unknown' };
    return days[args.crewLink] ?? { sharing: false };
  });
  check('with the link switched on, the server says it is configured', crewday.configured() === true);

  const boss = await connect('acct:boss');
  await boss('register_field', { name: 'North 40', lat, lon });
  await boss('register_equipment', { name: 'planter', correction: 'rtk' });
  forecast(2, 2);
  crewheat.seedForTest(lat, lon, hours(() => 99));
  const unknown = await boss('crew_contact', { action: 'add', name: 'Dana', dayCode: '1234 5678' });
  check('somebody not on the crew list cannot be linked', unknown.data.linked === false && /isn't on your crew list/.test(unknown.said), unknown.said);
  await boss('crew_contact', { action: 'add', name: 'Dana', email: 'dana@example.com' });
  const bad = await boss('crew_contact', { action: 'add', name: 'Dana', dayCode: '0000 0000' });
  check('a wrong code is refused in plain words', bad.data.linked === false && /That code did not work/.test(bad.said), bad.said);
  const linked = await boss('crew_contact', { action: 'add', name: 'Dana', dayCode: '1234 5678' });
  check('the right code links their day', linked.data.linked === true && /nothing about their health/.test(linked.said), linked.said);
  check('...it was asked over the sharing tool, as a crew', calls.some(([n, a]) => n === 'share_my_day' && a.as === 'crew' && a.code === '12345678'));
  check('...and the link is kept on the crew member', store.get('acct:boss').crew.find((c) => c.name === 'Dana').dayLink === 'linkDana');
  await crewday.refresh('linkDana', true);

  const go = await boss('can_i_run', { operation: 'planting' });
  check('the answer about the job names who is still getting used to the heat', go.data.go === true && /Dana is on day 2 in the heat: 4 hours of it today, done by 11 am\./.test(go.said), go.said);
  check('...after the verdict and the general heat line', go.said.indexOf('Clear for planting') === 0 && go.said.indexOf('For the crew') < go.said.indexOf('Dana is on day 2'), go.said);
  const later = await boss('can_i_run', { operation: 'planting', when: 'tomorrow afternoon' });
  check('a job tomorrow says nothing about today\'s hours', !/Dana is on day/.test(later.said), later.said);
  const status = await boss('farm_status');
  check('the farm overview names them too', /Dana is on day 2 in the heat/.test(status.said), status.said);

  store.update('acct:boss', (x) => {
    x.crew.push({ name: 'Lee', email: 'lee@example.com', role: null, notifyOn: ['storm'], addedAt: new Date().toISOString(), confirmedAt: null, dayLink: 'linkLee' });
    x.crew.push({ name: 'Sam', email: 'sam@example.com', role: null, notifyOn: ['storm'], addedAt: new Date().toISOString(), confirmedAt: null, dayLink: 'linkSam' });
    x.crew.push({ name: 'Pat', email: 'pat@example.com', role: null, notifyOn: ['storm'], addedAt: new Date().toISOString(), confirmedAt: null });
  });
  await crewday.refresh('linkLee', true);
  await crewday.refresh('linkSam', true);
  const all = await boss('can_i_run', { operation: 'planting' });
  check('somebody it turns risky for earlier is named, without a reason', /For Lee the risky part starts at 10 am\./.test(all.said) && !/because|medic|condition/i.test(all.said.split('For Lee')[1]), all.said);
  check('somebody with an ordinary day, and somebody who never shared, are not mentioned', !/Sam|Pat/.test(all.said), all.said);

  days.linkDana = { sharing: false };
  await crewday.refresh('linkDana', true);
  const after = await boss('can_i_run', { operation: 'planting' });
  check('when they stop sharing, they stop being mentioned at once', !/Dana/.test(after.said) && crewday.stopped('linkDana') === true, after.said);
  check('an old answer is not said', crewday.dayFor('linkLee', Date.now() + 4 * 3_600_000) === null);

  crewday.configureForTest(async () => null);
  const down = await boss('crew_contact', { action: 'add', name: 'Dana', dayCode: '1234 5678' });
  check('when the other server cannot be reached, linking says so', down.data.linked === false && /could not reach/.test(down.said), down.said);
  crewday.configureForTest(null);
  check('with no address to ask at, the link is simply off', crewday.configured() === false && crewday.sentences([{ name: 'Dana', link: 'linkDana' }]).length === 0);
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
