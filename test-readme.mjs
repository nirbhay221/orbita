/**
 * What the README says, checked against what the code does.
 *
 * A judge reads the README before anything else, and a number in it that the code no longer backs is worse than no
 * number. Every count and claim below is read from the README and compared with the thing it describes: the tools a
 * host is shown, the roles the playbook covers, the model the demo uses, the check counts, the conversation results
 * on record, and every file and setting the README names. Phrases that were true once and are not now are listed and
 * must not come back.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';

delete process.env.ORBITA_SCOPE;
process.env.ORBITA_DATA = './data/test-readme/farms.json';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const readme = readFileSync('./README.md', 'utf8');
const WORDS = { fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, 'twenty-two': 22, 'twenty-three': 23 };
const number = (w) => (/^\d/.test(w) ? Number(w.replace(/,/g, '')) : WORDS[w.toLowerCase()]);

const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { InMemoryTaskStore, InMemoryTaskMessageQueue } = await import('@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js');
const { registerTools } = await import('./dist/tools.js');
const caps = () => ({ capabilities: { tools: {}, resources: {}, tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } }, taskStore: new InMemoryTaskStore(), taskMessageQueue: new InMemoryTaskMessageQueue() });
async function toolsIn(scope) {
  if (scope) process.env.ORBITA_SCOPE = scope;
  const server = new McpServer({ name: 'orbita', version: '0.1.0' }, caps());
  registerTools(server, () => `readme-${scope ?? 'default'}`);
  delete process.env.ORBITA_SCOPE;
  const client = new Client({ name: 'readme', version: '0.1.0' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const names = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
  return names;
}
const tools = await toolsIn(null);
const every = new Set([...(await toolsIn('all')), ...tools]);

console.log('\nCounts');
const toolClaims = [...readme.matchAll(/(\d+) tools by default/g)].map((m) => Number(m[1]));
check('"N tools by default" is the number a host is shown', toolClaims.length > 0 && toolClaims.every((n) => n === tools.length), `${toolClaims} vs ${tools.length}`);
const { ROLES } = await import('./dist/playbook.js');
const roles = [...readme.matchAll(/\b([a-z]+teen|twenty(?:-[a-z]+)?|\d+) (?:roles|kinds of operator)/g)].map((m) => number(m[1])).filter(Boolean);
check('the number of roles is the number the playbook has', roles.length > 0 && roles.every((n) => n === ROLES.length), `${roles} vs ${ROLES.length}`);

console.log('\nCheck counts');
const total = [...readme.matchAll(/([\d,]+) (?:automated )?checks/g)].map((m) => number(m[1]));
const unit = number(/npm run test:unit\s+# ([\d,]+) checks/.exec(readme)?.[1] ?? '0');
const live = number(/npm run test:live\s+# ([\d,]+) checks/.exec(readme)?.[1] ?? '0');
const npmTest = number(/`npm test` runs (?:everything, )?([\d,]+) checks/.exec(readme)?.[1] ?? '0');
check('npm test is the unit checks plus the live ones', npmTest === unit + live && unit > 0 && live > 0, `${npmTest} vs ${unit} + ${live}`);
check('every check count stated is the total, the unit count or the live count', total.filter((n) => n > 1000).every((n) => n === npmTest || n === unit), JSON.stringify(total));

console.log('\nThe demo model and the conversation results');
const agentSrc = readFileSync('./src/agent.ts', 'utf8');
const demoModel = /The talking demo \| \*\*Real model\*\*: Claude ([A-Za-z]+ [\d.]+)/.exec(readme)?.[1];
const id = /AGENT_MODEL \?\? 'claude-([a-z]+)-(\d)-(\d)/.exec(agentSrc);
check('the demo model named is the stand-in\'s default', demoModel && id && demoModel.toLowerCase() === `${id[1]} ${id[2]}.${id[3]}`, `${demoModel} vs ${id?.slice(1).join('-')}`);
const run = JSON.parse(readFileSync('./evals/conversations-last-run.json', 'utf8'));
const said = /got (\d+) of\s+(\d+) turns right on (\w+)/.exec(readme.replace(/\n/g, ' '));
check('the conversation result quoted is the one on record', said && Number(said[1]) === run.summary.turnsRight && Number(said[2]) === run.summary.turns && run.model.includes(said[3].toLowerCase()), `${said?.slice(1)} vs ${JSON.stringify(run.summary)} ${run.model}`);
const rerun = JSON.parse(readFileSync('./evals/conversations-rerun-machine.json', 'utf8'));
check('...and the re-run it cites is on record too', /went 2 for 2/.test(readme) && rerun.summary.turnsRight === 2 && rerun.summary.turns === 2);

console.log('\nNames, files and settings');
const named = [...new Set([...readme.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]))];
// Sudor's tools, named where the two add-ons work together.
const SUDOR_TOOLS = ['share_my_day', 'weather_check', 'plan_my_day'];
const looksLikeTool = (n) => /^(can|storm|what|watch|crew|share|log|job|farm|plan|position|my|tell|register|remove)_/.test(n);
const notTools = named.filter((n) => looksLikeTool(n) && !every.has(n) && !SUDOR_TOOLS.includes(n));
check('every tool name in backticks is a real tool', notTools.length === 0, notTools.join());
const paths = [...new Set([...readme.matchAll(/`((?:src|evals|skills|scripts|strands|deploy|web|ui)\/[A-Za-z0-9_./-]+\.(?:ts|mjs|json|md|html|txt|sh))`/g)].map((m) => m[1]))];
const found = (p) => existsSync(p) || readdirSync('./skills').some((d) => existsSync(`./skills/${d}/${p}`));
check('every file the README points at exists', paths.length > 10 && paths.every(found), paths.filter((p) => !found(p)).join());
const env = [...new Set([...readme.matchAll(/\bORBITA_[A-Z_]+/g)].map((m) => m[0]))];
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(`${d}/${e.name}`)) : /\.(ts|sh|mjs|service|conf)$/.test(e.name) ? [`${d}/${e.name}`] : []));
const sources = [...walk('./src'), ...walk('./deploy'), ...walk('./strands')].map((f) => readFileSync(f, 'utf8')).join('\n');
check('every setting the README names is read by the code', env.every((v) => sources.includes(v)), env.filter((v) => !sources.includes(v)).join());

const unnamed = tools.filter((n) => !named.includes(n));
check('every tool a host is shown is named in the README', unnamed.length === 0, unnamed.join());

console.log('\nThe links that say lines on the demo page');
const links = [...readme.matchAll(/\(https:\/\/[^)\s]+\/echo\.html\?([^)\s]+)\)/g)].map((m) => new URLSearchParams(m[1]).getAll('say'));
check('the README has links that say lines', links.length >= 8, String(links.length));
check('each says one to three lines, as the page plays', links.every((l) => l.length >= 1 && l.length <= 3), JSON.stringify(links.map((l) => l.length)));
check('and no line is longer than the page takes', links.flat().every((l) => l.length <= 300));

console.log('\nImages and links inside the page');
const images = [...new Set([...readme.matchAll(/src="(media\/[^"]+)"/g)].map((m) => m[1]))];
check('the README shows images', images.length >= 5, String(images.length));
check('every image it shows is in the repository', images.every((p) => existsSync(p)), images.filter((p) => !existsSync(p)).join());
// GitHub makes an anchor of every heading and of every <a id>. A link to one that is not there goes nowhere.
const slug = (t) => t.trim().toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-');
const anchors = new Set([...readme.matchAll(/^#{1,4} (.+)$/gm)].map((m) => slug(m[1])).concat([...readme.matchAll(/<a id="([^"]+)">/g)].map((m) => m[1])));
const jumps = [...new Set([...readme.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]))];
check('every #link lands on a heading or an anchor', jumps.every((j) => anchors.has(j)), jumps.filter((j) => !anchors.has(j)).join());

console.log('\nThings that were true once');
for (const stale of ['Seventeen tools by default', 'Twenty one tools is a lot', 'Claude Haiku 4.5 reads', 'mrfentmen', '`ORBITA_GPSJAM=off` turns it off', 'GPSJAM\'s daily aircraft reports. The testing schedule covers']) {
  check(`"${stale}" is not said any more`, !readme.includes(stale));
}
check('no em dashes or arrows', !/[—–→]/.test(readme));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
