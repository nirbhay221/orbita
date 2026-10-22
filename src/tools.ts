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
import { shorten, more, morePage, inScope, sentences } from './brief.js';
import * as store from './store.js';
import { farmCountry, localiseUnits, metric } from './region.js';

/** An answer, spoken and structured, in the units of the country its fields are in. */
function localised<T>(r: T, country: string | null): T {
  if (!r || !metric(country)) return r;
  const x = r as unknown as { content?: { type?: string; text?: string }[]; structuredContent?: Record<string, unknown> };
  return {
    ...x,
    ...(x.content ? { content: x.content.map((c) => (typeof c.text === 'string' ? { ...c, text: localiseUnits(c.text, country) } : c)) } : {}),
    ...(x.structuredContent ? { structuredContent: JSON.parse(localiseUnits(JSON.stringify(x.structuredContent), country)) as Record<string, unknown> } : {}),
  } as unknown as T;
}
import * as setup from './tools/setup.js';
import * as decide from './tools/decide.js';
import * as history from './tools/history.js';
import * as crew from './tools/crew.js';
import * as records from './tools/records.js';
import * as roles from './tools/roles.js';
import * as discovery from './tools/discovery.js';
import * as season from './tools/season.js';
import * as agents from './tools/agents.js';
import * as schedule from './tools/schedule.js';

// Re-exported because alerts.ts and server.ts import them from here, and moving
// them to shared.ts should not make every caller learn the new layout.
export { statusOperations, resolveFieldTimeZone } from './tools/shared.js';
import { SPOKEN_ANSWER, say, ASK_FIRST_FIELD, ASK_CORRECTION, ASK_FIELD_FOR_MACHINE, OFFER_CHECK } from './tools/shared.js';
import { finish } from './finish.js';
import * as flow from './flow.js';

/**
 * The tools that are not part of the one story this add-on tells, which is a field job and whether it can run.
 * The list of everything else a storm is touching is real and tested, and it is a different product. It is
 * published when ORBITA_SCOPE is "all". See brief.ts.
 *
 * `what_should_i_do` used to be here too. It is one tool for seventeen kinds of operator, from a satellite
 * operator and a crew in orbit to a grid control room and a data centre, and hidden it meant none of them could
 * be answered on the deployed server and the demo page's own buttons for them said "I can't do that one". One
 * more tool in the list is the price of all of that being reachable.
 */
