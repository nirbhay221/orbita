/**
 * Three things that were known to be wrong, and are tested here as fixed.
 *
 *   1. A crew contact was "confirmed" by the customer. Now the person who owns the address agrees, or
 *      nothing but one invitation is ever sent to them.
 *   2. Five wrong passphrases locked a name for everybody, so anyone could lock a farm out.
 *   3. Somebody with no field registered, asking about a town, was answered in UTC.
 */
import { mkdirSync, rmSync } from 'node:fs';

const DIR = './data/test-fixes';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.ORBITA_DATA = `${DIR}/farms.json`;
process.env.ORBITA_OUTBOX = `${DIR}/outbox.jsonl`;
process.env.ORBITA_AUTH_DATA = `${DIR}/auth.json`;
process.env.ORBITA_PUBLIC_URL = 'https://orbita.example.org';
delete process.env.ORBITA_DATA_KEY;
delete process.env.ORBITA_SCOPE;
delete process.env.ORBITA_RECIPIENT_CONSENT;

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';

const store = await import('./dist/store.js');
const swpc = await import('./dist/swpc.js');
const solarwind = await import('./dist/solarwind.js');
const notify = await import('./dist/notify.js');
const consent = await import('./dist/consent.js');
const authstore = await import('./dist/authstore.js');
const geo = await import('./dist/geocode.js');
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
  return async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { said: (r.content ?? []).map((c) => c.text ?? '').join(' '), data: r.structuredContent ?? {} };
  };
}

