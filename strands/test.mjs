/**
 * The Strands agent, run for nothing: no key, no language model, no network.
 *
 * The real Orbita tools are registered on an in-process MCP server with a storm seeded, and the agent is
 * connected to it through Strands' own MCP client. The model is the scripted one in agent.mjs, which follows
 * each `nextAction`, so what is checked here is everything except Claude's choice of words: the connection, the
 * skill read from the server, the wrapped tools, the chain, the yes before anything is saved or sent, and the
 * cap on steps.
 *
 * Run it from the repository root after `npm run build`:  node strands/test.mjs
 */
import { mkdirSync, rmSync } from 'node:fs';

const DIR = './data/test-strands';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.ORBITA_DATA = `${DIR}/farms.json`;
process.env.ORBITA_OUTBOX = `${DIR}/outbox.jsonl`;
delete process.env.ORBITA_DATA_KEY;
delete process.env.ORBITA_SCOPE;
delete process.env.ANTHROPIC_API_KEY;

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { ChainModel, SKILL_URI, claude, connect, run, systemPrompt, wrap } from './agent.mjs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

// No network: nothing is fetched, so the seeded sky stands.
globalThis.fetch = async () => { throw new Error('offline in this test'); };

const swpc = await import('../dist/swpc.js');
const solarwind = await import('../dist/solarwind.js');
const interference = await import('../dist/interference.js');
const geo = await import('../dist/geocode.js');
const { registerTools } = await import('../dist/tools.js');
const { registerSkills } = await import('../dist/skill.js');
const { configureForTest: fakeZones } = await import('../dist/timezone.js');
fakeZones(async () => 'America/Chicago');
geo.configureForTest(async () => ({ name: 'Grand Island', region: 'Nebraska', country: 'United States', countryCode: 'US', lat: 40.92, lon: -98.34 }));

const HOUR = 3_600_000;
/** Kp for the next twelve hours, then Kp after that, with the storm scale to match. */
function sky(kpNow, kpLater) {
  const start = Math.floor(Date.now() / (3 * HOUR)) * 3 * HOUR;
  const slots = [];
  for (let i = -8; i < 24; i += 1) slots.push({ time: new Date(start + i * 3 * HOUR).toISOString(), kp: i < 4 ? kpNow : kpLater, observed: i < 0 });
  const g = kpNow >= 9 ? 5 : kpNow >= 8 ? 4 : kpNow >= 7 ? 3 : kpNow >= 6 ? 2 : kpNow >= 5 ? 1 : 0;
  swpc.seedForTest({ fetchedAt: new Date().toISOString(), slots, alerts: [], scales: { g, s: 0, r: 0, yesterday: { g: 0, s: 0, r: 0 }, days: [] }, stale: false });
}
solarwind.seedForTest({ wind: null, kp: null });
interference.seedForTest({ tests: [], satellites: [], jam: {} });

function server(id) {
  const s = new McpServer(
    { name: 'orbita', title: 'Orbita', version: '0.1.0' },
    {
      capabilities: { tools: {}, resources: {}, tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } },
      taskStore: new InMemoryTaskStore(),
      taskMessageQueue: new InMemoryTaskMessageQueue(),
      instructions: 'This farm has already saved 1 field and 1 machine.',
    },
  );
  registerTools(s, () => id);
  registerSkills(s);
  return s;
}

/** The farm, set up through the tool a first conversation would use. */
async function farm(id, setup) {
  const client = new Client({ name: 'setup', version: '1' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server(id).connect(a), client.connect(b)]);
  for (const [name, args] of setup) await client.callTool({ name, arguments: args });
  await client.close();
}

/** Orbita as a host sees it, default tools and the skill, with the agent's end of the connection. */
async function orbitaFor(id) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server(id).connect(a);
  return connect({ transport: b });
}

sky(2, 2);
await farm('acct:strands', [['my_farm', { fieldName: 'North 40', place: 'Grand Island, Nebraska', machineName: 'planter', correction: 'rtk' }]]);
// A severe storm now that eases after twelve hours.
sky(8, 2);

