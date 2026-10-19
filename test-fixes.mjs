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
// The aircraft reports are off unless asked for (no published licence); the tests of that feature ask for them.
process.env.ORBITA_GPSJAM = 'on';
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
  geo.configureForTest(async () => ({ name: 'Nowhere', region: null, country: null, lat: 40, lon: 10 }));
  const other = await connect('acct:new2');
  const noZone = await other('can_i_run', { operation: 'planting', place: 'Nowhere', correction: 'rtk' });
  check('a lookup with no zone still answers, in UTC', /UTC/.test(noZone.said) && noZone.data.go === true, noZone.said);
  check('picking a town keeps the zone the lookup gave', geo.pick('Phoenix, Arizona', [{ name: 'Phoenix', admin1: 'Arizona', country: 'United States', latitude: 33.45, longitude: -112.07, timezone: 'America/Phoenix' }]).timeZone === 'America/Phoenix');
}

console.log('\nA farm across two countries, and a year said alone');
{
  geo.configureForTest(async (q) => (/Ludhiana/.test(q)
    ? { name: 'Ludhiana', region: 'Punjab', country: 'India', countryCode: 'IN', lat: 30.9, lon: 75.85, timeZone: 'Asia/Kolkata' }
    : { name: 'Grand Island', region: 'Nebraska', country: 'United States', countryCode: 'US', lat: 40.92, lon: -98.34, timeZone: 'America/Chicago' }));
  const two = await connect('acct:two-countries');
  await two('my_farm', { fieldName: 'US field', place: 'Grand Island, Nebraska', machineName: 'planter', correction: 'rtk' });
  await two('my_farm', { fieldName: 'India field', place: 'Ludhiana, India' });
  const india = await two('can_i_run', { operation: 'planting', field: 'India field' });
  const us = await two('can_i_run', { operation: 'planting', field: 'US field' });
  check('a field in India is answered in centimetres, on a farm that also has one in Nebraska', /centimetres/.test(india.said) && !/inches/.test(india.said), india.said);
  check('...and the Nebraska field still in inches', /inches/.test(us.said), us.said);
  const old = await two('what_happened', { when: '1859' });
  check('a year before the record says where the record starts', /only goes back to 1932, so I cannot check 1859/.test(old.said), old.said);
  const some = await two('what_happened', { when: '2003' });
  check('a year in the record asks which day', /Which day in 2003\?/.test(some.said), some.said);
  geo.configureForTest(null);
}

