/**
 * The Echo-style demo page.
 *
 * The page promises that every line on it is a real tool with real arguments. This calls every one, in the
 * order the page shows them, and checks the story it tells: the farm, the job, and the crew member whose day
 * comes from the other server.
 */
import { mkdirSync, rmSync, readFileSync } from 'node:fs';

const DIR = './data/test-echo';
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
const crewday = await import('./dist/crewday.js');
const geo = await import('./dist/geocode.js');
const history = await import('./dist/history.js');
const { registerTools } = await import('./dist/tools.js');
const { speakErrorsPlainly } = await import('./dist/plainly.js');
const { configureForTest: fakeZones } = await import('./dist/timezone.js');
fakeZones(async () => 'America/Phoenix');
geo.configureForTest(async () => ({ name: 'Yuma', region: 'Arizona', country: 'United States', lat: 32.69, lon: -114.63, timeZone: 'America/Phoenix' }));

// The lines are real people's words now (see evals/real-voices.json), so they are named here once.
const PLANT = "No GPS. We're right in the middle of corn planting.";
const SUN = 'There is currently a very high KP index has anyone had any Issues using GPS navigation?';
const MAY = "May 10, 2024: it showed the tractor going in circles and auto steer didn't work, and you couldn't engage it.";
let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};
const HOUR = 3_600_000;

const server = new McpServer(
  { name: 't', version: '1' },
  { capabilities: { tools: {}, resources: {}, tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } }, taskStore: new InMemoryTaskStore(), taskMessageQueue: new InMemoryTaskMessageQueue() },
);
registerTools(server, () => 'demo:0123456789abcdef0123456789abcdef');
speakErrorsPlainly(server);
const client = new Client({ name: 'c', version: '1' }, { capabilities: {} });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a), client.connect(b)]);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { said: (r.content ?? []).map((c) => c.text ?? '').join(' '), data: r.structuredContent ?? {}, isError: r.isError };
};

const start = Math.floor(Date.now() / (3 * HOUR)) * 3 * HOUR;
const slots = [];
for (let i = -8; i < 24; i += 1) slots.push({ time: new Date(start + i * 3 * HOUR).toISOString(), kp: 2, observed: i < 0 });
swpc.seedForTest({ fetchedAt: new Date().toISOString(), slots, alerts: [], scales: { g: 0, s: 0, r: 0, yesterday: { g: 0, s: 0, r: 0 }, days: [] }, stale: false });
solarwind.seedForTest({ wind: null, kp: null });
const top = Math.floor(Date.now() / HOUR) * HOUR;
crewheat.seedForTest(32.69, -114.63, Array.from({ length: 72 }, (_, i) => ({ time: top + i * HOUR, tempF: 101, humidityPct: 30 })));
crewday.configureForTest(async (name, args) => {
  if (name === 'share_my_day') return args.code === '46914443' ? { joined: true, crewLink: 'dana-link' } : { joined: false, reason: 'unknown' };
  return args.crewLink === 'dana-link' ? { sharing: true, crew: { label: '7 am to 5 pm', peakHeatIndexF: 100, peakAt: '3 pm', highFrom: '10 am', riskyFrom: null, acclimatization: { kind: 'new', day: 1, heatHoursAllowed: 2, doneBy: '9 am' }, timezone: 'America/Phoenix' } } : { sharing: false };
});

console.log('\nEvery line on the page is a real tool with real arguments');
const scenes = JSON.parse(readFileSync('./web/echo-scenes.json', 'utf8'));
const names = (await client.listTools()).tools.map((t) => t.name);
const lines = scenes.groups.flatMap((g) => g.lines);
check('the page has lines to say', lines.length >= 10, String(lines.length));
check('every line names a tool a customer gets by default', lines.every((l) => names.includes(l.tool)), lines.filter((l) => !names.includes(l.tool)).map((l) => l.tool).join(','));
check('no line on the page takes something typed', lines.every((l) => !l.input));
const html = readFileSync('./web/echo.html', 'utf8');
check('the page says it is a stand-in, and which part a model runs', /stand-in for an Echo Show/.test(html) && /No assistant model runs on the fixed lines/.test(html) && /a model picks the tool/.test(html));
check('the page does not name or link the other add-on', !/Sudor/.test(html) && !/execute-api/.test(html));
check('the answer is announced to a screen reader', /id="answer" aria-live="polite"/.test(html));
// The main demo page sets up its stand-in farm only when the server says there is none. It looked for wording the
// server no longer used, so no farm was ever set up. Its check must still match what the server says today.
const shared = await import('./dist/tools/shared.js');
const appJs = readFileSync('./web/app.js', 'utf8');
const opening = shared.NO_FIELDS.split('.')[0];
check("the demo page recognises the server's own no-field answer", appJs.includes(opening), opening);

console.log('\nThe story the page tells, start to finish');
const said = {};
for (const group of scenes.groups) {
  for (const line of group.lines) {
    // The look back reads the real archive; here it is given the day it asks for, so the test stays offline.
    if (line.tool === 'what_happened' && !globalThis.__stubbed) {
      globalThis.__stubbed = true;
      const real = globalThis.fetch;
      globalThis.fetch = async (url, init) => (String(url).includes('kp.gfz.de') ? new Response(JSON.stringify({ datetime: Array.from({ length: 8 }, (_, i) => `2024-05-10T${String(i * 3).padStart(2, '0')}:00:00Z`), Kp: [2.7, 3, 2.7, 3.3, 4, 7, 8.7, 9] })) : real(url, init));
    }
    const args = { ...line.args, ...(line.input ? { [line.input]: '4691 4443' } : {}) };
    const r = await call(line.tool, args);
    if (line.input) await crewday.refresh('dana-link', true);
    said[line.say] = r;
    check(`"${line.say}" is answered`, !r.isError && r.said.length > 10, r.said.slice(0, 90));
  }
}
check('planting is clear on a quiet day, and the crew is told about the heat', said[PLANT].data.go === true && /For the crew, the heat index reaches/.test(said[PLANT].said), said[PLANT].said);
check('the very first answer about a new field is in local time, not UTC', /Clear until \w{3} \d{1,2}(:\d\d)? [AP]M MST/.test(said[PLANT].said) && !/UTC/.test(said[PLANT].said), said[PLANT].said);
check('before Dana shares her day, she is not named', !/Dana is on day/.test(said[PLANT].said));
// Sharing a crew member's day is no longer on the page, and still works: her code, then the same question.
const linked = await call('crew_contact', { action: 'add', name: 'Dana', dayCode: '4691 4443' });
await crewday.refresh('dana-link', true);
check('typing her code links her day', linked.data.linked === true, linked.said);
const withCrew = await call('can_i_run', { operation: 'planting', equipment: 'planter' });
check('after it, the same question names her and her hours', /Dana is on day 1 in the heat: 2 hours of it today, done by 9 am\./.test(withCrew.said), withCrew.said);
check('the storm of May 2024 is called what it was', /That was the sun/.test(said[MAY].said) && /lose their precise fix altogether/.test(said[MAY].said), said[MAY].said);
check('the sprayer on WAAS is answered for its own tolerance', said['Can I spray?'].data.correction === 'sbas' && said['Can I spray?'].data.go === true);
void history;

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
