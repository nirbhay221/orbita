/**
 * The design of the conversation, tested.
 *
 * The rest of the suite checks that answers are right. This checks that they can be listened to and acted on:
 * short, with the rest held for when it is asked for; possible for somebody who has set nothing up; ending in
 * a next step; shown on a card that fits the task; and open to the second person, who is usually the one the
 * answer is for. It runs with the DEFAULT scope, the tools a customer actually gets.
 */
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const DIR = './data/test-design';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.ORBITA_DATA = `${DIR}/farms.json`;
delete process.env.ORBITA_DATA_KEY;
delete process.env.ORBITA_SCOPE;

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';

const store = await import('./dist/store.js');
const swpc = await import('./dist/swpc.js');
const solarwind = await import('./dist/solarwind.js');
const brief = await import('./dist/brief.js');
const geo = await import('./dist/geocode.js');
const { registerTools, SECONDARY_TOOLS, MERGED_AWAY } = await import('./dist/tools.js');
const { speakErrorsPlainly } = await import('./dist/plainly.js');
const { configureForTest: fakeZones } = await import('./dist/timezone.js');
fakeZones(async () => 'America/Chicago');
geo.configureForTest(async (q) => (/fargo/i.test(q) ? { name: 'Fargo', region: 'North Dakota', country: 'United States', lat: 46.88, lon: -96.79 } : /grand island/i.test(q) ? { name: 'Grand Island', region: 'Nebraska', country: 'United States', lat: 40.92, lon: -98.34 } : null));

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};
const words = (s) => s.split(/\s+/).filter(Boolean).length;
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
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { said: (r.content ?? []).map((c) => c.text ?? '').join(' '), data: r.structuredContent ?? {}, isError: r.isError };
  };
  return { call, tools: async () => (await client.listTools()).tools, close: async () => { await client.close(); await server.close(); } };
}

const now = Date.now();
const start = Math.floor(now / (3 * HOUR)) * 3 * HOUR;
const forecast = (kpNow, kpLater) => {
  const slots = [];
  for (let i = -8; i < 24; i += 1) slots.push({ time: new Date(start + i * 3 * HOUR).toISOString(), kp: i < 4 ? kpNow : kpLater, observed: i < 0 });
  swpc.seedForTest({ fetchedAt: new Date().toISOString(), slots, alerts: [], scales: { g: 0, s: 0, r: 0, yesterday: { g: 0, s: 0, r: 0 }, days: [] }, stale: false });
};
forecast(2, 2);
solarwind.seedForTest({ wind: null, kp: null });

console.log('\nOne story: the tools a customer gets by default');
const owner = await connect('acct:owner');
{
  const names = (await owner.tools()).map((t) => t.name);
  check('the list of everything else a storm touches is not published by default', SECONDARY_TOOLS.every((n) => !names.includes(n)), names.join(','));
  check('the farm story is all there', ['can_i_run', 'watch_jobs', 'log_job', 'job_report', 'farm_status', 'crew_contact', 'my_farm'].every((n) => names.includes(n)));
  check('a hidden tool cannot be called', (await owner.call('what_else_is_affected', {})).isError === true);
  process.env.ORBITA_SCOPE = 'all';
  const all = await connect('acct:all');
  const allNames = (await all.tools()).map((t) => t.name);
  check('with the scope set to all, they are published', SECONDARY_TOOLS.every((n) => allNames.includes(n)) && MERGED_AWAY.every((n) => allNames.includes(n) && !names.includes(n)) && !allNames.includes('my_farm') && names.length === 17, `${names.length} ${names.join(',')}`);
  await all.close();
  delete process.env.ORBITA_SCOPE;
}

