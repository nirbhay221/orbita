/**
 * Warning first, for everybody, not only farms: tested.
 *
 * A grid control room, a robot fleet, anyone who said what they look after, is emailed the day before a storm that
 * matters to them, and again when the solar wind turns south about an hour out. Machines anywhere are in the machine
 * feed. And a fleet's own software can be pushed the feed, signed, at an address that has to be on the public
 * internet. The network is off; NOAA and the solar wind are seeded.
 */
import { mkdirSync, rmSync } from 'node:fs';

const DIR = './data/test-warn-first';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.ORBITA_DATA = `${DIR}/farms.json`;
process.env.ORBITA_OUTBOX = `${DIR}/outbox.jsonl`;
process.env.ORBITA_AUTH_DATA = `${DIR}/auth.json`;
process.env.ORBITA_PUBLIC_URL = 'https://orbita.example.org';
delete process.env.ORBITA_DATA_KEY;
delete process.env.ORBITA_SCOPE;
delete process.env.ORBITA_RECIPIENT_CONSENT;

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';

const store = await import('./dist/store.js');
const swpc = await import('./dist/swpc.js');
const solarwind = await import('./dist/solarwind.js');
const alerts = await import('./dist/alerts.js');
const machineAlerts = await import('./dist/machinealerts.js');
const webhooks = await import('./dist/webhooks.js');
const { registerTools } = await import('./dist/tools.js');
const notify = await import('./dist/notify.js');
const mail = [];
notify.configureForTest({ from: 'alerts@orbita.example.org', transport: async (email) => void mail.push(email) });
globalThis.fetch = async () => { throw new Error('network is off for this test'); };

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const HOUR = 3_600_000;
const t0 = Math.floor(Date.now() / (3 * HOUR)) * 3 * HOUR;
function seedKp(kps) {
  swpc.seedForTest({
    fetchedAt: new Date().toISOString(),
    slots: kps.map((kp, i) => ({ time: new Date(t0 + i * 3 * HOUR).toISOString(), kp, observed: i === 0 })),
    alerts: [],
    scales: { g: 0, s: 0, r: 0, yesterday: { g: 0, s: 0, r: 0 }, days: [] },
    stale: false,
  });
}
const quiet = Array(24).fill(2);
// G5 within the day: enough to put even a plain five metre receiver out, as on 10 May 2024.
const stormTomorrow = [2, 2, 2, 9, 9, 8, 3, 2, ...Array(16).fill(2)];
const wind = (bzNt) => solarwind.seedForTest({ wind: { speedKms: 600, bzNt, btNt: 15, at: new Date().toISOString() }, kp: null });
const contact = (name) => ({ name, email: `${name.toLowerCase()}@example.com`, role: null, notifyOn: ['storm'], addedAt: new Date().toISOString(), confirmedAt: new Date().toISOString(), acceptedAt: new Date().toISOString() });
const outbox = () => mail;

store.update('acct:grid', (f) => {
  f.role = 'grid_operator';
  f.rolePlace = { name: 'Columbus, Ohio', lat: 39.96, lon: -83.0 };
  f.crew = [contact('Ana')];
});

console.log('\nThe day before, for a role that is not a farm');
{
  seedKp(quiet);
  wind(2);
  const before = outbox().length;
  await alerts.checkRoleAlerts(new Date(), 'accounts');
  check('a quiet sky sends nothing', outbox().length === before);
  seedKp(stormTomorrow);
  await alerts.checkRoleAlerts(new Date(), 'accounts');
  const sent = outbox().slice(before);
  check('a storm within the day: the grid contact is emailed', sent.length === 1 && /Space weather ahead for .*near Columbus, Ohio/.test(sent[0]?.subject ?? ''), JSON.stringify(sent.map((m) => m.subject)));
  check('...with what to do, from the grid playbook', /What to do:/.test(sent[0]?.text ?? ''), sent[0]?.text);
  await alerts.checkRoleAlerts(new Date(), 'accounts');
  check('...and only once for that storm day', outbox().length === before + 1);
}

