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
  check('a visitor to the demo cannot send an invitation at all', sent.length === 0 && /has not been asked/.test(demo.said), demo.said);
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

await new Promise((r) => listener.close(r));
rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
