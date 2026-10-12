// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.ORBITA_SCOPE ??= 'all';
/**
 * The demo page, tested against a real server.
 *
 * A page that quietly stops working is worse than no page, and the way it
 * breaks is always the same: a button points at a tool that was renamed, or at
 * an argument the schema no longer accepts, and nobody notices until someone
 * clicks it. So this starts the built server, fetches the page and its assets,
 * then calls every single request the page offers and fails if any of them
 * comes back an error.
 *
 * It also checks the thing that would embarrass us most in front of other
 * people: that two visitors do not share one farm.
 */
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 8799;
const BASE = `http://localhost:${PORT}`;
const DATA = './data/test-web.json';
rmSync(DATA, { force: true });

const server = spawn(process.execPath, ['dist/server.js'], {
  env: { ...process.env, PORT: String(PORT), ORBITA_DATA: DATA, ORBITA_AUTH: 'off' },
  stdio: 'ignore',
});
const stop = () => { try { server.kill(); } catch { /* already gone */ } };
process.on('exit', stop);

let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch(`${BASE}/health`)).ok; } catch { await wait(500); }
}
if (!up) { console.log('  FAIL  the server never came up'); stop(); process.exit(1); }

/** One tool call, the way the page makes it. */
let rpcId = 0;
async function call(name, args = {}, sessionId = '42816a48288988c1b90e06066deea01d') {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-orbita-demo': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const line = raw.split('\n').find((l) => l.startsWith('data: '));
  const json = JSON.parse(line ? line.slice(6) : raw);
  return { error: json.error ?? null, text: json.result?.content?.[0]?.text ?? '', structured: json.result?.structuredContent ?? null };
}

console.log('\nThe page and everything it asks for');
for (const [path, type] of [['/', 'text/html'], ['/styles.css', 'text/css'], ['/app.js', 'javascript'], ['/requests.json', 'json'], ['/ui/window.html', 'text/html'], ['/echo.html', 'text/html'], ['/echo.js', 'javascript'], ['/echo.css', 'text/css'], ['/echo-scenes.json', 'json']]) {
  const res = await fetch(BASE + path);
  check(`${path} is served`, res.ok && (res.headers.get('content-type') ?? '').includes(type),
    `${res.status} ${res.headers.get('content-type')}`);
}

const html = readFileSync('./web/index.html', 'utf8');
const js = readFileSync('./web/app.js', 'utf8');
const css = readFileSync('./web/styles.css', 'utf8');
console.log('\nHouse style');
for (const [name, text] of [['index.html', html], ['app.js', js], ['styles.css', css]]) {
  check(`no em dashes or arrows in ${name}`, !/[—–→←⇒]|&mdash;|&ndash;/.test(text));
}
check('the page sets a viewport, so it works on a phone', /name="viewport"/.test(html));
check('the panel is sandboxed', /id="panel"[^>]*sandbox="allow-scripts"/.test(html));
check('the page says plainly that Alexa is not in the loop', /Alexa is not in the loop/.test(html));
check('the page does not claim to be Alexa', !/\bwe are Alexa\b/i.test(html));