export const SECONDARY_TOOLS = ['what_else_is_affected'] as const;

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
      reading.run(readOnly, async () => {
        // A watch asked for straight after a check by town alone: "near Sorriso, Brazil… watch it for me". The check
        // saved nothing, so the watch had no field and answered "I need to know where the field is first". The town
        // and correction come with the watch, and are saved first, the same way my_farm saves them.
        if (name === 'watch_jobs') {
          const a = (args[0] ?? {}) as { action?: string; field?: string; place?: string; correction?: string };
          const farm = store.get(farmOf());
          // A town with no field name is the town just asked about, even when another field is saved: "near
          // Sorriso… watch it for me" was watched on the North 40 from an earlier question.
          if (a.action === 'start' && a.place && !(a.field && store.findField(farm, a.field))) {
            const fieldName = a.field || `Field near ${a.place.split(',')[0].trim()}`;
            await impl.get('my_farm')?.({ fieldName, place: a.place, ...(a.correction && !farm.equipment.length ? { machineName: 'my machine', correction: a.correction } : {}) });
            args[0] = { ...a, field: fieldName };
          }
        }
        const said = finish(name, args[0], shorten((await cb(...args)) as Parameters<typeof shorten>[0], farmOf(), { readOnly }));
        // Centimetres and kilometres where the fields are not in the United States. See region.ts.
        // The field the question is about decides the units: a farm with a field in Nebraska and one in Punjab
        // was answered in inches for both, because a mixed farm had no one country. Unnamed, it is the first field,
        // which is the one the tools default to.
        const fields = store.get(farmFor()).fields;
        const asked = String((args[0] as { field?: unknown } | undefined)?.field ?? '').toLowerCase();
        const about = asked ? fields.find((f) => f.id.toLowerCase() === asked || f.name.toLowerCase() === asked) : undefined;
        // A check by town alone saves no field, so the answer itself says which country it was about.
        const checked = (said as { structuredContent?: { countryCode?: unknown } }).structuredContent?.countryCode;
        const done = localised(said, about?.countryCode ?? (typeof checked === 'string' ? checked : null) ?? farmCountry(fields) ?? fields[0]?.countryCode ?? null);
        // The chain this answer is on: what was just done, the next step, and the ones after. See flow.ts.
        const sc = done?.structuredContent;
        if (!sc || done.isError) return done;
        const chain = flow.describe(farmOf(), name, (sc.nextAction ?? null) as { tool: string; arguments: Record<string, unknown> } | null);
        return chain ? { ...done, structuredContent: { ...sc, flow: chain } } : done;
      });
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
  agents.register(server, farmFor);
  schedule.register(server, farmFor);

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
          correction: z.enum(['rtk', 'ppp', 'sbas', 'autonomous']).optional().describe('The correction that machine runs: rtk, ppp, sbas (also WAAS, EGNOS or GAGAN in India) or autonomous for none (NavIC or plain GPS alone)'),
          notSure: z.boolean().optional().describe('true when they say they do not know or are not sure what correction the machine runs'),
          hardened: z.boolean().optional().describe('true only when they say the receiver has scintillation protection, such as Trimble IonoGuard or a scintillation-resistant PPP service'),
          removeWhat: z.enum(['field', 'machine', 'everything']).optional().describe('Only to take something off: a field, a machine, or everything when they say start over or delete my data'),
          removeName: z.string().optional().describe('The name of the field or machine to remove'),
        },
      },
      async (input: unknown) => {
        const a = (input ?? {}) as { fieldName?: string; place?: string; crop?: string; acres?: number; baselineKm?: number; machineName?: string; correction?: string; notSure?: boolean; hardened?: boolean; removeWhat?: string; removeName?: string };
        const call = (tool: string, args: Record<string, unknown>) => impl.get(tool)!(args) as Promise<Part>;
        if (a.removeWhat) return call('remove', { what: a.removeWhat, ...(a.removeName ? { name: a.removeName } : {}) });
        // "My field is near Sorriso" gives the town and no name. It used to save only the machine and then ask "which
        // field is it working, and what town is it near?", the town it had just been told. Named as watch_jobs names it.
        if (!a.fieldName && a.place && /[a-z0-9]/i.test(a.place)) a.fieldName = `Field near ${a.place.split(',')[0].trim()}`;
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
        if (a.machineName && (a.correction || a.notSure)) await step('register_equipment', { name: a.machineName, ...(a.correction ? { correction: a.correction } : { notSure: true }), ...(typeof a.hardened === 'boolean' ? { hardened: a.hardened } : {}) });
        // A machine with no correction and no "not sure": asked, never guessed.
        const askCorrection = !!a.machineName && !a.correction && !a.notSure;
        if (!said.length && !askCorrection) return say(ASK_FIRST_FIELD, { needs: 'field_or_machine', asks: 'field' });
        // Each step names its own next question. Only the last one still open is asked, and it is asked last.
        const offers = did.map((d) => (typeof d.offer === 'string' ? d.offer : '')).filter(Boolean);
        const added = said.filter(Boolean).join(' ');
        const farm = store.get(farmFor());
        const fieldMissing = !farm.fields.length;
        const offer = askCorrection
          ? ASK_CORRECTION(a.machineName, farmCountry(farm.fields))
          : fieldMissing
            ? ASK_FIELD_FOR_MACHINE
            : farm.equipment.length ? OFFER_CHECK : (offers[offers.length - 1] ?? '');
        const check = !askCorrection && !fieldMissing && farm.equipment.length > 0;
        return say(added || '', { did, ...(offer ? { offer } : {}), ...(check ? { nextAction: { tool: 'can_i_run', arguments: a.fieldName ? { field: a.fieldName } : {} } } : did.length ? { nextAction: { tool: 'farm_status', arguments: {} } } : {}) });
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
      // Advice that reads its own steps leaves its next page rather than held sentences.
      const page = next ? null : await morePage(farmOf());
      if (page) return say(page, { left: /more step/.test(page) ? 1 : 0 });
      if (!next) return say('There is nothing more on that. Ask me about a job, a field or the forecast.', { left: 0 });
      return say(next.left > 0 ? `${next.spoken} There is a little more if you want it.` : next.spoken, { left: next.left });
    },
  );
}
