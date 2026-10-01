/**
 * What happened before, and what to watch for next.
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
  NOAA_DOWN,
  NO_EQUIP,
  NO_FIELDS,
  OPERATIONS,
  OPERATION_HINT,
  UI,
  andList,
  asked,
  clean,
  count,
  kpRightNow,
  localTime,
  say,
} from './shared.js';

export function register(server: McpServer, farmOf: () => string): void {
  /* ---------------------------------------------------------------- *
   * Looking backward. A forecast that is obeyed can never prove itself,
   * so this is what makes the forward-looking half believable.
   * ---------------------------------------------------------------- */
  server.registerTool(
    'what_happened',
    {
      title: 'Why did that job go wrong?',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'Look back at a past day and say whether space weather explains a job that went badly. ' +
        'Use when the farmer describes crooked rows, skips, overlap, or a machine that seemed to be misbehaving. ' +
        'If the conditions were quiet, say so plainly rather than inventing a cause. It looks backwards only; for whether a ' +
        'job can run now or later, use can_i_run.',
      inputSchema: {
        when: z.string().describe('When it happened, spoken or ISO, e.g. "last Tuesday", "10 May 2024"'),
        operation: z.enum(OPERATIONS).optional().describe(OPERATION_HINT),
        field: z.string().optional().describe('Field name as spoken, such as "North 40"; defaults to the only or first field'),
        equipment: z.string().optional().describe('Machine name as spoken, such as "the planter"; defaults to the first registered'),
      },
      _meta: { ui: { resourceUri: UI } },
    },
    async ({ when, operation, field, equipment }) => {
      const farm = store.get(farmOf());
      if (!farm.fields.length) return say(NO_FIELDS);
      const f = store.findField(farm, field ?? '');
      const eq = store.findEquipment(farm, equipment);
      if (!f || !eq) return say(NO_EQUIP);

      const at = history.parseWhen(when);
      if (!at) return say(`I could not work out what date "${when}" means. Try a day name or a date.`);
      if (at.getTime() > Date.now()) return say('That is in the future. Ask me whether you can run instead.');

      // The 15 minute NOAA poll already holds roughly the last seven days in memory.
      // Use it when the date falls inside that, and only reach for the archive for
      // older questions, so the common case ("last Tuesday") never leaves the process.
      const dayStart = new Date(at); dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = dayStart.getTime() + 24 * 3600_000;
      const cached = (swpc.current()?.slots ?? []).filter((sl) => {
        const t = new Date(sl.time).getTime();
        return sl.observed && t >= dayStart.getTime() && t < dayEnd;
      });

      let slots = cached;
      let fromArchive = false;
      if (slots.length < 8) {
        try {
          slots = await history.fetchDay(at);
          fromArchive = true;
        } catch {
          if (!cached.length) return say('I could not reach the Kp archive to check that day.');
          slots = cached;
        }
      }
      if (!slots.length) return say(`No Kp records for ${at.toISOString().slice(0, 10)}.`);

      const op = (operation ?? 'planting') as Operation;
      const peak = slots.reduce((a, b) => (b.kp > a.kp ? b : a));
      const worst = assess(op, peak.kp, eq, f);
      const badBlocks = slots.filter((sl) => !assess(op, sl.kp, eq, f).go);
      // Kp is a UTC index. Rendering the label in local time shifted the date back
      // a day, so a question about 11 May came back answered about 10 May.
      const dayLabel = at.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
      });
      const peakTime = new Date(peak.time).toLocaleString('en-US', {
        hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
      });

      const text = worst.go
        ? `Space weather was not the problem on ${dayLabel}. Kp peaked at only ${peak.kp.toFixed(1)}, ` +
          `and your drift would have stayed around ${worst.expectedErrorM < 0.076 ? (worst.expectedErrorM * 39.37).toFixed(1) : Math.round(worst.expectedErrorM * 39.37)} inches all day. ` +
          `Something else caused that.`
        : `That was the sun. On ${dayLabel} Kp peaked at ${peak.kp.toFixed(1)} (${worst.gScale}) around ` +
          `${peakTime}, putting expected drift near ` +
          `${worst.expectedErrorM >= 1 ? `${worst.expectedErrorM.toFixed(1)} metres` : `${Math.round(worst.expectedErrorM * 39.37)} inches`}, ` +
          `about ${(worst.expectedErrorM / worst.quietErrorM).toFixed(0)} times your normal. ` +
          `${badBlocks.length} of ${slots.length} three-hour blocks that day were outside ${op} tolerance.`;

      const dayKey = at.toISOString().slice(0, 10);
      const logged = farm.jobLog.filter((j) => j.at.slice(0, 10) === dayKey);
      const jobsLine = logged.length
        ? ` You logged ${logged.length === 1 ? 'one job' : `${logged.length} jobs`} that day: ${logged
            .slice(0, 3)
            .map((j) => `${j.operation.replace(/_/g, ' ')} on ${j.fieldName}`)
            .join(', ')}.`
        : '';
      return say(text + jobsLine, {
        ...worst,
        loggedJobs: logged,
        date: dayKey,
        field: f.name,
        equipment: eq.name,
        correction: eq.correction,
        peak: { kp: peak.kp, time: peak.time },
        blocksAffected: badBlocks.length,
        blocksTotal: slots.length,
        slots: slots.slice(0, 24),
        thresholdKp: thresholdKp(op, eq, f),
        historical: true,
        source: fromArchive ? 'gfz-archive' : 'noaa-cache',
      });
    },
  );

  /*
   * One door for waiting on a job, not three.
   *
   * Starting a watch, asking whether anything cleared, and calling it off are
   * the same conversation, and three separate tools spent three of a budget
   * that starts costing accuracy past about twenty. The action word is the one
   * the customer already says.
   */
  server.registerTool(
    'watch_jobs',
    {
      title: 'Waiting on a job to clear',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        'Wait on a job that space weather is blocking. action start watches a job and says when the forecast clears ' +
        'it. action check reports which watched jobs are clear now and when the rest clear. action stop cancels a ' +
        'watch, or all of them when no job is named. Call this when the customer wants to be told when they can run ' +
        'something, asks whether anything is clear yet, or says to stop waiting. Confirmed crew contacts are emailed ' +
        'when a watched job clears. Use it to be told later, not to answer whether a job can run right now; that is ' +
        'can_i_run. The job must be named when starting a watch.',
      inputSchema: {
        action: z.enum(['start', 'check', 'stop']).describe(
          'start to wait on a job, check to hear which are clear, stop to cancel',
        ),
        operation: z.enum(OPERATIONS).optional().describe(`${OPERATION_HINT} Required when starting a watch.`),
        field: z.string().optional().describe('Field name as spoken, such as "North 40"; defaults to the only or first field'),
        equipment: z.string().optional().describe('Machine name as spoken, such as "the planter"; defaults to the first registered'),
      },
    },
    async ({ action, operation, field, equipment }) => {
      const id = farmOf();
      const farm = store.get(id);

      if (action === 'start') {
        if (!operation) return say('Which job should I watch? Planting, spraying, surveying, something else?', { watching: false });
        if (!farm.fields.length) return say(NO_FIELDS);
        if (!farm.equipment.length) return say(NO_EQUIP);
        const f = store.findField(farm, field ?? '');
        if (!f) return say(`I don't have a field called "${field}".`);
        const eq = store.findEquipment(farm, equipment);
        if (!eq) return say(NO_EQUIP);
        const snap = swpc.current();
        const kp = kpRightNow();
        if (!snap || !kp) return say(NOAA_DOWN, { unavailable: true });

        const job = operation.replace(/_/g, ' ');
        const Job = job.charAt(0).toUpperCase() + job.slice(1);
        const nowVerdict = assess(operation as Operation, kp.kp, eq, f);
        if (nowVerdict.go) {
          return say(`${Job} on ${f.name} is clear right now, so there's nothing to wait for. ${nowVerdict.reason}`, {
            watching: false,
            go: true,
          });
        }
        if (nowVerdict.limitedBy === 'equipment') {
          return say(`${nowVerdict.reason} Watching the sky won't change that, so I haven't added a watch.`, {
            watching: false,
            limitedBy: 'equipment',
          });
        }
        const win = nextWindow(snap.slots, operation as Operation, eq, f, new Date());
        store.update(id, (x) => {
          x.waiting = x.waiting.filter((w) => !(w.operation === operation && w.fieldId === f.id && w.equipmentId === eq.id));
          x.waiting.push({
            id: `watch-${Date.now().toString(36)}`,
            operation,
            fieldId: f.id,
            equipmentId: eq.id,
            since: new Date().toISOString(),
            notifiedAt: null,
          });
        });
        const crew = farm.crew.filter((c) => c.confirmedAt && c.notifyOn.includes('window_clear')).map((c) => c.name);
        const when = win ? ` On the current forecast it clears ${localTime(win.start, f.timeZone)}.` : ' Nothing clears in the three day forecast yet.';
        const tell = crew.length
          ? ` I'll email ${crew.join(' and ')} when it does${emailConfigured() ? '' : ', once email is switched on for this server'}.`
          : " Ask me whether anything is clear yet, or add a crew member and I'll email them when it clears.";
        return say(`Watching ${job} on ${f.name}.${when}${tell}`, { watching: true, window: win, crewToEmail: crew });
      }

      if (action === 'stop') {
        const f = field ? store.findField(farm, field) : null;
        const keep = farm.waiting.filter((w) => (operation && w.operation !== operation) || (f && w.fieldId !== f.id));
        const removed = farm.waiting.length - (operation || f ? keep.length : 0);
        store.update(id, (x) => void (x.waiting = operation || f ? keep : []));
        return say(removed ? `Stopped watching ${removed} job${removed === 1 ? '' : 's'}.` : "I wasn't watching that.", { removed });
      }

      if (!farm.waiting.length) {
        return say("You're not waiting on any jobs. Ask me to watch one when it's blocked.", { clear: [], waiting: [] });
      }
      const snap = swpc.current();
      const kp = kpRightNow();
      if (!snap || !kp) return say(NOAA_DOWN, { unavailable: true });

      type Row = { watch: store.Watch; field: string; timeZone: string | null; go: boolean; window: ReturnType<typeof nextWindow> };
      const rows: Row[] = [];
      for (const w of farm.waiting) {
        const f = farm.fields.find((x) => x.id === w.fieldId);
        const eq = farm.equipment.find((x) => x.id === w.equipmentId);
        if (!f || !eq) continue;
        const v = assess(w.operation as Operation, kp.kp, eq, f);
        rows.push({
          watch: w,
          field: f.name,
          timeZone: f.timeZone ?? null,
          go: v.go,
          window: v.go ? null : nextWindow(snap.slots, w.operation as Operation, eq, f, new Date()),
        });
      }
      const job = (r: Row) => `${r.watch.operation.replace(/_/g, ' ')} on ${r.field}`;
      const sentence = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
      const clear = rows.filter((r) => r.go);
      const still = rows.filter((r) => !r.go);
      const parts: string[] = [];
      if (clear.length) {
        parts.push(`Clear now: ${clear.map(job).join(', ')}. I've taken ${clear.length === 1 ? 'it' : 'them'} off the watch list.`);
      }
      for (const r of still.slice(0, 3)) {
        parts.push(sentence(`${job(r)} ${r.window ? `clears ${localTime(r.window.start, r.timeZone)}` : "doesn't clear in the three day forecast"}.`));
      }
      if (!rows.length) parts.push('The fields or machines those watches were for have been removed, so I have cleared them.');
      store.update(id, (x) => void (x.waiting = x.waiting.filter((w) => still.some((r) => r.watch.id === w.id))));
      return say(parts.join(' '), {
        clear: clear.map((r) => ({ operation: r.watch.operation, field: r.field })),
        waiting: still.map((r) => ({ operation: r.watch.operation, field: r.field, window: r.window })),
      });
    },
  );

  /*
   * One door for taking things back out, and the only place a fresh start can
   * live.
   *
   * Two tools that both mean "take this off my list" cost a slot each out of a
   * budget that starts eating selection accuracy past about twenty, and neither
   * had anywhere to put "forget the whole farm", which the functional
   * requirements ask for in as many words.
   */
  server.registerTool(
    'remove',
    {
      title: 'Take something off the list',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description:
        'Remove a registered field or machine, or clear the whole farm. what field removes a field or site and any ' +
        'watches on it. what machine removes a machine, also called a tractor, planter, sprayer, combine or rig, and ' +
        'any watches that use it. what everything deletes the lot: fields, machines, watches, crew contacts and the ' +
        'job log. Use everything when the customer says forget everything, start over, start fresh, or delete my ' +
        'data. Clearing everything is asked for twice before anything goes.',
      inputSchema: {
        what: z.enum(['field', 'machine', 'everything']).describe(
          'field for one field or site, machine for one machine, everything for a fresh start',
        ),
        name: z.string().optional().describe('Which field or machine, as spoken. Not needed for everything.'),
      },
    },
    async ({ what, name }) => {
      const id = farmOf();
      const farm = store.get(id);

      if (what === 'everything') {
        const held = [
          farm.fields.length ? count(farm.fields.length, 'field') : '',
          farm.equipment.length ? count(farm.equipment.length, 'machine') : '',
          farm.crew.length ? count(farm.crew.length, 'crew contact') : '',
          farm.jobLog.length ? count(farm.jobLog.length, 'logged job') : '',
        ].filter(Boolean);
        if (!held.length) return say('There is nothing registered here, so there is nothing to clear.', { removed: false });
        if (!asked(farm.forgetAskedAt)) {
          store.update(id, (x) => void (x.forgetAskedAt = new Date().toISOString()));
          return say(`That clears ${andList(held)}, and I can't undo it. Ask me once more and it's gone.`, {
            removed: false,
            confirmNeeded: true,
            holds: held,
          });
        }
        store.forget(id);
        return say(`Done. I've cleared ${andList(held)}. There's nothing left on this farm.`, { removed: true, cleared: held });
      }

      const spoken = clean(name ?? '');
      if (what === 'field') {
        const named = spoken.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\b(the|field|place|acres?)\b/g, '').trim();
        if (!named) return say('Which field should I remove? Tell me its name.', { removed: false });
        const f = store.findField(farm, spoken);
        if (!f) return say(`I don't have a field called "${spoken}".`, { removed: false });
        store.update(id, (x) => {
          x.fields = x.fields.filter((y) => y.id !== f.id);
          x.waiting = x.waiting.filter((w) => w.fieldId !== f.id);
        });
        return say(`Removed ${f.name} and any watches on it. Its job log is kept.`, { removed: true, field: f.name });
      }

      const want = spoken.toLowerCase();
      // Exact or contained names only: finding "the first machine" is fine for a question, not for deleting one.
      const eq =
        farm.equipment.find((e) => e.name.toLowerCase() === want) ??
        farm.equipment.find((e) => e.name.toLowerCase().includes(want) || want.includes(e.name.toLowerCase()));
      if (!eq || !want) return say(`I don't have a machine called "${spoken}".`, { removed: false });
      store.update(id, (x) => {
        x.equipment = x.equipment.filter((y) => y.id !== eq.id);
        x.waiting = x.waiting.filter((w) => w.equipmentId !== eq.id);
      });
      return say(`Removed ${eq.name} and any watches that used it. Its job log is kept.`, { removed: true, equipment: eq.name });
    },
  );

}