const app = express();
consent.mountConsent(app);
const listener = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${listener.address().port}`;
const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });

const sent = [];
notify.configureForTest({ from: 'orbita@example.org', transport: async (email) => { sent.push(email); } });
const settle = () => new Promise((r) => setTimeout(r, 30));

const start = Math.floor(Date.now() / (3 * HOUR)) * 3 * HOUR;
const slots = [];
for (let i = -8; i < 24; i += 1) slots.push({ time: new Date(start + i * 3 * HOUR).toISOString(), kp: 2, observed: i < 0 });
swpc.seedForTest({ fetchedAt: new Date().toISOString(), slots, alerts: [], scales: { g: 0, s: 0, r: 0, yesterday: { g: 0, s: 0, r: 0 }, days: [] }, stale: false });
solarwind.seedForTest({ wind: null, kp: null });

console.log('\nThe person who gets the emails is the one who agrees');
const farm = await connect('acct:farm');
await farm('register_field', { name: 'North 40', lat: 40.92, lon: -98.34 });
await farm('register_equipment', { name: 'planter', correction: 'rtk' });
let token = '';
{
  check('with a public address, the recipient has to agree', consent.consentRequired() === true);
  await farm('crew_contact', { action: 'add', name: 'Dana', email: 'dana@example.com', role: 'planter operator' });
  check('adding somebody sends nothing', sent.length === 0);
  const yes = await farm('crew_contact', { action: 'confirm', name: 'Dana' });
  await settle();
  check('the customer saying yes sends one invitation, and says so', sent.length === 1 && sent[0].reason === 'invite' && /emailed Dana to ask if they agree/.test(yes.said) && /once they say yes, and not before/.test(yes.said), yes.said);
  token = (sent[0].text.match(/accept\?t=([0-9a-f]{48})/) ?? [])[1] ?? '';
  check('the invitation carries a link on the public address', token.length === 48 && sent[0].text.includes('https://orbita.example.org/contact/accept?t='), sent[0].text);
  const held = store.get('acct:farm').crew[0];
  check('only a hash of the invitation is stored', held.acceptHash && held.acceptHash.length === 64 && !JSON.stringify(held).includes(token));

  sent.length = 0;
  const report = await farm('job_report', { emailTo: 'Dana' });
  await settle();
  check('before she agrees, a report is not emailed to her, and the answer says why', sent.length === 0 && report.data.sent === false && /hasn't agreed to be emailed yet/.test(report.said), report.said);
  const again = await farm('crew_contact', { action: 'confirm', name: 'Dana' });
  await settle();
  check('saying yes again does not send a second invitation', sent.length === 0 && /already emailed Dana/.test(again.said), again.said);
}

console.log('\nThe invitation link');
let stopId = '';
{
  const opened = await fetch(`${base}/contact/accept?t=${token}`);
  check('opening it shows a page with a button, and is not itself agreement', opened.status === 200 && /<form method="post"/.test(await opened.text()) && !store.get('acct:farm').crew[0].acceptedAt);
  check('a made-up link is refused', (await fetch(`${base}/contact/accept?t=${'0'.repeat(48)}`)).status === 404);
  const agreed = await post('/contact/accept', { t: token, answer: 'yes' });
  check('pressing yes records it', agreed.status === 200 && !!store.get('acct:farm').crew[0].acceptedAt);
  check('the link works once', (await post('/contact/accept', { t: token, answer: 'yes' })).status === 404);
  stopId = store.get('acct:farm').crew[0].stopId;
  check('she is now reachable', consent.reachable(store.get('acct:farm').crew[0]) === true);
  check('a made-up stop link is refused', (await fetch(`${base}/contact/stop?s=${'a'.repeat(32)}`)).status === 404);
  const stopped = await post('/contact/stop', { s: stopId, answer: 'stop' });
  check('pressing stop removes her from the crew list', stopped.status === 200 && store.get('acct:farm').crew.length === 0);
}

console.log('\nIt cannot be used to pester a stranger');
{
  sent.length = 0;
  await farm('crew_contact', { action: 'add', name: 'Dana', email: 'DANA@example.com' });
  await farm('crew_contact', { action: 'confirm', name: 'Dana' });
  await settle();
  check('one address is invited once a day, however often it is added', sent.length === 0, String(sent.length));
  const visitor = await connect('demo:xyz');
  await visitor('crew_contact', { action: 'add', name: 'Stranger', email: 'stranger@example.com' });
  const demo = await visitor('crew_contact', { action: 'confirm', name: 'Stranger' });
  await settle();
  check('a visitor to the demo cannot send an invitation at all', sent.length === 0 && /phone on this page, not to a real inbox/.test(demo.said), demo.said);
  const phone = notify.demoPhone('demo:xyz');
  check('...it goes to the inbox on the demo page, word for word', phone.length === 1 && phone[0].to === 'Stranger' && /asked for you to be emailed/.test(phone[0].text) && /^[0-9a-f]{48}$/.test(phone[0].accept ?? ''), JSON.stringify(phone));
  check('...which nobody else can read', notify.demoPhone('demo:abc').length === 0 && notify.demoPhone('acct:farm').length === 0);
  check('...and until they agree there, they are not on the list of people to tell', !consent.reachable(store.get('demo:xyz').crew[0]) && consent.awaiting(store.get('demo:xyz').crew[0]));
  const yes = await post('/contact/accept', { t: phone[0].accept, answer: 'yes' });
  check('pressing yes there is the real agreement', yes.status === 200 && consent.reachable(store.get('demo:xyz').crew[0]));

  // A storm for that visitor's farm: what the crew would be emailed lands in the same inbox, and nowhere else.
  await visitor('my_farm', { fieldName: 'Home', place: 'Fargo, North Dakota', lat: 46.88, lon: -96.79, machineName: 'planter', correction: 'rtk' });
  const calm = swpc.current();
  swpc.seedForTest({ ...calm, slots: calm.slots.map((s, i) => ({ ...s, kp: !s.observed && i % 40 < 14 ? 8 : 2 })) });
  solarwind.seedForTest({ wind: null, kp: null });
  const { checkFieldAlerts } = await import('./dist/alerts.js');
  const before = sent.length;
  await checkFieldAlerts();
  const after = notify.demoPhone('demo:xyz');
  check('a storm over a visitor\u2019s field is shown in their inbox', after.some((m) => /^Storm ahead/.test(m.subject)), JSON.stringify(after.map((m) => m.subject)));
  check('...saying when it clears, or that the forecast does not say', after.some((m) => /back inside tolerance from |does not yet show when it clears/.test(m.text)));
  check('...and no email leaves the server for it', sent.slice(before).every((m) => m.to !== 'stranger@example.com'), JSON.stringify(sent.slice(before).map((m) => m.to)));
  swpc.seedForTest(calm);
}

console.log('\nAn address is typed, not said');
{
  const who = await connect('acct:typed');
  const asked = await who('crew_contact', { action: 'add', name: 'Lee', role: 'party chief' });
  check('adding somebody without an address hands back a page to type it on', asked.data.needs === 'email' && /\/contact\/enter\?e=[0-9a-f]{48}$/.test(asked.data.enterAt ?? ''), JSON.stringify(asked.data));
  const e = asked.data.enterAt.split('e=')[1];
  check('the page opens', (await fetch(`${base}/contact/enter?e=${e}`)).status === 200);
  check('a guessed page does not', (await fetch(`${base}/contact/enter?e=${'0'.repeat(48)}`)).status === 404);
  check('something that is not an address is refused', (await post('/contact/enter', { e, email: 'not an address' })).status === 400);
  const saved = await post('/contact/enter', { e, email: 'lee@example.com' });
  const crew = store.get('acct:typed').crew;
  check('a typed address stages them, exactly as saying it would', saved.status === 200 && crew.length === 1 && crew[0].email === 'lee@example.com' && crew[0].role === 'party chief' && crew[0].confirmedAt === null, JSON.stringify(crew));
  check('the page works once', (await post('/contact/enter', { e, email: 'other@example.com' })).status === 404 && store.get('acct:typed').crew.length === 1);
  check('only a hash of the page is kept', !JSON.stringify(store.get('acct:typed')).includes(e));
  sent.length = 0;
  notify.resetEmailLimitsForTest();
  const done = await who('crew_contact', { action: 'confirm', name: 'Lee' });
  await settle();
  check('saying yes afterwards is what sends the invitation', /Lee/.test(done.said) && done.data.confirmed === true, done.said);
}

console.log('\nNobody can lock somebody else out of their name');
{
  authstore.resetForTest();
  const good = 'correct horse battery';
  check('a name is claimed', (await authstore.claimOrVerify('jordan', good, '10.0.0.1')).kind === 'claimed');
  for (let i = 0; i < 5; i += 1) await authstore.claimOrVerify('jordan', `wrong guess ${i}`, '203.0.113.9');
  check('five wrong answers lock out the address that gave them', (await authstore.claimOrVerify('jordan', good, '203.0.113.9')).kind === 'locked');
  check('...but the owner, from their own address, still gets in', (await authstore.claimOrVerify('jordan', good, '10.0.0.1')).kind === 'ok');
  let spread = null;
  for (let i = 0; i < 60; i += 1) spread = await authstore.claimOrVerify('jordan', 'wrong everywhere', `192.0.2.${i}`);
  check('sixty wrong answers across many addresses lock the name itself', spread.kind === 'locked' && (await authstore.claimOrVerify('jordan', good, '10.0.0.1')).kind === 'locked');
}

console.log('\nA town is answered in its own time');
{
  geo.configureForTest(async () => ({ name: 'Phoenix', region: 'Arizona', country: 'United States', lat: 33.45, lon: -112.07, timeZone: 'America/Phoenix' }));
  const visitor = await connect('acct:new');
  const trial = await visitor('can_i_run', { operation: 'planting', place: 'Phoenix, Arizona', correction: 'rtk' });
  check('the clear-until time is in the town\'s zone', /Clear until \w{3} \d{1,2}(:\d\d)? [AP]M MST/.test(trial.said) && !/UTC/.test(trial.said), trial.said);
  geo.configureForTest(async () => ({ name: 'Nowhere', region: null, country: null, lat: 10, lon: 10 }));
  const other = await connect('acct:new2');
  const noZone = await other('can_i_run', { operation: 'planting', place: 'Nowhere', correction: 'rtk' });
  check('a lookup with no zone still answers, in UTC', /UTC/.test(noZone.said) && noZone.data.go === true, noZone.said);
  check('picking a town keeps the zone the lookup gave', geo.pick('Phoenix, Arizona', [{ name: 'Phoenix', admin1: 'Arizona', country: 'United States', latitude: 33.45, longitude: -112.07, timezone: 'America/Phoenix' }]).timeZone === 'America/Phoenix');
}

console.log('\nAnswers hand back a handle, and the next step takes it');
{
  geo.configureForTest(null);
  const who = await connect('acct:chain');
  await who('register_field', { name: 'North 40', lat: 40.92, lon: -98.34 });
  await who('register_field', { name: 'River Bottom', lat: 41.6, lon: -99.4 });
  await who('register_equipment', { name: 'planter', correction: 'rtk' });
  await who('register_equipment', { name: 'sprayer', correction: 'sbas' });
  const first = await who('can_i_run', { operation: 'spraying', field: 'River Bottom', equipment: 'sprayer' });
  check('an answer about a job carries the ids of the field and the machine', /^field-/.test(first.data.fieldId) && /^equip|^machine|^eq/.test(first.data.equipmentId) && first.data.field === 'River Bottom', JSON.stringify({ f: first.data.fieldId, e: first.data.equipmentId }));
  const again = await who('can_i_run', { operation: 'harvest', field: first.data.fieldId, equipment: first.data.equipmentId });
  check('the next question can name them by id and gets the same field and machine', again.data.field === 'River Bottom' && again.data.equipment === 'sprayer', `${again.data.field} ${again.data.equipment}`);
  store.update('acct:chain', (x) => { x.fields.find((f) => f.id === first.data.fieldId).name = 'The Bottoms'; });
  const renamed = await who('can_i_run', { operation: 'harvest', field: first.data.fieldId, equipment: first.data.equipmentId });
  check('an id still finds the field after it has been renamed', renamed.data.field === 'The Bottoms');
  check('an id from another farm finds nothing here', store.findField(store.get('acct:farm'), first.data.fieldId)?.id !== first.data.fieldId);
  const trial = await (await connect('acct:trialids'))('can_i_run', { operation: 'planting', place: 'Phoenix, Arizona', correction: 'rtk' });
  check('a trial answer hands back no ids, because nothing was stored', trial.data.fieldId === undefined);
}

console.log('\nNothing is said twice in one answer, and the next step is named');
{
  const who = await connect('acct:lean');
  await who('register_field', { name: 'North 40', lat: 40.92, lon: -98.34 });
  const eq = await who('register_equipment', { name: 'planter', correction: 'rtk' });
  check('adding a machine points at the farm overview', eq.data.nextAction?.tool === 'farm_status', JSON.stringify(eq.data.nextAction));
  const crew = await who('crew_contact', { action: 'add', name: 'Dana', email: 'dana2@example.com' });
  check('staging a crew contact points at confirming them, by name', crew.data.nextAction?.tool === 'crew_contact' && crew.data.nextAction.arguments.action === 'confirm' && crew.data.nextAction.arguments.name === 'Dana', JSON.stringify(crew.data.nextAction));
  const logged = await who('log_job', { operation: 'planting' });
  check('logging a job points at the report', logged.data.nextAction?.tool === 'job_report', JSON.stringify(logged.data.nextAction));
  const go = await who('can_i_run', { operation: 'planting' });
  const json = JSON.stringify(go.data);
  check('the notes tools leave for the shortening code do not leave the server', !('mustSay' in go.data) && !('fullAnswer' in go.data) && !('offer' in go.data) && !('full' in go.data), Object.keys(go.data).join(','));
  check('the verdict appears once in the structured half', json.split('Clear for planting').length - 1 <= 2, String(json.split('Clear for planting').length - 1));
  const quiet = await who('farm_status');
  check('with nothing blocked, the overview points nowhere', quiet.data.nextAction === undefined);
  const before = swpc.current();
  // A storm now that clears in about a day, so there is a window worth watching for.
  const cutoff = Date.now() + 24 * 3_600_000;
  swpc.seedForTest({ ...before, slots: before.slots.map((s) => ({ ...s, kp: new Date(s.time).getTime() < cutoff ? 8.7 : 2 })) });
  solarwind.seedForTest({ wind: null, kp: null });
  const stormy = await who('farm_status');
  check('with a job blocked by the storm, the overview points at asking about that job', stormy.data.nextAction?.tool === 'can_i_run' && typeof stormy.data.nextAction.arguments.operation === 'string' && stormy.data.nextAction.arguments.field === 'North 40', JSON.stringify(stormy.data.nextAction));
  const blocked = await who('can_i_run', { operation: 'planting' });
  check('a blocked job still names its own next step, the watch', blocked.data.go === false && blocked.data.nextAction?.tool === 'watch_jobs');
  const watch = await who(blocked.data.nextAction.tool, blocked.data.nextAction.arguments);
  check('following it starts the watch, and that points at checking it', watch.data.watching === true && watch.data.nextAction?.tool === 'watch_jobs' && watch.data.nextAction.arguments.action === 'check', JSON.stringify(watch.data));
  swpc.seedForTest(before);
}

console.log('\nOne tool for the farm');
{
  const who = await connect('acct:merged');
  const empty = await who('my_farm', {});
  check('with nothing given, it says what it needs', empty.data.needs === 'field_or_machine', empty.said);
  const both = await who('my_farm', { fieldName: 'North 40', place: 'Grand Island, Nebraska', machineName: 'planter', correction: 'rtk' });
  const farmNow = store.get('acct:merged');
  check('a field and a machine in one call are both added', farmNow.fields.length === 1 && farmNow.equipment.length === 1 && both.data.did.length === 2, both.said);
  check('...and it does not then ask what the machine runs', !/what correction/i.test(both.said), both.said);
  check('...and points at the overview', both.data.nextAction?.tool === 'farm_status');
  const half = await who('my_farm', { machineName: 'sprayer' });
  check('a machine with no correction is asked about, not guessed', store.get('acct:merged').equipment.length === 1 && /What correction does sprayer run/.test(half.said), half.said);
  const gone = await who('my_farm', { removeWhat: 'machine', removeName: 'planter' });
  check('a machine can be taken off through it', store.get('acct:merged').equipment.length === 0, gone.said);
  const go = await who('can_i_run', { operation: 'planting' });
  check('the rest of the tools see what it recorded', go.data.needs === 'equipment', go.said);
}

console.log('\nFound by using it as a stranger');
{
  geo.configureForTest(async () => ({ name: 'Fargo', region: 'North Dakota', country: 'United States', lat: 46.88, lon: -96.79, timeZone: 'America/Chicago' }));
  const who = await connect('acct:walk');
  const trial = await who('can_i_run', { operation: 'planting', place: 'Fargo, North Dakota', correction: 'rtk' });
  check('"want me to remember this?" has the call behind it', trial.data.nextAction?.tool === 'my_farm' && trial.data.nextAction.arguments.place === 'Fargo, North Dakota' && trial.data.nextAction.arguments.correction === 'rtk', JSON.stringify(trial.data.nextAction));
  const kept = await who(trial.data.nextAction.tool, trial.data.nextAction.arguments);
  check('following it remembers both the field and the machine', store.get('acct:walk').fields.length === 1 && store.get('acct:walk').equipment.length === 1, kept.said);
  check('a field and a machine given together are not then asked for', !/Now tell me/.test(kept.said), kept.said);
  const alone = await (await connect('acct:walk2'))('my_farm', { fieldName: 'Home', place: 'Fargo, North Dakota' });
  check('a field given alone still asks what the machine runs', /Now tell me what correction/.test(alone.said), alone.said);

  // May 10 2024, asked from a field in Chicago: the answer is about May 10, not the day after.
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('kp.gfz.de')) return real(url, init);
    asked.push(String(url));
    const day = String(url).match(/start=(\d{4}-\d{2}-\d{2})/)[1];
    return new Response(JSON.stringify({ datetime: Array.from({ length: 8 }, (_, i) => `${day}T${String(i * 3).padStart(2, '0')}:00:00Z`), Kp: [2.7, 3, 2.7, 3.3, 4, 7, 8.7, 9] }));
  };
  const back = await who('what_happened', { when: 'May 10 2024' });
  globalThis.fetch = real;
  check('the day somebody names is the day that is looked up', asked.length === 1 && asked[0].includes('start=2024-05-10'), asked.join(' '));
  check('...and the day that is said back', /On Friday, May 10\b/.test(back.said) && !/May 11/.test(back.said), back.said);

  // A time on that day, not only the day. The same storm, asked about two different hours.
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('kp.gfz.de')) return real(url, init);
    const [a, b] = [...String(url).matchAll(/(\d{4}-\d{2}-\d{2})T/g)].map((m) => m[1]);
    const days = a === b ? [a] : [a, b];
    return new Response(JSON.stringify({ datetime: days.flatMap((day) => Array.from({ length: 8 }, (_, i) => `${day}T${String(i * 3).padStart(2, '0')}:00:00Z`)), Kp: days.flatMap(() => [2.7, 3, 2.7, 3.3, 4, 7, 8.7, 9]) }));
  };
  const early = await who('what_happened', { when: 'May 10 2024 at 2 am' });
  check('an hour that was quiet is answered as quiet, on a day that had a storm', /^It was not the sun\./.test(early.said) && early.data.wasTheSun === false && early.data.byHour === true, early.said);
  check('...and says what to look at instead', /base station|correction link|converging|correction satellite|no correction/.test(early.said), early.said);
  const late = await who('what_happened', { when: 'May 10 2024 at 5 pm' });
  check('an hour inside the storm is answered as the sun', /^That was the sun\./.test(late.said) && late.data.wasTheSun === true, late.said);
  check('...in the field own clock, not UTC', !/UTC|GMT/.test(late.said) && /\d (AM|PM) to \d{1,2} (AM|PM)/.test(late.said), late.said);
  check('...with the passes to look at', /Passes made between/.test(late.said), late.said);
  const day2 = await who('what_happened', { when: 'May 11 2024' });
  check('a whole day asked afterwards still gets all eight blocks', day2.data.blocksTotal === 8, String(day2.data.blocksTotal));
  globalThis.fetch = real;

  const trade = await import('./dist/trade.js');
  check('a surveyor on a bad day is told to re-observe', /re-observed/.test(trade.adviceNow('surveying', false, 7, 'space_weather')));
  check('a drone pilot is told not to fly the mission, and about the compass', /Do not fly/.test(trade.adviceNow('drone_survey', false, 7, 'space_weather')) && /compass/.test(trade.adviceNow('drone_survey', true, 5, 'none')));
  check('a grading crew is told to hold the blade', /Hold the blade/.test(trade.adviceNow('machine_control', false, 7, 'space_weather')));
  check('a quiet day adds nothing for anybody', ['surveying', 'drone_survey', 'machine_control', 'planting', 'spraying'].every((o) => trade.adviceNow(o, true, 2, 'none') === ''));
  check('a machine that can never hold the tolerance is not blamed on the sky', trade.adviceNow('surveying', false, 7, 'equipment') === '');

  const { parseAlertForTest } = await import('./dist/swpc.js');
  if (parseAlertForTest) {
    const a = parseAlertForTest({ issue_datetime: 'x', message: 'Space Weather Message Code: WATA30\r\nSerial Number: 1\r\nWATCH: Geomagnetic Storm Category G2 Predicted\r\nHighest Storm Level Predicted by Day:\r\nOct 07: None (Below G1) Oct 08: None (Below G1) Oct 09: G2 (Moderate)\r\nTHIS SUPERSEDES ANY/ALL PRIOR WATCHES IN EFFECT\r\nComment: x' });
    check('an alert is said as its title, not as the whole bulletin', a.summary === 'Geomagnetic Storm Category G2 Predicted', a.summary);
    const long = parseAlertForTest({ issue_datetime: 'x', message: 'Space Weather Message Code: X\r\nALERT: ' + 'word '.repeat(40) });
    check('...and a long one ends at a word, within fourteen', long.summary.split(' ').length <= 14 && !/\s$/.test(long.summary));
  }
}

console.log('\nThe sky over the field, measured a minute ago');
{
  const roti = await import('./dist/roti.js');
  // The real file's shape, cut down: links placed where each path crosses the ionosphere.
  const file = (vals, lat = 46.9, lon = -96.8) => ({ metadata: { temporal_coverage: { end_time: '2026-10-10T22:47:00' }, integrated_gnss_stations: { features: vals.map((r, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon + (i % 5) * 0.3, lat + (i % 3) * 0.3] }, properties: { roti: r } })) } } });
  const parsed = roti.parse(file([0.1, 0.3]));
  check('the file is read as links with a place and a value', parsed.links.length === 2 && parsed.at === '2026-10-10T22:47:00Z');
  check('nonsense is refused, not guessed', roti.parse({}) === null && roti.parse(file([])) === null);
  const set = (vals) => roti.seedForTest({ links: roti.parse(file(vals)).links });
  set(Array(40).fill(0.05));
  check('forty calm links over Fargo read as quiet', roti.over(46.88, -96.79)?.state === 'quiet');
  check('...and nothing is said about a place 2,000 km away', roti.over(33.4, -112.1) === null);
  set([...Array(20).fill(0.6), ...Array(20).fill(0.05)]);
  check('half the links disturbed reads as disturbed, with the published effect said', roti.over(46.88, -96.79)?.state === 'disturbed' && /roughly half/.test(roti.say(roti.over(46.88, -96.79))));
  set(Array(12).fill(0.9));
  check('a few disturbed links are not enough to call it disturbed', roti.over(46.88, -96.79)?.state === 'between');
  set(Array(12).fill(0.05));
  check('a few calm links are not enough to call it quiet', roti.over(46.88, -96.79)?.state === 'between');
  roti.seedForTest({ links: roti.parse(file(Array(40).fill(0.05))).links, fetchedAt: Date.now() - 20 * 60_000 });
  check('a reading twenty minutes old is not "right now"', roti.over(46.88, -96.79) === null);

  const who = await connect('acct:sky');
  await who('my_farm', { fieldName: 'Home', place: 'Fargo, North Dakota', lat: 46.88, lon: -96.79, machineName: 'planter', correction: 'rtk' });
  const calm = swpc.current();
  solarwind.seedForTest({ wind: null, kp: null });
  swpc.seedForTest({ ...calm, slots: calm.slots.map((s) => ({ ...s, kp: 2 })) });
  set([...Array(25).fill(0.7), ...Array(15).fill(0.05)]);
  const blocked = await who('can_i_run', { operation: 'planting' });
  check('a quiet forecast with a disturbed sky overhead is a no, said as measured', blocked.data.go === false && blocked.data.decidedBy === 'measured' && /The forecast alone would call it clear/.test(blocked.said), blocked.said);
  swpc.seedForTest({ ...calm, slots: calm.slots.map((s) => ({ ...s, kp: 7.7 })) });
  set(Array(40).fill(0.04));
  const cleared = await who('can_i_run', { operation: 'planting' });
  check('a storm forecast with a calm sky overhead is a yes for now, said as a measurement that can change', cleared.data.go === true && cleared.data.measuredClear === true && /check your fix status as you go/.test(cleared.said), cleared.said);
  swpc.seedForTest({ ...calm, slots: calm.slots.map((s) => ({ ...s, kp: 8.3 })) });
  const severe = await who('can_i_run', { operation: 'planting' });
  check('...but never at Kp 8 or above', severe.data.go === false && !severe.data.measuredClear, severe.said);
  const later = await who('can_i_run', { operation: 'planting', when: 'tomorrow at 3 pm' });
  check('...and never for a question about later', !later.data.measuredClear && later.data.skyOverField === undefined);
  swpc.seedForTest(calm);
  roti.resetForTest();
}

console.log('\nThe stand-in with no model behind it');
{
  const { chooseByWords } = await import('./dist/rules.js');
  const tools = ['can_i_run', 'storm_status', 'what_happened', 'watch_jobs', 'crew_contact', 'log_job', 'job_report', 'farm_status', 'plan_season', 'my_farm', 'tell_me_more', 'what_can_you_do', 'share_access'].map((name) => ({ name }));
  const pick = (s) => chooseByWords(s, tools);
  check('"can I plant this afternoon" asks about planting, then', pick('Can I plant this afternoon?').tool === 'can_i_run' && pick('Can I plant this afternoon?').args.operation === 'planting' && pick('Can I plant this afternoon?').args.when === 'this afternoon');
  check('"is it safe to fly the drone" is a drone survey', pick('Is it safe to fly the drone?').args.operation === 'drone_survey');
  check('"was it the sun yesterday at 3 pm" looks back', pick('Was it the sun yesterday at 3 pm?').tool === 'what_happened');
  check('"my field is near Yuma, Arizona and the planter runs RTK" sets up the farm', (() => { const r = pick('My field is near Yuma, Arizona and the planter runs RTK'); return r.tool === 'my_farm' && r.args.place === 'Yuma, Arizona' && r.args.correction === 'rtk' && r.args.machineName === 'planter'; })(), JSON.stringify(pick('My field is near Yuma, Arizona and the planter runs RTK').args));
  check('"what is the sun doing" is the storm status', pick('What is the sun doing?').tool === 'storm_status');
  check('nothing it knows is a decline, said as the word rules', pick('purple elephants').tool === null && pick('purple elephants').model === 'word rules');
}

await new Promise((r) => listener.close(r));
rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
