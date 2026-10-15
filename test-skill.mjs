/**
 * The Agent Skill in skills/orbita-gps-trust, checked against the format and against the server it describes.
 *
 *   The format: agentskills.io/specification. A name that matches its folder, a description inside the limit,
 *   a body short enough to load whole, and links that go one level down to files that exist.
 *
 *   The server: every tool the skill names is a real tool, every tool the server offers is in the skill, the
 *   tool reference is the server's own list, and each chain the skill describes is one the code really names.
 *
 *   The delivery: the same files are readable as MCP resources, byte for byte, and the script inside the skill
 *   connects to a running server and lists its tools.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';

// The default set of tools, which is what a host is shown and what the skill is written for.
delete process.env.ORBITA_SCOPE;
const DATA = './data/test-skill.json';
rmSync(DATA, { force: true });
process.env.ORBITA_DATA = DATA;

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const NAME = 'orbita-gps-trust';
const DIR = `./skills/${NAME}`;
const read = (p) => readFileSync(`${DIR}/${p}`, 'utf8').replace(/\r\n/g, '\n');
const skill = read('SKILL.md');
const chains = read('references/chains.md');

console.log('\nThe format');
const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? '';
const body = skill.slice(skill.indexOf('\n---\n', 4) + 5);
const field = (key) => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(front)?.[1].trim() ?? '';
check('SKILL.md opens with frontmatter', front.length > 0);
check('the name is the folder name', field('name') === NAME, field('name'));
check('...lower case letters, digits and single hyphens, 64 at most', /^[a-z0-9]+(-[a-z0-9]+)*$/.test(field('name')) && field('name').length <= 64);
const description = field('description');
check('the description is inside 1024 characters', description.length > 0 && description.length <= 1024, String(description.length));
check('...and says both what it does and when to use it', /\bUse when\b/.test(description) && /GPS/.test(description));
check('compatibility is inside 500 characters', field('compatibility').length > 0 && field('compatibility').length <= 500);
check('the licence is the repository licence', field('license') === 'Apache-2.0' && /Apache License/.test(readFileSync('./LICENSE', 'utf8')));
check('SKILL.md is under 500 lines', skill.split('\n').length < 500, String(skill.split('\n').length));
// About four characters to a token: the spec asks for instructions under 5000 tokens.
check('...and under 5000 tokens, near enough', body.length / 4 < 5000, String(Math.round(body.length / 4)));
const links = [...body.matchAll(/\]\(([^)#]+)\)/g)].map((m) => m[1]).filter((l) => !/^https?:/.test(l));
check('it links to its reference files', links.length >= 2, links.join());
check('every link is to a file that exists', links.every((l) => existsSync(`${DIR}/${l}`)), links.filter((l) => !existsSync(`${DIR}/${l}`)).join());
check('...one level down and no further', links.every((l) => l.split('/').length <= 2), links.join());
check('no em dashes or arrows in what an assistant will read', ![skill, chains, read('references/machines.md')].some((t) => /[—–→]|->/.test(t)));

console.log('\nAgainst the server');
const { registerTools } = await import('./dist/tools.js');
const { registerSkills, skillFiles } = await import('./dist/skill.js');
const server = new McpServer({ name: 'orbita', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} } });
registerTools(server, () => 'acct:skill');
registerSkills(server);
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: 'test-skill', version: '0.1.0' }, { capabilities: {} });
await client.connect(b);
const tools = (await client.listTools()).tools.map((t) => t.name);

// Anything in backticks shaped like a tool name, which is every snake_case word bar the one verdict that is.
const named = (text) => [...new Set([...text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]))].filter((n) => n !== 'do_not_trust');
check('every tool the skill names is a real one', named(skill).every((n) => tools.includes(n)), named(skill).filter((n) => !tools.includes(n)).join());
check('...and so is every tool in the chains', named(chains).every((n) => tools.includes(n)), named(chains).filter((n) => !tools.includes(n)).join());
const choosing = skill.slice(skill.indexOf('## Choosing the tool'), skill.indexOf('## Following the chain'));
check('every tool the server offers is in the table for choosing one', tools.every((t) => choosing.includes(`\`${t}\``)), tools.filter((t) => !choosing.includes(`\`${t}\``)).join());

const { toolsReference } = await import('./scripts/skill-tools.mjs');
const reference = await toolsReference();
check('the tool reference is the server\'s own list, not a copy that has drifted', reference.text === read('references/tools.md'), 'run: node scripts/skill-tools.mjs');
check('...with every tool in it', tools.every((t) => reference.text.includes(`## \`${t}\``)));

console.log('\nThe chains it describes are the ones the code names');
const { nextFor } = await import('./dist/finish.js');
const flow = await import('./dist/flow.js');
const rows = [...chains.matchAll(/^\| `([a-z_]+)` \| ([^|]+) \| `([a-z_]+)`/gm)].map((m) => ({ after: m[1], when: m[2].trim(), next: m[3] }));
check('the chain tables parse', rows.length >= 13, String(rows.length));
check('every step in them is a tool', rows.every((r) => tools.includes(r.after) && tools.includes(r.next)), JSON.stringify(rows.filter((r) => !tools.includes(r.after) || !tools.includes(r.next))));
const has = (after, next) => rows.some((r) => r.after === after && r.next === next);
const source = (p) => readFileSync(p, 'utf8');
check('a blocked job leads to watching it, named by the answer itself', has('can_i_run', 'watch_jobs') && /tool: 'watch_jobs', arguments: \{ action: 'start'/.test(source('./src/tools/decide.ts')));
const go = nextFor('can_i_run', {}, { go: true, fieldId: 'f1', equipmentId: 'e1', operation: 'planting' });
check('a clear job leads to logging it, with the field and machine', has('can_i_run', 'log_job') && go?.tool === 'log_job' && go.arguments.field === 'f1' && go.arguments.equipment === 'e1');
check('a place not saved yet leads to saving it', has('can_i_run', 'my_farm') && /tool: 'my_farm'/.test(source('./src/tools/decide.ts')));
check('a watch with nobody to tell leads to adding somebody', has('watch_jobs', 'crew_contact') && nextFor('watch_jobs', {}, { watching: true, crewToEmail: [] })?.arguments.action === 'add');
check('a watch with a crew leads to checking it', has('watch_jobs', 'watch_jobs') && nextFor('watch_jobs', {}, { watching: true, crewToEmail: ['Dale'] })?.arguments.action === 'check');
check('a cleared watch leads back to the job', has('watch_jobs', 'can_i_run') && nextFor('watch_jobs', {}, { clear: [{ operation: 'planting', field: 'f1' }] })?.tool === 'can_i_run');
check('a staged contact leads to confirming it', has('crew_contact', 'crew_contact') && nextFor('crew_contact', {}, { staged: true, name: 'Dale' })?.arguments.action === 'confirm');
check('a logged job leads to the report', has('log_job', 'job_report') && nextFor('log_job', {}, { logged: { id: 'j1' } })?.tool === 'job_report');
const cause = nextFor('what_happened', { operation: 'planting' }, { wasTheSun: true, at: '2024-05-10T18:00:00Z' });
check('a bad day with a cause leads to logging it, with the cause written in', has('what_happened', 'log_job') && cause?.tool === 'log_job' && /space weather/.test(cause.arguments.note));
check('a bad day with no cause points nowhere, as the skill says', nextFor('what_happened', { operation: 'planting' }, { wasTheSun: false, at: '2024-05-10T18:00:00Z' }) === null && /No record is invented/.test(chains));
check('a storm leads to the farm, and the farm to the job it is hurting', has('storm_status', 'farm_status') && nextFor('storm_status', {}, { scales: { g: 2 } })?.tool === 'farm_status' && has('farm_status', 'can_i_run') && nextFor('farm_status', {}, { rows: [{ go: false, limitedBy: 'space_weather', operation: 'planting' }] })?.tool === 'can_i_run');
check('a quiet sky points nowhere', nextFor('storm_status', {}, { scales: { g: 0 } }) === null);
check('held back steps lead to the rest of them', has('what_should_i_do', 'what_should_i_do') && nextFor('what_should_i_do', {}, { nextStep: 3, role: 'airline' })?.arguments.step === 3);
check('saving a field leads to the farm', has('my_farm', 'farm_status') && /nextAction: \{ tool: 'farm_status'/.test(source('./src/tools.ts')));
const again = nextFor('position_trust', { lat: 46.88, lon: -96.79, needMeters: 5 }, { verdict: 'verify' });
check('"verify" leads to the same call again', has('position_trust', 'position_trust') && again?.tool === 'position_trust' && again.arguments.lat === 46.88 && again.arguments.needMeters === 5);
check('"trust" points nowhere, and so does a reading that could not be had', nextFor('position_trust', {}, { verdict: 'trust' }) === null && nextFor('position_trust', {}, { verdict: 'verify', unavailable: true }) === null);

console.log('\nWhat the skill tells a machine is what the tool does');
const machines = read('references/machines.md');
const agents = source('./src/tools/agents.ts');
check('the three verdicts are the tool\'s own', ['trust', 'verify', 'do_not_trust'].every((v) => skill.includes(`\`${v}\``) && machines.includes(`\`${v}\``)) && /against\.length \? 'do_not_trust' : caution\.length \? 'verify' : 'trust'/.test(agents));
check('ask again in 30 minutes after trust and 10 after anything else', /30 after `trust` and 10 after anything else/.test(machines) && /recheckInMinutes: verdict === 'trust' \? 30 : 10/.test(agents));
check('the default accuracy is 5 metres and the default correction is autonomous', /5 when not given/.test(machines) && /DEFAULT_NEED_M = 5\b/.test(agents) && /correction \?\? 'autonomous'/.test(agents));
check('a spacecraft starts at 100 kilometres', /`altitudeKm` of 100 or more/.test(machines) && /altitudeKm >= 100/.test(agents));
check('the 0.3 metre line between verify and do not trust is the code\'s', /0\.3 metres/.test(machines) && /need < 0\.3 && !hardened \? against : caution/.test(agents) && /`hardened: true`/.test(machines));
check('three satellites out, and a reading older than 45 minutes, are the code\'s numbers', /Three or more GPS satellites/.test(machines) && /satellites\.length >= 3/.test(agents) && /older than 45 minutes/.test(machines) && /age > 45/.test(agents));
check('every field the skill tells a machine to read is one the tool returns', ['verdict', 'confidence', 'recheckInMinutes', 'expectedErrorM', 'needM', 'reasons', 'checks'].every((f) => machines.includes(`\`${f}\``) && new RegExp(`\\b${f}\\b`).test(agents)));

flow.resetForTest();
flow.describe('acct:skill-flow', 'can_i_run', { tool: 'watch_jobs', arguments: {} });
const example = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(chains)[1]);
const real = flow.describe('acct:skill-flow', 'watch_jobs', { tool: 'crew_contact', arguments: {} });
check('the example of `flow` in the skill is what the server really returns', JSON.stringify(example) === JSON.stringify(real), JSON.stringify(real));
flow.resetForTest();

console.log('\nRead from the server, over MCP');
const files = skillFiles();
const { resources } = await client.listResources();
const listed = resources.filter((r) => r.uri.startsWith('skill://'));
check('every file of the skill is listed as a resource', listed.length === files.length && files.length >= 5, `${listed.length} of ${files.length}`);
const main = listed.find((r) => r.uri === `skill://${NAME}/SKILL.md`);
check('SKILL.md is listed with the skill\'s own description, so a host can decide before reading it', main?.description === description && main?.mimeType === 'text/markdown', JSON.stringify(main));
const got = await client.readResource({ uri: `skill://${NAME}/SKILL.md` });
check('reading it returns the file, byte for byte', got.contents[0].text === skill);
const sha = createHash('sha256').update(skill).digest('hex');
check('...with a digest a host can check it against', main?._meta?.['io.modelcontextprotocol/skills']?.sha256 === sha);
for (const f of files.filter((x) => x.path !== 'SKILL.md')) {
  const r = await client.readResource({ uri: f.uri });
  check(`${f.path} reads back the same`, r.contents[0].text === read(f.path));
}
check('the running server registers the skill', /registerSkills\(server\)/.test(source('./src/server.ts')));
check('...and the deploy bundle and the container both carry the folder', /\bweb ui skills\b/.test(source('./deploy/bundle.sh')) && /COPY skills \.\/skills/.test(source('./Dockerfile')));
await client.close();

console.log('\nThe script inside the skill, against a running server');
const PORT = 8793;
const child = spawn(process.execPath, ['dist/server.js'], { env: { ...process.env, PORT: String(PORT), ORBITA_DATA: DATA, ORBITA_AUTH: 'off' }, stdio: 'ignore' });
const stop = () => { try { child.kill(); } catch { /* already gone */ } };
process.on('exit', stop);
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch(`http://127.0.0.1:${PORT}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 500)); }
}
check('the server came up', up);
const ran = spawnSync(process.execPath, [`${DIR}/scripts/connect.mjs`, `http://127.0.0.1:${PORT}/mcp`], { encoding: 'utf8' });
check('connect.mjs connects and exits clean', ran.status === 0, ran.stderr);
check('...on the protocol version the track asks for', /Protocol 2025-11-25/.test(ran.stdout), ran.stdout.slice(0, 200));
check('...and lists every tool', tools.every((t) => new RegExp(`^  ${t}\\b`, 'm').test(ran.stdout)), ran.stdout);
check('...marking the ones that write', /^  log_job {2}\(writes\)$/m.test(ran.stdout) && /^  can_i_run$/m.test(ran.stdout));
const none = spawnSync(process.execPath, [`${DIR}/scripts/connect.mjs`, 'http://127.0.0.1:9/mcp'], { encoding: 'utf8' });
check('with no server there it says so and exits 1', none.status === 1 && /Could not reach Orbita/.test(none.stderr), none.stderr);
stop();
rmSync(DATA, { force: true });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