console.log('\nConnected through Strands\' MCP client');
const orbita = await orbitaFor('acct:strands');
check('the tools are the server\'s default set', orbita.tools.length === 17 && orbita.tools.some((t) => t.name === 'position_trust'), String(orbita.tools.length));
check('the skill was read from the server, not from a file', /^---\nname: orbita-gps-trust\n/.test(orbita.skill) && SKILL_URI === 'skill://orbita-gps-trust/SKILL.md');
check('the server\'s instructions came with it', /already saved 1 field/.test(orbita.instructions));
const prompt = systemPrompt(orbita);
check('the system prompt is the skill, without its frontmatter', /## Choosing the tool/.test(prompt) && /## When the caller is a machine/.test(prompt) && !/^name: orbita-gps-trust$/m.test(prompt));
check('...followed by what the server knows about this farm', prompt.indexOf('already saved 1 field') > prompt.indexOf('## Following the chain'));
check('...and it tells the model how the wrapped results read', /`say`/.test(prompt) && /`nextAction`/.test(prompt) && /`refused`/.test(prompt));

console.log('\nOne request, carried down the chain');
const out = await run('What is the sun doing?', { orbita, model: new ChainModel({ from: 'storm_status' }) });
if (process.env.SHOW) console.log(JSON.stringify(out.trace, null, 1));
const ran = out.trace.filter((t) => !t.refused);
check('it began where it was told', out.trace[0]?.tool === 'storm_status', JSON.stringify(out.trace.map((t) => t.tool)));
check('the storm led to the farm, and the farm to the job it is hurting', ran.map((t) => t.tool).join() === 'storm_status,farm_status,can_i_run', JSON.stringify(out.trace.map((t) => t.tool)));
check('every step after the first is the one the answer before it named', out.trace.slice(1).every((t, i) => out.trace[i].nextAction?.tool === t.tool), JSON.stringify(out.trace.map((t) => [t.tool, t.nextAction?.tool])));
check('...with the arguments it was given, not rebuilt', out.trace.slice(1).every((t, i) => JSON.stringify(t.args) === JSON.stringify(out.trace[i].nextAction.arguments)));
check('the job asked about is the one the farm answer put worst, on the saved field', ran[2]?.args.operation === 'surveying' && ran[2].args.field === 'North 40' && /worst first: surveying on North 40/.test(ran[1].say), JSON.stringify(ran[2]?.args));
check('each wrapped result carried the chain it is on', ran.slice(1).every((t) => t.flow && t.flow.done.includes(t.tool)), JSON.stringify(ran.map((t) => t.flow)));
check('the blocked job named watching it, which saves, so it was held for a yes', out.trace.at(-1).tool === 'watch_jobs' && out.trace.at(-1).refused === 'needs_yes' && out.stopReason === 'endTurn', JSON.stringify(out.trace.at(-1)));
check('what is said to the caller is the answers, in order, then the ask', ran.every((t) => out.said.includes(t.say)) && out.said.indexOf(ran[0].say) === 0 && /has not said yes/.test(out.said), out.said.slice(-200));
check('no tokens were used', (out.usage?.totalTokens ?? 0) === 0, JSON.stringify(out.usage));

console.log('\nNothing is saved or sent without a yes');
{
  const trace = [];
  const tools = wrap(orbita, { trace });
  const refused = await tools.find((t) => t.name === 'log_job').invoke({ operation: 'planting' });
  check('log_job is refused, and says why', refused.refused === 'needs_yes' && /has not said yes/.test(refused.say), JSON.stringify(refused));
  check('...and the server was never called', trace.length === 1 && trace[0].refused === 'needs_yes' && !trace[0].flow);
  const read = await tools.find((t) => t.name === 'can_i_run').invoke({ operation: 'planting' });
  check('a tool that only reads runs without asking', !read.refused && /Kp/.test(read.say), read.say);
  const writers = orbita.tools.filter((t) => t.toolSpec.annotations?.readOnlyHint !== true).map((t) => t.name).sort();
  check('the tools held back are exactly the ones the server marks as writing', writers.join() === ['crew_contact', 'job_report', 'log_job', 'my_farm', 'share_access', 'watch_jobs'].join(), writers.join());
}

console.log('\nWith a yes, the chain goes on');
{
  const went = await run('Can I plant the North 40?', { orbita, yes: true, model: new ChainModel({ from: 'can_i_run', args: { operation: 'planting' } }) });
  const names = went.trace.map((t) => t.tool);
  check('the blocked job is watched, then somebody to tell is asked for', names.slice(0, 3).join() === 'can_i_run,watch_jobs,crew_contact', names.join());
  check('...and the watch ends on who to email', /Want somebody on the crew emailed when it clears\? Tell me who\.$/.test(went.trace[1]?.say ?? ''), went.trace[1]?.say);
}

console.log('\nA machine asking about its position');
{
  const robot = await run('Can I trust my position?', { orbita, model: new ChainModel({ from: 'position_trust', args: { lat: 46.88, lon: -96.79, needMeters: 5, correction: 'rtk' } }), steps: 2 });
  check('in a severe storm an RTK receiver is told not to trust it', /^Do not trust it\./.test(robot.trace[0]?.say ?? ''), robot.trace[0]?.say);
  check('...and the same call is named to make again', robot.trace[0]?.nextAction?.tool === 'position_trust' && robot.trace[0].nextAction.arguments.lat === 46.88);
  check('...then, told not to trust it, it asks when it clears, and the chain ends there by itself', robot.trace[1]?.tool === 'position_trust' && robot.trace.filter((t) => !t.refused).length === 2 && !robot.trace.some((t) => t.refused), JSON.stringify(robot.trace.map((t) => [t.tool, t.refused])));
  const capped = await run('Can I trust my position?', { orbita, model: new ChainModel({ from: 'position_trust', args: { lat: 46.88, lon: -96.79, needMeters: 5, correction: 'rtk' } }), steps: 1 });
  check('the cap on steps still stops it at the limit', capped.trace.filter((t) => !t.refused).length === 1 && capped.trace.at(-1).refused === 'limit', JSON.stringify(capped.trace.map((t) => [t.tool, t.refused])));
}

console.log('\nClaude is only reached when asked for');
{
  let message = '';
  try { await claude({ apiKey: '' }); } catch (err) { message = err.message; }
  check('without a key it refuses, and points at the free mode', /ANTHROPIC_API_KEY is not set/.test(message) && /--plan/.test(message), message);
  const model = await claude({ apiKey: 'not-a-real-key' });
  const config = model.getConfig();
  check('with one, it is Strands\' Anthropic provider on the cheapest current Claude', model.constructor.name === 'AnthropicModel' && config.modelId === 'claude-haiku-5-5', JSON.stringify(config));
  check('...with the reply capped, and no request made to build it', config.maxTokens === 700);
}

await orbita.mcp.disconnect();
rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
