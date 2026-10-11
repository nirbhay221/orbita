/**
 * Streamable HTTP MCP server (spec 2025-11-25) for Alexa+.
 *
 * NOAA is polled on a 15-minute background timer, never inside a tool call,
 * so every request is served from memory and stays well inside the 500 ms budget.
 */

import { chooseByWords } from './rules.js';
import * as roti from './roti.js';
import { speakErrorsPlainly } from './plainly.js';
import express from 'express';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools, resolveFieldTimeZone } from './tools.js';
import * as store from './store.js';
import * as swpc from './swpc.js';
import * as solarwind from './solarwind.js';
import * as geomag from './geomag.js';
import * as glotec from './glotec.js';
import * as crewheat from './crewheat.js';
import * as crewday from './crewday.js';
import { mountConsent } from './consent.js';
import { demoPhone } from './notify.js';
import * as swpcplus from './swpcplus.js';
import * as aurora from './aurora.js';
import { checkFieldAlerts } from './alerts.js';
import { AUTH_ON, demoIdOf, mountAuth, requireAuth, subjectOf } from './auth.js';
import { requireOrigin, requireOriginSecret, originSecretConfigured } from './origin.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as agent from './agent.js';
import * as speak from './speak.js';
import * as ntrip from './ntrip.js';
import * as trace from './trace.js';
import * as vault from './vault.js';
import { dailyCap, perCaller } from './budget.js';

/**
 * Tasks outlive the request that created them, and this server does not.
 *
 * Every /mcp request builds its own McpServer and StreamableHTTPServerTransport
 * with `sessionIdGenerator: undefined` and closes both when the response ends.
 * That is deliberate: it is why a tool call answers in single digit
 * milliseconds and why a restart costs nothing but tokens.
 *
 * It is also exactly wrong for tasks, which are a create-now, fetch-later shape.
 * A store built per request dies before the poll arrives, so `tasks/get` answers
 * "Task not found" for a task the same server created a second earlier: a tool
 * that advertises task support and can never return a result. Observed, before
 * this was hoisted.
 *
 * So the store is a module-level singleton, shared by every request. Task ids are
 * 128 bits of randomness rather than sequential, so one farm cannot enumerate
 * another's, and with auth on the tool that creates them is already scoped to a
 * subject. The queue is paired with it for the same reason.
 */
const TASK_STORE = new InMemoryTaskStore();
const TASK_QUEUE = new InMemoryTaskMessageQueue();

/**
 * Carried in every stand-in response, so the disclaimer travels with the data
 * rather than living in a README. This is a model playing the part Alexa+ would
 * play; it does not share Alexa's prompt, its turn budget, or its judgment about
 * when to call something.
 */
const STAND_IN_NOTE =
  "Alexa+ stand-in: a model reading this server's real tools/list and calling it over MCP. Not Alexa.";

// Before anything reads the farms file. With ORBITA_REQUIRE_ENCRYPTION=on a missing
// key stops the process here, rather than letting it serve a farm's coordinates and
// its crew's addresses out of a plaintext file because somebody forgot a variable.
vault.assertRequirementMet();

const PORT = Number(process.env.PORT ?? 8788);
const WINDOW_HTML = resolve('./ui/window.html');
const CARD_HTML = resolve('./ui/card.html');

/**
 * Whose fields these are. After account linking that is the OAuth subject, so
 * two crews on one server never see each other's sites. With auth off, for the
 * local probe, everything belongs to one development farm.
 */
function farmFrom(req: express.Request): string {
  const subject = subjectOf(req);
  if (subject) return `acct:${subject}`;
  // A farm holds fields, machines and a crew list, so two visitors must never share
  // one. Each browser has its own 128 bit id, and it only ever reaches `demo:`.
  const demo = demoIdOf(req);
  if (demo) return `demo:${demo}`;
  if (AUTH_ON) throw new Error('unauthenticated request reached the MCP handler');
  return 'local-dev';
}