console.log('\nEvery tool the page names exists on the server');
const listed = await fetch(`${BASE}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/list' }),
}).then(async (r) => {
  const raw = await r.text();
  const line = raw.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : raw).result.tools.map((t) => t.name);
});
const catalogue = JSON.parse(readFileSync('./web/requests.json', 'utf8'));
const named = [...new Set([...catalogue.tools, ...catalogue.groups.flatMap((g) => g.requests.map((r) => r.tool))])];
const missing = named.filter((t) => !listed.includes(t));
check(`all ${named.length} tools named on the page are registered`, missing.length === 0, missing.join(', '));
check('the dropdown lists every tool the server has', listed.every((t) => catalogue.tools.includes(t)),
  listed.filter((t) => !catalogue.tools.includes(t)).join(', '));

console.log('\nThe farm the page sets up for a visitor');
check('a fresh visitor has no fields', (await call('farm_status', {}, 'freshaaa0002')).text.startsWith('I need to know where the field is first'));
check('the seed field is accepted', !(await call('register_field', catalogue.seed.field)).error);
for (const machine of catalogue.seed.equipment) {
  check(`the seed machine "${machine.name}" is accepted`, !(await call('register_equipment', machine)).error);
}

console.log('\nEvery request on the page, actually called');
const friday = (() => {
  const d = new Date();
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7));
  return d.toISOString().slice(0, 10);
})();
const fill = (v) => JSON.parse(JSON.stringify(v).replaceAll('{{next-friday}}', friday));
for (const group of catalogue.groups) {
  for (const req of fill(group.requests)) {
    const out = await call(req.tool, req.args);
    check(`"${req.say}" answers`, !out.error && out.text.trim().length > 0, out.error?.message ?? '(empty answer)');
  }
}

console.log('\nTwo visitors are two farms');
await call('register_field', { name: 'Somebody Elses Field', lat: 47.92, lon: -97.03 }, 'otheraaa0003');
const mine = await call('farm_status', {}, '42816a48288988c1b90e06066deea01d');
const theirs = await call('farm_status', {}, 'otheraaa0003');
check('the second visitor does not see the first visitor\'s field',
  !theirs.text.includes('North 40') && !mine.text.includes('Somebody Elses Field'), `${mine.text} // ${theirs.text}`);
const junk = await call('farm_status', {}, 'not a valid id!!');
check('a nonsense session id falls back instead of crashing', !junk.error, junk.error?.message);

console.log('\nA host opening a stream gets an answer, not a hung connection');
const streamStarted = Date.now();
const stream = await fetch(`${BASE}/mcp`, { headers: { accept: 'text/event-stream' } });
const streamMs = Date.now() - streamStarted;
check('GET /mcp answers 405 rather than hanging', stream.status === 405 && streamMs < 3000, `${stream.status} in ${streamMs} ms`);
check('...and says which method to use', (stream.headers.get('allow') ?? '').includes('POST'), stream.headers.get('allow') ?? '(none)');

console.log('\nClients that do not send the header the spec asks for');
const wildcard = await fetch(`${BASE}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: '*/*' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'tools/list' }),
});
const wildcardBody = await wildcard.text();
check('a plain curl, which sends Accept: */*, gets the tool list rather than a 406',
  wildcard.status === 200 && wildcardBody.includes('"tools"'), `${wildcard.status} ${wildcardBody.slice(0, 90)}`);
const jsonOnly = await fetch(`${BASE}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 901, method: 'tools/list' }),
});
check('...while a client that says it cannot read an event stream is still told so',
  jsonOnly.status === 406, String(jsonOnly.status));

console.log('\nHosts still speaking an older version of the protocol');
for (const version of ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 902,
      method: 'initialize',
      params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'era-test', version: '0' } },
    }),
  });
  const raw = await res.text();
  const line = raw.split('\n').find((l) => l.startsWith('data: '));
  const body = JSON.parse(line ? line.slice(6) : raw);
  check(`a host on ${version} is answered on ${version}`,
    res.status === 200 && body.result?.protocolVersion === version, `${res.status} ${JSON.stringify(body).slice(0, 100)}`);
}
const stale = await fetch(`${BASE}/mcp`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-session-id': 'a-session-this-server-never-issued',
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 903, method: 'tools/list' }),
});
check('a session id from some other server is ignored rather than refused, because we keep no sessions',
  stale.status === 200, String(stale.status));

console.log('\nThe add-on tells a host what this person has saved, never what it is');
{
  const me = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const rpc = async (method, params) => {
    const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orbita-demo': me }, body: JSON.stringify({ jsonrpc: '2.0', id: 990, method, params }) });
    const raw = await res.text();
    const line = raw.split('\n').find((l) => l.startsWith('data: '));
    return JSON.parse(line ? line.slice(6) : raw);
  };
  const hello = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'known-test', version: '0' } };
  const before = (await rpc('initialize', hello)).result?.instructions ?? '';
  check('before anything is saved, the host is told nothing is', /not saved anything yet/.test(before), before.slice(-120));
  await rpc('tools/call', { name: 'register_field', arguments: { name: 'North', place: 'Fargo, North Dakota', lat: 46.88, lon: -96.79 } });
  const after = (await rpc('initialize', hello)).result?.instructions ?? '';
  check('after, the host is told what kind of thing is saved, and not to ask again', after.includes('1 field') && /do not ask/.test(after), after.slice(-160));
  check('...without the name of any medicine, field or town', !/furosemide|Fargo|North\b/.test(after.slice(after.indexOf('already saved'))), after.slice(-160));
}

stop();
rmSync(DATA, { force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