console.log('\nA watch straight after a check by town alone, and a machine that names its town');
{
  const looked = [];
  geo.configureForTest(async (q) => { looked.push(q); return /Fargo/.test(q)
    ? { name: 'Fargo', region: 'North Dakota', country: 'United States', countryCode: 'US', lat: 46.88, lon: -96.79, timeZone: 'America/Chicago' }
    : { name: 'Sorriso', region: 'Mato Grosso', country: 'Brazil', countryCode: 'BR', lat: -12.55, lon: -55.71, timeZone: 'America/Cuiaba' }; });
  const v = await connect('acct:town-watch');
  const w = await v('watch_jobs', { action: 'start', operation: 'planting', place: 'Sorriso, Brazil', correction: 'rtk' });
  check('a watch given only a town saves the field first, instead of asking where the field is', !/where the field is first/.test(w.said), w.said);
  const once = await connect('acct:town-once');
  const abroad = await once('can_i_run', { operation: 'planting', place: 'Sorriso, Brazil', correction: 'rtk' });
  check('a one-off check by a town abroad carries its country, so its units are that country\'s, though no field is saved', abroad.data.countryCode === 'BR' && !/inches/.test(abroad.said), abroad.said);
  const r = await v('position_trust', { place: 'Fargo, North Dakota' });
  check('a position named by town is looked up and judged there, not at a saved field', looked.some((q) => /Fargo/.test(q)) && !/couldn't find/.test(r.said), r.said);
  geo.configureForTest(null);
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
  check('adding a machine to a known field offers the check itself, as the closing question', eq.data.nextAction?.tool === 'can_i_run' && /Want me to check whether you can run a job there today\?$/.test(eq.said), JSON.stringify(eq.data.nextAction) + ' ' + eq.said);
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
  check('following it starts the watch, and with nobody to tell that points at adding somebody', watch.data.watching === true && watch.data.nextAction?.tool === 'crew_contact' && watch.data.nextAction.arguments.action === 'add' && watch.data.flow?.done.slice(-2).join() === 'can_i_run,watch_jobs', JSON.stringify(watch.data));
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
  check('...and offers the check for that field', both.data.nextAction?.tool === 'can_i_run' && both.data.nextAction?.arguments?.field === 'North 40', JSON.stringify(both.data.nextAction));
  const half = await who('my_farm', { machineName: 'sprayer' });
  check('a machine with no correction is asked about, not guessed', store.get('acct:merged').equipment.length === 1 && /correction the sprayer runs\. Is it RTK, WAAS, or are you not sure\?$/.test(half.said), half.said);
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
  check('a field given alone still asks what the machine runs', /Is it RTK, WAAS, or are you not sure\?$/.test(alone.said), alone.said);

  // The setup questions: why first, the question last, at most three choices, and "not sure" is an answer.
  const unsure = await who('my_farm', { machineName: 'drone', notSure: true });
  const drone = store.get('acct:walk').equipment.find((e) => e.name === 'drone');
  check('"I don\'t know what it runs" is kept, judged as RTK, and said so', drone?.correction === 'rtk' && drone?.assumed === true && /judge it as RTK, the most demanding/.test(unsure.said), unsure.said);
  const told = await who('register_equipment', { name: 'drone', correction: 'sbas' });
  check('...and told later, the guess is dropped', store.get('acct:walk').equipment.find((e) => e.name === 'drone')?.assumed === undefined, told.said);
  const bare = await who('register_equipment', { name: 'rover' });
  check('a machine with no correction at all is asked, and nothing is kept', !store.get('acct:walk').equipment.some((e) => e.name === 'rover') && /the rover runs\. Is it RTK, WAAS, or are you not sure\?$/.test(bare.said), bare.said);
  const fresh = await connect('acct:first-time');
  const intro = await fresh('what_can_you_do', {});
  check('"what can you do" on a new farm ends on one question, with the reason before it', /nearer it is to the magnetic poles\. Which field should I watch, and what town is it near\?$/.test(intro.said), intro.said);
  const nothing = await fresh('my_farm', {});
  check('an empty setup asks for the first field as a question', /Which field should I watch, and what town is it near\?$/.test(nothing.said), nothing.said);

  const rules = await import('./dist/rules.js');
  // The twelve Alexa+ countries: the region's own correction in the question, and centimetres outside the US.
  const region = await import('./dist/region.js');
  check('the question names the local free correction: EGNOS, GAGAN, SouthPAN, WAAS, and PPP in Brazil', region.secondChoice('FR') === 'EGNOS' && region.secondChoice('GB') === 'EGNOS' && region.secondChoice('IN') === 'GAGAN' && region.secondChoice('AU') === 'SouthPAN' && region.secondChoice('MX') === 'WAAS' && region.secondChoice('BR') === 'PPP');
  check('drift in centimetres outside the US, inches in it', region.localiseUnits('about 0.8 inches, inside the 2.0 inches', 'DE') === 'about 2.0 centimetres, inside the 5.1 centimetres' && region.localiseUnits('about 0.8 inches', 'US') === 'about 0.8 inches');
  check('miles become kilometres, except in the UK', region.localiseUnits('about 12 miles', 'IN') === 'about 19 km' && region.localiseUnits('about 12 miles', 'GB') === 'about 12 miles');
  geo.configureForTest(async () => ({ name: 'Lyon', region: 'Auvergne-Rhône-Alpes', country: 'France', countryCode: 'FR', lat: 45.76, lon: 4.84, timeZone: 'Europe/Paris' }));
  const lyon = await connect('acct:lyon');
  const fieldFr = await lyon('my_farm', { fieldName: 'Les Grandes Terres', place: 'Lyon, France' });
  check('a field near Lyon is asked about EGNOS, not WAAS', /Is it RTK, EGNOS, or are you not sure\?$/.test(fieldFr.said), fieldFr.said);
  await lyon('my_farm', { machineName: 'semoir', correction: 'rtk' });
  const goFr = await lyon('can_i_run', { operation: 'planting' });
  check('...and its drift is said in centimetres', /centimetres/.test(goFr.said) && !/inches/.test(goFr.said), goFr.said);
  const noFr = rules.bareAnswer('EGNOS', [{ role: 'user', text: 'x' }, { role: 'assistant', text: fieldFr.said }]);
  check('...and "EGNOS" after that question is kept as SBAS', noFr?.args?.correction === 'sbas', JSON.stringify(noFr));
  geo.configureForTest(async () => ({ name: 'Fargo', region: 'North Dakota', country: 'United States', lat: 46.88, lon: -96.79, timeZone: 'America/Chicago' }));

  // The stand-in keeps the conversation, as Alexa+ does. See conversation() in standin.ts.
  const { conversation } = await import('./dist/standin.js');
  const kept2 = conversation([{ role: 'user', text: 'add my sprayer' }, { role: 'assistant', text: 'Is it RTK, WAAS, or are you not sure?' }]);
  check('the stand-in passes the question just asked, so a bare "not sure" can be read', kept2.length === 2 && kept2[1].role === 'assistant');
  const _rulesAgain = await import('./dist/rules.js');
  const q = [{ role: 'user', text: 'add the sprayer' }, { role: 'assistant', text: 'Added sprayer. How far a storm throws your guidance depends on the correction the sprayer runs. Is it RTK, WAAS, or are you not sure?' }];
  check('with no model, "not sure" after the correction question is kept for that machine', JSON.stringify(rules.bareAnswer("I'm not sure", q)) === JSON.stringify({ tool: 'my_farm', args: { machineName: 'sprayer', notSure: true } }));
  check('...and "RTK" is kept as RTK for it', rules.bareAnswer('it runs RTK', q)?.args?.correction === 'rtk');
  check('...and "yes" to "want me to check" runs the check the answer named', rules.bareAnswer('yes', [{ role: 'user', text: 'x' }, { role: 'assistant', text: 'Want me to check whether you can run a job there today?' }], { tool: 'can_i_run', arguments: { field: 'North 40' } })?.args?.field === 'North 40');
  const agentMod = await import('./dist/agent.js');
  check('a reworded reply that drops 911 is replaced by the tool\'s own words', agentMod.keepSafety('Hold off.', [{ tool: 'x', args: {}, result: { content: [{ type: 'text', text: 'Call 911 if anyone is hurt.' }] } }]) === 'Call 911 if anyone is hurt.');
  // Found with the model: the part of an answer that is about this field was dropped in the rewording.
  const border = { tool: 'can_i_run', args: {}, result: { content: [{ type: 'text', text: 'Clear for planting. One thing that is not the sun: the FAA lists the India and Pakistan border for regular GPS jamming and spoofing, so check your line.' }] } };
  check('a reworded reply that drops the line about what is not the sun gets it back', /not the sun: the FAA lists the India and Pakistan border/.test(agentMod.keepReason('Clear for planting today.', [border])));
  const own = 'Clear. The FAA lists the India and Pakistan border for regular GPS jamming and spoofing.';
  check('...but one that said it in its own words is not given it twice', agentMod.keepReason(own, [border]) === own);
  check('...and drops anything malformed, out of order, or ending on the customer', conversation([{ role: 'system', text: 'x' }, { role: 'assistant', text: 'a' }, { role: 'user', text: 'b' }]).length === 0 && conversation('nope').length === 0);

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

  // The field's own day, not the UTC day: on May 10 2024 the Kp 9 block began at midnight UTC, 7 PM in Chicago.
  // The same storm is replayed a year earlier here, so the day cached by the tests above is not reused.
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('kp.gfz.de')) return real(url, init);
    const [a, b] = [...String(url).matchAll(/(\d{4}-\d{2}-\d{2})T/g)].map((m) => m[1]);
    const days = a === b ? [a] : [a, b];
    const kp = { '2023-05-10': [2.7, 2.7, 2.3, 2, 3.7, 7.7, 8.7, 8.7], '2023-05-11': [9, 8.3, 8.3, 9, 8.7, 8.3, 7.7, 7.7] };
    return new Response(JSON.stringify({ datetime: days.flatMap((day) => Array.from({ length: 8 }, (_, i) => `${day}T${String(i * 3).padStart(2, '0')}:00:00Z`)), Kp: days.flatMap((day) => kp[day] ?? Array(8).fill(1)) }));
  };
  const evening = await who('what_happened', { when: 'May 10 2023' });
  check('a day is the field\'s own day: the evening block after midnight UTC counts', evening.data.peak?.kp === 9 && evening.data.blocksTotal === 8, `${evening.data.peak?.kp} ${evening.data.blocksTotal} ${evening.said}`);
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
  check('half the links disturbed reads as disturbed, with the published effect said', roti.over(46.88, -96.79)?.state === 'disturbed' && /halves how long RTK holds a fix/.test(roti.say(roti.over(46.88, -96.79))));
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

console.log('\nNear the magnetic equator, after dark');
{
  const d = await import('./dist/domain.js');
  const pune = { name: 'Pune', lat: 18.52, lon: 73.86 };
  const fargo = { name: 'Fargo', lat: 46.88, lon: -96.79 };
  const rtk = { name: 'drone', correction: 'rtk' };
  const at = (iso) => new Date(iso);
  // 21:30 local solar time in Pune is about 16:35 UTC.
  const evening = d.assess('drone_survey', 2, rtk, pune, at('2026-03-20T16:35:00Z'));
  check('an RTK job in Pune on a March evening is a hold, at Kp 2, and says why', !evening.go && evening.equatorial === true && /plasma bubbles/.test(evening.reason), evening.reason);
  check('...the same job that morning is clear', d.assess('drone_survey', 2, rtk, pune, at('2026-03-20T03:30:00Z')).go);
  check('...and in June, outside the equinox seasons, nothing is said', d.assess('drone_survey', 2, rtk, pune, at('2026-06-20T16:35:00Z')).go);
  check('...a spraying job that does not need centimetres is not held', d.assess('spraying', 2, { name: 's', correction: 'sbas' }, pune, at('2026-03-20T16:35:00Z')).go);
  const slots = Array.from({ length: 16 }, (_, i) => ({ time: new Date(Date.parse('2026-03-20T00:00:00Z') + i * 3 * 3_600_000).toISOString(), kp: 2, observed: false }));
  const win = d.nextWindow(slots, 'drone_survey', rtk, pune, at('2026-03-20T04:30:00Z'));
  check('a clear window in Pune ends before the evening, not the next morning', win && Date.parse(win.end) <= Date.parse('2026-03-20T15:00:00Z'), JSON.stringify(win));
  const trade = await import('./dist/trade.js');
  check('the drone line for the evening hold does not blame a storm or the compass', !/compass|storm/.test(trade.adviceNow('drone_survey', false, 2, 'space_weather', true)));
  // Over South America the season is the December solstice, not the equinoxes. Sorriso, Mato Grosso, soy
  // country: 21:30 local solar time is about 01:13 UTC.
  const sorriso = { name: 'Sorriso', lat: -12.55, lon: -55.71 };
  const nov = d.assess('planting', 2, rtk, sorriso, at('2026-11-21T01:13:00Z'));
  check('an RTK job in Mato Grosso on a November evening is a hold, with the South American season named', !nov.go && nov.equatorial === true && /October to March over South America/.test(nov.reason), nov.reason);
  check('...in June it is not, because bubbles are rare there then', d.assess('planting', 2, rtk, sorriso, at('2026-06-21T01:13:00Z')).go);
  check('...and Pune in November, past its equinox season, is not held', d.assess('drone_survey', 2, rtk, pune, at('2026-11-20T16:35:00Z')).go);
  check('...and Fargo, far from the magnetic equator, is untouched at the same hour', d.assess('drone_survey', 2, rtk, fargo, at('2026-03-21T03:30:00Z')).equatorial === undefined);
}

