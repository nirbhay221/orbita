/**
 * The certification contract, checked against a running server.
 *
 * Amazon's functional requirements for add-ons are specific and testable, and
 * three of them are about the tool surface rather than about any one answer:
 *
 *   "Every tool returned by your server's tools/list endpoint must be invocable"
 *   "Your server must gracefully handle unexpected or invalid parameters"
 *   "Surface no API codes, tool names, JSON, or internal IDs in any
 *    customer-facing response"
 *
 * So this walks tools/list, calls every tool on it for real, reads what comes
 * back the way a customer would hear it, and then sends each one arguments it
 * never asked for to make sure the server refuses them cleanly and is still
 * answering afterwards. It is deliberately not a list of tools written down
 * here: a tool added later and forgotten is exactly the failure this catches.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = './data/test-contract.json';
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

let rpcId = 0;
async function rpc(method, params, session = '9da1d202c3254add05ca39329cac11bd') {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-orbita-demo': session,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const raw = await res.text();
  const line = raw.split('\n').find((l) => l.startsWith('data: '));
  return { status: res.status, body: JSON.parse(line ? line.slice(6) : raw) };
}
const callTool = (name, args, session) => rpc('tools/call', { name, arguments: args }, session);

/**
 * Arguments a real customer's words would produce, one set per tool.
 *
 * Every value here is a real place, a real machine type or a real date. The
 * sweep below fails if a tool appears in tools/list without an entry, so this
 * cannot quietly fall behind the server.
 */
const SPOKEN = {
  register_field: { name: 'North 40', lat: 42.03, lon: -93.62, crop: 'corn', acres: 40, baselineKm: 18 },
  register_equipment: { name: 'the planter', correction: 'rtk' },
  can_i_run: { operation: 'planting', field: 'north', equipment: 'planter' },
  storm_status: {},
  farm_status: {},
  // Registered through the SDK's experimental task surface with
  // taskSupport 'optional', so it answers a plain tools/call as well as a
  // task-carrying one. Both paths are exercised: this map covers the plain one.
  plan_season: {},
  what_happened: { when: '10 May 2024', operation: 'planting' },
  what_should_i_do: { role: 'grid_operator' },
  what_else_is_affected: {},
  what_can_you_do: {},
  watch_jobs: { action: 'check' },
  log_job: { operation: 'planting', field: 'north', equipment: 'planter', acres: 40 },
  job_report: { days: 7 },
  crew_contact: { action: 'add', name: 'Dana', email: 'dana@example.com', notifyOn: ['storm'] },
  remove: { what: 'field', name: 'North 40' },
};

/** The order they have to run in: nothing can be judged before it is registered. */
const FIRST = ['register_field', 'register_equipment'];

console.log('\nEvery tool on tools/list is invocable');
const listed = (await rpc('tools/list', {})).body.result?.tools ?? [];
check('tools/list answers with tools', listed.length > 0, JSON.stringify(listed).slice(0, 120));

const names = listed.map((t) => t.name);
const missing = names.filter((n) => !(n in SPOKEN));
check('every listed tool has a real request written for it here', !missing.length, missing.join(', '));

for (const name of names) check(`${name} declares an input schema`, !!listed.find((t) => t.name === name)?.inputSchema);

console.log('\nWhat each tool says it does to the world');
const ann = (n) => listed.find((t) => t.name === n)?.annotations;
const unannotated = names.filter((n) => !ann(n));
check('every tool declares its annotations', !unannotated.length, unannotated.join(', '));
const destructive = names.filter((n) => ann(n)?.destructiveHint).sort();
check('...and the destructive ones are exactly the ones that take something away',
  JSON.stringify(destructive) === JSON.stringify(['crew_contact', 'remove']), destructive.join(', '));
/*
 * The duplicate-write bug, turned into an invariant. A tool that writes and is
 * not idempotent has to be a deliberate decision, named here, rather than
 * something that slipped in unnoticed.
 */