/* What this farm has already saved, as counts and never names, so a host calls the tool instead of asking. */
function instructionsFor(farmId: string): string {
  const base =
        'This add-on turns the NOAA space weather forecast into decisions. It tells field crews, surveyors, drone ' +
        'mappers and grade crews whether GPS guidance will hold accuracy, and tells satellite, grid, airline, HF radio, ' +
        'timing, pipeline, drilling, rail, vessel positioning, mining and fleet operators, aurora watchers and ' +
        'households what to do about a storm and when. ' +
        'Always read the returned reason aloud, it names the binding constraint and what to do next. ' +
        'If NOAA is unreachable, say so plainly rather than guessing; a wrong go-ahead costs a season. ' +
        'It remembers the fields, machines and corrections the customer saved, so call the tool without asking for them; ' +
        'with one field and one machine saved those are used, and with several the answer itself says which it used.';
  const f = store.get(farmId);
  const known = [
    f.fields.length ? `${f.fields.length} field${f.fields.length === 1 ? '' : 's'}` : '',
    f.equipment.length ? `${f.equipment.length} machine${f.equipment.length === 1 ? '' : 's'}` : '',
    f.crew.length ? 'a crew list' : '',
  ].filter(Boolean);
  return known.length
    ? `${base} This farm has already saved ${known.join(' and ')}. Use them: do not ask which field, where it is, or what correction it runs.`
    : `${base} This farm has not saved anything yet; a tool will say what it needs.`;
}

function build(farmId: string): McpServer {
  const server = new McpServer(
    {
      name: 'orbita',
      title: 'Orbita',
      description: 'Tells farm crews and other GPS-dependent operators whether guidance will hold accuracy, from NOAA space weather.',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        // Declared explicitly, because the SDK checks this before it will accept
        // a tools/call carrying a task, and a task-capable tool that is
        // advertised but refuses every call is worse than no tool at all.
        tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
      },
      // Tasks, new in spec 2025-11-25. Without a store the SDK registers the
      // task-capable tool but answers "no task store provided" when it is
      // called, which is a tool that advertises itself and does not work.
      //
      // In memory is the honest choice here and matches how tokens are held in
      // auth.ts: a restart loses in-flight tasks, and the only task this server
      // has is a season plan that takes milliseconds to rebuild. A durable store
      // would be pretending the work was expensive.
      taskStore: TASK_STORE,
      taskMessageQueue: TASK_QUEUE,
      instructions: instructionsFor(farmId),
    },
  );

  registerTools(server, () => farmId);
  speakErrorsPlainly(server);

  server.registerResource(
    'window',
    'ui://orbita/window.html',
    { title: 'Accuracy window', mimeType: 'text/html;profile=mcp-app' },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: 'text/html;profile=mcp-app', text: readFileSync(WINDOW_HTML, 'utf8') },
      ],
    }),
  );

  server.registerResource(
    'card',
    'ui://orbita/card.html',
    { title: 'Orbita card', mimeType: 'text/html;profile=mcp-app' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/html;profile=mcp-app', text: readFileSync(CARD_HTML, 'utf8') }],
    }),
  );

  return server;
}

const app = express();
// How many proxies in front of this process to believe.
//
// This used to be `trust proxy: true` unless a hop count was set, which is the opposite of what the
// comment beside it said: with no count configured, Express believed whatever X-Forwarded-For the
// caller sent. Every limit keyed on the caller's address (the sandbox rate limit, the stand-in and
// speech budgets, new-account claims) could then be walked around by sending a different made-up
// address with each request. The default is now to trust nothing.
//
// Behind API Gateway, set ORBITA_TRUST_PROXY=1: every request arrives from the gateway, so without
// it one noisy visitor would spend everyone's allowance, and with it Express reads the address the
// gateway recorded. It must stay unset when the process is reachable directly. The origin secret is
// what makes one hop safe to trust. Behind a tunnel in development, set it to 1 as well, so the
// OAuth URLs carry the scheme and host the client dialled (or set ORBITA_PUBLIC_URL).
const trustedHops = Number(process.env.ORBITA_TRUST_PROXY ?? 0);
app.set('trust proxy', Number.isInteger(trustedHops) && trustedHops > 0 ? trustedHops : false);

