// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.ORBITA_SCOPE ??= 'all';
/**
 * The DynamoDB store and the scheduled alert check, against an in-memory table with
 * DynamoDB's own version rule. No network and no AWS account.
 *
 * What it has to show: a change made in one place is not lost when another place
 * wrote the same farm first; a record sealed for one farm cannot be opened as another;
 * a forgotten farm is gone from the table; a sandbox record carries its own deletion
 * date; moving from the file copies every farm once; and the scheduled check, starting
 * from nothing but the table, emails the crew once, writes down that it did before it
 * sends, and leaves the sandboxes to the server.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';

const DIR = './data/test-table';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.ORBITA_STORE = 'dynamodb';
process.env.ORBITA_DATA = `${DIR}/farms.json`;
process.env.ORBITA_AUTH_DATA = `${DIR}/auth.json`;
process.env.ORBITA_OUTBOX = `${DIR}/outbox.jsonl`;
process.env.ORBITA_DATA_KEY = randomBytes(32).toString('base64');

const table = await import('./dist/table.js');
const store = await import('./dist/store.js');
const vault = await import('./dist/vault.js');
const swpc = await import('./dist/swpc.js');
const notify = await import('./dist/notify.js');
const { registerTools } = await import('./dist/tools.js');
const { configureForTest: fakeZones } = await import('./dist/timezone.js');
const { sweep } = await import('./dist/sweep.js');
fakeZones(async () => 'America/Chicago');

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};
const opened = (rows, id) => JSON.parse(vault.open(rows.get(id).body, `orbita:farms:v1:${id}`).plain);
const sealed = (id, farm) => vault.sealIfConfigured(JSON.stringify(farm), `orbita:farms:v1:${id}`);

const mem = table.memoryTable();
table.configureForTest(mem);
await store.init();

console.log('\nOne item per farm, sealed');
{
  store.update('acct:ana', (f) => { f.fields.push({ id: 'f1', name: 'North 40', lat: 42.03, lon: -93.62 }); });
  await store.flush();
  const row = mem.rows.get('acct:ana');
  check('a write lands as one item, version 1', row?.v === 1);
  check('...sealed: the field name is not readable on the table', row && !/North 40/.test(row.body));
  check('...and an account farm carries no deletion date', row?.ttl === null);
  mem.rows.set('acct:eve', { ...row, id: 'acct:eve' });
  store.reloadForTest();
  await store.init();
  check('a sealed farm copied onto another id does not open, and is skipped', store.get('acct:eve').fields.length === 0 && store.get('acct:ana').fields[0]?.name === 'North 40');
  mem.rows.delete('acct:eve');
}

console.log('\nA conflict keeps both changes');
{
  const n = mem.rows.get('acct:ana').v;
  // Another writer (the scheduled check) lands version n+1 with a sent alert.
  const theirs = opened(mem.rows, 'acct:ana');
  theirs.alertsSent = ['storm:2026-10-17'];
  mem.rows.set('acct:ana', { id: 'acct:ana', body: sealed('acct:ana', theirs), v: n + 1, ttl: null });
  // This process, still at n, adds a field.
  store.update('acct:ana', (f) => { f.fields.push({ id: 'f2', name: 'South 80', lat: 42.0, lon: -93.6 }); });
  await store.flush();
  const merged = opened(mem.rows, 'acct:ana');
  check('a write that finds a newer version is refused, and made again on top of it', mem.rows.get('acct:ana').v === n + 2);
  check('...so their alert and our field are both there', merged.alertsSent.includes('storm:2026-10-17') && merged.fields.length === 2, JSON.stringify({ a: merged.alertsSent, f: merged.fields.length }));
  theirs.alertsSent = ['storm:2026-10-17', 'storm:2026-10-18'];
  theirs.fields = merged.fields;
  mem.rows.set('acct:ana', { id: 'acct:ana', body: sealed('acct:ana', theirs), v: n + 3, ttl: null });
  await store.refresh('acct:ana');
  check('refresh() reads a newer version written elsewhere', store.get('acct:ana').alertsSent.includes('storm:2026-10-18'));
}

console.log('\nForgetting, the sandbox, and a failed write');
{
  store.forget('acct:ana');
  await store.flush();
  check('a forgotten farm is deleted from the table, not blanked', !mem.rows.has('acct:ana'));
  const demo = 'demo:' + '0'.repeat(32);
  store.update(demo, (f) => { f.fields.push({ id: 'f', name: 'x', lat: 1, lon: 1 }); });
  await store.flush();
  const days = (mem.rows.get(demo).ttl * 1000 - Date.now()) / 86_400_000;
  check('a sandbox farm carries its own deletion date, seven days on', days > 6.9 && days <= 7.01, String(days));
  mem.rows.delete(demo);
  await store.refresh(demo);
  check('...and once DynamoDB has deleted it, refresh() forgets it too', store.get(demo).fields.length === 0);

  let down = true;
  table.configureForTest({ ...mem, async put(...a) { if (down) throw new Error('throttled'); return mem.put(...a); } });
  store.update('acct:cy', (f) => { f.crew = []; });
  let threw = false;
  try { await store.flush(); } catch { threw = true; }
  check('flush() says so when DynamoDB refused', threw && !mem.rows.has('acct:cy'));
  down = false;
  await store.flush();
  check('...and the change is written on the next try, not lost', mem.rows.has('acct:cy'));
  table.configureForTest(mem);
}

console.log('\nMoving a server from the file to the table');
{
  writeFileSync(process.env.ORBITA_DATA, JSON.stringify({ 'acct:file-one': { fields: [{ id: 'a', name: 'Home', lat: 1, lon: 1 }] } }));
  const fresh = table.memoryTable();
  table.configureForTest(fresh);
  const first = await store.copyFileToTable();
  check('every farm in the file is copied in, sealed for its own id', first.copied === 1 && opened(fresh.rows, 'acct:file-one').fields[0].name === 'Home');
  check('running it again changes nothing', (await store.copyFileToTable()).already === 1);
  check('the file is kept, so going back is possible', readFileSync(process.env.ORBITA_DATA, 'utf8').length > 0);
  table.configureForTest(mem);
}

console.log('\nThe scheduled check, from the table alone');
{
  const toolsFor = (farmId) => {
    const t = {};
    registerTools({ registerTool: (name, _cfg, handler) => { t[name] = handler; } }, () => farmId);
    return t;
  };
  const mails = [];
  const order = [];
  notify.configureForTest({ from: 'orbita@example.com', transport: async (email) => { order.push(/storm:/.test(opened(mem.rows, 'acct:red river').alertsSent.join())); mails.push(email); } });
  // Built by the server, through the tools, as a customer would.
  for (const id of ['acct:red river', 'demo:' + 'b'.repeat(32)]) {
    const t = toolsFor(id);
    await t.register_field({ name: 'North 40', lat: 42.03, lon: -93.62, baselineKm: 18 });
    await t.register_equipment({ name: 'the planter', correction: 'rtk' });
    await t.crew_contact({ action: 'add', name: 'Sam', email: id.startsWith('demo') ? 'sandbox@example.com' : 'crew@example.com', role: 'planter operator' });
    await t.crew_contact({ action: 'confirm', name: 'sam' });
  }
  await store.flush();
  store.reloadForTest();
  // A storm in the next block, then quiet.
  const t0 = Date.now() - 3600e3;
  swpc.seedForTest({ fetchedAt: new Date().toISOString(), slots: [7.3, 7.3, ...Array(22).fill(2)].map((kp, i) => ({ time: new Date(t0 + i * 3 * 3600e3).toISOString(), kp, observed: i === 0 })), alerts: [], scales: { g: 0, s: 0, r: 0, yesterday: { g: 0, s: 0, r: 0 }, days: [] }, stale: false });
  const r = await sweep(new Date(), { read: false });
  await new Promise((res) => setTimeout(res, 50));
  check('the check reads farms from the table with nothing in memory first', r.farms === 1 && r.forecastSlots === 24, JSON.stringify(r));
  check('...emails the crew of an account that a storm puts out of tolerance', r.sent.storm === 1 && mails.some((m) => m.to === 'crew@example.com' && /Storm ahead/.test(m.subject)), JSON.stringify(r.sent));
  check('...and wrote down that it had, on the table, before it sent', order.length > 0 && order.every(Boolean));
  check('...and never the sandbox, which the server keeps', !mails.some((m) => m.to === 'sandbox@example.com'));
  const again = await sweep(new Date(), { read: false });
  check('the next run sends nothing more', again.sent.storm === 0 && mails.filter((m) => /Storm ahead/.test(m.subject)).length === 1);

  // EventBridge Scheduler delivers at least once: a second run can start before the first has written.
  // This run reads the farm as it was before the storm email, then the other run marks it and sends.
  const id = 'acct:red river';
  const now = opened(mem.rows, id);
  const row = mem.rows.get(id);
  const unmarked = { ...now, alertsSent: now.alertsSent.filter((k) => !k.startsWith('storm:')) };
  mem.rows.set(id, { ...row, body: sealed(id, unmarked) });
  await store.init();
  mem.rows.set(id, { ...row, v: row.v + 1 });
  const before = mails.filter((m) => /Storm ahead/.test(m.subject)).length;
  const { checkFieldAlerts } = await import('./dist/alerts.js');
  await checkFieldAlerts(new Date(), 'accounts');
  check('a second run that read before the first one wrote sends nothing', mails.filter((m) => /Storm ahead/.test(m.subject)).length === before);
  check('...and the mark is on the table once', opened(mem.rows, id).alertsSent.filter((k) => k.startsWith('storm:')).length === 1, JSON.stringify(opened(mem.rows, id).alertsSent));
}

rmSync(DIR, { recursive: true, force: true });
{
  // DynamoDB deletes a sandbox at its ttl even while this server still has it in memory and in use.
  const id = 'demo:' + 'c'.repeat(32);
  store.update(id, (f) => { f.fields.push({ id: 'f9', name: 'East 80', lat: 41.6, lon: -93.6 }); });
  await store.flush();
  mem.rows.delete(id);
  store.update(id, (f) => { f.alertsSent = [...f.alertsSent, 'storm:test']; });
  await store.flush();
  const vault = await import('./dist/vault.js');
  const back = mem.rows.get(id) && JSON.parse(vault.open(mem.rows.get(id).body, `orbita:farms:v1:${id}`).plain);
  check('a sandbox DynamoDB expired under a later write is written back whole', back?.fields?.length === 1 && back?.alertsSent?.includes('storm:test'), JSON.stringify(back));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