console.log('\nA first question gets an answer, not a form');
{
  const nothing = await owner.call('can_i_run', { operation: 'planting' });
  check('with nothing set up it asks for a town, not for coordinates', /nearest town/.test(nothing.said) && !/latitude|longitude|coordinates/i.test(nothing.said), nothing.said);
  const trial = await owner.call('can_i_run', { operation: 'planting', place: 'Fargo, North Dakota', correction: 'rtk' });
  check('"can I plant near Fargo on RTK" is answered straight away', trial.data.go === true && /Clear for planting/.test(trial.said), trial.said);
  check('...for that town', trial.data.field === 'Fargo, North Dakota');
  check('...without storing anything', store.get('acct:owner').fields.length === 0 && store.get('acct:owner').equipment.length === 0);
  check('...and offers to remember it', /Want me to remember this field and machine\?/.test(trial.said));
  const lost = await owner.call('can_i_run', { operation: 'planting', place: 'Atlantis', correction: 'rtk' });
  check('a town it cannot find is said to be so', /couldn't find Atlantis/.test(lost.said), lost.said);
}

console.log('\nA field is added by its nearest town');
{
  const added = await owner.call('register_field', { name: 'North 40', place: 'Grand Island, Nebraska', crop: 'corn' });
  const field = store.get('acct:owner').fields[0];
  check('the town is looked up and the field is placed there', field && Math.abs(field.lat - 40.92) < 0.01 && Math.abs(field.lon + 98.34) < 0.01, JSON.stringify(field));
  check('the answer says where it put it, and what to say next', /Added North 40 near Grand Island, Nebraska\./.test(added.said) && /correction/.test(added.said), added.said);
  const nowhere = await owner.call('register_field', { name: 'South Cut' });
  check('with no place at all it asks for the nearest town', nowhere.data.added === false && /nearest town will do/.test(nowhere.said), nowhere.said);
  const coords = await owner.call('register_field', { name: 'Lot 12', lat: 40.77, lon: -97.88 });
  check('coordinates still work for somebody who has them', /Added Lot 12/.test(coords.said) && store.get('acct:owner').fields.length === 2);
  await owner.call('register_equipment', { name: 'the planter', correction: 'rtk' });
}

console.log('\nAnswers are short, and the rest is kept for when it is asked for');
{
  // A storm now that clears later: the longest answer this tool gives.
  forecast(7, 2);
  const r = await owner.call('can_i_run', { operation: 'planting', field: 'North 40', deadline: new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10) });
  check('the spoken answer is under sixty words (it was 151)', words(r.said) <= 60, `${words(r.said)}: ${r.said}`);
  check('it leads with the verdict', /^Hold off planting\./.test(r.said), r.said.slice(0, 40));
  check('when it clears is said second, not buried', /Next clear window opens/.test(brief.sentences(r.said).slice(0, 3).join(' ')), r.said);
  check('the whole answer is still returned for a screen or a host', r.data.full === undefined && Array.isArray(r.data.more) && r.data.more.length > 0);
  check('the spoken field matches what is said', r.data.spoken === r.said);
  check('it ends on one question, the next step, not a menu', /Want me to watch it and tell you when it clears\?$/.test(r.said) && !/Ask for more/.test(r.said), r.said.slice(-80));
  check('...with that step named for the host', r.data.nextAction?.tool === 'watch_jobs' && r.data.nextAction.arguments.action === 'start');

  const more = await owner.call('tell_me_more');
  check('"tell me more" continues where it stopped', more.said.length > 20 && r.data.more[0].startsWith(brief.sentences(more.said)[0].slice(0, 30)), more.said);
  let guard = 0;
  let last = more;
  while (last.data.left > 0 && guard++ < 10) last = await owner.call('tell_me_more');
  check('...until there is nothing left', last.data.left === 0 && guard < 10);
  check('...and then says so, with what to ask instead', /nothing more on that/.test((await owner.call('tell_me_more')).said));

  forecast(2, 2);
  const short = await owner.call('farm_status');
  check('a short answer is left alone', !short.data.more && !/Ask for more/.test(short.said), short.said);
  check('asking for more after a short answer does not replay an old one', /nothing more on that/.test((await owner.call('tell_me_more')).said));

  check('an answer that mentions 911 is never cut', (() => {
    const long = { content: [{ type: 'text', text: 'One. Two. Three. Four. If they collapse call 911. Six.' }], structuredContent: {} };
    return brief.shorten(long, 'x', { readOnly: true }).content[0].text === long.content[0].text;
  })());
  check('a write is never cut, so a confirmation is always heard whole', (() => {
    const long = { content: [{ type: 'text', text: 'One. Two. Three. Four. Five. Six.' }], structuredContent: {} };
    return brief.shorten(long, 'x', { readOnly: false }).content[0].text === long.content[0].text;
  })());
  check('a sentence a tool marks as must-say is said even when it comes late', (() => {
    const long = { content: [{ type: 'text', text: 'One. Two. Three. Four. Watch this one though. Six.' }], structuredContent: { mustSay: ['Watch this one though.'] } };
    const out = brief.shorten(long, 'x', { readOnly: true });
    return /Watch this one though\./.test(out.content[0].text) && !out.structuredContent.more.includes('Watch this one though.');
  })());
  check('a name like St. Mary\'s is not split into two sentences', brief.sentences("Go to St. Mary's Hall. It is open.").length === 2);
  check('a decimal is not a sentence break', brief.sentences('Kp 2.0, expected drift 1.0 inches. Clear.').length === 2);
  check('"what can you do" is under sixty words (it was 168)', words((await owner.call('what_can_you_do')).said) <= 60);
}

