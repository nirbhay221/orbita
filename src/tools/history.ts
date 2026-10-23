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
import { reachable } from '../consent.js';
import { adviceAfter, notTheSun } from '../trade.js';
import * as interference from '../interference.js';
import { lookupTimeZone, spokenTime } from '../timezone.js';
import {
  NOAA_DOWN,
  NO_EQUIP,
  NO_FIELDS,
  OPERATIONS,
  OPERATION_HINT,
  UI,
  andList,
  CARD,
  asked,
  clean,
  count,
  kpRightNow,
  localTime,
  namesOf,
  say,
  CORRECTIONS,
} from './shared.js';

/** What was checked and ruled out is said before what to look at; what could not be checked, after it. */
const lookAt = (ruled: string, advice: string): string => (/^I could not check/.test(ruled) ? `${advice} ${ruled}` : `${ruled} ${advice}`).trim();

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
        'Look back at a past day, or a time on that day, and say whether space weather explains a job that went badly. ' +
        'Call this when someone describes crooked rows, skips, overlap, a survey that would not close, or a machine ' +
        'that seemed to be misbehaving, and names a day. ' +
        'If the conditions were quiet, say so plainly rather than inventing a cause. It looks backwards only; for whether a ' +
        'job can run now or later, use can_i_run.',
      inputSchema: {
        when: z.string().describe('When it happened, spoken or ISO, with the time of day if they said one, e.g. "last Tuesday", "yesterday at 3 pm", "10 May 2024"'),
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
      // This used to answer "no equipment registered" when it was the field that was not found.
      if (!f) return say(`I don't have a field called "${clean(field)}".${namesOf(farm.fields)} Which one did you mean?`);
      const eq = store.findEquipment(farm, equipment);
      if (!eq) return say(NO_EQUIP);

      let at = history.parseWhen(when, new Date(), { prefer: 'past', timeZone: f.timeZone, country: f.countryCode });
      if (!at) {
        // A year alone is a fair question, "what about 1859?", and deserves more than "I could not work out what date".
        const year = /^\s*(\d{4})\s*$/.exec(String(when ?? ''))?.[1];
        if (year && Number(year) < 1932) return say(`The Kp record only goes back to 1932, so I cannot check ${year}. The storms since then, like March 1989 or May 2024, I can.`);
        if (year && Number(year) > new Date().getFullYear()) return say('That is in the future. Ask me whether you can run instead.');
        if (year) return say(`Which day in ${year}? Tell me the date, like May 10 ${year}.`);
        return say(`I could not work out what date "${clean(when)}" means. Try a day name or a date.`);
      }
      if (at.getTime() > Date.now()) return say('That is in the future. Ask me whether you can run instead.');
      if (at.getTime() < history.EARLIEST) return say('The Kp record only goes back to 1932, so I cannot check that day.');

      const op0 = (operation ?? 'planting') as Operation;
      const tz = f.timeZone ?? 'UTC';
      const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).replace(':00', '');

      /*
       * A time was named, not only a day.
       *
       * "My guidance was jumping at three yesterday afternoon" is a question about three o'clock, and the old
       * answer was about the whole day: it could say "that was the sun" because of a storm that ended before
       * breakfast. Kp is measured in three-hour blocks, so the block that holds the moment is looked at, with
       * the one before and the one after, and the answer is about that stretch in the field's own time.
       */
      if (/\b\d{1,2}(:\d\d)?\s*(am|pm|a\.m\.|p\.m\.)|\b\d{1,2}:\d\d\b|\b(morning|afternoon|evening|tonight|night|noon|midday|midnight|dawn|dusk|lunch)/i.test(when)) {
        const moment = at.getTime();
        const BLOCK = 3 * 3_600_000;
        const start = Math.floor(moment / BLOCK) * BLOCK;
        const inMemory = (swpc.current()?.slots ?? []).filter((sl) => sl.observed);
        let pool = inMemory;
        if (!pool.some((sl) => new Date(sl.time).getTime() === start)) {
          try {
            const DAY = 86_400_000;
            pool = await history.fetchRange(new Date(Math.floor((start - BLOCK) / DAY) * DAY), new Date(Math.floor((start + BLOCK) / DAY) * DAY + DAY - 1000));
          } catch {
            return say('I could not reach the Kp archive to check that time.');
          }
        }
        const at3 = (t: number) => pool.find((sl) => new Date(sl.time).getTime() === t) ?? null;
        const here = at3(start);
        if (!here) return say(`I have no Kp record for that time on ${at.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz })}.`);
        const around = [at3(start - BLOCK), here, at3(start + BLOCK)].filter((x): x is NonNullable<typeof here> => x !== null);
        const judged = around.map((sl) => ({ sl, v: assess(op0, sl.kp, eq, f, new Date(new Date(sl.time).getTime() + BLOCK / 2)) }));
        const mine = judged.find((j) => j.sl === here)!;
        const bad = judged.filter((j) => !j.v.go && j.v.limitedBy === 'space_weather');
        const dayLabelLocal = at.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz });
        const span = `${clock(start)} to ${clock(start + BLOCK)}`;
        let said: string;
        if (mine.v.limitedBy === 'equipment') {
          said = `That is not something the sky did. ${eq.name} on ${eq.correction.toUpperCase()} cannot hold ${op0.replace(/_/g, ' ')} tolerance on any day.`;
        } else if (!mine.v.go) {
          const from = clock(new Date(bad[0].sl.time).getTime());
          const to = clock(new Date(bad[bad.length - 1].sl.time).getTime() + BLOCK);
          said =
            `That was the sun. On ${dayLabelLocal}, ${span}, Kp was ${here.kp.toFixed(1)} (${mine.v.gScale}), outside ${op0.replace(/_/g, ' ')} tolerance. ` +
            adviceAfter(op0, true, from, to);
        } else if (bad.length) {
          const other = bad[0];
          const when2 = `${clock(new Date(other.sl.time).getTime())} to ${clock(new Date(other.sl.time).getTime() + BLOCK)}`;
          said = `At that time the sky was inside tolerance, Kp ${here.kp.toFixed(1)}. It was outside it ${when2}, Kp ${other.sl.kp.toFixed(1)}, so if the trouble ran into that stretch, that part was the sun. ` + adviceAfter(op0, true, clock(new Date(other.sl.time).getTime()), clock(new Date(other.sl.time).getTime() + BLOCK));
        } else {
          said = `It was not the sun. On ${dayLabelLocal}, ${span}, Kp was only ${here.kp.toFixed(1)}, well inside tolerance, and quiet for three hours either side.`;
        }
        // The other published causes: a military GPS test, a satellite out, aircraft reporting interference.
        const other = await interference.nearThen(f.lat, f.lon, new Date(moment));
        const sunToo = !mine.v.go && mine.v.limitedBy === 'space_weather';
        const otherSaid = interference.sayThen(other, sunToo);
        if (otherSaid) said += ` ${otherSaid}`;
        else if (mine.v.go && !bad.length) said += ` ${lookAt(interference.ruledOut(other), notTheSun(eq.correction))}`;
        const mustSay = mine.v.go && !bad.length && !otherSaid ? [notTheSun(eq.correction).split('. ')[0] + '.'] : otherSaid ? [otherSaid.split('. ')[0].replace(/\.?$/, '.')] : [];
        return say(said.trim(), {
          mustSay,
          historical: true,
          byHour: true,
          at: new Date(moment).toISOString(),
          block: { start: new Date(start).toISOString(), kp: here.kp, go: mine.v.go },
          around: judged.map((j) => ({ time: j.sl.time, kp: j.sl.kp, go: j.v.go })),
          wasTheSun: !mine.v.go && mine.v.limitedBy === 'space_weather',
          otherCauses: { gpsTests: other.tests.map((t) => ({ name: t.name, place: t.place, milesAway: Math.round(t.milesAway ?? 0) })), satellitesOut: other.satellites.map((x) => x.prn), aircraftReports: other.reported, unchecked: other.unchecked, sources: interference.SOURCES },
          field: f.name,
          equipment: eq.name,
          correction: eq.correction,
        });
      }

      // The 15 minute NOAA poll already holds roughly the last seven days in memory.
      // Use it when the date falls inside that, and only reach for the archive for
      // older questions, so the common case ("last Tuesday") never leaves the process.
      // The calendar day they named, where the field is, looked up as that same date in the Kp record. A
      // spoken day is now read in the field's own time, so "May 10" lands on the evening of the 10th there,
      // which is already the 11th in UTC: the answer came back about "Saturday, May 11".
      const namedDay = at.toLocaleDateString('en-CA', { timeZone: f.timeZone ?? 'UTC' });
      at = new Date(`${namedDay}T12:00:00Z`);
      // The field's own day, midnight to midnight there, not the UTC day: May 10 2024 in Nebraska ran to
      // 05:00 UTC on the 11th, and its worst hours, Kp 9 from 7 PM, fell in the UTC block after midnight.
      // A three-hour block belongs to the day its middle falls in, which always gives eight.
      const dayStart = localMidnight(namedDay, f.timeZone ?? 'UTC');
      const dayEnd = dayStart + 24 * 3600_000;
      const BLOCK_MS = 3 * 3600_000;
      const inDay = (sl: { time: string }) => {
        const mid = new Date(sl.time).getTime() + BLOCK_MS / 2;
        return mid >= dayStart && mid < dayEnd;
      };
      const cached = (swpc.current()?.slots ?? []).filter((sl) => sl.observed && inDay(sl));

      let slots = cached;
      let fromArchive = false;
      if (slots.length < 8) {
        try {
          // Whole UTC days around the field's day, as the archive is asked everywhere else.
          const DAY_MS = 24 * 3600_000;
          const from = new Date(Math.floor((dayStart - BLOCK_MS) / DAY_MS) * DAY_MS);
          const to = new Date(Math.floor((dayEnd - 1) / DAY_MS) * DAY_MS + DAY_MS - 60_000);
          slots = (await history.fetchRange(from, to)).filter(inDay);
          fromArchive = true;
        } catch {
          if (!cached.length) return say('I could not reach the Kp archive to check that day.');
          slots = cached;
        }
      }
      if (!slots.length) return say(`No Kp records for ${at.toISOString().slice(0, 10)}.`);

      const op = (operation ?? 'planting') as Operation;
      const peak = slots.reduce((a, b) => (b.kp > a.kp ? b : a));
      const worst = assess(op, peak.kp, eq, f, new Date(new Date(peak.time).getTime() + 90 * 60_000));
      const badBlocks = slots.filter((sl) => !assess(op, sl.kp, eq, f, new Date(new Date(sl.time).getTime() + 90 * 60_000)).go);
      // Kp is a UTC index. Rendering the label in local time shifted the date back
      // a day, so a question about 11 May came back answered about 10 May.
      const dayLabel = at.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
      });
      // The peak in the field's own time, like the passes named after it; it was said in UTC beside local hours.
      const peakTime = new Date(peak.time).toLocaleString('en-US', {
        hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short',
      });

      const otherFound = await interference.nearThen(f.lat, f.lon, at);
      const otherDay = interference.sayThen(otherFound, !worst.go);
      const text = worst.go
        ? `Space weather was not the problem on ${dayLabel}. Kp peaked at only ${peak.kp.toFixed(1)}, ` +
          `and your drift would have stayed around ${worst.expectedErrorM < 0.076 ? (worst.expectedErrorM * 39.37).toFixed(1) : Math.round(worst.expectedErrorM * 39.37)} inches all day. ` +
          (otherDay ? `${otherDay} ${notTheSun(eq.correction)}` : `Something else caused that. ${lookAt(interference.ruledOut(otherFound), notTheSun(eq.correction))}`)
        : `That was the sun. On ${dayLabel} Kp peaked at ${peak.kp.toFixed(1)} (${worst.gScale}) around ` +
          `${peakTime}, ` +
          // A storm that strong does not move a fix by so many inches. Receivers lose it. See evals/receivers.mjs.
          (worst.expectedErrorM / worst.quietErrorM >= 25 && eq.correction === 'rtk'
            ? 'strong enough that receivers lose their precise fix altogether. '
            : `putting expected drift near ${worst.expectedErrorM >= 1 ? `${worst.expectedErrorM.toFixed(1)} metres` : `${Math.round(worst.expectedErrorM * 39.37)} inches`}, ` +
              `about ${(worst.expectedErrorM / worst.quietErrorM).toFixed(0)} times your normal. `) +
          `${badBlocks.length} of ${slots.length} three-hour blocks that day were outside ${op.replace(/_/g, ' ')} tolerance.` +
          (badBlocks.length && badBlocks.length < slots.length ? ` ${adviceAfter(op, true, `${clock(new Date(badBlocks[0].time).getTime())}`, `${clock(new Date(badBlocks[badBlocks.length - 1].time).getTime() + 3 * 3_600_000)}`)}` : '');

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
        // The same shape the hour-by-hour answer gives, so what follows it is worked out the same way.
        wasTheSun: !worst.go && worst.limitedBy === 'space_weather',
        at: at.toISOString(),
        otherCauses: { gpsTests: otherFound.tests.map((t) => ({ name: t.name, place: t.place, milesAway: Math.round(t.milesAway ?? 0) })), satellitesOut: otherFound.satellites.map((x) => x.prn), aircraftReports: otherFound.reported, unchecked: otherFound.unchecked, sources: interference.SOURCES },
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
      _meta: { ui: { resourceUri: CARD } },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        'Wait on a job that space weather is blocking. action start watches a job and says when the forecast clears ' +
        'it. action check reports which watched jobs are clear now and when the rest clear. action stop cancels a ' +
        'watch, or all of them when no job is named. Call this when the customer wants to be told when they can run ' +
        'something, asks whether anything is clear yet, or says to stop waiting. Confirmed crew contacts are emailed ' +
        'when a watched job clears. Use it to be told later, not to answer whether a job can run right now; that is ' +
        'can_i_run. The job must be named when starting a watch. When the field was only checked by its town and is ' +
        'not saved yet, give place, and correction if they said it, and it is saved first.',
      inputSchema: {
        action: z.enum(['start', 'check', 'stop']).describe(
          'start to wait on a job, check to hear which are clear, stop to cancel',
        ),
        operation: z.enum(OPERATIONS).optional().describe(`${OPERATION_HINT} Required when starting a watch.`),
        field: z.string().optional().describe('Field name as spoken, such as "North 40"; defaults to the only or first field'),
        equipment: z.string().optional().describe('Machine name as spoken, such as "the planter"; defaults to the first registered'),
        place: z.string().optional().describe('The nearest town, as spoken, when the field is not saved yet: it is saved, then watched'),
        correction: z.enum(CORRECTIONS).optional().describe('With place, when no machine is saved yet: the correction they said it runs'),
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
        if (!f) return say(`I don't have a field called "${clean(field)}".${namesOf(farm.fields)} Which one did you mean?`, { watching: false });
        const eq = store.findEquipment(farm, equipment);
        if (!eq) return say(NO_EQUIP);
        const snap = swpc.current();
        const kp = kpRightNow();
        if (!snap || !kp) return say(NOAA_DOWN, { unavailable: true });

        const job = operation.replace(/_/g, ' ');
        const Job = job.charAt(0).toUpperCase() + job.slice(1);
        const nowVerdict = assess(operation as Operation, kp.kp, eq, f, new Date());
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
        const crew = farm.crew.filter((c) => reachable(c) && c.notifyOn.includes('window_clear')).map((c) => c.name);
        const when = win ? ` On the current forecast it clears ${localTime(win.start, f.timeZone)}.` : ' Nothing clears in the three day forecast yet.';
        const tell = crew.length
          ? ` I'll email ${crew.join(' and ')} when it does${emailConfigured() ? '' : ', once email is switched on for this server'}.`
          : " Ask me whether anything is clear yet. Want somebody on the crew emailed when it clears? Tell me who.";
        return say(`Watching ${job} on ${f.name}.${when}${tell}`, {
          watching: true,
          window: win,
          crewToEmail: crew,
          card: {
            kind: 'card',
            title: `Watching ${job} on ${f.name}`,
            status: { label: 'waiting', tone: 'neutral' },
            lines: [win ? `Clears ${localTime(win.start, f.timeZone)} on the current forecast.` : 'Nothing clears in the three day forecast yet.'],
            foot: crew.length ? `${crew.join(' and ')} will be emailed when it clears.` : 'Ask whether anything is clear yet.',
          },
        });
      }

      if (action === 'stop') {
        const f = field ? store.findField(farm, field) : null;
        // A field that was named and not recognised used to fall through to "no field given", which cancels
        // every watch on the farm. Mis-hearing one name must not clear the list.
        if (field && !f) {
          return say(`I don't have a field called "${clean(field)}", so I have not stopped anything.${namesOf(farm.fields)}`, { removed: 0 });
        }
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
        const v = assess(w.operation as Operation, kp.kp, eq, f, new Date());
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
        card: {
          kind: 'list',
          title: 'Waiting to clear',
          status: clear.length ? { label: `${clear.length} clear`, tone: 'good' } : { label: 'none clear yet', tone: 'neutral' },
          items: [
            ...clear.map((r) => ({ title: sentence(job(r)), note: 'clear now', tone: 'good' })),
            ...still.map((r) => ({ title: sentence(job(r)), note: r.window ? `clears ${localTime(r.window.start, r.timeZone)}` : 'not in the forecast', tone: 'neutral' })),
          ],
          foot: 'From the NOAA three day forecast.',
        },
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
        'data. Clearing everything is asked for twice before anything goes. It is not for taking somebody off the ' +
        'crew list (use crew_contact) or for ending a watch on a job (use watch_jobs).',
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
        if (!f) return say(`I don't have a field called "${spoken}".${namesOf(farm.fields)}`, { removed: false });
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
        farm.equipment.find((e) => e.name && (e.name.toLowerCase().includes(want) || want.includes(e.name.toLowerCase())));
      if (!eq || !want) return say(`I don't have a machine called "${spoken}".${namesOf(farm.equipment)}`, { removed: false });
      store.update(id, (x) => {
        x.equipment = x.equipment.filter((y) => y.id !== eq.id);
        x.waiting = x.waiting.filter((w) => w.equipmentId !== eq.id);
      });
      return say(`Removed ${eq.name} and any watches that used it. Its job log is kept.`, { removed: true, equipment: eq.name });
    },
  );

}

/** The moment a calendar day begins in a time zone, as milliseconds since the epoch. */
function localMidnight(day: string, timeZone: string): number {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const offsetAt = (ms: number) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms));
    const n = (t: string) => Number(parts.find((x) => x.type === t)?.value);
    return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute')) - ms;
  };
  // Twice, so a day that starts on the other side of a clock change still lands on its midnight.
  const first = guess - offsetAt(guess);
  return guess - offsetAt(first);
}
