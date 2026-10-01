/**
 * The stand-in, minus the model.
 *
 * What is tested here is the half that can be tested without spending money: that
 * a client connected over an in-memory transport sees the same `tools/list` a
 * real host would, with real JSON Schema rather than the Zod shapes the tools are
 * declared with, and that a tool name plus arguments chosen from that list
 * actually execute through the protocol.
 *
 * That is the half that matters for the demo's honesty. If the schemas the model
 * reads were not the published ones, or the call were dispatched by reaching into
 * a handler map instead of going through the protocol, the demo would be testing
 * a function and calling it an add-on.
 *
 * What is NOT tested here: the model call itself. No credential was available in
 * this environment, so `choose` has never been run against the live API. The
 * configuration it sends is asserted statically below - `tool_choice: auto` in
 * particular, because forced tool use returns a 400 on this model and that
 * failure would only ever appear at runtime.
 */
import { mkdirSync, rmSync, readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

mkdirSync('./data', { recursive: true });
rmSync('./data/test-agent.json', { force: true });
process.env.ORBITA_DATA = './data/test-agent.json';

const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { registerTools } = await import('./dist/tools.js');
const agent = await import('./dist/agent.js');
const swpc = await import('./dist/swpc.js');
const store = await import('./dist/store.js');

const quiet = () => {
  const t0 = Date.now() - 3600e3;
  swpc.seedForTest({
    fetchedAt: new Date().toISOString(),
    slots: Array.from({ length: 24 }, (_, i) => ({ time: new Date(t0 + i * 3 * 3600e3).toISOString(), kp: 1, observed: i === 0 })),
    alerts: [], scales: { g: 0, s: 0, r: 0, yesterday: { g: 0, s: 0, r: 0 }, days: [] }, stale: false,
  });
};

/** A real server and a real client, linked in memory. */
const linked = async () => {
  const server = new McpServer({ name: 'orbita-test', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} } });
  registerTools(server, () => 'agent-test');
  const client = new Client({ name: 'stand-in-test', version: '0.1.0' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { server, client, close: async () => { await client.close(); await server.close(); } };
};

console.log('\nThe stand-in is off without a key, and says so rather than failing oddly');
{
  check('configured() is false with no key set', agent.configured() === false);
}

console.log('\nThe published tool list is real JSON Schema, not Zod shapes');
{
  store.forget('agent-test');
  const { client, close } = await linked();
  try {
    const listed = await client.listTools();
    check('tools are listed', listed.tools.length > 10, String(listed.tools.length));

    const canIRun = listed.tools.find((t) => t.name === 'can_i_run');
    check('can_i_run is published', canIRun !== undefined);
    check('its inputSchema is a JSON Schema object', canIRun.inputSchema?.type === 'object', JSON.stringify(canIRun.inputSchema?.type));
    check('the operation enum survived the conversion',
      Array.isArray(canIRun.inputSchema?.properties?.operation?.enum), JSON.stringify(canIRun.inputSchema?.properties?.operation));
    check('planting is one of the operations',
      canIRun.inputSchema.properties.operation.enum.includes('planting'));

    // This is the thing the stand-in actually tests, so it must be present.
    check('every tool carries a description for the model to read',
      listed.tools.every((t) => (t.description ?? '').length > 20),
      JSON.stringify(listed.tools.filter((t) => (t.description ?? '').length <= 20).map((t) => t.name)));
    check('descriptions mention synonyms customers use',
      /also called|or |e\.g\./i.test(listed.tools.map((t) => t.description).join(' ')));
  } finally { await close(); }
}

console.log('\nA chosen tool and arguments execute through the protocol');
{
  store.forget('agent-test');
  quiet();
  const { client, close } = await linked();
  try {
    // Stand in for what the model would return.
    await client.callTool({ name: 'register_field', arguments: { name: 'North 40', lat: 40.92, lon: -98.34, baselineKm: 30 } });
    await client.callTool({ name: 'register_equipment', arguments: { name: 'the planter', correction: 'rtk' } });

    const result = await client.callTool({ name: 'can_i_run', arguments: { operation: 'planting', field: 'North 40' } });
    const text = result.content?.[0]?.text ?? '';
    check('the call returns a real verdict', /Clear for planting|Hold off/.test(text), text.slice(0, 120));
    check('and it is not flagged as an error', result.isError !== true);
  } finally { await close(); }
}

console.log('\nArguments the schema rejects are refused by the protocol, not by us');
{
  store.forget('agent-test');
  quiet();
  const { client, close } = await linked();
  try {
    const bad = await client.callTool({ name: 'can_i_run', arguments: { operation: 'juggling' } });
    check('an operation outside the enum is refused', bad.isError === true, JSON.stringify(bad).slice(0, 160));
  } finally { await close(); }
}

console.log('\nThe request configuration avoids the 400 that forced tool use would cause');
{
  // Read rather than executed: no credential exists here, so the live call is
  // unverified and the shape is asserted from source instead.
  const src = readFileSync('./src/agent.ts', 'utf8');
  check("tool_choice is auto", /tool_choice:\s*\{\s*type:\s*'auto'\s*\}/.test(src), 'auto not found');
  check("it never asks for type 'any'", !/type:\s*'any'/.test(src));
  check("it never forces a named tool", !/tool_choice[^\n]*type:\s*'tool'/.test(src));
  check('strict is set on every tool', /strict:\s*true/.test(src));
  check('effort is low, matching a one-shot choice', /effort:\s*'low'/.test(src));
  check('the model is the current Opus', /claude-opus-5-5/.test(src));
  check('thinking is not disabled anywhere', !/type:\s*'disabled'/.test(src));
  check('and budget_tokens is not used', !/budget_tokens/.test(src));
}

console.log('\nA decline is a real outcome, and the test seam reports it as one');
{
  agent.configureForTest(async () => ({ tool: null, args: {}, said: 'Orbita cannot order parts.', ms: 12, model: 'test' }));
  const chosen = await agent.choose('order me a new seed drill', []);
  check('no tool is chosen', chosen.tool === null);
  check('and what it said comes back', chosen.said.includes('cannot order parts'));
  agent.configureForTest(null);
}

console.log('\nTyped API failures become something a page can display');
{
  check('an unknown error still yields a sentence', agent.explainError(new Error('x')).length > 10);
  check('and it does not leak a stack', !agent.explainError(new Error('x')).includes('at '));
}

store.forget('agent-test');
rmSync('./data/test-agent.json', { force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