console.log('\nRain over the field');
{
  const ch = await import('./dist/crewheat.js');
  const t0 = Date.now();
  ch.seedForTest(18.52, 73.86, Array.from({ length: 12 }, (_, i) => ({ time: t0 + i * 3_600_000, tempF: 84, humidityPct: 80, rainMm: i === 2 ? 6 : 0 })));
  const rain = ch.rainAhead(18.52, 73.86, new Date(t0), 4);
  check('rain in the next hours over a field is found', rain?.mm === 6);
  check('...and said for spraying, with GPS left out of it', /Most sprays need one to four dry hours/.test(ch.rainSentence('spraying', rain, () => '3 PM')) && /GPS accuracy is not affected/.test(ch.rainSentence('spraying', rain, () => '3 PM')));
  check('...and for a drone', /most drones are not built to fly in it/.test(ch.rainSentence('drone_survey', rain, () => '3 PM')));
  check('a dry spell finds nothing', ch.rainAhead(18.52, 73.86, new Date(t0 + 4 * 3_600_000), 4) === null);
}

console.log('\nWhen it is not the sun: GPS tests, satellites out, and what aircraft reported');
{
  const i = await import('./dist/interference.js');
  // The Coast Guard's schedule, as its PDF comes out as text: no spaces between the columns.
  const pdf = 'USCG NAVCEN 2026 GPS TESTING\nSCHEDULE\nLAST UPDATE 9/28/26\n1\nGPS CoordinatesRange\n@\n50ft\nRange\n@\n10,000ft\nEnd DateStart DateLocationGPS#Test Name\n' +
    '33-50-01N 080-29-28W31NM119NM17 Oct28 SepColumbia, SCGPS 26-01PECRSC\n32-36-24N 114-12-05W131 NM191 NM06 Oct06 OctYuma, AZGPS 26-02MAWTS1\n19-41-55N 155-37-09W162NM244NM05 Jan20 DecKamuela, HIGPS 26-68POHAHI\n';
  const parsed = i.parseTests(pdf);
  const col = parsed.list.find((t) => t.name === 'PECRSC');
  check('the schedule is read: three tests, with the date it was last updated', parsed.list.length === 3 && parsed.updated === '9/28/26', JSON.stringify(parsed.list.map((t) => t.name)));
  check('...Columbia: position, the radius at 50 feet, and both dates', col && Math.abs(col.lat - 33.8336) < 0.001 && Math.abs(col.lon + 80.4911) < 0.001 && col.groundNm === 31 && col.start === '2026-09-28T00:00:00.000Z' && col.end === '2026-10-17T23:59:59.000Z' && col.place === 'Columbia, SC', JSON.stringify(col));
  check('...a radius written "131 NM" with a space is read too', parsed.list.find((t) => t.name === 'MAWTS1')?.groundNm === 131);
  check('...a test ending in January that began in December began the year before', parsed.list.find((t) => t.name === 'POHAHI')?.start === '2025-12-20T00:00:00.000Z');
  check('a page that is not the schedule yields nothing, not a guess', i.parseTests('Access denied').list.length === 0);

  const now = Date.parse('2026-10-12T12:00:00Z');
  const sof = '<GPSISFILE FILEID="SOF">' +
    '<HISTORICAL SVID="8" SVN="38" NAME="NANU" TYPE="UNUSABLE" REFERENCE="1998006" START_YEAR="1998" START_DOY="009" START_HR="09" START_MIN="55" START_SEC="00" END_YEAR="1998" END_DOY="009" END_HR="22" END_MIN="56" END_SEC="00" />' +
    '<HISTORICAL SVID="5" SVN="50" NAME="NANU" TYPE="UNUSABLE" REFERENCE="2026080" START_YEAR="2026" START_DOY="280" START_HR="10" START_MIN="00" START_SEC="00" END_YEAR="2026" END_DOY="280" END_HR="16" END_MIN="00" END_SEC="00" />' +
    '<PREDICTED SVID="31" SVN="52" NAME="NANU" TYPE="FCSTMX" REFERENCE="2026086" START_YEAR="2026" START_DOY="286" START_HR="15" START_MIN="00" START_SEC="00" END_YEAR="2026" END_DOY="286" END_HR="23" END_MIN="00" END_SEC="00" /></GPSISFILE>';
  const outs = i.parseSof(sof, now);
  check('the satellite outage file: the 1998 outage is dropped, last week\'s and tomorrow\'s are kept', outs.length === 2 && outs.map((o) => o.prn).join() === '5,31', JSON.stringify(outs));
  check('...day 286 of 2026 at 15:00 is 13 October, and it is marked as scheduled', outs[1].start === '2026-10-13T15:00:00.000Z' && outs[1].scheduled === true);
  check('the mirror pointer names the newest file, and nothing else is taken for a name',
    i.mirrorName('2026_288_202325_v01.sof\n') === '2026_288_202325_v01.sof' && i.mirrorName('<html>Access denied</html>') === null && i.mirrorName('../../etc/passwd.sof') === null);

  // The FAA's flight advisories, for when the Coast Guard refuses. Texts as unpdf reads the real October 2026 PDFs.
  const irwin = 'FEDERAL AVIATION ADMINISTRATION\nFLIGHT ADVISORY\nGPS INTERFERENCE TESTING\nFTIRCA GPS 26-66 REV 2\n20 OCTOBER – 1 NOVEMBER\nFORT IRWIN, CA\n' +
    'GPS testing is scheduled as follows and may result in unreliable or unavailable GPS signal.\nA. Centered at 352146N1163221W or the DAG VOR 350-degree radial at 24 NM.\n' +
    'B. Dates and times (Dates and times are based on GMT (Z).):\n20 OCT 26 1630Z - 2229Z\n21 OCT 26 1630Z - 1959Z\n23 OCT 26 1630Z - 1959Z\n24 - 31 OCT 26 DLY 0600Z - 1259Z\n24 - 31 OCT 26 DLY 1630Z - 2229Z\n01 NOV 26 0700Z - 1359Z\n01 NOV 26 1700Z - 2229Z\n' +
    'C. Duration: Each event may last the entire requested period.\nD. NOTAM INFO: NAV GPS (FTIRCA GPS 26-66 REV 2) (INCLUDING WAAS, GBAS, AND ADS-B) MAY NOT BE AVBL\nWI A:\n299NM RADIUS CENTERED AT 352146N1163221W (DAG350024) FL400-UNL\n253NM RADIUS AT FL250\n178NM RADIUS AT 10000FT\n149NM RADIUS AT 4000FT AGL\n133NM RADIUS AT 50FT AGL\n';
  const w = i.parseAdvisory(irwin);
  check('an FAA advisory: name, place, centre and the radius at 50 feet', w[0]?.name === 'FTIRCA' && w[0].id === 'GPS 26-66' && w[0].place === 'Fort Irwin, CA' && Math.abs(w[0].lat - 35.3628) < 0.001 && Math.abs(w[0].lon + 116.5392) < 0.001 && w[0].groundNm === 133, JSON.stringify(w[0]));
  check('...one window per line, and per day where it says DLY: 3 + 8 + 8 + 2', w.length === 21, String(w.length));
  check('...each in its own hours, so 20 October runs 16:30 to 22:29 UTC', w[0].start === '2026-10-20T16:30:00.000Z' && w[0].end === '2026-10-20T22:29:59.000Z');
  check('...and the last is 1 November', w.at(-1).start === '2026-11-01T17:00:00.000Z');
  const poinsett = i.parseAdvisory('PECRSC GPS 26-01\n28 SEPTEMBER – 17 OCTOBER\nPOINSETT ELECTRONIC COMBAT RANGE, SC\nA. Centered at 335001N0802928W or the CAE VOR.\nB. Dates and times (Dates and times are based on GMT (Z).):\n28 SEP - 05 OCT 26 DLY 1100Z - 1600Z\nC. Duration: x\n31NM RADIUS AT 50FT AGL');
  check('...a run of days across a month end', poinsett.length === 8 && poinsett[0].start === '2026-09-28T11:00:00.000Z' && poinsett.at(-1).start === '2026-10-05T11:00:00.000Z' && poinsett[0].place === 'Poinsett Electronic Combat Range, SC', JSON.stringify(poinsett.map((x) => x.start)));
  const night = i.parseAdvisory('XAMPLE GPS 26-02\nSOMEWHERE, TX\nA. Centered at 300000N0970000W.\nB. Dates and times (Z):\n05 NOV 26 2200Z - 0200Z\nC. Duration: x\n40NM RADIUS AT 50FT AGL');
  check('...hours past midnight end the next day', night[0]?.end === '2026-11-06T02:00:59.000Z', JSON.stringify(night));
  check('...a page that is not an advisory gives nothing', i.parseAdvisory('Access denied').length === 0);
  check('the FAA list: only GPS interference notices, by id', JSON.stringify(i.noticeIds('<a href="noticeView.aspx?nid=15274">GPS Interference Testing Glamis</a><a href="noticeView.aspx?nid=15000">Fly-in breakfast</a>')) === '["15274"]');
  check('...and an advisory whose file name is misspelled is still found', i.advisoryPath('<a href="http://www.faasafety.gov/files/notices/2026/Oct/WSMRNM_26-45_GPS_Flighy_Advisory.pdf">x</a>') === '/files/notices/2026/Oct/WSMRNM_26-45_GPS_Flighy_Advisory.pdf');
  i.seedForTest({ tests: w, satellites: [] });
  const barstow = { lat: 34.9, lon: -117.02 };
  check('a point inside the radius hears of the test during its hours', i.near(barstow.lat, barstow.lon, new Date('2026-10-20T18:00:00Z')).tests.length === 1);
  check('...and not between them, when GPS there is fine', i.near(barstow.lat, barstow.lon, new Date('2026-10-20T23:30:00Z')).tests.length === 0);

  const fargo = { lat: 46.88, lon: -96.79 };
  const columbia = { lat: 34.0, lon: -81.03 };
  const cell = i.cellOf(fargo.lat, fargo.lon);
  i.seedForTest({ tests: parsed.list, satellites: outs, jam: { '2026-10-11': { [cell]: [60, 13] }, '2026-10-10': { [cell]: [60, 3] }, '2026-10-09': { [cell]: [4, 3] } } });
  check('aircraft reports: 13 bad of 73 is red, with one taken off as the guard against a faulty transponder', JSON.stringify(i.reportedOver(fargo.lat, fargo.lon, '2026-10-11')) === JSON.stringify({ date: '2026-10-11', pct: 16, aircraft: 73, level: 'high' }), JSON.stringify(i.reportedOver(fargo.lat, fargo.lon, '2026-10-11')));
  check('...3 bad of 63 is "some"', i.reportedOver(fargo.lat, fargo.lon, '2026-10-10')?.level === 'some');
  check('...seven aircraft is too few to say anything', i.reportedOver(fargo.lat, fargo.lon, '2026-10-09') === null);
  check('...and a day that is not held is null', i.reportedOver(fargo.lat, fargo.lon, '2026-01-01') === null);

  const atCol = i.near(columbia.lat, columbia.lon, new Date('2026-10-12T15:00:00Z'));
  check('a field 33 miles from the Columbia test, inside its 36 mile reach on the ground, is told', atCol.tests.length === 1 && Math.round(atCol.tests[0].milesAway) === 33, JSON.stringify(atCol.tests));
  check('...in plain words, with how far it reaches and when it ends', /^One thing that is not the sun: a military GPS interference test near Columbia, SC is scheduled through October 17 and can reach receivers on the ground out to about 36 miles; this field is about 33 miles from its centre, so expect dropouts while it runs\.$/.test(i.sayAhead(atCol)), i.sayAhead(atCol));
  check('...and not after it has ended', i.near(columbia.lat, columbia.lon, new Date('2026-10-19T15:00:00Z')).tests.length === 0);
  check('...nor 80 miles away, outside its reach at ground level', i.near(35.0, -81.03, new Date('2026-10-12T15:00:00Z')).tests.length === 0);
  const atFargo = i.near(fargo.lat, fargo.lon, new Date('2026-10-12T15:00:00Z'));
  check('the newest day of aircraft reports is used for a question about now', atFargo.reported?.date === '2026-10-11' && /aircraft over this area reported degraded GPS on October 11, 16 percent of them/.test(i.sayAhead(atFargo)), i.sayAhead(atFargo));
  check('one satellite scheduled out is not said ahead: it does not break a fix', !/satellite/.test(i.sayAhead(i.near(fargo.lat, fargo.lon, new Date('2026-10-13T16:00:00Z')))));
  const then = i.near(fargo.lat, fargo.lon, new Date('2026-10-07T12:00:00Z'));
  check('asked what happened: the satellite that was out then is named, with what it means', /GPS satellite 5 was out of service then, which a receiver that also tracks Galileo or GLONASS would not notice\./.test(i.sayThen(then, false)), i.sayThen(then, false));
  check('a test is "the likeliest cause" when the sun was quiet, and "may have added to it" when it was not', /likeliest cause/.test(i.sayThen(atCol, false)) && /may have added to it/.test(i.sayThen(atCol, true)));
  i.seedForTest({ jam: { '2026-10-11': { [cell]: [80, 1] } } });
  const clean = i.near(fargo.lat, fargo.lon, new Date('2026-10-12T15:00:00Z'));
  check('nothing found: what was checked is said as ruled out', i.ruledOut(clean) === 'I checked the other published causes: no military GPS test was scheduled over the field, no GPS satellite was out and aircraft reported nothing unusual.', i.ruledOut(clean));
  i.seedForTest({ tests: null });
  check('a schedule that could not be read is "could not check", never "no test"', /^I checked the other published causes: no GPS satellite was out and aircraft reported nothing unusual\. I could not check the GPS testing schedule\.$/.test(i.ruledOut(i.near(fargo.lat, fargo.lon, new Date('2026-10-12T15:00:00Z')))), i.ruledOut(i.near(fargo.lat, fargo.lon, new Date('2026-10-12T15:00:00Z'))));

  // Through the tool: a job the sky allows, under a test that is running.
  const today = new Date();
  const test = { name: 'TESTSC', id: 'GPS 26-99', place: 'Columbia, SC', lat: 33.8336, lon: -80.4911, groundNm: 31, start: new Date(today.getTime() - 86_400_000).toISOString(), end: new Date(today.getTime() + 5 * 86_400_000).toISOString() };
  i.seedForTest({ tests: [test], satellites: [], jam: {} });
  const who = await connect('acct:jam');
  await who('register_field', { name: 'Congaree', lat: columbia.lat, lon: columbia.lon });
  await who('register_equipment', { name: 'planter', correction: 'rtk' });
  const run = await who('can_i_run', { operation: 'planting' });
  check('"can I plant": the sky is clear, and the GPS test over the field is said aloud', /Clear for planting/.test(run.said) && /a military GPS interference test near Columbia, SC/.test(run.said), run.said);
  i.seedForTest({ tests: [], satellites: [], jam: {} });
  const quiet = await who('can_i_run', { operation: 'planting' });
  check('...and with no test and no reports, nothing is added', !/not the sun/.test(quiet.said), quiet.said);
  i.seedForTest({ tests: null, satellites: null, jam: null });
}

