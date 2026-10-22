/**
 * Two tools added beside the rest: fit a week's jobs into the clear hours, and count the hours the sky took before.
 *
 * Neither changes what any other tool says. schedule_jobs reads the same NOAA forecast can_i_run does and places
 * work only in blocks clearWindows calls clear; outage_patterns reads the GFZ archive what_happened already reads.
 * The logic is in schedule.ts.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as store from '../store.js';
import * as swpc from '../swpc.js';
import * as history from '../history.js';
import { scheduleJobs, lostHours, speakLost, PERIOD_DAYS, type JobAsk } from '../schedule.js';
import type { Operation } from '../domain.js';
import { NO_FIELDS, NO_EQUIP, NOAA_DOWN, OPERATIONS, OPERATION_HINT, say, clean, namesOf, statusOperations } from './shared.js';

export function register(server: McpServer, farmOf: () => string): void {
  server.registerTool(
    'schedule_jobs',
    {
      title: 'Fit my jobs into the clear hours',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'Puts the hours of work a customer needs into the hours space weather leaves clear over the next three days, ' +
        'from the NOAA forecast: "I need twelve hours of planting and six of spraying" comes back as when to run each, ' +
        'on which machine, around storm blocks and, near the magnetic equator, the evening plasma bubble hours. The ' +
        'tightest job is fitted first; one machine does one job at a time. Pass fromHour and toHour for their working ' +
        'hours. Call this when they say how many hours of which jobs they need to get done, or ask when to schedule ' +
        'work this week. For one job right now use can_i_run; for which weeks to book use plan_season.',
      inputSchema: {
        jobs: z
          .array(z.object({
            operation: z.enum(OPERATIONS).describe(OPERATION_HINT),
            hours: z.number().min(1).max(72).describe('Hours of work the job needs'),
            equipment: z.string().optional().describe('Machine name as spoken; defaults to the first registered'),
          }))
          .min(1)
          .max(6)
          .describe('The jobs and the hours each needs'),
        field: z.string().optional().describe('Field name as spoken; defaults to the only or first field'),
        fromHour: z.number().int().min(0).max(23).optional().describe('Hour the working day starts where the field is, 0 to 23, when they say'),
        toHour: z.number().int().min(1).max(24).optional().describe('Hour the working day ends, 1 to 24'),
      },
    },
    async ({ jobs, field, fromHour, toHour }) => {
      const farm = store.get(farmOf());
      if (!farm.fields.length) return say(NO_FIELDS, { needs: 'field' });
      if (!farm.equipment.length) return say(NO_EQUIP, { needs: 'equipment' });
      const f = store.findField(farm, field ?? '');
      if (!f) return say(`I don't have a field called "${clean(field)}".${namesOf(farm.fields)} Which one did you mean?`);
      const snap = swpc.current();
      if (!snap?.slots.length) return say(NOAA_DOWN, { unavailable: true });
      // A machine named and not on the farm is asked about. Planned on the first machine instead, "ten hours on the
      // combine" was answered for the planter without a word.
      const unknown = jobs.map((j) => j.equipment).find((e) => e && !store.equipmentNamed(farm, e));
      if (unknown) return say(`I don't have a machine called "${clean(unknown)}".${namesOf(farm.equipment)} Which one will do it?`, { needs: 'equipment' });
      const asks: JobAsk[] = jobs.map((j) => ({ operation: j.operation as Operation, hours: j.hours, eq: store.findEquipment(farm, j.equipment) ?? farm.equipment[0], field: f }));
      const plan = scheduleJobs(snap.slots, asks, new Date(), { fromHour, toHour: toHour === 24 ? 0 : toHour });
      return say(plan.spoken, {
        field: f.name,
        timeZone: f.timeZone ?? null,
        horizonEnds: plan.horizonEnds,
        jobs: plan.placed.map((p) => ({ operation: p.operation, machine: p.machine, asked: p.asked, placed: p.placed, blocks: p.blocks })),
        source: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json',
      });
    },
  );

  server.registerTool(
    'outage_patterns',
    {
      title: 'How many hours space weather cost me',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'Looks back over the last week, month or year at a field and counts the working hours space weather would have ' +
        'held each job on its machine: how many hours and days, the worst day, how many were the evening plasma bubble ' +
        'hours near the magnetic equator rather than storms, and for a year the month that cost most. From the GFZ Kp ' +
        'archive. Call this for how much GPS downtime they had, how many hours storms cost this month or year, or ' +
        'patterns over the season. It looks back; for days ahead use schedule_jobs or plan_season.',
      inputSchema: {
        period: z.enum(['week', 'month', 'year']).optional().describe('How far back: week, month or year; month unless they say'),
        operation: z.enum(OPERATIONS).optional().describe(`${OPERATION_HINT} Leave it out to report the jobs that matter for the machine`),
        field: z.string().optional().describe('Field name as spoken; defaults to the only or first field'),
        equipment: z.string().optional().describe('Machine name as spoken; defaults to the first registered'),
      },
    },
    async ({ period, operation, field, equipment }) => {
      const farm = store.get(farmOf());
      if (!farm.fields.length) return say(NO_FIELDS, { needs: 'field' });
      if (!farm.equipment.length) return say(NO_EQUIP, { needs: 'equipment' });
      const f = store.findField(farm, field ?? '');
      if (!f) return say(`I don't have a field called "${clean(field)}".${namesOf(farm.fields)} Which one did you mean?`);
      if (equipment && !store.equipmentNamed(farm, equipment)) return say(`I don't have a machine called "${clean(equipment)}".${namesOf(farm.equipment)} Which one did you mean?`, { needs: 'equipment' });
      const eq = store.findEquipment(farm, equipment) ?? farm.equipment[0];
      let p = period ?? 'month';
      const now = new Date();
      const since = (q: typeof p) => new Date(now.getTime() - PERIOD_DAYS[q] * 86_400_000 - 3 * 3_600_000);
      let slots;
      // A year needs the GFZ archive. When it is down, the last month from NOAA is said instead, and said to be.
      let shorter = '';
      try {
        slots = await history.fetchRange(since(p), now);
      } catch {
        if (p !== 'year') return say("I can't reach the Kp archive right now. Ask me again in a few minutes.", { unavailable: true });
        try {
          slots = await history.fetchRange(since('month'), now);
          shorter = "The archive for the whole year isn't answering right now, so here is the last month. ";
          p = 'month';
        } catch {
          return say("I can't reach the Kp archive right now. Ask me again in a few minutes.", { unavailable: true });
        }
      }
      if (!slots.length) return say("The Kp archive didn't have those days. Ask me again in a few minutes.", { unavailable: true });
      // With no job named, the farm job the machine is bought for: planting on a centimetre rig, spraying otherwise.
      const usual = statusOperations(eq.correction);
      const ops = [operation ?? (usual.includes('planting') ? 'planting' : usual[0])] as Operation[];
      const lost = lostHours(slots, ops.map((o) => ({ operation: o, eq })), f, p, now);
      const source = history.fromNoaa.has(slots) ? 'https://services.swpc.noaa.gov/text/daily-geomagnetic-indices.txt' : 'https://kp.gfz.de/en/data';
      return say(`${shorter}${speakLost(lost, f.name, p)}`, { field: f.name, period: p, asked: period ?? 'month', jobs: lost, source });
    },
  );
}