// Spec 2025-11-25: a Streamable HTTP server must answer 403 to an Origin it
// does not accept. Mounted before the body parser so a rejected request never
// has its payload read.
app.use(requireOrigin);
// And that it came through the gateway rather than off the street. See origin.ts
// for why a security group rule cannot express this.
app.use(requireOriginSecret);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

mountAuth(app);
// Where somebody who was added to the crew list agrees to it, or stops it. See consent.ts.
mountConsent(app);

// The phone on the demo page: the messages a sandbox visitor's crew would have been emailed, readable only
// with that visitor's own sandbox id. See notify.ts.
app.get('/demo/phone', (req, res) => {
  const id = demoIdOf(req);
  res.setHeader('Cache-Control', 'no-store');
  if (!id) return void res.status(401).json({ error: 'no_sandbox' });
  res.json({ messages: demoPhone(`demo:${id}`) });
});

app.get('/health', (_req, res) => {
  const snap = swpc.current();
  res.json({
    ok: true,
    transport: 'streamable-http',
    spec: '2025-11-25',
    auth: AUTH_ON ? 'oauth2.1+pkce' : 'off (local dev)',
    noaa: snap ? { slots: snap.slots.length, alerts: snap.alerts.length, ageMinutes: swpc.ageMinutes(), stale: snap.stale } : null,
    ground: { observatories: geomag.watched(), ageMinutes: geomag.ageMinutes() },
    ionosphere: glotec.status(),
    skyLinks: roti.status(),
    crewHeat: crewheat.status(),
    crewDays: crewday.status(),
    swpc: swpcplus.status(),
    aurora: aurora.status(),
    corrections: ntrip.status(),
    speech: speak.status(),
    storage: vault.status(),
    budgets: { agent: agentDaily.status(), speechCharacters: speakDaily.status() },
  });
});

/**
 * A host that opens a stream gets an answer, not silence.
 *
 * This server is stateless: there is no session to stream events into, so the
 * only useful verb is POST. Passing GET through to the transport left the
 * connection open with nothing ever sent, which a probe found as a hung request
 * and the gateway in front reported as a 503, as though the server were down.
 */
app.get('/mcp', (_req, res) => {
  res.status(405).set('Allow', 'POST').json({
    jsonrpc: '2.0',
    error: { code: -32601, message: 'This server is stateless. Send JSON-RPC over POST /mcp.' },
    id: null,
  });
});
app.delete('/mcp', (_req, res) => {
  res.status(405).set('Allow', 'POST').json({
    jsonrpc: '2.0',
    error: { code: -32601, message: 'This server is stateless. There is no session to end.' },
    id: null,
  });
});

/**
 * Strips the three keys that break argument parsing.
 *
 * Found by fuzzing: a tools/call whose arguments contain a key named "constructor" is answered with
 * "-32603 Internal error" and a raw dump of a validation library's issue list, from any tool, because the
 * SDK's schema parsing trips over a key that collides with Object.prototype. That is an upstream bug, and
 * the effect for us is the thing Amazon's requirements say never to do: expose an internal error. No
 * tool takes arguments with these names, so they are removed from the arguments before the request
 * reaches the SDK, and the call then behaves exactly like any other call with an argument nobody asked for.
 */
const UNSAFE_KEYS = ['constructor', 'prototype', '__proto__'];
function stripUnsafeKeys(value: unknown, depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 8) return;
  for (const key of UNSAFE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) delete (value as Record<string, unknown>)[key];
  }
  for (const child of Object.values(value as Record<string, unknown>)) stripUnsafeKeys(child, depth + 1);
}
const dropUnsafeArguments: express.RequestHandler = (req, _res, next) => {
  const body = req.body as unknown;
  for (const message of Array.isArray(body) ? body : [body]) {
    const params = (message as { params?: { arguments?: unknown } } | null)?.params;
    if (params?.arguments) stripUnsafeKeys(params.arguments);
  }
  next();
};

