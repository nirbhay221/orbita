import { z } from 'zod';
/**
 * Every tool this add-on publishes, grouped by what it is for.
 *
 * This file used to be 1,324 lines with fifteen tools inside one function. That
 * is past the point where a reader can find anything in it, and well past the
 * point where a reviewer keeps reading the diff. The tools are the same; they now
 * live in one file per job, and this is the index.
 *
 * Registration order is deliberate and worth keeping. A host reads `tools/list`
 * in the order the server declares them, and the order is roughly the order a
 * customer meets them: get a farm on the books, ask the question, look at what
 * happened, tell somebody, keep the record, then the wider roles and the
 * discovery tools. `plan_season` is last because it is the only task-based tool
 * and the only one that answers about a season rather than a day.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { shorten, more, inScope, sentences } from './brief.js';
import * as store from './store.js';
import * as setup from './tools/setup.js';
import * as decide from './tools/decide.js';
import * as history from './tools/history.js';
import * as crew from './tools/crew.js';
import * as records from './tools/records.js';
import * as roles from './tools/roles.js';
import * as discovery from './tools/discovery.js';
import * as season from './tools/season.js';

// Re-exported because alerts.ts and server.ts import them from here, and moving
// them to shared.ts should not make every caller learn the new layout.
export { statusOperations, resolveFieldTimeZone } from './tools/shared.js';
import { SPOKEN_ANSWER, say } from './tools/shared.js';
import { finish } from './finish.js';

/**
 * The tools that are not part of the one story this add-on tells, which is a field job and whether it can run.
 * Advice for satellite operators, grid control rooms and aurora watchers is real and tested, and it is a
 * different product. It is published when ORBITA_SCOPE is "all". See brief.ts.
 */
export const SECONDARY_TOOLS = ['what_should_i_do', 'what_else_is_affected'] as const;

/** Whether the tool now running only reads. A read may look at a farm the caller was invited to; a write never does. */
const reading = new AsyncLocalStorage<boolean>();

/**
 * Tools folded into another one on the default surface.
 *
 * Anthropic's guidance on writing tools is to consolidate related operations into fewer tools, because fewer,
 * more capable tools are chosen between more reliably and cost a host less to carry. Adding a field, adding a
 * machine and taking either off again were one job, describing the farm, split three ways. They are now
 * `my_farm`, so "my field is near Yuma and the planter runs RTK" is one call.
 *
 * With ORBITA_SCOPE=all the original tools are listed as they always were, and `my_farm` is not.
 */
export const MERGED_AWAY = ['register_field', 'register_equipment', 'remove'] as const;

/**
 * Leave the folded tools out of tools/list, and nowhere else.
 *
 * They stay registered and callable, so a host that learned the old names, the demo pages and the other
 * server that calls this one all keep working. Amazon's rule is that every tool listed must be invocable,
 * which holds; it does not say every invocable tool must be listed.
 */
function hideFromList(server: McpServer, hidden: readonly string[]): void {
  const handlers = (server as unknown as { server?: { _requestHandlers?: Map<string, (req: unknown, extra: unknown) => Promise<{ tools?: { name: string }[] }>> } }).server?._requestHandlers;
  const list = handlers?.get('tools/list');
  if (!handlers || !list) return;
  handlers.set('tools/list', async (req, extra) => {
    const res = await list(req, extra);
    return { ...res, tools: (res.tools ?? []).filter((t) => !hidden.includes(t.name)) };
  });
}

type Callback = (...args: unknown[]) => unknown;