const repeatable = names.filter((n) => ann(n)?.readOnlyHint === false && ann(n)?.idempotentHint !== true).sort();
check('...and every writing tool folds a repeat, except the two we chose',
  JSON.stringify(repeatable) === JSON.stringify(['crew_contact', 'job_report']), repeatable.join(', '));
const openWorld = names.filter((n) => ann(n)?.openWorldHint).length;
check('...and the tools that depend on the outside world say so', openWorld >= 8, String(openWorld));

console.log('\nA customer who has told us nothing yet');
/*
 * The first thing a certifier does is open the add-on and start talking, before
 * registering anything. A live probe asked for the farm status with a field but
 * no machine and heard "Cannot read properties of undefined (reading
 * 'correction')" read back as the answer. Every tool gets asked on an empty
 * farm here, because that is the state every customer starts in.
 */
const emptyAnswers = {};
for (const name of names) {
  if (!(name in SPOKEN)) continue;
  const { status, body } = await callTool(name, {}, 'emptyfarm01');
  const text = body.result?.content?.[0]?.text ?? '';
  emptyAnswers[name] = text;
  const broke = /Cannot read|undefined|not a function|at Object\.|TypeError|Error:/.test(text);
  check(`${name} answers before anything is registered`,
    status === 200 && !body.error && text.trim().length > 0 && !broke,
    body.error ? JSON.stringify(body.error).slice(0, 140) : `${status} ${text.slice(0, 140)}`);
}
for (const [name, text] of Object.entries(emptyAnswers)) {
  // "Provide actionable next step for every error": an empty farm is not an
  // error, but it is a dead end unless the answer says what to say next.
  const empty = /don't have|not registered|no fields|no equipment|nothing|tell me|ask me|give me|first|yet/i.test(text);
  check(`${name} says what to do next rather than stopping dead`, empty || text.length > 60, text.slice(0, 140));
}

const order = [...FIRST.filter((n) => names.includes(n)), ...names.filter((n) => !FIRST.includes(n))];
const spoken = {};
for (const name of order) {
  if (!(name in SPOKEN)) continue;
  const { status, body } = await callTool(name, SPOKEN[name]);
  const text = body.result?.content?.[0]?.text ?? '';
  spoken[name] = text;
  check(`${name} answers`, status === 200 && !body.error && text.trim().length > 0,
    body.error ? JSON.stringify(body.error).slice(0, 140) : `${status} empty`);
}

console.log('\nGround registered, but nothing to drive on it yet');
await callTool('register_field', SPOKEN.register_field, 'halfsetup01');
for (const name of names) {
  // Registering a machine, or removing the field again, would end the very
  // state being tested. The first version of this loop did both, and quietly
  // proved nothing: by the time it reached the status sweep there was no farm
  // left to sweep.
  if (name === 'register_equipment' || name === 'remove') continue;
  const { status, body } = await callTool(name, SPOKEN[name] ?? {}, 'halfsetup01');
  const text = body.result?.content?.[0]?.text ?? '';
  check(`${name} answers with a field but no machine`,
    status === 200 && !body.error && text.trim().length > 0 && !/Cannot read|undefined|TypeError/.test(text),
    `${status} ${text.slice(0, 140)}`);
}

console.log('\nNothing a customer hears is written for a developer');
for (const [name, text] of Object.entries(spoken)) {
  const leak =
    /[{}]/.test(text) ? 'JSON braces' :
    /\b(field|eq|job|watch)-[a-z0-9]{4,}/.test(text) ? 'an internal id' :
    /undefined|NaN|\[object Object\]/.test(text) ? 'a broken value' :
    /_[a-z]+_|\bjsonrpc\b|\bHTTP \d\d\d/.test(text) ? 'a tool name or protocol detail' : '';
  check(`${name} says nothing internal`, !leak, `${leak}: ${text.slice(0, 120)}`);
}

console.log('\nSentences that would sound wrong out loud');
for (const [name, text] of Object.entries(spoken)) {
  const stumble =
    /\b(so|and|but|then) \1\b/i.test(text) ? 'a doubled connective' :
    /\bso and\b|\band so\b(?! much)/i.test(text) ? 'two connectives in a row' :
    /\bcan also can\b|\bthe the\b|\ba a\b/i.test(text) ? 'a doubled word' :
    /\.\s*\./.test(text) ? 'a doubled full stop' :
    /\s,|,,/.test(text) ? 'a stray comma' : '';
  check(`${name} reads cleanly`, !stumble, `${stumble}: ${text.slice(0, 140)}`);
}

