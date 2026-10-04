/**
 * The people on the crew, by name, asked of the server that knows them.
 *
 * crewheat.ts says what the heat does to anybody: past 90, breaks every two hours. That is the same for the
 * operator who has run a planter for thirty Julys and the one who started on Monday, and those two are not
 * in the same danger. Of outdoor workers who died of heat, 79 percent were in their first two weeks on the
 * job or just back from time away, and what is safe also depends on things about a person that are nobody's
 * business on the farm.
 *
 * Sudor is the add-on that knows those things. A crew member who uses it can share their working day with a
 * one-time code. Orbita exchanges that code for a link, once, and from then on asks Sudor over MCP how that
 * person's day looks. What comes back is what a foreman needs and nothing more: how hot the shift gets, when
 * it turns risky for them, and how many hours of heat they should do while they are still getting used to
 * it. No medicine, no condition and no reason ever crosses, because Sudor does not send them.
 *
 * Asked in the background and answered from memory, like every other feed here. When Sudor cannot be
 * reached, or the person has stopped sharing, nothing is said about them.
 */

import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { backoff } from './backoff.js';

export type CrewDay = {
  label: string | null;
  peakHeatIndexF: number | null;
  peakAt: string | null;
  highFrom: string | null;
  /** When it turns risky for this person, only when that is earlier than for anybody. */
  riskyFrom: string | null;
  acclimatization: { kind: 'new' | 'returning'; day: number; heatHoursAllowed: number; doneBy: string } | null;
  fetchedAt: number;
};

const URL_BASE = (process.env.ORBITA_SUDOR_URL ?? '').trim().replace(/\/$/, '');
const SANDBOX_ID = randomBytes(16).toString('hex');
const TIMEOUT_MS = 5000;
const STALE_MS = 3 * 60 * 60 * 1000;
const FRESH_MS = 20 * 60 * 1000;

type Call = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;