/**
 * A client that will take anything does take both of the two types the
 * transport insists on.
 *
 * The Streamable HTTP transport rejects a POST unless Accept names both
 * application/json and text/event-stream, which is what the spec asks clients
 * to send. But curl's default Accept is the wildcard, and a probe found that a
 * plain curl to this endpoint came back 406, which reads as a broken server
 * rather than a picky one. A wildcard is rewritten to the pair it already
 * covers. An Accept that names application/json and nothing else is left to be
 * refused, because that client really cannot read the stream we answer with.
 */
const widenWildcardAccept: express.RequestHandler = (req, _res, next) => {
  const accept = String(req.headers.accept ?? '').trim();
  const wildcard = !accept || accept.split(',').some((part) => part.trim().split(';')[0] === '*/*');
  if (wildcard) req.headers.accept = 'application/json, text/event-stream';
  next();
};


/**
 * A ceiling on how fast one caller can be served.
 *
 * The specification's security section asks servers to rate limit tool
 * invocations, and this endpoint is public. A token bucket: a burst of
 * __BURST__ is fine, and it refills at __RATE__ a second, which is far above
 * anything a voice conversation does and far below what a script does. The
 * bucket is per caller, so one noisy visitor cannot spend everyone else's.
 */
const BURST = Number(process.env.ORBITA_BURST ?? 600);
const REFILL_PER_SECOND = Number(process.env.ORBITA_REFILL ?? 10);
const buckets = new Map<string, { tokens: number; at: number }>();

function withinRate(key: string): boolean {
  const now = Date.now();
  const held = buckets.get(key) ?? { tokens: BURST, at: now };
  const refilled = Math.min(BURST, held.tokens + ((now - held.at) / 1000) * REFILL_PER_SECOND);
  if (refilled < 1) {
    buckets.set(key, { tokens: refilled, at: now });
    return false;
  }
  buckets.set(key, { tokens: refilled - 1, at: now });
  // Callers who have gone quiet and are back to a full bucket cost nothing to forget.
  if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.tokens >= BURST - 1) buckets.delete(k);
  return true;
}

/*
 * Who to charge for this request, worked out before authentication has run.
 * farmFrom throws on an unauthenticated request when auth is on, which is the
 * right thing for a tool call and the wrong thing here: a limiter that throws
 * turns a 401 into a 500, which a probe caught immediately.
 */
const callerKey = (req: express.Request): string => {
  try {
    const who = farmFrom(req);
    // A linked account is a stable identity and is charged as itself. A sandbox
    // identity is not: anyone can invent a new 128 bit id for free, so keying the
    // limiter on it gives every request a fresh bucket and turns every per caller
    // limit, including the ones on the paid endpoints, into decoration. Sandbox
    // callers are charged by network address instead.
    if (who.startsWith('acct:')) return who;
    return `ip:${req.ip ?? 'unknown'}`;
  } catch {
    return `ip:${req.ip ?? 'unknown'}`;
  }
};

const rateLimit: express.RequestHandler = (req, res, next) => {
  const key = callerKey(req);
  if (withinRate(key)) return next();
  res.status(429).set('Retry-After', '1').json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Too many requests. Slow down and try again in a moment.' },
    id: null,
  });
};


/**
 * What the paid endpoints are allowed to cost. See budget.ts for why there are two
 * kinds of limit and what each one is for.
 *
 * A model call is a few cents; 300 a day is roughly the price of a coffee and is far
 * more than a judge clicking through a demo will use. Speech is metered in characters
 * because that is what Polly bills, and a cache hit is free, so the same six canned
 * answers replayed all day cost six syntheses.
 */
