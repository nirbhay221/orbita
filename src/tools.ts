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
import { shorten, more, inScope } from './brief.js';
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

/**
 * The tools that are not part of the one story this add-on tells, which is a field job and whether it can run.
 * Advice for satellite operators, grid control rooms and aurora watchers is real and tested, and it is a
 * different product. It is published when ORBITA_SCOPE is "all". See brief.ts.
 */
export const SECONDARY_TOOLS = ['what_should_i_do', 'what_else_is_affected'] as const;

/** Whether the tool now running only reads. A read may look at a farm the caller was invited to; a write never does. */
const reading = new AsyncLocalStorage<boolean>();

type Callback = (...args: unknown[]) => unknown;

export function registerTools(server: McpServer, farmOf: () => string): void {
  const scope = process.env.ORBITA_SCOPE;
  const raw = server.registerTool.bind(server) as (name: string, config: Record<string, unknown>, cb: unknown) => unknown;

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
    const readOnly = (config.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint === true;
    const wrapped = (...args: unknown[]) =>
      reading.run(readOnly, async () => shorten((await cb(...args)) as Parameters<typeof shorten>[0], farmOf(), { readOnly }));
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