console.log('\nFor a machine: can this position be trusted');
{
  const i = await import('./dist/interference.js');
  const quietSky = swpc.current();
  const withKp = (k) => swpc.seedForTest({ ...quietSky, fetchedAt: new Date().toISOString(), slots: quietSky.slots.map((s) => ({ ...s, kp: k })) });
  const agent = await connect('acct:agent');
  const fargo = { lat: 46.88, lon: -96.79 };
  i.seedForTest({ tests: [], satellites: [], jam: { [new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)]: { [i.cellOf(fargo.lat, fargo.lon)]: [90, 1] } } });
  withKp(2);
  const ok = await agent('position_trust', { ...fargo });
  check('a quiet sky, nothing published against it: trust, as a word an agent can branch on', ok.data.verdict === 'trust' && ok.data.confidence === 'high' && /^Trust it\./.test(ok.said) && ok.data.reasons.length === 0, ok.said);
  check('...with what was checked, and when to ask again', ok.data.checks.spaceWeather.kp === 2 && Array.isArray(ok.data.checks.gpsTests) && ok.data.checks.unchecked.length === 0 && ok.data.recheckInMinutes === 30, JSON.stringify(ok.data.checks));
  check('...a receiver with no correction is judged against five metres unless told', ok.data.needM === 5 && ok.data.correction === 'autonomous');

  const tight = await agent('position_trust', { ...fargo, correction: 'autonomous', needMeters: 0.5 });
  check('asked for half a metre from an uncorrected receiver: do not trust, and why', tight.data.verdict === 'do_not_trust' && /outside the 50 centimetres needed/.test(tight.said) && /Hold the action/.test(tight.said), tight.said);

  withKp(8.7);
  const storm = await agent('position_trust', { ...fargo, correction: 'rtk', needMeters: 0.03 });
  check('RTK in a severe storm: do not trust, because receivers there lose the fix', storm.data.verdict === 'do_not_trust' && /lose their fix altogether/.test(storm.said), storm.said);
  withKp(2);

  const today = new Date();
  i.seedForTest({ tests: [{ name: 'T', id: 'GPS 26-99', place: 'Fargo, ND', lat: 46.9, lon: -96.8, groundNm: 40, start: new Date(today.getTime() - 86_400_000).toISOString(), end: new Date(today.getTime() + 86_400_000).toISOString() }] });
  const jam = await agent('position_trust', { ...fargo });
  check('inside a military GPS test: verify against something independent, even though the sky is quiet', jam.data.verdict === 'verify' && /Verify before acting/.test(jam.said) && /military GPS interference test near Fargo, ND/.test(jam.said) && /inertial sensors, a camera, a known landmark/.test(jam.said) && jam.data.recheckInMinutes === 10, jam.said);

  i.seedForTest({ tests: null });
  const blind = await agent('position_trust', { ...fargo });
  check('a source that could not be read is never "trust": verify, and it says what it could not check', blind.data.verdict === 'verify' && /could not check the GPS testing schedule/.test(blind.said) && blind.data.checks.unchecked.includes('the GPS testing schedule'), blind.said);
  i.seedForTest({ tests: [] });

  const none = await (await connect('acct:agent-empty'))('position_trust', {});
  check('no position and no saved field: it asks for one, and does not guess', none.data.unavailable === true && /latitude and longitude/.test(none.said), none.said);
  await agent('register_field', { name: 'Yard', lat: 46.88, lon: -96.79 });
  const named = await agent('position_trust', { field: 'Yard', correction: 'rtk', needMeters: 0.05 });
  check('a saved field can be named in place of coordinates', named.data.position?.lat === 46.88 && named.data.verdict === 'trust', named.said);
  i.seedForTest({ tests: null, satellites: null, jam: null });
  swpc.seedForTest(quietSky);
}