const agentDaily = dailyCap(Number(process.env.ORBITA_AGENT_DAILY_MAX ?? 25));
const speakDaily = dailyCap(Number(process.env.ORBITA_SPEAK_DAILY_CHARS ?? 100_000));
// Burst and sustained rate per caller. A person typing into the stand-in does not
// send six requests a minute; the defaults are for people and the knobs are for tests
// and for an operator who has a reason.
const agentPerCaller = perCaller(Number(process.env.ORBITA_AGENT_BURST ?? 3), Number(process.env.ORBITA_AGENT_PER_MINUTE ?? 6));
const speakPerCaller = perCaller(Number(process.env.ORBITA_SPEAK_BURST ?? 5), Number(process.env.ORBITA_SPEAK_PER_MINUTE ?? 20));

/**
 * The Alexa+ stand-in.
 *
 * A model reads this server's own `tools/list` cold, decides what the sentence
 * means, and the chosen call is then executed through the real protocol. Both
 * halves are returned, so a viewer sees the decision and not only the answer.
 *
 * The round trip goes through an in-memory MCP transport rather than calling the
 * tool handlers directly. That costs a few milliseconds and buys the thing that
 * makes the demo worth anything: the schemas the model reads are the schemas the
 * protocol publishes, and the call it makes is validated and dispatched exactly
 * as a real host's would be. Reaching into the handler map would be testing a
 * function, not an add-on.
 */
