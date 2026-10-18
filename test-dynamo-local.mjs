/**
 * The DynamoDB store against DynamoDB Local, so the version rule is DynamoDB's own and
 * not only the stand-in in table.ts. Needs the table from docker-compose.yml:
 *
 *   docker compose up -d dynamodb table && npm run test:dynamo
 *
 * Skipped, and says so, when nothing is listening.
 */
import { randomBytes } from 'node:crypto';

const endpoint = process.env.ORBITA_DYNAMO_ENDPOINT ?? 'http://localhost:8000';
try {
  await fetch(endpoint, { signal: AbortSignal.timeout(1500) });
} catch {
  console.log(`  skip  no DynamoDB Local at ${endpoint}; start it with: docker compose up -d dynamodb table`);
  process.exit(0);
}
Object.assign(process.env, {
  ORBITA_STORE: 'dynamodb', ORBITA_DYNAMO_ENDPOINT: endpoint, ORBITA_TABLE: 'orbita-farms',
  AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'local', AWS_SECRET_ACCESS_KEY: 'local',
  ORBITA_DATA_KEY: randomBytes(32).toString('base64'),
});

const { table } = await import('./dist/table.js');
const store = await import('./dist/store.js');

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const id = `acct:local-${randomBytes(4).toString('hex')}`;
const t = table();
check('a first write needs the item not to exist', await t.put({ id, body: 'a', v: 1 }, 0, null));
check('...and a second "first" write is refused', !(await t.put({ id, body: 'b', v: 1 }, 0, null)));
check('a write against the wrong version is refused', !(await t.put({ id, body: 'c', v: 3 }, 2, null)));
check('...against the right one it lands', await t.put({ id, body: 'd', v: 2 }, 1, 123));
check('get() reads it back with its version', (await t.get(id))?.v === 2 && (await t.get(id))?.body === 'd');
await t.remove(id);
check('remove() deletes it', (await t.get(id)) === null);

await store.init();
store.update(id, (p) => { p.fields.push({ id: "f", name: "North 40", lat: 42, lon: -93 }); });
await store.flush();
store.reloadForTest();
await store.init();
check('the store writes a farm and a fresh start reads them back from the table', store.get(id).fields[0]?.name === "North 40");
check('...sealed on the table', !/North 40/.test((await t.get(id))?.body ?? "North 40"));
store.forget(id);
await store.flush();
check('forget() leaves nothing on the table', (await t.get(id)) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