console.log('\nArguments no tool asked for');
for (const name of names) {
  const { status, body } = await callTool(name, { nonsense: '?!', when: 12345, action: 'explode', lat: 'north' }, 'contractaa02');
  const text = body.result?.content?.[0]?.text ?? '';
  const refusedCleanly = !!body.error && status === 200;
  const answeredAnyway = !body.error && text.trim().length > 0;
  check(`${name} survives junk arguments`, refusedCleanly || answeredAnyway,
    `${status} ${JSON.stringify(body).slice(0, 140)}`);
}

console.log('\nArguments named after the language itself');
for (const name of names) {
  const { status, body } = await callTool(name, { constructor: 'x', prototype: 'y', nonsense: '?' }, 'contractaa02');
  check(`${name} answers an argument named "constructor" instead of an internal error`,
    status === 200 && body.error?.code !== -32603, `${status} ${JSON.stringify(body).slice(0, 140)}`);
}
const nested = await callTool(names[0], { nested: { constructor: 'x' } }, 'contractaa02');
check('a nested one is handled the same way', nested.body.error?.code !== -32603, JSON.stringify(nested.body).slice(0, 140));

const wrongWord = await callTool('can_i_run', { operation: 'dancing', field: 'north' }, 'contractaa02');
const wrongText = wrongWord.body.result?.content?.[0]?.text ?? '';
check('a word we do not know is answered with the words we do know', /I can do planting/.test(wrongText), wrongText);
check('...spoken, not spelled like an identifier', !/_/.test(wrongText), wrongText);
check('...and the word it could not use is never offered back as a choice', !/dancing/.test(wrongText), wrongText);
const missingDetail = await callTool('can_i_run', {}, 'contractaa02');
check('a missing detail asks for it again rather than quoting the protocol',
  !/MCP error|validation/i.test(missingDetail.body.result?.content?.[0]?.text ?? ''),
  missingDetail.body.result?.content?.[0]?.text ?? '');

const afterJunk = await callTool('storm_status', {});
check('and the server is still answering after all of that',
  !afterJunk.body.error && (afterJunk.body.result?.content?.[0]?.text ?? '').length > 0);

console.log('\nA request that is not a tool call at all');
const nonsense = await rpc('tools/call', { name: 'no_such_tool', arguments: {} });
const nonsenseText = nonsense.body.result?.content?.[0]?.text ?? '';
check('an unknown tool name is refused, not a crash',
  !!nonsense.body.error || nonsense.body.result?.isError === true, JSON.stringify(nonsense.body).slice(0, 140));
check('...in words, with somewhere to go next, and no protocol in them',
  !/MCP error|-32\d\d\d|no_such_tool/.test(nonsenseText) && /ask me/i.test(nonsenseText), nonsenseText);
const badMethod = await rpc('resources/list', {});
check('a method this server does not implement is answered, not hung',
  badMethod.status === 200 && (!!badMethod.body.error || !!badMethod.body.result), JSON.stringify(badMethod.body).slice(0, 140));


console.log('\nOne caller cannot spend everyone else\'s share');
/*
 * The specification asks servers to rate limit tool invocations, and this
 * endpoint is public. A second server is started with a tiny bucket, because
 * the real one is set high enough that a voice conversation never meets it.
 */
