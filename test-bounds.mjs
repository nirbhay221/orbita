// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.ORBITA_SCOPE ??= 'all';
/**
 * What a stranger can make this server keep.
 *
 * flush() rewrites the whole farms file, synchronously, on every update. So the size
 * of anything an anonymous caller can grow is, through a side door, the latency of
 * every other farm's next write, and on a single threaded server slow means stopped.
 * Every farm with a field in it is also polled for ground magnetometer and ionosphere
 * data, and every crew address on a demo farm is somewhere an email could go.
 *
 * None of that was bounded. The tests that matter most are about who pays when a
 * ceiling is hit, and about the one mistake a flat limit invites here: a real
 * operation has hundreds of fields, so a single small number would silently drop a
 * genuine farm's data while protecting nobody. Hence two sizes, and a test that a
 * linked account is given real room.
 *
 * The network is stubbed throughout.
 */
import { mkdirSync, rmSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const DIR = './data/test-bounds';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.ORBITA_DATA = `${DIR}/farms.json`;
process.env.ORBITA_AUTH_DATA = `${DIR}/auth.json`;
delete process.env.ORBITA_DATA_KEY;
process.env.ORBITA_MAX_DEMO_RECORDS = '5';
process.env.ORBITA_MAX_RECORDS = '8';

const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('offline in tests'); };

const store = await import('./dist/store.js');
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { registerTools } = await import('./dist/tools.js');

const reset = () => { store.reloadForTest(); rmSync(`${DIR}/farms.json`, { force: true }); };
const demoId = (i) => `demo:${String(i).padStart(32, '0')}`;

console.log('\nThe sandbox has its own ceiling, and a newcomer is never refused');
{
  reset();
  for (let i = 0; i < 12; i += 1) store.update(demoId(i), () => {});
  const ids = store.allEntries().map(([id]) => id);
  check('twelve sandboxes made, five kept', ids.length === 5, String(ids.length));
  check('the newest is always there', ids.includes(demoId(11)));
  check('the oldest went', !ids.includes(demoId(0)));
}

console.log('\nA linked account is never evicted, and the sandbox pays when the total is full');
{
  reset();
  for (let i = 0; i < 3; i += 1) store.update(`acct:farm${i}`, () => {});
  for (let i = 0; i < 5; i += 1) store.update(demoId(i), () => {});
  check('eight records held, at the total ceiling', store.allEntries().length === 8, String(store.allEntries().length));

  store.update('acct:farm3', () => {});
  const ids = store.allEntries().map(([id]) => id);
  check('a fourth account was admitted', ids.includes('acct:farm3'));
  check('all four accounts are still there', [0, 1, 2, 3].every((i) => ids.includes(`acct:farm${i}`)));
  check('the sandbox gave up a place for it', ids.filter((id) => id.startsWith('demo:')).length === 4,
    String(ids.filter((id) => id.startsWith('demo:')).length));
}

console.log('\nA linked account is given real room, because a real farm has hundreds of fields');
{
  reset();
  store.update('acct:bigfarm', (f) => {
    for (let i = 0; i < 400; i += 1) f.fields.push({ id: `f${i}`, name: `Field ${i}`, lat: 40, lon: -98 });
  });
  const f = store.get('acct:bigfarm');
  check('four hundred fields are all kept', f.fields.length === 400, String(f.fields.length));
  check('so a genuine operation loses nothing', f.fields[0].name === 'Field 0' && f.fields.at(-1).name === 'Field 399');
  check('the account ceiling is well above the sandbox one', store.LIMITS.account.fields >= 10 * store.LIMITS.demo.fields,
    `${store.LIMITS.account.fields} vs ${store.LIMITS.demo.fields}`);
}