app.post('/agent', requireAuth, async (req, res) => {
  // Identity and spend are checked before anything else, including whether the
  // stand-in is configured, so an unconfigured server cannot be used to find out
  // which of the two a caller failed.
  if (!agentPerCaller.allow(callerKey(req))) {
    res.status(429).set('Retry-After', '10').json({ error: 'slow_down', detail: 'Too many stand-in requests. Try again in a few seconds.' });
    return;
  }
  const utterance = typeof req.body?.say === 'string' ? req.body.say.slice(0, 500).trim() : '';
  if (!utterance) {
    res.status(400).json({ error: 'say_required' });
    return;
  }
  // Last, so a malformed request never spends a unit of the budget.
  // No model configured, or today's model budget spent: the word rules choose instead, and say so. See rules.ts.
  const useModel = agent.configured() && agentDaily.take(1);

  const server = build(farmFrom(req));
  const client = new Client({ name: 'alexa-plus-stand-in', version: '0.1.0' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const listed = await client.listTools();

    const chosen = useModel ? await agent.choose(utterance, listed.tools as agent.ToolDef[], client.getInstructions() ?? '') : chooseByWords(utterance, listed.tools as agent.ToolDef[]);

    // A decline is a real outcome and is reported as one. A host that calls
    // nothing when nothing fits is behaving correctly, and flattening that into
    // an error would hide the most interesting thing this can show.
    if (!chosen.tool) {
      res.json({ standIn: STAND_IN_NOTE, utterance, chose: null, said: chosen.said, ms: chosen.ms, model: chosen.model });
      return;
    }

    const result = await client.callTool({ name: chosen.tool, arguments: chosen.args });
    res.json({
      standIn: STAND_IN_NOTE,
      utterance,
      chose: { tool: chosen.tool, args: chosen.args },
      said: chosen.said,
      ms: chosen.ms,
      model: chosen.model,
      result,
    });
  } catch (err) {
    console.error('[agent]', err);
    res.status(502).json({ error: 'stand_in_failed', detail: agent.explainError(err) });
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
});


/**
 * Speak a sentence this server produced.
 *
 * For the demo page and the video only; it is not part of the MCP path, because
 * Alexa+ does its own speech and a server that also synthesised audio would be
 * duplicating work the host does better. The point is narrow: every sentence here
 * is written to be heard once by someone with their hands busy, and a page that
 * renders it as text cannot show whether that actually works.
 */
app.post('/speak', requireAuth, async (req, res) => {
  if (!speakPerCaller.allow(callerKey(req))) {
    res.status(429).set('Retry-After', '5').json({ error: 'slow_down' });
    return;
  }
  if (!speak.SPEAK_ON) {
    res.status(503).json({
      error: 'not_enabled',
      detail: 'Set ORBITA_SPEAK=on to enable spoken answers. The demo works as text without it.',
    });
    return;
  }
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (!speak.usable(text.trim().replace(/\s+/g, ' '))) {
    res.status(400).json({ error: 'not_speakable' });
    return;
  }
  // Characters are what Polly bills, and a sentence already held costs nothing, so
  // only a synthesis is charged against the day.
  if (!speak.isCached(text) && !speakDaily.take(text.trim().length)) {
    res.status(429).json({ error: 'daily_budget', detail: 'Spoken answers have reached their limit for today.' });
    return;
  }
  try {
    const out = await speak.speak(text);
    res.setHeader('content-type', 'audio/mpeg');
    // Cached by content hash server side; let the browser hold it too, since the
    // same canned answers are replayed constantly during a demo.
    res.setHeader('cache-control', 'public, max-age=3600');
    res.setHeader('x-orbita-cached', out.cached ? '1' : '0');
    res.send(Buffer.from(out.audio));
  } catch (err) {
    console.error('[speak]', err);
    res.status(502).json({ error: 'speak_failed' });
  }
});

app.all('/mcp', widenWildcardAccept, dropUnsafeArguments, rateLimit, requireAuth, async (req, res) => {
  const started = Date.now();
  // One id per request, echoed in any error logged while handling it, so a line
  // in the JSON log and a stack on stderr can be tied together.
  const traceId = trace.newTraceId();
  let failure: string | undefined;
  try {
    const server = build(farmFrom(req));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    failure = trace.errClass(err);
    // The message goes to stderr where a human will see it; the line below carries
    // only the class, because a message can contain whatever was interpolated
    // into it and these logs should be safe to attach to a bug report.
    console.error(`[mcp] ${traceId}`, err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  } finally {
    const snap = swpc.current();
    trace.log({
      t: new Date().toISOString(),
      id: traceId,
      method: typeof req.body?.method === 'string' ? req.body.method : undefined,
      tool: typeof req.body?.params?.name === 'string' ? req.body.params.name : undefined,
      ms: Date.now() - started,
      ok: !failure,
      who: trace.whoHash(farmFrom(req)),
      err: failure,
      // Which feed was stale when the answer was given. Without this, "the answer
      // was wrong on Tuesday" has nothing to check against.
      feeds: {
        noaa: swpc.ageMinutes(),
        wind: solarwind.ageMinutes(),
        tec: glotec.ageMinutes(),
        ground: geomag.ageMinutes(),
        aurora: aurora.ageMinutes(),
        stale: snap?.stale ? 1 : 0,
      },
    });
  }
});

// The demo page, and the panel file it embeds. Mounted after /mcp and the OAuth
// routes so a static file can never shadow an endpoint a client depends on.
const revalidate = (res: express.Response) => res.setHeader('Cache-Control', 'no-cache');
app.use(express.static(resolve('./web'), { setHeaders: revalidate }));
app.use('/ui', express.static(resolve('./ui'), { setHeaders: revalidate }));

await swpc.start();

// The minute by minute half: an estimated Kp and the solar wind at L1, which is
// where the extra half hour of warning comes from. Two of these feeds are about
// sixty bytes each, so a one minute poll costs nothing.
await solarwind.start();

// The ground truth half: INTERMAGNET observatories near fields that already
// exist. A restart must not lose this, or a farm registered last week would get
// no corroboration until somebody happened to add a field again, which is the
// kind of gap nobody notices because it looks exactly like a quiet day.
for (const [, farm] of store.allEntries()) {
  for (const field of farm.fields) {
    geomag.watch(field.lat, field.lon);
    glotec.watch(field.lat, field.lon);
    crewheat.watch(field.lat, field.lon);
  }
}
await geomag.start();

// The measured ionosphere, and the rest of the SWPC catalogue: Dst, the minute
// cadence Kp nowcast, the 45 day outlook a planting season actually needs, flare
// and proton probabilities, electron fluence, and the ICAO aviation advisories.
// These are started after the forecast so a slow 2.5 MB TEC map never delays the
// thing every answer depends on.
// Where the RTK base stations actually are, so baselineKm can be measured rather
// than remembered. Six hourly: the directory changes as volunteers come and go.
await Promise.allSettled([glotec.start(), swpcplus.start(), aurora.start(), ntrip.start(), roti.start()]);
// The crew's half of the same decision: the heat over each field for the hours a job would run. Not awaited,
// because nothing about whether the receiver holds its line should wait on a weather forecast.
void crewheat.start();

// Crew members who shared their working day: asked of the heat safety server every twenty minutes, one at a
// time, so an answer about a job never waits on another server. A link that server says has stopped is dropped.
const refreshCrewDays = async () => {
  if (!crewday.configured()) return;
  for (const [id, farm] of store.allEntries()) {
    for (const c of farm.crew) {
      if (!c.dayLink) continue;
      await crewday.refresh(c.dayLink);
      if (crewday.stopped(c.dayLink)) {
        const dead = c.dayLink;
        store.update(id, (x) => {
          const hit = x.crew.find((y) => y.dayLink === dead);
          if (hit) hit.dayLink = null;
        });
      }
    }
  }
};
void refreshCrewDays();
const crewDayTimer = setInterval(() => void refreshCrewDays(), 20 * 60 * 1000);
crewDayTimer.unref?.();

// Crew emails for watched jobs that clear and storms that are coming, on the NOAA refresh cadence.
const alertTimer = setInterval(() => {
  checkFieldAlerts().catch((err) => console.error('[alerts]', err));
}, 15 * 60 * 1000);
alertTimer.unref?.();

// Fields registered before times were said locally get their timezone looked up once.
for (const [farmId, farm] of store.allEntries()) {
  for (const field of farm.fields) {
    if (!field.timeZone) resolveFieldTimeZone(farmId, field.id, field.lat, field.lon);
  }
}
const snap = swpc.current();
console.log(
  snap?.slots.length
    ? `NOAA loaded: ${snap.slots.length} Kp slots, ${snap.alerts.length} alerts.`
    : `NOAA unreachable at boot: ${snap?.error ?? 'unknown'}`,
);

/*
 * Demo records are swept once a day. A profile made by a stranger on the demo
 * page has no reason to outlive their visit, and this one holds health details.
 */
const sweepTimer = setInterval(() => {
  const gone = store.expireDemoRecords();
  if (gone) console.log(`[store] expired ${gone} demo record${gone === 1 ? '' : 's'}`);
}, 24 * 60 * 60 * 1000);
sweepTimer.unref?.();
store.expireDemoRecords();

/*
 * Going down on purpose, and not going down by surprise.
 *
 * systemd sends SIGTERM on a redeploy. Without this the process dies mid
 * request and any write still in memory goes with it. And an unhandled
 * rejection anywhere in a background timer takes the whole server out on modern
 * Node, which for a background poll is the wrong trade entirely: log it and
 * keep answering.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[unhandled rejection]', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaught exception]', err.stack ?? err);
});

const listener = app.listen(PORT, () =>
  console.log(
    `orbita MCP on http://localhost:${PORT}/mcp  (auth: ${AUTH_ON ? 'OAuth 2.1 + PKCE' : 'off, set ORBITA_AUTH=on for Alexa+'})`,
  ),
);

/*
 * SIGTERM is what systemd sends on a redeploy. Closing the listener lets the
 * request in flight finish and stops a new one arriving, and the timer is there
 * because a request that will never finish must not hold a redeploy open.
 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[${signal}] closing`);
    listener.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
