// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.ORBITA_SCOPE ??= 'all';
/**
 * Defects found by reading the whole codebase, each pinned by a test.
 *
 * Every block here is a bug that shipped: the code was wrong, the existing tests passed, and the answer a
 * customer would have heard was confidently mistaken. They are kept together, with what was wrong written
 * above each, because the pattern matters more than any one of them: most were values that looked right in
 * a fixture and wrong against the real feed, or a fallback that turned "I don't know" into a number.
 */
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const DIR = './data/test-review';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.ORBITA_DATA = `${DIR}/farms.json`;
process.env.ORBITA_AUTH_DATA = `${DIR}/auth.json`;
process.env.ORBITA_OUTBOX = `${DIR}/outbox.jsonl`;
delete process.env.ORBITA_DATA_KEY;

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';

const store = await import('./dist/store.js');
const swpc = await import('./dist/swpc.js');
const solarwind = await import('./dist/solarwind.js');
const aurora = await import('./dist/aurora.js');
const geomag = await import('./dist/geomag.js');
const glotec = await import('./dist/glotec.js');
const history = await import('./dist/history.js');
const season = await import('./dist/season.js');
const swpcplus = await import('./dist/swpcplus.js');
const impacts = await import('./dist/impacts.js');
const notify = await import('./dist/notify.js');
const shared = await import('./dist/tools/shared.js');
const { registerTools } = await import('./dist/tools.js');
const { speakErrorsPlainly } = await import('./dist/plainly.js');
const { configureForTest: fakeZones } = await import('./dist/timezone.js');
fakeZones(async () => 'America/Chicago');

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
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const said = (r.content ?? []).map((c) => c.text ?? '').join(' ');
    // `text` is the whole answer: what is spoken first plus what is held for "tell me more". `spoken` is the short part.
    return { text: [said, ...(r.structuredContent?.more ?? [])].join(' '), spoken: said, data: r.structuredContent ?? {}, isError: r.isError };
  };
  return { call, close: async () => { await client.close(); await server.close(); } };
}

// NOAA's file as it really is: a week of observed blocks, then three days of forecast. Quiet throughout,
// except the whole of tomorrow, which is a G3.
const now = Date.now();
const blockStart = Math.floor(now / (3 * HOUR)) * 3 * HOUR;
// "Tomorrow" is tomorrow where the field is, because that is how a spoken "tomorrow" is understood. This used
// to mark tomorrow by the UTC date, so the test failed for the five or six hours each night when it is already
// tomorrow in UTC and still today in Chicago.
const FIELD_ZONE = 'America/Chicago';
const localDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: FIELD_ZONE });
const tomorrow = localDay(now + 24 * HOUR);
const slots = [];
for (let i = -56; i < 24; i += 1) {
  const at = blockStart + i * 3 * HOUR;
  slots.push({ time: new Date(at).toISOString(), kp: localDay(at) === tomorrow ? 7 : 2, observed: i < 0 });
}
slots[0].kp = 8; // the oldest block in the file, a week ago: the one an invalid date used to be answered with
swpc.seedForTest({ fetchedAt: new Date().toISOString(), slots, alerts: [], scales: { g: 0, s: 0, r: 0, yesterday: { g: 0, s: 0, r: 0 }, days: [] }, stale: false });
solarwind.seedForTest({ wind: null, kp: null });

const farm = await connect('acct:review');
await farm.call('register_field', { name: 'North 40', lat: 40.92, lon: -98.34, crop: 'corn', baselineKm: 18 });
await farm.call('register_equipment', { name: 'the planter', correction: 'rtk' });