console.log('\nThe last hour');
{
  seedKp(quiet);
  wind(-14);
  const before = outbox().length;
  await alerts.checkRoleAlerts(new Date(), 'accounts');
  const sent = outbox().slice(before);
  check('the solar wind turned hard south: an arriving warning goes out', sent.length === 1 && /Arriving in about \d+ minutes/.test(sent[0]?.subject ?? ''), JSON.stringify(sent.map((m) => m.subject)));
  check('...and it says it can still turn back', /turn back north/.test(sent[0]?.text ?? ''));
  await alerts.checkRoleAlerts(new Date(), 'accounts');
  check('...once in six hours, not every fifteen minutes', outbox().length === before + 1);
  wind(2);
}

console.log('\nA farm is not told twice');
{
  store.update('acct:farm', (f) => {
    f.role = 'field_crew';
    f.fields = [{ id: 'f1', name: 'North 40', lat: 40.92, lon: -98.34 }];
    f.equipment = [{ id: 'e1', name: 'planter', correction: 'rtk' }];
    f.crew = [contact('Dale')];
  });
  seedKp(stormTomorrow);
  const before = outbox().filter((m) => m.to === 'dale@example.com').length;
  await alerts.checkRoleAlerts(new Date(), 'accounts');
  check('a farm with fields gets no second, role-shaped storm email', outbox().filter((m) => m.to === 'dale@example.com').length === before);
}

console.log('\nMachines anywhere, in the machine feed');
{
  store.update('acct:robots', (f) => {
    // Robots on RTK that work to a few centimetres, as robot mowers and field robots do. Said with the push address.
    f.machineHook = { url: 'https://fleet.example.invalid/hook', secret: 'whsec_' + Buffer.from('k').toString('base64'), addedAt: new Date().toISOString(), needM: 0.05, correction: 'rtk', lastEtag: null, lastResult: null, failures: 0 };
    f.role = 'robots';
    f.rolePlace = { name: 'Fargo, North Dakota', lat: 46.88, lon: -96.79 };
  });
  seedKp(stormTomorrow);
  const feed = machineAlerts.forFarm(store.get('acct:robots'));
  const fargo = feed.alerts.find((a) => a.site === 'Fargo, North Dakota');
  check('a robot fleet with no farm is in the feed', Boolean(fargo), JSON.stringify(feed.alerts));
  check('...and a storm within the day is imminent for it', fargo?.phase === 'imminent', JSON.stringify(fargo));
  wind(-14);
  const hot = machineAlerts.forFarm(store.get('acct:robots'));
  check('the solar wind turning south is in the feed, with minutes', hot.arriving && hot.arriving.minutes > 0, JSON.stringify(hot.arriving));
  check('...the etag changes with it, so a poller re-plans', hot.etag !== feed.etag);
  check('...and it says to read again in five minutes', Date.parse(hot.checkAgainAt) - Date.now() <= 5 * 60_000 + 1000, hot.checkAgainAt);
  wind(2);
}

console.log('\nWhere a push may go');
{
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::ffff:10.0.0.1', 'fd00::1', 'fe80::1']) {
    check(`${ip} is not public`, webhooks.publicAddress(ip) === false);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) check(`${ip} is public`, webhooks.publicAddress(ip) === true);
  const fake = (addrs) => async () => addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  check('http is refused', !(await webhooks.checkUrl('http://fleet.example.com/hook', fake(['8.8.8.8']))).ok);
  check('another port is refused', !(await webhooks.checkUrl('https://fleet.example.com:8443/hook', fake(['8.8.8.8']))).ok);
  check('a user name in the address is refused', !(await webhooks.checkUrl('https://a:b@fleet.example.com/hook', fake(['8.8.8.8']))).ok);
  check('localhost is refused', !(await webhooks.checkUrl('https://localhost/hook', fake(['8.8.8.8']))).ok);
  check('a public name that resolves to a private address is refused', !(await webhooks.checkUrl('https://fleet.example.com/hook', fake(['10.0.0.5']))).ok);
  check('...or to a public and a private one', !(await webhooks.checkUrl('https://fleet.example.com/hook', fake(['8.8.8.8', '169.254.169.254']))).ok);
  const good = await webhooks.checkUrl('https://fleet.example.com/hook?x=1', fake(['8.8.8.8']));
  check('a public https address is accepted, pinned to the address checked', good.ok && good.address === '8.8.8.8');
  const refused = await webhooks.push('https://127.0.0.1/hook', 'whsec_' + Buffer.from('k').toString('base64'), { a: 1 });
  check('push never sends to a private address', refused.ok === false && /public internet/.test(refused.why ?? ''), JSON.stringify(refused));
  // The example in the Standard Webhooks specification's own tests.
  const sig = webhooks.sign('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}');
  check('signed the way Standard Webhooks specifies', sig === 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=', sig);
}

