/**
 * Streamable HTTP MCP server (spec 2025-11-25) for Alexa+.
 *
 * NOAA is polled on a 15-minute background timer, never inside a tool call,
 * so every request is served from memory and stays well inside the 500 ms budget.
 *
 * This file is the wiring: the MCP endpoint, the routes, and the start. The rest is beside it:
 *
 *   caller.ts      who a request is for, and who to charge for it
 *   guards.ts      what every MCP request passes through first
 *   standin.ts     the Alexa+ stand-in and speech, for the demo page
 *   background.ts  every feed kept up to date between requests, and the crew alert timer
 *   domain.ts      the one model every answer comes from: how far the sky moves a fix, by place and hour
 */

import * as roti from './roti.js';
import * as ground from './ground.js';
import * as machineAlerts from './machinealerts.js';
import { speakErrorsPlainly } from './plainly.js';
import express from 'express';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from './tools.js';
import { registerSkills } from './skill.js';
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
import { AUTH_ON, demoIdOf, mountAuth, requireAuth } from './auth.js';
import { requireOrigin, requireOriginSecret, originSecretConfigured } from './origin.js';
import * as speak from './speak.js';
import * as ntrip from './ntrip.js';
import * as trace from './trace.js';
import * as vault from './vault.js';
import { farmFrom, callerKey, requestCaller } from './caller.js';
import { dropUnsafeArguments, widenWildcardAccept, rateLimit } from './guards.js';
import { mountStandIn, budgetStatus } from './standin.js';
import { startBackground } from './background.js';

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

// Before anything reads the farms file. With ORBITA_REQUIRE_ENCRYPTION=on a missing
// key stops the process here, rather than letting it serve a farm's coordinates and
// its crew's addresses out of a plaintext file because somebody forgot a variable.
vault.assertRequirementMet();

const PORT = Number(process.env.PORT ?? 8788);
const WINDOW_HTML = resolve('./ui/window.html');
const CARD_HTML = resolve('./ui/card.html');

/* What this farm has already saved, as counts and never names, so a host calls the tool instead of asking. */
/*
 * Alexa+ is in early access in Brazil, Mexico, Germany, France, Italy, Spain and India, and the host is itself a
 * language model that answers in the customer's language. The answers here are written in English, so the host is
 * told which language the farm most likely speaks, and to keep every number and time exactly as given.
 */
const LANGUAGE: Record<string, string> = { DE: 'German', AT: 'German', FR: 'French', ES: 'Spanish', MX: 'Spanish', AR: 'Spanish', CO: 'Spanish', IT: 'Italian', BR: 'Portuguese', PT: 'Portuguese', IN: 'Hindi or English' };

function instructionsFor(farmId: string): string {
  const base =
        'This add-on turns the NOAA space weather forecast into decisions. It tells field crews, surveyors, drone ' +
        'mappers and grade crews whether GPS guidance will hold accuracy, and tells satellite, grid, airline, HF radio, ' +
        'timing, pipeline, drilling, rail, vessel positioning, shipping, undersea cable, mining, fleet, robot and ' +
        'magnetic survey operators, ' +
        'small plane pilots, aurora watchers and ' +
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
  const codes = [...new Set(f.fields.map((x) => (x.countryCode ?? '').toUpperCase()).filter(Boolean))];
  const lang = codes.length === 1 ? LANGUAGE[codes[0]] : undefined;
  const say = lang
    ? ` This farm's fields are where ${lang} is spoken: unless the customer speaks to you in English, give the answer in ${lang}, translating it faithfully, and keep every number, time and correction name (RTK, PPP, SBAS) exactly as given.`
    : '';
  return known.length
    ? `${base}${say} This farm has already saved ${known.join(' and ')}. Use them: do not ask which field, where it is, or what correction it runs.`
    : `${base}${say} This farm has not saved anything yet; a tool will say what it needs.`;
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

  // The Agent Skill for this add-on, readable from the same connection. See skill.ts.
  registerSkills(server);

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

  // What a scheduler for a fleet polls: each saved site and machine, out of tolerance or not, over three days.
  server.registerResource(
    'alerts',
    'orbita://alerts',
    {
      title: 'Alerts for machines',
      description: 'For each saved site and machine: whether the next three days put it out of tolerance, when, and the clear windows. Poll it; etag changes only when an alert does.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(machineAlerts.forFarm(store.get(farmId))) }],
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
// Which framework answers is nobody's business, and a response is never read as a type it does not declare.
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
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
    absorptionAndEfield: { ageMinutes: ground.ageMinutes() },
    ionosphere: glotec.status(),
    skyLinks: roti.status(),
    crewHeat: crewheat.status(),
    crewDays: crewday.status(),
    swpc: swpcplus.status(),
    aurora: aurora.status(),
    corrections: ntrip.status(),
    speech: speak.status(),
    storage: vault.status(),
    budgets: budgetStatus(),
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

mountStandIn(app, build);

app.all('/mcp', widenWildcardAccept, dropUnsafeArguments, rateLimit, requireAuth, async (req, res) => {
  const started = Date.now();
  // One id per request, echoed in any error logged while handling it, so a line
  // in the JSON log and a stack on stderr can be tied together.
  const traceId = trace.newTraceId();
  let failure: string | undefined;
  try {
    const who = farmFrom(req);
    // A write made elsewhere, such as an alert the scheduled check sent. A no-op for the file store.
    await store.refresh(who).catch((err) => console.error('[store] refresh failed:', err instanceof Error ? err.message : err));
    const server = build(who);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await requestCaller.run(callerKey(req), () => transport.handleRequest(req, res, req.body));
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

// The farms table, read before anything uses it. Nothing for the file, which loads itself.
await store.init();
await startBackground();

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
    // A change still on its way to DynamoDB goes out before the process does.
    listener.close(() => void store.flush().catch((err) => console.error('[store]', err)).finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