console.log('\nThe panel draws the forecast, not last week');
{
  const up = shared.upcomingSlots(slots);
  check('the first block sent is the one in progress', new Date(up[0].time).getTime() === blockStart, up[0]?.time);
  check('none of them has already ended', up.every((s) => new Date(s.time).getTime() + 3 * HOUR > now));
  check('positive control: the old slice was entirely in the past', slots.slice(0, 24).every((s) => new Date(s.time).getTime() + 3 * HOUR < now));
  const r = await farm.call('can_i_run', { operation: 'planting' });
  check('can_i_run sends upcoming blocks', r.data.slots.length > 0 && r.data.slots.every((s) => new Date(s.time).getTime() + 3 * HOUR > now), JSON.stringify(r.data.slots?.[0]));
  const st = await farm.call('storm_status');
  check('storm_status sends upcoming blocks', st.data.slots.every((s) => new Date(s.time).getTime() + 3 * HOUR > now));
  const fs = await farm.call('farm_status');
  check('farm_status sends upcoming blocks', fs.data.slots.every((s) => new Date(s.time).getTime() + 3 * HOUR > now));
}

console.log('\nA spoken "when" is understood, and a time I cannot place is not answered with a guess');
{
  const quiet = await farm.call('can_i_run', { operation: 'planting' });
  check('right now is clear', quiet.data.go === true && quiet.data.kp === 2, quiet.text);
  const tm = await farm.call('can_i_run', { operation: 'planting', when: 'tomorrow at noon' });
  check('"tomorrow at noon" is judged on tomorrow\'s forecast, which is a storm', tm.data.go === false && tm.data.kp === 7, `${tm.data.kp} ${tm.text.slice(0, 120)}`);
  const junk = await farm.call('can_i_run', { operation: 'planting', when: 'whenever the cows come home' });
  check('a time it cannot place is said to be so', junk.data.unavailable === true && /could not work out when/.test(junk.text), junk.text);
  check('...and is not answered with the week-old block at the top of the file', junk.data.kp !== 8 && !/Kp 8/.test(junk.text), junk.text);
  const far = await farm.call('can_i_run', { operation: 'planting', when: 'in 9 days' });
  check('beyond the forecast it says where the forecast ends', far.data.unavailable === true && /only reaches/.test(far.text), far.text);
  const past = await farm.call('can_i_run', { operation: 'planting', when: 'yesterday' });
  check('the past is sent to the tool that looks back', past.data.unavailable === true && /in the past/.test(past.text), past.text);
  check('kpAt is null a week beyond the file', swpc.kpAt(new Date(now + 9 * 24 * HOUR)) === null);
  check('kpAt is null for an invalid date', swpc.kpAt(new Date('nonsense')) === null);
  check('kpAt still answers inside the file', swpc.kpAt(new Date())?.kp === 2);
  // Found by breaking the code on purpose: with every neighbouring block at the same Kp, reading the block
  // before the right one went unnoticed. Each block here has its own value.
  const held = swpc.current();
  const distinct = held.slots.map((s, i) => ({ ...s, kp: i / 10 }));
  swpc.seedForTest({ ...held, slots: distinct });
  const here = distinct.findIndex((s) => new Date(s.time).getTime() === blockStart);
  check('kpAt reads the block the moment falls in, not its neighbour', swpc.kpAt(new Date(now))?.kp === distinct[here].kp, `${swpc.kpAt(new Date(now))?.kp} vs ${distinct[here].kp}`);
  check('...at the first minute of a block', swpc.kpAt(new Date(blockStart + 3 * HOUR))?.kp === distinct[here + 1].kp);
  check('...and at its last', swpc.kpAt(new Date(blockStart + 3 * HOUR - 1))?.kp === distinct[here].kp);
  swpc.seedForTest(held);
}