console.log('\nPushing when it changes');
{
  seedKp(quiet);
  store.update('acct:robots', (f) => void Object.assign(f.machineHook, { lastEtag: null, lastResult: null, failures: 0 }));
  await alerts.pushMachineAlerts(new Date());
  const first = store.get('acct:robots').machineHook;
  check('a first look that is all clear sends nothing, and remembers it', first.lastEtag && !first.lastResult, JSON.stringify(first));
  seedKp(stormTomorrow);
  await alerts.pushMachineAlerts(new Date());
  const after = store.get('acct:robots').machineHook;
  check('a storm coming: a push is tried, and an address that cannot be reached is said so', /^failed /.test(after.lastResult ?? '') && after.failures === 1, JSON.stringify(after));
  check('...and the change is tried again next time, not dropped', after.lastEtag === first.lastEtag);
  store.update('demo:abc', (f) => void (f.machineHook = { url: 'https://fleet.example.invalid/hook', secret: webhooks.newSecret(), addedAt: new Date().toISOString(), lastEtag: null, lastResult: null, failures: 0 }));
  store.update('demo:abc', (f) => void (f.rolePlace = { name: 'Fargo, North Dakota', lat: 46.88, lon: -96.79 }));
  await alerts.pushMachineAlerts(new Date());
  check('the demo page never pushes anywhere', !store.get('demo:abc').machineHook.lastResult);
}

console.log('\nThe tool');
{
  const server = new McpServer({ name: 't', version: '1' }, { capabilities: { tools: {}, resources: {}, tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } }, taskStore: new InMemoryTaskStore(), taskMessageQueue: new InMemoryTaskMessageQueue() });
  registerTools(server, () => 'demo:tool');
  const client = new Client({ name: 'c', version: '1' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (args) => {
    const r = await client.callTool({ name: 'alert_my_machines', arguments: args });
    return { said: (r.content ?? []).map((c) => c.text ?? '').join(' '), data: r.structuredContent ?? {} };
  };
  const listed = (await client.listTools()).tools.map((t) => t.name);
  check('alert_my_machines is listed', listed.includes('alert_my_machines'));
  const http = await call({ action: 'set', url: 'http://fleet.example.com/hook' });
  check('an http address is refused, with why', /can't use that address. The address has to start with https/.test(http.said), http.said);
  const status = await call({ action: 'status' });
  check('nothing set: status says how to set it', /No address is set/.test(status.said), status.said);
  const set = await call({ action: 'set', url: 'https://8.8.8.8/hook' });
  check('on the demo page: saved, nothing sent, and the message it would get is shown', /nothing is sent to other addresses; the message it would have sent comes back with this answer/.test(set.said) && set.data.wouldSend?.type === 'orbita.alerts.test', set.said);
  check('...with the secret to check signatures, given once and not spoken', /^whsec_/.test(set.data.signingSecret ?? '') && !set.said.includes('whsec_'));
  const removed = await call({ action: 'remove' });
  check('remove stops it', /Nothing more will be pushed/.test(removed.said) && !store.get('demo:tool').machineHook, removed.said);
  await client.close();
  await server.close();
}

console.log('\nThe offer');
{
  const server = new McpServer({ name: 't', version: '1' }, { capabilities: { tools: {}, resources: {}, tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } }, taskStore: new InMemoryTaskStore(), taskMessageQueue: new InMemoryTaskMessageQueue() });
  registerTools(server, () => 'acct:offer');
  const client = new Client({ name: 'c', version: '1' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  seedKp(quiet);
  const r = await client.callTool({ name: 'what_should_i_do', arguments: { role: 'robots' } });
  const said = (r.content ?? []).map((c) => c.text ?? '').join(' ');
  check('a role answer offers the warning to somebody nobody warns yet', /Want a warning before the next storm, a day ahead and again in the last hour\? Tell me who to email\.$/.test(said), said);
  store.update('acct:offer', (f) => void (f.crew = [contact('Kim')]));
  const r2 = await client.callTool({ name: 'what_should_i_do', arguments: { role: 'robots' } });
  check('...and does not offer again once somebody is', !/Want a warning/.test((r2.content ?? []).map((c) => c.text ?? '').join(' ')));
  await client.close();
  await server.close();
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