/** One call to Sudor, over MCP, with a short fuse. The connection is opened and closed each time. */
async function callSudor(name: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  if (!URL_BASE) return null;
  const client = new Client({ name: 'orbita', version: '0.1.0' }, { capabilities: {} });
  // Sudor takes a linked account or a sandbox id. The sandbox carries nothing: the crew link in the
  // arguments is what says whose day this is, and Sudor checks it.
  const transport = new StreamableHTTPClientTransport(new globalThis.URL(`${URL_BASE}/mcp`), { requestInit: { headers: { 'x-sudor-demo': SANDBOX_ID } } });
  const cutOff = setTimeout(() => void transport.close().catch(() => {}), TIMEOUT_MS);
  try {
    await client.connect(transport);
    const result = (await client.callTool({ name, arguments: args })) as { structuredContent?: Record<string, unknown> };
    return result.structuredContent ?? null;
  } catch (err) {
    console.error('[crewday] could not reach the heat safety server:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(cutOff);
    try {
      await client.close();
    } catch {
      /* already gone */
    }
  }
}

let call: Call = callSudor;

/** Whether this server has been pointed at a Sudor to ask. */
export const configured = (): boolean => URL_BASE.length > 0 || call !== callSudor;

/** Exchange a crew member's one-time code for a link. Done once, when they are added. */
export async function join(code: string): Promise<{ ok: true; link: string } | { ok: false; why: 'unreachable' | 'refused' }> {
  const digits = String(code ?? '').replace(/\D/g, '');
  if (digits.length !== 8) return { ok: false, why: 'refused' };
  const sc = await call('share_my_day', { action: 'join', code: digits, as: 'crew' });
  if (!sc) return { ok: false, why: 'unreachable' };
  return sc.joined === true && typeof sc.crewLink === 'string' ? { ok: true, link: sc.crewLink } : { ok: false, why: 'refused' };
}

/** Only the fields a foreman needs, and only when they have the shape expected. Anything else is dropped. */
export function parse(sc: Record<string, unknown> | null, now = Date.now()): CrewDay | null {
  const crew = sc?.crew as Record<string, unknown> | undefined;
  if (!sc || sc.sharing !== true || !crew || typeof crew !== 'object') return null;
  const text = (v: unknown) => (typeof v === 'string' && v.length <= 40 ? v : null);
  const a = crew.acclimatization as Record<string, unknown> | null | undefined;
  const acclimatization =
    a && (a.kind === 'new' || a.kind === 'returning') && typeof a.day === 'number' && typeof a.heatHoursAllowed === 'number' && typeof a.doneBy === 'string'
      ? { kind: a.kind as 'new' | 'returning', day: a.day, heatHoursAllowed: a.heatHoursAllowed, doneBy: a.doneBy.slice(0, 20) }
      : null;
  return {
    label: text(crew.label),
    peakHeatIndexF: typeof crew.peakHeatIndexF === 'number' ? crew.peakHeatIndexF : null,
    peakAt: text(crew.peakAt),
    highFrom: text(crew.highFrom),
    riskyFrom: text(crew.riskyFrom),
    acclimatization,
    fetchedAt: now,
  };
}

const held = new Map<string, CrewDay>();
const gone = new Set<string>();
const gate = backoff();

/** Ask about one crew member, unless a fresh answer is already held. */
export async function refresh(link: string, force = false): Promise<void> {
  const have = held.get(link);
  if (!force && have && Date.now() - have.fetchedAt < FRESH_MS) return;
  if (!gate.ready()) return;
  const sc = await call('check_on', { crewLink: link });
  if (!sc) {
    gate.fail();
    return;
  }
  gate.ok();
  // They stopped sharing. Forget what was held at once, so yesterday's answer is not said about them today.
  if (sc.sharing === false) {
    held.delete(link);
    gone.add(link);
    return;
  }
  gone.delete(link);
  const day = parse(sc);
  if (day) held.set(link, day);
  if (held.size > 5000) held.delete(held.keys().next().value as string);
}

/** What is known about this crew member's day, or null when it is unknown or too old to say. */
export function dayFor(link: string | null | undefined, now = Date.now()): CrewDay | null {
  if (!link) return null;
  const d = held.get(link);
  return d && now - d.fetchedAt <= STALE_MS ? d : null;
}

/** Whether Sudor has said this link no longer works. */
export const stopped = (link: string | null | undefined): boolean => !!link && gone.has(link);

/**
 * What to say about named crew members: at most two sentences, the ones that change today's plan.
 * Somebody still getting used to the heat comes first, because that is who the numbers say is in danger.
 */
export function sentences(crew: { name: string; link?: string | null }[], now = Date.now()): string[] {
  const days = crew.map((c) => ({ name: c.name, day: dayFor(c.link, now) })).filter((x): x is { name: string; day: CrewDay } => x.day !== null);
  const out: string[] = [];
  for (const { name, day } of days) {
    if (!day.acclimatization) continue;
    const a = day.acclimatization;
    out.push(`${name} is on day ${a.day} ${a.kind === 'new' ? 'in the heat' : 'back in the heat'}: ${a.heatHoursAllowed} ${a.heatHoursAllowed === 1 ? 'hour' : 'hours'} of it today, done by ${a.doneBy}.`);
  }
  for (const { name, day } of days) {
    if (day.acclimatization || !day.riskyFrom) continue;
    out.push(`For ${name} the risky part starts at ${day.riskyFrom}.`);
  }
  if (out.length <= 2) return out;
  return [...out.slice(0, 2), `There ${out.length - 2 === 1 ? 'is 1 more' : `are ${out.length - 2} more`} on the crew to plan around: ask me about the crew.`];
}

export function status(): { configured: boolean; held: number } {
  return { configured: configured(), held: held.size };
}

export function configureForTest(fn: Call | null): void {
  call = fn ?? callSudor;
  held.clear();
  gone.clear();
  gate.reset();
}
