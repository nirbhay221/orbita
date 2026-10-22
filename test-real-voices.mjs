/**
 * evals/real-voices.json, checked for free: people's own words, each with where it came from.
 *
 * The model run that scores it costs money (npm run eval -- --file evals/real-voices.json). This only checks
 * the file: every case names the person and the link, says how close it is to their words, points at a tool
 * the server publishes, and is not one of our own golden sentences dressed up as somebody else's.
 */
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { validateGolden } from './evals/lib.mjs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const file = JSON.parse(readFileSync('./evals/real-voices.json', 'utf8'));
const golden = JSON.parse(readFileSync('./evals/golden.json', 'utf8'));
const { registerTools } = await import('./dist/tools.js');
const { ROLES } = await import('./dist/playbook.js');

const server = new McpServer(
  { name: 't', version: '1' },
  { capabilities: { tools: {}, resources: {}, tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } }, taskStore: new InMemoryTaskStore(), taskMessageQueue: new InMemoryTaskMessageQueue() },
);
registerTools(server, () => 'real-voices');
const client = new Client({ name: 'c', version: '1' }, { capabilities: {} });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a), client.connect(b)]);
const tools = (await client.listTools()).tools;

console.log('\nThe file');
const v = validateGolden(file, tools);
check('it matches the server, as the eval runner requires', v.problems.length === 0, v.problems.join('; '));
check('it says how it was made and what is still missing', /Not found in public/.test(file._comment ?? ''));

console.log('\nEvery case');
const PROVENANCE = new Set(['verbatim', 'joined', 'title and post', 'first person']);
const bad = (test) => file.cases.filter((c) => !test(c)).map((c) => c.say.slice(0, 50));
check('names the person or the report it came from', bad((c) => typeof c.who === 'string' && c.who.length > 3).length === 0, bad((c) => c.who).join(' | '));
check('has a link to where it was said', bad((c) => /^https:\/\/[^\s]+\.[a-z]{2,}\//.test(c.source ?? '')).length === 0, bad((c) => /^https:\/\//.test(c.source ?? '')).join(' | '));
check('says how close it is to their words', bad((c) => PROVENANCE.has(c.provenance)).length === 0, bad((c) => PROVENANCE.has(c.provenance)).join(' | '));
check('anything put into first person says what the original was', bad((c) => c.provenance !== 'first person' || (c.note ?? '').length > 20).length === 0);
check('names a role Orbita serves', bad((c) => ROLES.includes(c.role) || c.role === 'surveying').length === 0, bad((c) => ROLES.includes(c.role) || c.role === 'surveying').join(' | '));
const ours = new Set(golden.cases.map((c) => String(c.say).trim().toLowerCase()));
check('none is one of our own golden sentences', bad((c) => !ours.has(c.say.trim().toLowerCase())).length === 0);
const roles = new Set(file.cases.map((c) => c.role));
check('more than one kind of person: at least six roles', roles.size >= 6, [...roles].join(', '));

console.log('\nSomebody reporting a problem now');
{
  // The real lines made this: "We're seeing persistent geomagnetically induced current at multiple stations" was
  // answered as if nothing had been said. NOAA is seeded, the network is off.
  const swpc = await import('./dist/swpc.js');
  globalThis.fetch = async () => { throw new Error('network is off for this test'); };
  const t0 = Date.now() - 3600e3;
  const seed = (kp) => swpc.seedForTest({
    fetchedAt: new Date().toISOString(),
    slots: Array.from({ length: 24 }, (_, i) => ({ time: new Date(t0 + i * 3 * 3600e3).toISOString(), kp: i === 0 ? kp : 2, observed: i === 0 })),
    alerts: [], scales: { g: kp >= 5 ? 1 : 0, s: 0, r: 0, yesterday: { g: 0, s: 0, r: 0 }, days: [] }, stale: false,
  });
  const ask = async (args) => ((await client.callTool({ name: 'what_should_i_do', arguments: args })).content ?? []).map((c) => c.text ?? '').join(' ');
  seed(2);
  const grid = await ask({ role: 'grid_operator', seeing: 'persistent geomagnetically induced current at multiple stations' });
  check('quiet sky: it says first that what they see is not a storm', /^Kp is only 2\.0 right now, which is quiet, so what you are seeing is not a geomagnetic storm/.test(grid), grid);
  check('...and for a grid, what to check is the grid, not an antenna', /a fault or switching on the system/.test(grid) && !/antenna/.test(grid), grid);
  const plain = await ask({ role: 'grid_operator' });
  check('nothing reported: the answer is as before', !/what you are seeing/.test(plain), plain);
  seed(7);
  const storm = await ask({ role: 'grid_operator', seeing: 'GIC at multiple stations' });
  check('a storm running: it says the storm fits', /^That fits: Kp is 7\.0 right now/.test(storm), storm);
}

await client.close();
await server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