console.log('\nDates are read by rule, not by the built-in parser\'s guesses');
{
  const at = new Date('2026-10-04T15:00:00Z');
  const day = (s, o) => history.parseWhen(s, at, o)?.toISOString().slice(0, 10) ?? null;
  check('"the tenth of May 2024" is the tenth (it used to be the first)', day('the tenth of May 2024') === '2024-05-10', day('the tenth of May 2024'));
  check('"May 10" is the last one (it used to be 2001)', day('May 10') === '2026-05-10', day('May 10'));
  check('"field 12" is not a date (it used to be December 2001)', day('field 12') === null, String(day('field 12')));
  check('"planting 3" is not a date', day('planting 3') === null);
  check('"two days ago" is understood', day('two days ago') === '2026-10-02');
  check('a weekday looks back by default', day('Tuesday') === '2026-09-29');
  check('...and forward when asked about the future', day('Thursday', { prefer: 'future' }) === '2026-10-08');
  check('"tomorrow morning" is morning where the field is', history.parseWhen('tomorrow morning', at, { prefer: 'future', timeZone: 'America/Chicago' })?.toISOString() === '2026-10-05T13:00:00.000Z');
  check('the 31st of June does not exist', day('the 31st of June') === null);
  check('ISO still passes straight through', history.parseWhen('2024-05-10T12:00:00Z', at)?.toISOString() === '2024-05-10T12:00:00.000Z');
}

console.log('\nThe aurora model is compared with the Kp rule the right way round');
{
  // North 40 is at about 50 degrees geomagnetic. At Kp 2 the rule puts the oval's edge at 62.5, so the
  // field is about 12 degrees clear. The model says there is precipitation overhead anyway.
  aurora.seedForTest({ cells: [[-98, 41, 8]] });
  const r = await farm.call('can_i_run', { operation: 'planting' });
  check('a field the rule puts clear, with the oval modelled overhead, is told so', /degrees clear of the oval/.test(r.text), r.text);
  check('...with a sensible margin', /puts you 1\d degrees clear/.test(r.text), r.text.match(/puts you[^,]*/)?.[0]);
  aurora.resetForTest();
}