console.log('\nData centres and AI infrastructure');
{
  const pb = await import('./dist/playbook.js');
  const lv = (g) => ({ g, s: 0, r: 0 });
  const sky = (g) => ({ now: new Date(), levels: lv(g), yesterday: lv(0), days: [], slots: [] });
  const quiet = pb.advise('data_centre', sky(0), 40);
  check('on a quiet day it says nothing needs doing', quiet.phase === 'quiet' && /No storm in the forecast is strong enough/.test(quiet.spoken), quiet.spoken);
  check('...and that it is not the servers a storm reaches', /Servers on the ground are not what a storm reaches/.test(quiet.note?.say ?? ''));
  const g4 = pb.advise('data_centre', sky(4), 40);
  check('during a G4 the first thing said is the grid and the fuel, from the Uptime Institute', /^.*The risk to a data centre or an AI cluster is the grid, not the servers/.test(g4.actions[0]?.say ?? '') && g4.actions[0].sources[0].name.startsWith('Uptime Institute'), g4.actions[0]?.say);
  check('...then GPS time in holdover, satellite links, and the undersea cable studies that disagree', g4.actions.some((a) => /holdover/.test(a.say)) && g4.actions.some((a) => /Starlink reported it in the May 2024 storm/.test(a.say)) && g4.actions.some((a) => /a Google study found undersea cables have voltage margin/.test(a.say) && /an earlier study put it in the cable repeaters/.test(a.say)));
  check('...isolating on backup power is only said at G5', !g4.actions.some((a) => /isolate the site/.test(a.say)) && pb.advise('data_centre', sky(5), 40).actions.some((a) => /isolate the site from the grid/.test(a.say)));
  check('every line names an https source, and none says a chip on the ground is at risk', pb.PLAYBOOKS.data_centre.actions.every((a) => a.sources.length && a.sources.every((s) => /^https:\/\//.test(s.url))) && !/bit flip|chips? (are|is) at risk/i.test(JSON.stringify(pb.PLAYBOOKS.data_centre.actions)));
  check('"a GPU cluster" and "AI infrastructure" are in the hint the host fills the role from', /GPU or AI training cluster/.test(pb.ROLE_HINT));
}

console.log('\nPeople and spacecraft in orbit');
{
  const pb = await import('./dist/playbook.js');
  const pa = await import('./dist/particles.js');
  const lv = (g, s) => ({ g, s, r: 0 });
  const sky = (g, s) => ({ now: new Date(), levels: lv(g, s), yesterday: lv(0, 0), days: [], slots: [] });

  const quiet = pb.advise('crewed_spaceflight', sky(0, 0), 40);
  check('a crew on a quiet day hears that nothing changes a spacewalk', quiet.phase === 'quiet' && /change a spacewalk or send a crew to shelter/.test(quiet.spoken), quiet.spoken);
  const s3 = pb.advise('crewed_spaceflight', sky(0, 3), 40);
  check('in an S3 radiation storm the first thing said is to bring anyone outside back in', /^Bring anyone outside back in and hold spacewalks/.test(s3.actions[0]?.say ?? ''), s3.actions[0]?.say);
  check('...and it says whose call that is, and states no flight rule of its own', /flight director's and the flight surgeon's/.test(s3.actions[0].say));
  check('...at S2 that line is not said: NOAA names spacewalks from S3', !pb.advise('crewed_spaceflight', sky(0, 2), 40).actions.some((a) => /Bring anyone outside/.test(a.say)));
  const moon = pb.advise('crewed_spaceflight', sky(0, 3), 40, 0, 'beyond');
  check('a crew beyond low orbit is told there is no magnetic field in the way, and to shelter on the first threshold', moon.actions.some((a) => /no magnetic field in the way/.test(a.say) && /Shelter on the first threshold/.test(a.say)) && !moon.actions.some((a) => /South Atlantic Anomaly/.test(a.say)), moon.actions.map((a) => a.say.slice(0, 40)).join(' | '));
  const station = pb.advise('crewed_spaceflight', sky(4, 3), 40, 0, 'low');
  check('a station crew is told when the field does not shield them, and that the station is losing altitude', station.actions.some((a) => /South Atlantic Anomaly/.test(a.say)) && station.actions.some((a) => /plan the reboost/.test(a.say)) && !station.actions.some((a) => /Shelter on the first threshold/.test(a.say)));
  check('with no orbit named, both are said, each saying which it is about', s3.actions.some((a) => /^Beyond low Earth orbit/.test(a.say)) && s3.actions.some((a) => /^In low Earth orbit/.test(a.say)));
  check('the Artemis II shelter is said as published: built from stowed equipment in about half an hour', pb.PLAYBOOKS.crewed_spaceflight.actions.some((a) => /build one inside Orion from stowed equipment in about half an hour/.test(a.say) && a.sources[0].url.startsWith('https://science.nasa.gov/')));
  check('every line for a crew names an https source', pb.PLAYBOOKS.crewed_spaceflight.actions.every((a) => a.sources.length && a.sources.every((s) => /^https:\/\//.test(s.url))));

  const low = pb.advise('satellite_operator', sky(4, 0), 40, 0, 'low');
  const high = pb.advise('satellite_operator', sky(4, 0), 40, 0, 'high');
  check('a low orbit operator hears about drag and conjunctions, not about electron charging', low.actions.some((a) => /conjunction warnings/.test(a.say)) && !low.actions.some((a) => /no drag to worry about/.test(a.say)));
  check('a geostationary operator hears about charging, and not about drag or conjunctions', high.actions.some((a) => /no drag to worry about; the problem is charging/.test(a.say) && /pass 1,000/.test(a.say)) && !high.actions.some((a) => /conjunction warnings|orbit predictions to degrade/.test(a.say)), high.actions.map((a) => a.say.slice(0, 40)).join(' | '));
  const watch = pb.PLAYBOOKS.satellite_operator.actions.find((a) => /Webb telescope/.test(a.say));
  check('the launch rule is the published Webb one, with what it cannot do', /twelve hours to ten minutes before lift-off/.test(watch.say) && /flux above 50 MeV past 5/.test(watch.say) && /cannot predict one/.test(watch.say) && watch.sources[0].url.startsWith('https://ntrs.nasa.gov/'));

  // What the GOES satellites measure, in the feed's own rows.
  const rows = (energy, flux, t = '2026-10-13T01:15:00Z') => ({ time_tag: t, satellite: 19, flux, energy });
  const calm = pa.parse([rows('>=2 MeV', 324, '2026-10-12T20:00:00Z'), rows('>=2 MeV', 152.9)], [rows('>=10 MeV', 0.235), rows('>=50 MeV', 0.227), rows('>=100 MeV', 0.222)]);
  check('the newest reading of each energy is taken, and the day\'s most for electrons', calm.electrons === 152.9 && calm.electronsDayMax === 324 && calm.protons10 === 0.235 && calm.measuredAt === '2026-10-13T01:15:00Z', JSON.stringify(calm));
  check('calm electrons are said against NOAA\'s alert line', pa.sayHighOrbit(calm) === 'Measured now at geostationary orbit, electrons above 2 MeV are at 153, under the 1,000 where NOAA alerts for charging building up inside spacecraft.', pa.sayHighOrbit(calm));
  const hot = pa.parse([rows('>=2 MeV', 4200)], [rows('>=10 MeV', 1500), rows('>=50 MeV', 40), rows('>=100 MeV', 6)]);
  check('past the line: hold commanding that can wait', /are at 4,200, past the 1,000/.test(pa.sayHighOrbit(hot)) && /Hold commanding that can wait/.test(pa.sayHighOrbit(hot)), pa.sayHighOrbit(hot));
  const after = pa.parse([rows('>=2 MeV', 2000, '2026-10-12T20:00:00Z'), rows('>=2 MeV', 600)], [rows('>=10 MeV', 0.2)]);
  check('back under it after a day above: charge built up may still discharge', /back under NOAA's alert line of 1,000 after passing it in the last day/.test(pa.sayHighOrbit(after)), pa.sayHighOrbit(after));
  check('protons at 1,500 are an S3 storm, and the ones that get inside a spacecraft are said as raised', /are at 1,500, an S3 radiation storm\./.test(pa.sayCrew(hot)) && /get inside a spacecraft, are at 6\.0, which is raised/.test(pa.sayCrew(hot)), pa.sayCrew(hot));
  check('quiet protons are said as under where a storm begins, and background inside', /under the 10 where a radiation storm begins/.test(pa.sayCrew(calm)) && /are at background/.test(pa.sayCrew(calm)), pa.sayCrew(calm));
  check('a launch is judged against the Webb rule both ways', /under the 5 that was a no go/.test(pa.sayLaunch(calm)) && /are at 40 now, past the 5 that was a no go/.test(pa.sayLaunch(hot)), pa.sayLaunch(hot));
  check('with no reading, nothing is said', pa.sayHighOrbit(null) === '' && pa.sayCrew(null) === '' && pa.sayLaunch(null) === '' && pa.parse([], []) === null);

  // Through the tool, with the scope that publishes the operator roles.
  process.env.ORBITA_SCOPE = 'all';
  const crew = await connect('acct:crew-in-orbit');
  pa.seedForTest(hot);
  const said = await crew('what_should_i_do', { role: 'crewed_spaceflight', orbit: 'beyond' });
  check('asked by a crew: the advice, then what is measured this minute', /protons above 10 MeV, the ones that get through a spacesuit, are at 1,500/.test(said.said) && said.data.orbit === 'beyond' && said.data.measuredNow?.protons10 === 1500, said.said);
  const geo = await crew('what_should_i_do', { role: 'satellite_operator', orbit: 'high' });
  check('asked by a geostationary operator: the electron reading and the launch reading', /electrons above 2 MeV are at 4,200/.test(geo.said) && /For a launch: protons above 50 MeV are at 40 now/.test(geo.said), geo.said);
  const leo = await crew('what_should_i_do', { role: 'satellite_operator', orbit: 'low' });
  check('...a low orbit operator is not read the geostationary electron number', !/geostationary orbit, electrons/.test(leo.said) && /For a launch/.test(leo.said), leo.said);
  pa.seedForTest(null);
  const blind = await crew('what_should_i_do', { role: 'crewed_spaceflight' });
  check('with no live reading the advice stands alone, and no number is invented', !/Measured now/.test(blind.said) && blind.data.measuredNow === undefined, blind.said);
  delete process.env.ORBITA_SCOPE;
  check('"astronauts", "a space station" and "the Moon" are in the hint the host fills the role from', /astronauts, a crewed spacecraft or capsule, a space station, a spacewalk, or a mission to the Moon/.test(pb.ROLE_HINT));
}

console.log('\nFor a spacecraft: can it trust where it thinks it is');
{
  const sc = await import('./dist/spacecraft.js');
  const pa = await import('./dist/particles.js');
  const pb = await import('./dist/playbook.js');
  const calm = { electrons: 150, electronsDayMax: 300, protons10: 0.2, protons50: 0.2, protons100: 0.2, measuredAt: '2026-10-13T01:15:00Z' };
  const charged = { ...calm, electrons: 4200, electronsDayMax: 4200 };
  const fargo = { lat: 46.9, lon: -96.8 };
  check('550 km is low orbit, 20,200 is medium, 35,786 is high', sc.regimeOf(550) === 'low' && sc.regimeOf(20200) === 'medium' && sc.regimeOf(35786) === 'high');

  const quiet = sc.judge({ altitudeKm: 550, ...fargo, g: 0, s: 0, particles: calm });
  check('low orbit on a quiet day: trust, naming the two things judged', quiet.verdict === 'trust' && /the predicted orbit and the onboard fix/.test(quiet.spoken), quiet.spoken);
  const g2 = sc.judge({ altitudeKm: 550, ...fargo, g: 2, s: 0, particles: calm });
  check('at G2, the level NOAA names for drag on orbit predictions: verify, with fresh orbit determination', g2.verdict === 'verify' && /the level from which NOAA says drag changes orbit predictions/.test(g2.spoken) && /Run fresh orbit determination/.test(g2.spoken), g2.spoken);
  const g4 = sc.judge({ altitudeKm: 420, ...fargo, g: 4, s: 0, particles: calm });
  check('at G4: do not trust an orbit predicted before the storm, with the published size of the error', g4.verdict === 'do_not_trust' && /errors of several kilometres within a day/.test(g4.spoken) && /about two days/.test(g4.spoken), g4.spoken);
  // 23:00 UTC over 40 degrees west is 20:20 local solar time, on the magnetic equator.
  const dusk = sc.judge({ altitudeKm: 500, lat: -3, lon: -40, g: 0, s: 0, particles: calm, now: new Date('2026-10-13T23:00:00Z') });
  check('over the magnetic equator after sunset, where Swarm lost its GPS signal: verify, on a quiet day', dusk.verdict === 'verify' && /Swarm satellites lost their GPS signal to plasma irregularities/.test(dusk.spoken), dusk.spoken);
  const noon = sc.judge({ altitudeKm: 500, lat: -3, lon: -40, g: 0, s: 0, particles: calm, now: new Date('2026-10-13T15:00:00Z') });
  check('...the same place at midday is trusted', noon.verdict === 'trust', noon.spoken);
  const polar = sc.judge({ altitudeKm: 500, lat: 78, lon: 16, g: 1, s: 0, particles: calm });
  check('at high latitude during geomagnetic activity, the other place Swarm lost it: verify', polar.verdict === 'verify' && /the other place Swarm lost its GPS signal/.test(polar.spoken), polar.spoken);
  const nowhere = sc.judge({ altitudeKm: 500, g: 0, s: 0, particles: calm });
  check('with no point below it given, low orbit is verify and says what it could not judge', nowhere.verdict === 'verify' && nowhere.unchecked.length === 1 && /could not check where the spacecraft is over the ground/.test(nowhere.spoken), nowhere.spoken);

  const meo = sc.judge({ altitudeKm: 20200, g: 4, s: 0, particles: calm });
  check('medium orbit in a G4 storm is not told about drag: there is none', meo.verdict === 'trust' && !/drag|predicted orbit/.test(meo.spoken), meo.spoken);
  const meoHot = sc.judge({ altitudeKm: 20200, g: 0, s: 0, particles: charged });
  check('...with electrons past NOAA\'s line it is verify, saying the reading is geostationary, the nearest there is', meoHot.verdict === 'verify' && /are at 4,200, measured at geostationary orbit, the nearest reading there is for medium orbit, past the 1,000/.test(meoHot.spoken), meoHot.spoken);
  const geo = sc.judge({ altitudeKm: 35786, g: 3, s: 2, particles: calm });
  check('geostationary at G3 and S2: verify, for surface charging and upsets, each at the level NOAA names', geo.verdict === 'verify' && /NOAA expects surface charging/.test(geo.spoken) && /single event upsets in memory/.test(geo.spoken) && /Hold commanding that can wait/.test(geo.spoken), geo.spoken);
  check('...surface charging is not claimed at G2', !/surface charging/.test(sc.judge({ altitudeKm: 35786, g: 2, s: 0, particles: calm }).spoken));
  const s4 = sc.judge({ altitudeKm: 35786, g: 0, s: 4, particles: calm });
  check('an S4 radiation storm: do not trust what the spacecraft reports, at any height', s4.verdict === 'do_not_trust' && /star tracker problems that can throw off a spacecraft's orientation/.test(s4.spoken) && sc.judge({ altitudeKm: 500, ...fargo, g: 0, s: 4, particles: calm }).verdict === 'do_not_trust', s4.spoken);
  const blind = sc.judge({ altitudeKm: 35786, g: 0, s: 0, particles: null });
  check('with no particle reading, high orbit is verify, never trust', blind.verdict === 'verify' && /could not check/.test(blind.spoken), blind.spoken);

  // Through the tool.
  pa.seedForTest(calm);
  const craft = await connect('acct:spacecraft');
  const leo = await craft('position_trust', { altitudeKm: 550, lat: 46.9, lon: -96.8 });
  check('position_trust with an altitude answers for a spacecraft, in the same three words', leo.data.spacecraft === true && leo.data.orbit === 'low' && ['trust', 'verify', 'do_not_trust'].includes(leo.data.verdict) && leo.data.checks.particles?.electrons === 150, leo.said);
  const high = await craft('position_trust', { altitudeKm: 35786 });
  check('...and needs no point on the ground for a geostationary satellite', high.data.orbit === 'high' && high.data.verdict === 'trust', high.said);
  const ground = await craft('position_trust', { lat: 46.9, lon: -96.8 });
  check('...without an altitude it is still the check for a receiver on the ground', ground.data.spacecraft === undefined && typeof ground.data.expectedErrorM === 'number');
  pa.seedForTest(null);

  // Medium orbit in the advice for operators.
  const lv = (g, s) => ({ g, s, r: 0 });
  const sky = (g, s) => ({ now: new Date(), levels: lv(g, s), yesterday: lv(0, 0), days: [], slots: [] });
  const adv = pb.advise('satellite_operator', sky(4, 0), 40, 0, 'medium');
  check('a navigation satellite operator hears the outer radiation belt, not drag, conjunctions or geostationary charging', adv.actions.some((a) => /where navigation satellites fly, there is no drag; the hazard is the outer radiation belt/.test(a.say) && /ten thousand times in the 2003 Halloween storm/.test(a.say)) && !adv.actions.some((a) => /conjunction warnings|In geostationary and other high orbits/.test(a.say)), adv.actions.map((a) => a.say.slice(0, 40)).join(' | '));
  check('...and is told the electron reading is from geostationary orbit, not its own', adv.actions.some((a) => /NOAA measures them at geostationary orbit and not in medium orbit/.test(a.say)));
}

console.log('\nOne request, several steps: the chain every answer is on');
{
  const flow = await import('./dist/flow.js');
  const i = await import('./dist/interference.js');
  const before = swpc.current();
  const withKp = (k) => swpc.seedForTest({ ...before, fetchedAt: new Date().toISOString(), slots: before.slots.map((s) => ({ ...s, kp: k })) });
  i.seedForTest({ tests: [], satellites: [], jam: {} });
  flow.resetForTest();

  // A job the sky allows: nothing is offered aloud, and the record of it is the step that follows.
  withKp(2);
  const farmer = await connect('acct:chain-go');
  await farmer('register_field', { name: 'North 40', lat: 40.92, lon: -98.34 });
  await farmer('register_equipment', { name: 'planter', correction: 'rtk' });
  const go = await farmer('can_i_run', { operation: 'planting' });
  check('a clear job points at logging it, with the field and machine it was about', go.data.go === true && go.data.nextAction?.tool === 'log_job' && go.data.nextAction.arguments.operation === 'planting' && go.data.nextAction.arguments.field === go.data.fieldId && go.data.nextAction.arguments.equipment === go.data.equipmentId, JSON.stringify(go.data.nextAction));
  check('...without asking "shall I log it" before the planter has moved', !/log/i.test(go.said), go.said);
  check('...and the chain says what follows: the log, then the report', go.data.flow?.next === 'log_job' && go.data.flow.then.join() === 'job_report' && go.data.flow.done.slice(-1)[0] === 'can_i_run', JSON.stringify(go.data.flow));
  const logged = await farmer('log_job', go.data.nextAction.arguments);
  check('following it logs the job, and that points at the report', logged.data.nextAction?.tool === 'job_report' && logged.data.flow?.done.slice(-2).join() === 'can_i_run,log_job', JSON.stringify(logged.data.flow));
  const report = await farmer('job_report', {});
  check('the report is the end of the chain, with the three steps behind it', report.data.nextAction == null && report.data.flow?.next === null && report.data.flow.done.slice(-3).join() === 'can_i_run,log_job,job_report', JSON.stringify(report.data.flow));

  // A job the sky blocks for the next half day, clear after: when, watch it, who to tell.
  const cutoff = Date.now() + 12 * 3_600_000;
  swpc.seedForTest({ ...before, fetchedAt: new Date().toISOString(), slots: before.slots.map((s) => ({ ...s, kp: new Date(s.time).getTime() < cutoff ? 8.7 : 2 })) });
  flow.resetForTest();
  const held = await connect('acct:chain-hold');
  await held('register_field', { name: 'North 40', lat: 40.92, lon: -98.34 });
  await held('register_equipment', { name: 'planter', correction: 'rtk' });
  const no = await held('can_i_run', { operation: 'planting' });
  check('a blocked job points at watching it, then at who to tell', no.data.go === false && no.data.nextAction?.tool === 'watch_jobs' && no.data.flow?.then.join() === 'crew_contact', JSON.stringify(no.data.flow));
  const watch = await held('watch_jobs', no.data.nextAction.arguments);
  check('the watch, with nobody to tell, asks who and points at adding them', /Want somebody on the crew emailed when it clears\? Tell me who\.$/.test(watch.said) && watch.data.nextAction?.tool === 'crew_contact', watch.said.slice(-90));
  withKp(2);
  const cleared = await held('watch_jobs', { action: 'check' });
  check('when it clears, the check points back at the job itself', cleared.data.clear?.length === 1 && cleared.data.nextAction?.tool === 'can_i_run' && cleared.data.nextAction.arguments.operation === 'planting', JSON.stringify(cleared.data.nextAction));

  // Looking back at a bad day: the cause goes into the record.
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  i.seedForTest({ tests: [{ name: 'T', id: 'GPS 26-98', place: 'Grand Island, NE', lat: 40.92, lon: -98.34, groundNm: 40, start: new Date(today.getTime() - 3 * 86_400_000).toISOString(), end: new Date(today.getTime() + 86_400_000).toISOString() }], satellites: [], jam: {} });
  const back = await held('what_happened', { when: yesterday.toISOString().slice(0, 10), operation: 'planting' });
  check('a bad day explained by a GPS test points at logging it, with the cause written in', back.data.nextAction?.tool === 'log_job' && /military GPS interference test/.test(back.data.nextAction.arguments.note) && back.data.nextAction.arguments.operation === 'planting' && typeof back.data.nextAction.arguments.when === 'string', JSON.stringify(back.data.nextAction));
  i.seedForTest({ tests: [], satellites: [], jam: {} });
  const calmDay = await held('what_happened', { when: yesterday.toISOString().slice(0, 10), operation: 'planting' });
  check('...a day with no cause found points at nothing, and invents no record', calmDay.data.nextAction == null, JSON.stringify(calmDay.data.nextAction));

  // A machine told to verify is told to ask again, with the same position.
  i.seedForTest({ tests: [{ name: 'T', id: 'GPS 26-97', place: 'Fargo, ND', lat: 46.9, lon: -96.8, groundNm: 40, start: new Date(today.getTime() - 86_400_000).toISOString(), end: new Date(today.getTime() + 86_400_000).toISOString() }], satellites: [], jam: {} });
  const robot = await connect('acct:chain-robot');
  const verify = await robot('position_trust', { lat: 46.88, lon: -96.79, needMeters: 5 });
  check('"verify" hands the agent the same call to make again', verify.data.verdict === 'verify' && verify.data.nextAction?.tool === 'position_trust' && verify.data.nextAction.arguments.lat === 46.88 && verify.data.nextAction.arguments.needMeters === 5 && verify.data.recheckInMinutes === 10, JSON.stringify(verify.data.nextAction));
  i.seedForTest({ tests: [], satellites: [], jam: { [new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10)]: { [i.cellOf(46.88, -96.79)]: [90, 1] } } });
  const trusted = await robot('position_trust', { lat: 46.88, lon: -96.79 });
  check('..."trust" points at nothing', trusted.data.verdict === 'trust' && trusted.data.nextAction == null, JSON.stringify(trusted.data.nextAction));

  i.seedForTest({ tests: null, satellites: null, jam: null });
  swpc.seedForTest(before);
  flow.resetForTest();
}

await new Promise((r) => listener.close(r));
rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
