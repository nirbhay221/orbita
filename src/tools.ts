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
import { SPOKEN_ANSWER } from './tools/shared.js';

export function registerTools(server: McpServer, farmOf: () => string): void {
  // Declare the output schema once, here, rather than on every tool in every file, so a tool added later
  // cannot be the one that forgets. A tool that sets its own outputSchema keeps it.
  const registerTool = server.registerTool.bind(server) as (name: string, config: Record<string, unknown>, cb: unknown) => unknown;
  (server as unknown as { registerTool: unknown }).registerTool = (name: string, config: Record<string, unknown>, cb: unknown) =>
    registerTool(name, { outputSchema: SPOKEN_ANSWER, ...config }, cb);
  setup.register(server, farmOf);
  decide.register(server, farmOf);
  history.register(server, farmOf);
  crew.register(server, farmOf);
  records.register(server, farmOf);
  roles.register(server, farmOf);
  discovery.register(server, farmOf);
  season.register(server, farmOf);
}