console.log('\nNames that are not recognised');
{
  const wh = await farm.call('what_happened', { when: 'yesterday', field: 'Zanzibar' });
  check('an unknown field is called an unknown field, not missing equipment', /don't have a field called "Zanzibar"/.test(wh.text) && /North 40/.test(wh.text), wh.text);
  await farm.call('register_field', { name: 'South Cut', lat: 41.15, lon: -98.02 });
  swpc.seedForTest({ ...swpc.current(), slots: slots.map((s) => ({ ...s, kp: 7 })) });
  await farm.call('watch_jobs', { action: 'start', operation: 'planting', field: 'North 40' });
  await farm.call('watch_jobs', { action: 'start', operation: 'planting', field: 'South Cut' });
  check('two watches are set', store.get('acct:review').waiting.length === 2);
  const stop = await farm.call('watch_jobs', { action: 'stop', field: 'Zanzibar' });
  check('stopping a field it does not know stops nothing (it used to clear every watch)', store.get('acct:review').waiting.length === 2 && /have not stopped anything/.test(stop.text), stop.text);
  const real = await farm.call('watch_jobs', { action: 'stop', field: 'South Cut' });
  check('stopping a real one stops that one', store.get('acct:review').waiting.length === 1, real.text);
  const drill = await farm.call('can_i_run', { operation: 'planting', field: 'North 40', equipment: 'the drill' });
  check('a machine it does not know is answered for the first one, and says so', /don't have a machine called "the drill", so that is for the planter/.test(drill.text), drill.text);
  swpc.seedForTest({ ...swpc.current(), slots });
}

console.log('\nfarm_status covers every machine');
{
  await farm.call('register_equipment', { name: 'the old sprayer', correction: 'autonomous' });
  swpc.seedForTest({ ...swpc.current(), slots: slots.map((s) => ({ ...s, kp: 7 })) });
  const r = await farm.call('farm_status');
  const machines = new Set(r.data.rows.map((x) => x.equipment));
  check('both machines are judged (it used to be the first only)', machines.has('the planter') && machines.has('the old sprayer'), [...machines].join(','));
  check('nothing is read out with an underscore in it', !/_/.test(r.text), r.text);
  check('a job the machine can never hold is said apart from the storm', /cannot hold tolerance on the correction/.test(r.text), r.text);
  swpc.seedForTest({ ...swpc.current(), slots });
}

console.log('\nThe season plan');
{
  const field = { id: 'f', name: 'North 40', lat: 40.92, lon: -98.34 };
  const coarse = { id: 'a', name: 'the old sprayer', correction: 'autonomous' };
  const fine = { id: 'b', name: 'the planter', correction: 'rtk' };
  const today = new Date();
  swpcplus.seedForTest({ outlook: Array.from({ length: 10 }, (_, i) => ({ date: new Date(today.getTime() + i * 86_400_000).toISOString().slice(0, 10), ap: 8, kp: 2, f107: 120 })) });
  // The first machine can never plant. Every day used to be a write-off, because every plan's jobs were
  // judged against the first field and the first machine.
  const plan = season.plan([field], [coarse, fine], ['planting']);
  check('a day the second machine can work is not a write-off', plan.writeOffDays.length === 0, JSON.stringify(plan.writeOffDays));
  const said = season.summarise(plan);
  check('the spoken summary never points at a screen', !/on screen|on the screen/i.test(said), said);
  check('...and says a date as a date', !/\d{4}-\d{2}-\d{2}/.test(said) && /starting \w+day, \w+ \d+/.test(said), said);
  const many = Array.from({ length: 300 }, (_, i) => ({ ...field, id: `f${i}`, name: `Field ${i}` }));
  const started = Date.now();
  const big = season.plan(many, [fine], ['planting', 'spraying']);
  check('a very large farm is planned in bounded time', Date.now() - started < 1500 && big.plans.length <= 25 * 6, `${Date.now() - started} ms, ${big.plans.length} plans`);
  check('...and says it only covered the first of them', big.notes.some((n) => /first 25 fields/.test(n)));
}

console.log('\nFeeds that answer but are behind');
{
  const realFetch = globalThis.fetch;
  const feed = (kpTag) => async (url) => ({
    ok: true,
    json: async () =>
      String(url).includes('planetary_k_index_1m')
        ? [{ time_tag: kpTag, estimated_kp: 6.33 }]
        : String(url).includes('speed')
          ? [{ proton_speed: 400, time_tag: new Date().toISOString() }]
          : [{ bz_gsm: -2, bt: 5, time_tag: new Date().toISOString() }],
  });
  globalThis.fetch = feed(new Date(Date.now() - 5 * HOUR).toISOString().slice(0, 19));
  await solarwind.refresh();
  check('a one minute estimate that is five hours old is not "right now"', solarwind.estimatedKp() === null, JSON.stringify(solarwind.estimatedKp()));
  globalThis.fetch = feed(new Date().toISOString().slice(0, 19));
  await solarwind.refresh();
  check('a current one is used', solarwind.estimatedKp()?.kp === 6.33);
  globalThis.fetch = async (url) => {
    if (String(url).includes('planetary_k_index_1m')) return { ok: true, json: async () => [{ time_tag: new Date().toISOString().slice(0, 19), estimated_kp: 3 }] };
    throw new Error('wind summary is down');
  };
  await solarwind.refresh();
  check('the wind summary failing does not throw away the Kp estimate', solarwind.estimatedKp()?.kp === 3);
  globalThis.fetch = realFetch;
  solarwind.seedForTest({ wind: null, kp: null });

  glotec.seedForTest({ cells: [[41.25, -97.5, { tec: 20, anomaly: 0, quality: 0 }]], at: new Date(Date.now() - 4 * HOUR).toISOString() });
  check('a map made four hours ago is not a measurement of now, however recently it was downloaded', glotec.ionosphere(40.92, -98.34) === null);
  glotec.resetForTest();

  // An hour of quiet, a half hour with no data, then a level 60 nT lower. That is one step across a gap.
  const base = Date.now() - 180 * 60_000;
  const samples = [];
  for (let m = 0; m < 180; m += 1) {
    if (m >= 100 && m < 130) continue;
    samples.push({ at: new Date(base + m * 60_000).toISOString(), h: m < 100 ? 20000 : 19970 });
  }
  geomag.seedForTest({ readings: [{ id: 'BOU', samples }] });
  const reading = geomag.reading(40.137, -105.237);
  check('a step across a gap in the data is not counted as a rate per minute', reading && reading.rate < 6 && reading.level === 'quiet', JSON.stringify(reading && { rate: reading.rate, level: reading.level }));
  geomag.resetForTest();
}

console.log('\nNothing is offered that cannot be asked for');
{
  const said = impacts.speakImpacts({ g: 4, s: 2, r: 3 });
  check('no "more if you want them" from a tool with no way to ask for more', !/if you want them/.test(said), said.slice(-160));
}

console.log('\nSetting up');
{
  const blank = await farm.call('register_field', { name: '<>', lat: 40, lon: -98 });
  check('a field with no sayable name is refused', blank.data.added === false && /need a name/.test(blank.text), blank.text);
  await farm.call('register_field', { name: 'North 40', lat: 40.92, lon: -98.34 });
  const kept = store.get('acct:review').fields.find((f) => f.name === 'North 40');
  check('correcting a field without repeating its crop or baseline keeps them', kept.crop === 'corn' && kept.baselineKm === 18, JSON.stringify(kept));
  const neg = await farm.call('register_field', { name: 'Odd', lat: 40, lon: -98, baselineKm: -5 });
  check('a negative baseline is refused', neg.isError === true, neg.text);
  store.update('acct:kyiv', (f) => void f.fields.push({ id: 'x', name: 'Поле', lat: 50, lon: 30 }, { id: 'y', name: 'East', lat: 50, lon: 31 }));
  check('a name in another script no longer matches every question', store.findField(store.get('acct:kyiv'), 'East')?.id === 'y' && store.findField(store.get('acct:kyiv'), 'West') === null);
  check('...and can still be found by its own name', store.findField(store.get('acct:kyiv'), 'Поле')?.id === 'x');
  const late = await farm.call('log_job', { operation: 'planting', field: 'North 40', when: 'tomorrow' });
  check('a job cannot be logged as done tomorrow', late.data.logged === false && /in the future/.test(late.text), late.text);
}

console.log('\nForgetting is deleting');
{
  store.update('demo:' + 'a'.repeat(32), (f) => void f.fields.push({ id: 'z', name: 'Z', lat: 1, lon: 1 }));
  store.forget('demo:' + 'a'.repeat(32));
  check('no empty record is left behind', !store.allEntries().some(([id]) => id === 'demo:' + 'a'.repeat(32)));
  check('...on disk either', !readFileSync(`${DIR}/farms.json`, 'utf8').includes('a'.repeat(32)));
}

console.log('\nEmail has a ceiling, and the outbox keeps no addresses');
{
  const sent = [];
  notify.configureForTest({ from: 'orbita@example.com', transport: async (email) => void sent.push(email) });
  notify.resetEmailLimitsForTest();
  const results = [];
  for (let i = 0; i < 12; i += 1) results.push(await notify.sendEmail({ to: 'Victim@Example.com', subject: `Report ${i}`, text: 'x', reason: 'job_report', sender: 'acct:review' }));
  check('one address gets eight in a day and then no more', sent.length === 8 && results.slice(8).every((r) => r.status === 'limited'), `${sent.length} sent`);
  check('the refusal is recorded as a refusal, not as sent', results[9].status === 'limited');
  notify.resetEmailLimitsForTest();
  let ok = 0;
  for (let i = 0; i < 40; i += 1) if ((await notify.sendEmail({ to: `p${i}@example.com`, subject: 's', text: 'x', reason: 'job_report', sender: 'acct:review' })).status === 'sent') ok += 1;
  check('one account sends thirty in a day across everybody, and then no more', ok === 30, String(ok));
  const out = readFileSync(`${DIR}/outbox.jsonl`, 'utf8');
  check('the outbox holds no address', !/example\.com/i.test(out), out.slice(0, 120));
  check('...and no subject line', !/Report \d/.test(out));
  check('...but still tells two recipients apart', new Set(out.trim().split('\n').map((l) => JSON.parse(l).to)).size > 5);

  await farm.call('crew_contact', { action: 'add', name: 'Dale', email: 'dale@example.com' });
  await farm.call('crew_contact', { action: 'confirm', name: 'Dale' });
  notify.resetEmailLimitsForTest();
  let said = '';
  for (let i = 0; i < 10; i += 1) said = (await farm.call('job_report', { emailTo: 'Dale' })).text;
  check('asking for the report again and again ends in an honest "not sent"', /as many emails as I will send in a day/.test(said), said);
  notify.resetEmailLimitsForTest();
}

await farm.close();

console.log('\nA running server');
{
  const PORT = 8813;
  const BASE = `http://127.0.0.1:${PORT}`;
  const boot = async (env) => {
    const child = spawn(process.execPath, ['dist/server.js'], {
      env: { ...process.env, PORT: String(PORT), ORBITA_DATA: `${DIR}/srv.json`, ORBITA_AUTH_DATA: `${DIR}/srv-auth.json`, ...env },
      stdio: 'ignore',
    });
    for (let i = 0; i < 80; i += 1) {
      try { if ((await fetch(`${BASE}/health`)).ok) return child; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    child.kill();
    throw new Error('the server never came up');
  };
  const stop = (child) => new Promise((r) => { child.on('exit', r); child.kill(); setTimeout(r, 3000); });
  const demo = (n) => n.toString(16).padStart(32, '0');

  // Not behind a proxy, and not told that it is. A caller who invents a new address and a new sandbox id
  // for every request is still one caller.
  let child = await boot({ ORBITA_AUTH: 'on', ORBITA_AGENT_BURST: '3', ORBITA_AGENT_PER_MINUTE: '1' });
  const codes = [];
  for (let i = 0; i < 6; i += 1) {
    const res = await fetch(`${BASE}/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-orbita-demo': demo(i + 1), 'x-forwarded-for': `203.0.113.${i + 1}` },
      body: JSON.stringify({ say: 'what can you do' }),
    });
    codes.push(res.status);
  }
  check('a made-up X-Forwarded-For does not buy a fresh allowance when no proxy is trusted', codes.slice(3).every((c) => c === 429), codes.join(','));
  check('...and the first few were not refused, so the limit is what stopped the rest', codes.slice(0, 3).every((c) => c !== 429), codes.join(','));

  const register = (body) => fetch(`${BASE}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  check('a javascript: redirect is refused', (await register({ redirect_uris: ['javascript:alert(1)'] })).status === 400);
  check('plain http to somewhere else is refused', (await register({ redirect_uris: ['http://evil.example/cb'] })).status === 400);
  check('a URL with credentials in it is refused', (await register({ redirect_uris: ['https://user:pw@evil.example/cb'] })).status === 400);
  const good = await register({ redirect_uris: ['https://dev.example/cb'], client_name: 'Alexa+' });
  const client = await good.json();
  check('https is accepted', good.status === 201 && typeof client.client_id === 'string');
  check('http on localhost is accepted, for development', (await register({ redirect_uris: ['http://localhost:3000/cb'] })).status === 201);
  const page = await fetch(`${BASE}/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent('https://dev.example/cb')}&code_challenge=abc&code_challenge_method=S256`);
  const html = await page.text();
  check('a registered name is shown as a claim, so nobody can simply be "Alexa+"', /An app calling itself &quot;Alexa\+&quot;/.test(html), html.match(/<p>[^<]*/)?.[0]);
  check('the consent page cannot be framed', /frame-ancestors 'none'/.test(page.headers.get('content-security-policy') ?? '') && page.headers.get('x-frame-options') === 'DENY');
  check('...and is not cached', page.headers.get('cache-control') === 'no-store');
  await stop(child);
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
