/**
 * The answer that does not fit in a turn.
 *
 * One of the grouped tool modules split out of tools.ts. The code is unchanged
 * from when it lived there; only the file it lives in is new.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  assess, nextWindow, thresholdKp, TOLERANCE_M, degradedOptions, deadlinePressure, geomagneticLatitude,
  auroralBoundaryDeg,
  type Correction, type Operation,
} from '../domain.js';
import { activeImpacts, speakImpacts } from '../impacts.js';
import * as swpc from '../swpc.js';
import * as solarwind from '../solarwind.js';
import * as geomag from '../geomag.js';
import * as glotec from '../glotec.js';
import * as swpcplus from '../swpcplus.js';
import * as aurora from '../aurora.js';
import { chooseOne, canAsk } from '../elicit.js';
import * as season from '../season.js';
import * as store from '../store.js';
import * as history from '../history.js';
import { advise, ROLES, ROLE_HINT, type Role } from '../playbook.js';
import { sendEmail, emailConfigured } from '../notify.js';
import { lookupTimeZone, spokenTime } from '../timezone.js';
import {
  NO_FIELDS,
  SPOKEN_ANSWER,
  NO_EQUIP,
  OPERATIONS,
  UI,
} from './shared.js';

export function register(server: McpServer, farmOf: () => string): void {
  /* ---------------------------------------------------------------- *
   * The answer that does not fit in a turn.
   *
   * Tasks are new in spec 2025-11-25: the host calls, gets a handle, polls, and
   * fetches the result when it has somewhere to put it. A season plan is a table
   * with a row per field and per window, which belongs on a screen rather than
   * read aloud, so the shape fits.
   *
   * Registered through the SDK's experimental surface and guarded, because
   * `experimental.tasks` is explicitly documented as liable to change without
   * notice and a server that will not boot is worse than one missing a tool.
   * taskSupport is 'optional' rather than 'required' so a host that cannot poll
   * is not handed a tool it can never call.
   * ---------------------------------------------------------------- */
  const tasks = (server as unknown as { experimental?: { tasks?: { registerToolTask?: Function } } })
    .experimental?.tasks;
  if (typeof tasks?.registerToolTask === 'function') {
    const buildPlan = () => {
      const farm = store.get(farmOf());
      return season.plan(farm.fields, farm.equipment, [...OPERATIONS] as Operation[]);
    };

    // Null from plan() has three causes and only two of them are the customer's to
    // fix. Saying "no fields registered" to someone who has three, because the NOAA
    // outlook has not loaded, sends them to re-enter data that was never the problem.
    const whyNoPlan = (): string => {
      const farm = store.get(farmOf());
      if (!farm.fields.length) return NO_FIELDS;
      if (!farm.equipment.length) return NO_EQUIP;
      return 'The 45 day outlook from NOAA is not available right now, so I cannot plan the season. Ask again in a few minutes, or ask about today.';
    };

    tasks.registerToolTask(
      'plan_season',
      {
        title: 'Plan the season',
        description:
          'Work out which jobs hold accuracy on which fields across the next 45 days, from the NOAA 45 day Ap ' +
          'forecast. Use this for questions about weeks rather than today: when to book a custom crew, which ' +
          'week to plan planting, whether a machine can hold a tolerance at all. The spoken answer gives the ' +
          'longest clear run; the full table is in the structured result for a host that has a screen.',
        inputSchema: {},
        outputSchema: SPOKEN_ANSWER,
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        execution: { taskSupport: 'optional' },
        _meta: { ui: { resourceUri: UI } },
      },
      {
        createTask: async (_args: unknown, extra: { taskStore: { createTask: Function; storeTaskResult?: Function } }) => {
          // Five minutes is far longer than the work needs and short enough that
          // an abandoned poll does not hold a slot indefinitely.
          const task = await extra.taskStore.createTask({ ttl: 5 * 60_000 });
          // Computed synchronously from feeds already in memory, then stored, so
          // there is no window where the task exists with nothing behind it.
          try {
            const built = buildPlan();
            await extra.taskStore.storeTaskResult?.(
              task.taskId,
              built ? 'completed' : 'failed',
              built
                ? { content: [{ type: 'text', text: season.summarise(built) }], structuredContent: { spoken: season.summarise(built), ...built } }
                : { content: [{ type: 'text', text: whyNoPlan() }], isError: true },
            );
          } catch (err) {
            await extra.taskStore.storeTaskResult?.(task.taskId, 'failed', {
              content: [{ type: 'text', text: 'The season plan could not be built.' }],
              isError: true,
            });
            console.error('[plan_season]', err);
          }
          return { task };
        },
        getTask: async (_args: unknown, extra: { taskId: string; taskStore: { getTask: Function } }) =>
          extra.taskStore.getTask(extra.taskId),
        getTaskResult: async (_args: unknown, extra: { taskId: string; taskStore: { getTaskResult: Function } }) =>
          extra.taskStore.getTaskResult(extra.taskId),
      },
    );
  }
}