export function registerTools(server: McpServer, farmOf: () => string): void {
  const scope = process.env.ORBITA_SCOPE;
  const raw = server.registerTool.bind(server) as (name: string, config: Record<string, unknown>, cb: unknown) => unknown;
  const impl = new Map<string, Callback>();
  const merged = (scope ?? 'core').toLowerCase() !== 'all';

  // The farm a tool works on. A tool that only reads looks at the farm the caller was invited to, when there
  // is one; every tool that writes works on the caller's own record, whatever they were invited to.
  const farmFor = (): string => {
    const own = farmOf();
    return reading.getStore() ? store.viewedBy(own) ?? own : own;
  };

  // One wrapper, so no tool can be the one that forgets: an output schema, the published scope, the farm a
  // read is about, and an answer short enough to listen to (brief.ts).
  (server as unknown as { registerTool: unknown }).registerTool = (name: string, config: Record<string, unknown>, cb: Callback) => {
    if (!inScope(name, SECONDARY_TOOLS, scope)) return undefined;
    impl.set(name, cb);
    const readOnly = (config.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint === true;
    const wrapped = (...args: unknown[]) =>
      reading.run(readOnly, async () => finish(name, args[0], shorten((await cb(...args)) as Parameters<typeof shorten>[0], farmOf(), { readOnly })));
    return raw(name, { outputSchema: SPOKEN_ANSWER, ...config }, wrapped);
  };

  setup.register(server, farmFor);
  decide.register(server, farmFor);
  history.register(server, farmFor);
  crew.register(server, farmFor);
  records.register(server, farmFor);
  roles.register(server, farmFor);
  discovery.register(server, farmFor);
  season.register(server, farmFor);

  if (merged) {
    type Part = { content?: { text?: string }[]; structuredContent?: Record<string, unknown> };
    (server as unknown as { registerTool: (n: string, c: Record<string, unknown>, cb: Callback) => unknown }).registerTool(
      'my_farm',
      {
        title: 'My fields and machines',
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        description:
          'Describe the operation: add or correct a field or site by its name and nearest town, add or correct a ' +
          'machine by its name and the correction it runs, or take one off the list. Call this when someone says where a ' +
          'field or site is, what correction a planter, sprayer, rover, drone or dozer runs, or asks to remove a field or ' +
          'a machine or to forget everything. A field and a machine can be given together. It only records them; for ' +
          'whether a job can run use can_i_run, and for people on the crew use crew_contact.',
        inputSchema: {
          fieldName: z.string().optional().describe('Name of the field or site, as spoken, e.g. "North 40"'),
          place: z.string().optional().describe('The nearest town to that field, with state or country, as spoken'),
          crop: z.string().optional().describe('What is grown there, if said'),
          acres: z.number().positive().optional().describe('Size of the field in acres, if said'),
          baselineKm: z.number().positive().optional().describe('Distance to the RTK base station in kilometres, if they know it'),
          machineName: z.string().optional().describe('Name of the machine, e.g. "planter", "sprayer", "rover"'),
          correction: z.enum(['rtk', 'ppp', 'sbas', 'autonomous']).optional().describe('The correction that machine runs: rtk, ppp, sbas (also WAAS or EGNOS) or autonomous for none'),
          removeWhat: z.enum(['field', 'machine', 'everything']).optional().describe('Only to take something off: a field, a machine, or everything when they say start over or delete my data'),
          removeName: z.string().optional().describe('The name of the field or machine to remove'),
        },
      },
      async (input: unknown) => {
        const a = (input ?? {}) as { fieldName?: string; place?: string; crop?: string; acres?: number; baselineKm?: number; machineName?: string; correction?: string; removeWhat?: string; removeName?: string };
        const call = (tool: string, args: Record<string, unknown>) => impl.get(tool)!(args) as Promise<Part>;
        if (a.removeWhat) return call('remove', { what: a.removeWhat, ...(a.removeName ? { name: a.removeName } : {}) });
        const said: string[] = [];
        const did: { tool: string; [k: string]: unknown }[] = [];
        const step = async (tool: string, args: Record<string, unknown>) => {
          const r = await call(tool, args);
          said.push(r.content?.[0]?.text ?? '');
          const { spoken: _spoken, card: _card, ...rest } = r.structuredContent ?? {};
          did.push({ tool, ...rest });
        };
        // The field, then the machine, so the answer ends on what to ask next.
        if (a.fieldName) {
          await step('register_field', { name: a.fieldName, ...(a.place ? { place: a.place } : {}), ...(a.crop ? { crop: a.crop } : {}), ...(a.acres ? { acres: a.acres } : {}), ...(a.baselineKm ? { baselineKm: a.baselineKm } : {}) });
        }
        if (a.machineName && a.correction) await step('register_equipment', { name: a.machineName, correction: a.correction });
        if (a.machineName && !a.correction) said.push(`What correction does ${a.machineName} run: RTK, WAAS, PPP or none?`);
        if (!said.length) return say('Tell me a field and its nearest town, or a machine and the correction it runs.', { needs: 'field_or_machine' });
        // Each half ends by asking for the other. When both were given, neither question is left to ask.
        const both = !!a.fieldName && !!a.machineName && !!a.correction;
        const kept = said.filter(Boolean).flatMap((t) => sentences(t)).filter((x) => !both || !/^Now tell me\b/.test(x));
        return say(kept.join(' '), { did, ...(did.length ? { nextAction: { tool: 'farm_status', arguments: {} } } : {}) });
      },
    );
    hideFromList(server, MERGED_AWAY);
  }

  // The rest of the last answer. Registered directly: it is the thing that reads out what was held back, so
  // it must not be shortened itself.
  raw(
    'tell_me_more',
    {
      title: 'Go on',
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
      description:
        'Continue the last answer. Answers are kept short for listening, and the detail is held back until asked ' +
        'for. Call this when the customer says go on, tell me more, why, what else, give me the detail or the ' +
        'rest, straight after another answer. It takes no arguments and only continues; it does not answer a new question.',
      inputSchema: {},
      outputSchema: SPOKEN_ANSWER,
    },
    async () => {
      const next = more(farmOf());
      if (!next) return say('There is nothing more on that. Ask me about a job, a field or the forecast.', { left: 0 });
      return say(next.left > 0 ? `${next.spoken} There is a little more if you want it.` : next.spoken, { left: next.left });
    },
  );
}