console.log('\nA card that fits the task');
{
  forecast(7, 2);
  const watch = await owner.call('watch_jobs', { action: 'start', operation: 'planting', field: 'North 40' });
  check('starting a watch returns a card about that watch', watch.data.card?.kind === 'card' && /Watching planting on North 40/.test(watch.data.card.title));
  const list = await owner.call('watch_jobs', { action: 'check' });
  check('checking watches returns a list, one row a job', list.data.card?.kind === 'list' && list.data.card.items.length === 1 && /Planting on North 40/.test(list.data.card.items[0].title));
  const stage = await owner.call('crew_contact', { action: 'add', name: 'Dale', email: 'dale@example.com' });
  check('adding somebody returns a commit card saying what yes will do', /Say yes to add Dale/.test(stage.data.card?.confirm ?? '') && stage.data.card.lines.includes('dale@example.com'));
  const tools = await owner.tools();
  const ui = (n) => tools.find((t) => t.name === n)?._meta?.ui?.resourceUri;
  check('the chart is still the view for a verdict', ui('can_i_run') === 'ui://orbita/window.html');
  check('lists and confirmations use the card view', ['watch_jobs', 'job_report', 'crew_contact', 'share_access'].every((n) => ui(n) === 'ui://orbita/card.html'));
  forecast(2, 2);

  // The view itself, played by a host: it must initialise before it is sent anything, then draw the card.
  const html = readFileSync('ui/card.html', 'utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  const sent = [];
  dom.window.parent = { postMessage: (m) => sent.push(m) };
  const fresh = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, 'parent', { value: { postMessage: (m) => sent.push(m) } });
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  const init = sent.find((m) => m.method === 'ui/initialize');
  check('the view sends ui/initialize before anything else', !!init && init.params.protocolVersion === '2026-01-26', JSON.stringify(sent[0]));
  const doc = fresh.window.document;
  check('it shows a labelled example until real data arrives', /Example/.test(doc.getElementById('foot').textContent));
  fresh.window.dispatchEvent(new fresh.window.MessageEvent('message', { data: { jsonrpc: '2.0', id: init.id, result: { hostContext: { theme: 'dark' } } } }));
  await new Promise((r) => setTimeout(r, 20));
  check('it confirms with initialized', sent.some((m) => m.method === 'ui/notifications/initialized'));
  check('it takes the host theme', doc.documentElement.getAttribute('data-theme') === 'dark');
  fresh.window.dispatchEvent(new fresh.window.MessageEvent('message', { data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { card: { kind: 'list', title: '<b>Waiting</b>', status: { label: '1 clear', tone: 'good' }, items: [{ title: 'Planting on <i>North 40</i>', note: 'clear now', tone: 'good' }] } } } } }));
  await new Promise((r) => setTimeout(r, 20));
  check('it draws the card it is sent', doc.getElementById('title').textContent === '<b>Waiting</b>' && doc.querySelectorAll('#items li').length === 1);
  check('a name with markup in it is shown as text, never run', doc.querySelector('#items li b, #items li i, #title b') === null);
  check('the status is a word with a mark, not a colour alone', /✓ 1 clear/.test(doc.getElementById('chip').textContent));
  dom.window.close();
  fresh.window.close();
}

console.log('\nA second person can ask for themselves');
{
  const dale = await connect('acct:dale');
  const before = await dale.call('can_i_run', { operation: 'planting' });
  check('before joining, the operator has no fields', /nearest town/.test(before.said));
  const invite = await owner.call('share_access', { action: 'invite' });
  const code = invite.data.code;
  check('the owner gets an eight digit code, read out in two groups', /^\d{8}$/.test(code) && invite.said.includes(code.slice(0, 4).split('').join(' ')), invite.said);
  check('the code is not stored, only its hash', !readFileSync(`${DIR}/farms.json`, 'utf8').includes(code));
  check('a wrong code does not work', (await dale.call('share_access', { action: 'join', code: '00000000' })).data.joined === false);
  check('the owner cannot join their own farm', (await owner.call('share_access', { action: 'join', code })).data.reason === 'own');
  const joined = await dale.call('share_access', { action: 'join', code: `${code.slice(0, 4)} ${code.slice(4)}` });
  check('the right code works, however it was spoken', joined.data.joined === true && /North 40/.test(joined.said), joined.said);
  const mallory = await connect('acct:mallory');
  check('the code works once', (await mallory.call('share_access', { action: 'join', code })).data.joined === false);
  await mallory.close();
  const view = await dale.call('can_i_run', { operation: 'planting', field: 'North 40' });
  check('the operator can now ask about the owner\'s field', view.data.field === 'North 40' && typeof view.data.go === 'boolean', view.said);
  const status = await dale.call('farm_status');
  check('...and see the whole farm', status.data.rows?.some((r) => r.field === 'North 40'));
  await dale.call('register_field', { name: 'Dale Home', lat: 41, lon: -98 });
  check('but what they write goes to their own record, never the owner\'s', !store.get('acct:owner').fields.some((f) => f.name === 'Dale Home') && store.get('acct:dale').fields.some((f) => f.name === 'Dale Home'));
  await dale.call('remove', { what: 'field', name: 'North 40' });
  check('...and they cannot remove the owner\'s field', store.get('acct:owner').fields.some((f) => f.name === 'North 40'));
  const stopped = await owner.call('share_access', { action: 'stop' });
  check('the owner can end it', stopped.data.stopped === 1, stopped.said);
  const after = await dale.call('can_i_run', { operation: 'planting', field: 'North 40' });
  check('and the operator is back to their own fields at once', after.data.field !== 'North 40', after.said);
  let refused = 0;
  for (let i = 0; i < 9; i += 1) if ((await dale.call('share_access', { action: 'join', code: String(10000000 + i) })).data.reason === 'limit') refused += 1;
  check('guessing codes is cut off', refused >= 3, String(refused));
  await dale.close();
}

await owner.close();
rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