console.log('\nThe sandbox gets very little, and every collection is bounded');
{
  reset();
  const id = `demo:${'a'.repeat(32)}`;
  store.update(id, (f) => {
    for (let i = 0; i < 500; i += 1) {
      f.fields.push({ id: `f${i}`, name: `f${i}`, lat: 40, lon: -98 });
      f.equipment.push({ id: `e${i}`, name: `e${i}`, correction: 'rtk' });
      f.waiting.push({ id: `w${i}`, operation: 'planting', field: 'x', createdAt: new Date().toISOString(), notifiedAt: null });
      f.crew.push({ name: `c${i}`, email: `c${i}@example.com`, role: null, notifyOn: [], addedAt: new Date().toISOString(), confirmedAt: null });
    }
  });
  const f = store.get(id);
  const lim = store.LIMITS.demo;
  check('fields are bounded', f.fields.length === lim.fields, String(f.fields.length));
  check('equipment is bounded', f.equipment.length === lim.equipment, String(f.equipment.length));
  check('watches are bounded', f.waiting.length === lim.waiting, String(f.waiting.length));
  check('crew is bounded', f.crew.length === lim.crew, String(f.crew.length));
  check('the newest are kept, not the oldest', f.fields.at(-1)?.name === 'f499', f.fields.at(-1)?.name);

  store.update('acct:same', (x) => { for (let i = 0; i < 500; i += 1) x.crew.push({ name: `c${i}`, email: `c${i}@e.com`, role: null, notifyOn: [], addedAt: '', confirmedAt: null }); });
  check('the same flood on an account stops at the account ceiling', store.get('acct:same').crew.length === store.LIMITS.account.crew,
    String(store.get('acct:same').crew.length));
}

console.log('\nThe tools refuse politely before the backstop is reached');
{
  reset();
  const id = `demo:${'b'.repeat(32)}`;
  const server = new McpServer({ name: 'bounds', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} } });
  registerTools(server, () => id);
  const client = new Client({ name: 'bounds-client', version: '0.1.0' }, { capabilities: {} });
  const [x, y] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(x), client.connect(y)]);
  const say = async (name, args) => (await client.callTool({ name, arguments: args })).content?.[0]?.text ?? '';

  const lim = store.LIMITS.demo;
  for (let i = 0; i < lim.fields; i += 1) await say('register_field', { name: `Field ${i}`, lat: 40 + i * 0.01, lon: -98 });
  const refused = await say('register_field', { name: 'One Too Many', lat: 41, lon: -98 });
  check('a sandbox field past the limit is refused in plain words', refused.includes('as many fields as I can'), refused);
  check('and says what to do', refused.includes('Take one off'), refused);
  const updated = await say('register_field', { name: 'Field 3', lat: 40.5, lon: -98 });
  check('updating a field that exists is not an addition', !updated.includes('as many fields as I can'), updated);

  for (let i = 0; i < lim.equipment; i += 1) await say('register_equipment', { name: `Machine ${i}`, correction: 'rtk' });
  const tooManyMachines = await say('register_equipment', { name: 'One Too Many', correction: 'rtk' });
  check('a machine past the limit is refused', tooManyMachines.includes('as many machines as I can'), tooManyMachines);
  const changed = await say('register_equipment', { name: 'Machine 2', correction: 'sbas' });
  check('changing the correction on one already held is allowed', !changed.includes('as many machines as I can'), changed);

  for (let i = 0; i < lim.crew; i += 1) await say('crew_contact', { action: 'add', name: `Person ${i}`, email: `p${i}@example.com` });
  const eleventh = await say('crew_contact', { action: 'add', name: 'One Too Many', email: 'many@example.com' });
  check('a crew member past the limit is refused', eleventh.includes('as many people as I can'), eleventh);
  const replace = await say('crew_contact', { action: 'add', name: 'Person 1', email: 'replacement@example.com' });
  check('replacing somebody already on the list is allowed', !replace.includes('as many people as I can'), replace);

  await client.close();
  await server.close();
}

globalThis.fetch = realFetch;
rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