const limitedPort = 8789;
const limited = spawn(process.execPath, ['dist/server.js'], {
  env: {
    ...process.env,
    PORT: String(limitedPort),
    ORBITA_DATA: './data/test-ratelimit.json',
    ORBITA_AUTH: 'off',
    ORBITA_BURST: '5',
    ORBITA_REFILL: '0',
    // One proxy hop, so X-Forwarded-For can stand in for two different callers. Sandbox
    // callers are charged by address: a demo id is free to invent and cannot be a key.
    ORBITA_TRUST_PROXY: '1',
  },
  stdio: 'ignore',
});
try {
  let limitedUp = false;
  for (let i = 0; i < 60 && !limitedUp; i++) {
    try { limitedUp = (await fetch(`http://127.0.0.1:${limitedPort}/health`)).ok; } catch { await wait(500); }
  }
  const hit = async () => {
    const res = await fetch(`http://127.0.0.1:${limitedPort}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-forwarded-for': '203.0.113.10', 'x-orbita-demo': 'ee74208ad57ec4a74674a4945ab22e9e' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'storm_status', arguments: {} } }),
    });
    return res.status;
  };
  const statuses = [];
  for (let i = 0; i < 8; i++) statuses.push(await hit());
  check('the first few calls are served', statuses.slice(0, 5).every((s) => s === 200), statuses.join(','));
  check('...and then the caller is turned away rather than served forever',
    statuses.slice(5).some((s) => s === 429), statuses.join(','));
  const refused = await fetch(`http://127.0.0.1:${limitedPort}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-forwarded-for': '203.0.113.10', 'x-orbita-demo': 'ee74208ad57ec4a74674a4945ab22e9e' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'storm_status', arguments: {} } }),
  });
  check('...with a retry hint rather than a closed door', !!refused.headers.get('retry-after'), String(refused.status));
  const body = await refused.json();
  check('...and the refusal is in words, not a stack trace',
    /slow down/i.test(body.error?.message ?? '') && !/Error:|at /.test(body.error?.message ?? ''), JSON.stringify(body).slice(0, 120));
  // The bypass this closes: from the SAME address, a fresh demo id must not reset the
  // limit, because inventing one costs nothing.
  const rotated = await fetch(`http://127.0.0.1:${limitedPort}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-forwarded-for': '203.0.113.10', 'x-orbita-demo': 'b3f1a9c2d4e5f60718293a4b5c6d7e8f' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'what_can_you_do', arguments: {} } }),
  });
  check('a fresh demo id from the same address is still limited', rotated.status === 429, String(rotated.status));
  // A different address has its own bucket and is unaffected.
  const otherRes = await fetch(`http://127.0.0.1:${limitedPort}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-forwarded-for': '203.0.113.20', 'x-orbita-demo': '7c4c1db8ad9f3bb4266e7629a9c34875' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'storm_status', arguments: {} } }),
  });
  check('a caller at a different address is not punished for the first one', otherRes.status === 200, String(otherRes.status));
} finally {
  try { limited.kill(); } catch { /* already gone */ }
  rmSync('./data/test-ratelimit.json', { force: true });
}


console.log('\nGoing down on purpose');
/*
 * systemd sends SIGTERM on every redeploy. Without a handler the process dies
 * where it stands. Windows does not deliver the signal to a Node handler at
 * all, so this runs where it means something and says so where it does not.
 */
if (process.platform === 'win32') {
  console.log('  skip  SIGTERM is not delivered to a handler on Windows; CI runs this on Linux');
} else {
  const victim = spawn(process.execPath, ['dist/server.js'], {
    env: { ...process.env, PORT: '8786', ORBITA_DATA: './data/test-shutdown.json', ORBITA_AUTH: 'off' },
    stdio: 'ignore',
  });
  let alive = false;
  for (let i = 0; i < 60 && !alive; i++) {
    try { alive = (await fetch('http://127.0.0.1:8786/health')).ok; } catch { await wait(500); }
  }
  check('the server came up to be shut down', alive);
  const started = Date.now();
  const exited = await new Promise((resolve) => {
    victim.on('exit', (code) => resolve({ code, ms: Date.now() - started }));
    victim.kill('SIGTERM');
    setTimeout(() => resolve({ code: 'still running', ms: Date.now() - started }), 8000);
  });
  check('SIGTERM stops it cleanly rather than killing it mid request',
    exited.code === 0 && exited.ms < 8000, JSON.stringify(exited));
  rmSync('./data/test-shutdown.json', { force: true });
}

stop();
rmSync(DATA, { force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
