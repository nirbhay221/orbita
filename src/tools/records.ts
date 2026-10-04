/**
 * The record of what was actually run.
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
import * as crewheat from '../crewheat.js';
import * as crewday from '../crewday.js';
import { reachable, stopFooter } from '../consent.js';
import * as swpcplus from '../swpcplus.js';
import * as aurora from '../aurora.js';
import { chooseOne, canAsk } from '../elicit.js';
import * as season from '../season.js';
import * as store from '../store.js';
import * as history from '../history.js';
import { advise, ROLES, ROLE_HINT, type Role } from '../playbook.js';
import { sendEmail, withinEmailLimits, emailConfigured, canEmailFor, DEMO_NO_EMAIL } from '../notify.js';
import { lookupTimeZone, spokenTime } from '../timezone.js';
import {
  NOAA_DOWN,
  NO_EQUIP,
  NO_FIELDS,
  OPERATIONS,
  OPERATION_HINT,
  CARD,
  REPEAT_WINDOW_MS,
  UI,
  asked,
  clean,
  justNow,
  kpRightNow,
  localTime,
  newId,
  namesOf,
  sameName,
  say,
  spokenJob,
  statusOperations,
  upcomingSlots,
} from './shared.js';

export function register(server: McpServer, farmOf: () => string): void {
  /* ---------------------------------------------------------------- *
   * A record of the work that actually ran, so a bad season can be
   * explained with numbers rather than a memory.
   * ---------------------------------------------------------------- */
  server.registerTool(
    'log_job',
    {
      title: 'Log a job that ran',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        'Record a job that was actually run, with the space weather at the time, so it can be reported on later, for a ' +
        'crew, a client or an insurer. Call this when the customer says they planted, sprayed, surveyed or ran a job, ' +
        'including how much was done. It records something that already happened; it does not check whether a job ' +
        'can run (use can_i_run) or summarise past jobs (use job_report).',
      inputSchema: {
        operation: z.enum(OPERATIONS).describe(OPERATION_HINT),
        field: z.string().optional().describe('Field name as spoken, such as "North 40"; defaults to the only or first field'),
        equipment: z.string().optional().describe('Machine name as spoken, such as "the planter"; defaults to the first registered'),
        when: z.string().optional().describe('When it ran, ISO or spoken like "yesterday"; defaults to now'),
        acres: z.number().optional().describe('Acres covered, if they said, such as 40'),
        note: z.string().optional().describe('Anything they said about how it went, in their words'),
      },
    },
    async ({ operation, field, equipment, when, acres, note }) => {
      const id = farmOf();
      const farm = store.get(id);
      if (!farm.fields.length) return say(NO_FIELDS);
      if (!farm.equipment.length) return say(NO_EQUIP);
      // Which field. With one registered there is nothing to ask about. With
      // several and no name spoken, store.findField falls back to the first one,
      // which is a silent wrong answer: tolerance, baseline and exposure all
      // differ between fields. So ask, where the host can be asked.
      let chosenName = field;
      if (!field && farm.fields.length > 1 && canAsk(server)) {
        const answer = await chooseOne(server, {
          message: 'Which field?',
          label: 'Field',
          values: farm.fields.map((x) => x.name),
        });
        if (answer.kind === 'declined') {
          return say('No problem. Ask me again and name the field, and I will check that one.');
        }
        if (answer.kind === 'chosen') chosenName = answer.value;
      }

      const f = store.findField(farm, chosenName ?? '');
      if (!f) return say(`I don't have a field called "${clean(field)}".${namesOf(farm.fields)} Which one did you mean?`, { logged: false });

      // Same for the machine: the correction it runs is most of the answer, so
      // guessing between an RTK planter and a WAAS sprayer changes the verdict.
      let chosenEquip = equipment;
      if (!equipment && farm.equipment.length > 1 && canAsk(server)) {
        const answer = await chooseOne(server, {
          message: 'Which machine?',
          label: 'Machine',
          values: farm.equipment.map((x) => x.name),
        });
        if (answer.kind === 'declined') {
          return say('Fine. Ask again and name the machine, and I will judge that one.');
        }
        if (answer.kind === 'chosen') chosenEquip = answer.value;
      }

      const eq = store.findEquipment(farm, chosenEquip);
      if (!eq) return say(NO_EQUIP);

      // When nobody could be asked, the answer still has to say which field and
      // machine it is about, because the customer named neither and the old
      // behaviour was to pick silently.
      const assumed = !field && farm.fields.length > 1 && chosenName === undefined;
      const at = when ? history.parseWhen(when, new Date(), { prefer: 'past', timeZone: f.timeZone }) : new Date();
      if (!at) return say(`I couldn't work out when "${clean(when)}" was. Try a day name or a date.`, { logged: false });
      // A log is of work that happened. A date ahead of now is a plan, and it would sit in the report as done.
      if (at.getTime() > Date.now() + 5 * 60_000) {
        return say('That is in the future, so there is nothing to log yet. Tell me once it has been done.', { logged: false });
      }

      // Kp only counts if a published block actually covers that time.
      const slot = (swpc.current()?.slots ?? []).find((s) => {
        const start = new Date(s.time).getTime();
        return at.getTime() >= start && at.getTime() < start + 3 * 3_600_000;
      });
      // For a job logged as it happens, this has to be the same number the rest
      // of the add-on is saying this minute, or the log reads Kp 4 while the
      // status reads Kp 1. A job logged for a past day only has its block.
      const live = when ? null : kpRightNow();
      const kp = live ? live.kp : slot ? slot.kp : null;
      const v = kp != null ? assess(operation as Operation, kp, eq, f) : null;
      const entry: store.JobEntry = {
        id: newId('job'),
        at: at.toISOString(),
        loggedAt: new Date().toISOString(),
        operation,
        fieldId: f.id,
        fieldName: f.name,
        equipmentId: eq.id,
        equipmentName: eq.name,
        kp,
        expectedErrorM: v ? v.expectedErrorM : null,
        toleranceM: TOLERANCE_M[operation as Operation],
        go: v ? v.go : null,
        limitedBy: v ? v.limitedBy : null,
        acres: acres ?? null,
        note: note ? clean(note, 200) : null,
      };
      // Saying it again, or a host retrying, is not a second job. The job's own
      // time has to match too, so "planting yesterday" then "planting today"
      // stays two entries.
      const repeat = store.get(id).jobLog.find(
        (j) =>
          j.operation === entry.operation &&
          j.fieldId === entry.fieldId &&
          j.equipmentId === entry.equipmentId &&
          (j.acres ?? null) === (entry.acres ?? null) &&
          justNow(j.loggedAt ?? j.at) &&
          Math.abs(new Date(j.at).getTime() - at.getTime()) < REPEAT_WINDOW_MS,
      );
      if (repeat) {
        return say(`I logged ${operation.replace(/_/g, ' ')} on ${f.name} a moment ago, so I haven't written it down twice.`, {
          logged: repeat,
          duplicate: true,
        });
      }
      store.update(id, (x) => void x.jobLog.push(entry));

      const job = operation.replace(/_/g, ' ');
      const inch = (m: number) => Math.max(1, Math.round(m * 39.37));
      const said = !v
        ? `Logged ${job} on ${f.name}. I don't have the space weather for that time in memory, so ask me what happened that day to check it.`
        : v.go
          ? `Logged ${job} on ${f.name}. Kp was ${kp!.toFixed(1)}, inside tolerance.`
          : v.limitedBy === 'space_weather'
            ? `Logged ${job} on ${f.name}. Kp was ${kp!.toFixed(1)}, which puts expected drift near ${inch(v.expectedErrorM)} inches against ${inch(v.toleranceM)}, so that work is worth checking.`
            : `Logged ${job} on ${f.name}. ${eq.name} can't hold that tolerance even on a quiet day, so check that work whatever the sky was doing.`;
      return say(said, { logged: entry });
    },
  );

  /*
   * The report, and sending it, are one request.
   *
   * "Send that to the insurer" is the same sentence as asking for it, and
   * splitting them cost a tool out of a budget that starts costing accuracy
   * past about twenty. Naming someone is what turns a report into an email.
   */
  server.registerTool(
    'job_report',
    {
      title: 'Report on the jobs I ran',
      _meta: { ui: { resourceUri: CARD } },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        'Summarise logged jobs over recent days, and which ran while space weather put them outside tolerance. Name a ' +
        'confirmed crew contact in emailTo and the same report is emailed to them, for a client, an insurer or the ' +
        'office. Call this when the customer asks for a report, a record, or to send one to someone. It reads jobs already logged; to record a new one use log_job.',
      inputSchema: {
        days: z.number().int().min(1).max(366).optional().describe('How far back, default 30'),
        emailTo: z.string().optional().describe('A confirmed crew contact to email the report to, by name'),
      },
    },
    async ({ days, emailTo }) => {
      const span = days ?? 30;
      const farm = store.get(farmOf());
      const since = Date.now() - span * 86_400_000;
      const entries = farm.jobLog.filter((j) => new Date(j.at).getTime() >= since);
      const outside = entries.filter((j) => j.go === false && j.limitedBy === 'space_weather');
      const unknown = entries.filter((j) => j.go === null);
      const date = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });

      if (emailTo) {
        // The report carries each job's free-text note, which the caller wrote, so a
        // sandbox able to email it could send its own words to any address. See
        // canEmailFor in notify.ts.
        if (!canEmailFor(farmOf())) return say(DEMO_NO_EMAIL, { sent: false, reason: 'demo' });
        const contact = farm.crew.find((c) => sameName(c.name, emailTo));
        if (!contact) return say(`${emailTo} isn't on your crew list. Add them first.`, { sent: false });
        if (!contact.confirmedAt) return say(`${contact.name} hasn't been confirmed yet, so I won't email them.`, { sent: false });
        if (!reachable(contact)) return say(`${contact.name} hasn't agreed to be emailed yet, so I won't send it.`, { sent: false, reason: 'not_agreed' });
        if (!emailConfigured()) return say("I can't email the report yet, because email isn't set up on this server.", { sent: false });
        const lines = entries.map(
          (j) =>
            `${j.at.slice(0, 16).replace('T', ' ')} UTC  ${j.operation.replace(/_/g, ' ')}  ${j.fieldName}  ${j.equipmentName}  ` +
            `Kp ${j.kp == null ? 'unknown' : j.kp.toFixed(1)}  ` +
            `${j.go == null ? 'no record' : j.go ? 'inside tolerance' : j.limitedBy === 'space_weather' ? 'outside tolerance, space weather' : 'outside tolerance, equipment'}` +
            `${j.acres ? `  ${j.acres} acres` : ''}${j.note ? `  ${j.note}` : ''}`,
        );
        // Asked for by voice, so it can be asked for again and again. Past the limit the honest answer is
        // that it was not sent, rather than "emailing it now" about a message that was dropped.
        if (!withinEmailLimits({ to: contact.email, reason: 'job_report', sender: farmOf() })) {
          return say(`I have already sent ${contact.name} as many emails as I will send in a day. Ask me again tomorrow.`, { sent: false, reason: 'limit' });
        }
        void sendEmail({
          to: contact.email,
          sender: farmOf(),
          reason: 'job_report',
          subject: `Orbita job report, last ${span} days`,
          text: `${lines.length} jobs logged.\n\n${lines.join('\n')}\n\nKp from NOAA SWPC. Tolerances are the ones Orbita uses for each job.${stopFooter(contact)}`,
        });
        return say(`I'm emailing the report to ${contact.name} now.`, { sent: true, jobs: lines.length });
      }

      if (!entries.length) {
        return say(`No jobs logged in the last ${span} days. Tell me when you run one and I'll keep the record.`, { entries: [] });
      }
      const parts = [`In the last ${span} days you logged ${entries.length} job${entries.length === 1 ? '' : 's'}.`];
      parts.push(
        outside.length
          ? `${outside.length} ran while space weather put ${outside.length === 1 ? 'it' : 'them'} outside tolerance: ${outside
              .slice(0, 3)
              .map((j) => `${j.operation.replace(/_/g, ' ')} on ${j.fieldName} on ${date(j.at)} at Kp ${j.kp?.toFixed(1)}`)
              .join('; ')}.`
          : 'None of them ran while space weather put them outside tolerance.',
      );
      if (unknown.length) parts.push(`${unknown.length} had no space weather on record for that time.`);
      return say(parts.join(' '), {
        days: span,
        entries,
        outside,
        unknown,
        card: {
          kind: 'list',
          title: `Jobs, last ${span} days`,
          status: outside.length ? { label: `${outside.length} outside tolerance`, tone: 'bad' } : { label: 'all inside tolerance', tone: 'good' },
          items: entries.slice(-8).reverse().map((j) => ({
            title: `${spokenJob(j.operation)} on ${j.fieldName}`,
            note: `${date(j.at)}, ${j.go == null ? 'no record' : j.go ? 'inside' : 'outside'}`,
            tone: j.go === false ? 'bad' : j.go ? 'good' : 'neutral',
          })),
          foot: 'Kp from NOAA at the time each job ran.',
        },
      });
    },
  );

  server.registerTool(
    'farm_status',
    {
      title: 'What can I run right now',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'Every registered field and machine, and whether accuracy holds for each at the moment, as one overview. ' +
        'Call this when someone asks how the farm is looking, what is going on across the fields, or for a summary ' +
        'of everything. It does not look at past jobs (use job_report) and does not answer one specific job (use can_i_run).',
      inputSchema: {},
      _meta: { ui: { resourceUri: UI } },
    },
    async () => {
      const farm = store.get(farmOf());
      if (!farm.fields.length) return say(NO_FIELDS);
      const snap = swpc.current();
      const kp = kpRightNow();
      if (!kp) return say(NOAA_DOWN, { unavailable: true });

      // A farm with ground but no machines on it yet. Without this the sweep
      // reads a correction off nothing at all, and a live probe heard the
      // exception itself read back: "Cannot read properties of undefined".
      if (!farm.equipment.length) return say(NO_EQUIP);
      // Every machine, as the description promises. It used to judge the first machine only, so a farm with a
      // planter on RTK and a sprayer on WAAS heard about one of them and was told that was the farm. Bounded,
      // because the answer is spoken and the sweep is fields times machines times jobs.
      const fields = farm.fields.slice(0, 40);
      const machines = farm.equipment.slice(0, 8);
      const rows = fields.flatMap((f) =>
        machines.flatMap((eq) =>
          (statusOperations(eq.correction) as Operation[]).map((op) => {
            const v = assess(op, kp.kp, eq, f, new Date());
            return {
              field: f.name,
              equipment: eq.name,
              operation: op,
              go: v.go,
              errorM: v.expectedErrorM,
              toleranceM: v.toleranceM,
              limitedBy: v.limitedBy,
            };
          }),
        ),
      );
      // What the storm is blocking, furthest outside tolerance first. A job the machine can never hold is a
      // different fact, said separately, because waiting will not change it.
      const stormed = rows.filter((r) => r.limitedBy === 'space_weather').sort((a, b) => b.errorM / b.toleranceM - a.errorM / a.toleranceM);
      const never = rows.filter((r) => r.limitedBy === 'equipment');
      const several = machines.length > 1;
      const name = (r: (typeof rows)[number]) => `${spokenJob(r.operation)} on ${r.field}${several ? ` with ${r.equipment}` : ''}`;
      const parts = [`Kp ${kp.kp.toFixed(1)}.`];
      parts.push(
        stormed.length
          ? `${stormed.length} of ${rows.length} jobs are outside tolerance because of space weather, worst first: ${stormed.slice(0, 3).map(name).join(', ')}.`
          : 'Space weather is not putting any job outside tolerance right now.',
      );
      if (never.length) {
        parts.push(`${never.length} more cannot hold tolerance on the correction that machine runs, whatever the sky does.`);
      }
      if (farm.fields.length > fields.length || farm.equipment.length > machines.length) {
        parts.push('That covers your first fields and machines; ask about a particular one for the rest.');
      }
      // The hottest field over the working day ahead, for whoever is deciding where to send people.
      const heat = fields
        .map((f) => ({ f, heat: crewheat.during(f.lat, f.lon, new Date(), 10) }))
        .filter((x): x is { f: (typeof fields)[number]; heat: crewheat.CrewHeat } => x.heat !== null)
        .sort((a, b) => b.heat.peakF - a.heat.peakF)[0];
      const mustSay: string[] = [];
      if (heat) {
        const line = crewheat.sentence(heat.heat, (iso) => localTime(iso, heat.f.timeZone)).replace('For the crew,', `For the crew on ${heat.f.name},`);
        parts.push(line);
        if (heat.heat.level === 'high') mustSay.push(line);
      }
      for (const line of crewday.sentences(farm.crew.map((c) => ({ name: c.name, link: c.dayLink })))) {
        parts.push(line);
        mustSay.push(line);
      }
      return say(parts.join(' '), {
        kp: kp.kp,
        rows,
        slots: upcomingSlots(snap?.slots ?? []),
        ...(mustSay.length ? { mustSay } : {}),
        crewHeat: heat ? { field: heat.f.name, ...heat.heat } : null,
      });
    },
  );

}
