import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  assess, nextWindow, thresholdKp, TOLERANCE_M, degradedOptions, deadlinePressure, geomagneticLatitude,
  type Correction, type Operation,
} from './domain.js';
import { activeImpacts, speakImpacts } from './impacts.js';
import * as swpc from './swpc.js';
import * as solarwind from './solarwind.js';
import * as store from './store.js';
import * as history from './history.js';
import { advise, ROLES, ROLE_HINT, type Role } from './playbook.js';
import { sendEmail, emailConfigured } from './notify.js';
import { lookupTimeZone, spokenTime } from './timezone.js';

const UI = 'ui://orbita/window.html';

const say = (text: string, structured?: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text }],
  ...(structured ? { structuredContent: structured } : {}),
});

const OPERATIONS = [
  'planting', 'strip_till', 'cultivating', 'spraying', 'harvest', 'tillage', 'scouting',
  'surveying', 'drone_survey', 'machine_control',
] as const;

/**
 * Alexa+ picks the tool and fills the arguments from speech, so the words a
 * customer actually says have to appear here. Nobody stands in a field and says
 * "machine_control"; they say the dozer is cutting grade. Amazon's guidance is
 * explicit that parameter descriptions should carry synonyms and abbreviations,
 * and this is the parameter the whole verdict turns on.
 */
/**
 * Which jobs a status sweep should report on. Reporting cadastral survey to a
 * farmer is noise, and reporting harvest to a survey crew is worse, so the set
 * follows the rig: a centimetre correction is bought by people doing
 * centimetre work, anything coarser is not.
 */
export function statusOperations(correction: string): string[] {
  return correction === 'rtk' || correction === 'ppp'
    ? ['surveying', 'machine_control', 'planting', 'spraying']
    : ['spraying', 'harvest', 'tillage'];
}

const OPERATION_HINT =
  'The job being done. planting, also called drilling or seeding or putting the crop in. ' +
  'strip_till for strip tilling. cultivating, also row-crop cultivation or inter-row work. ' +
  'spraying, also chemical, herbicide, a spray pass or boom work. ' +
  'harvest, also combining, cutting or picking. ' +
  'tillage, also discing, ripping, ploughing or plowing or working ground. ' +
  'scouting, also walking the field or crop checks. ' +
  'surveying for cadastral, boundary, topo, staking or setting out. ' +
  'drone_survey for UAV, UAS, photogrammetry or a mapping flight. ' +
  'machine_control for grade control, earthworks, cut and fill, or a dozer, grader or excavator on design grade.';
const CORRECTIONS = ['rtk', 'ppp', 'sbas', 'autonomous'] as const;

const NO_FIELDS = 'No fields registered yet. Add one first, I need its location to judge how badly a storm will hit it.';
const NO_EQUIP = 'No equipment registered yet. Tell me what correction you run, RTK, PPP, SBAS or none.';
/**
 * Certification requires an actionable next step on every error, and a wrong
 * go-ahead here costs a season, so this never guesses. It says what is wrong,
 * what to do instead, and when to come back.
 */
const NOAA_DOWN =
  "I can't reach NOAA right now, so I won't guess at your accuracy. " +
  'The forecast refreshes every fifteen minutes, so ask me again shortly. ' +
  'If you need an answer now, check swpc.noaa.gov before you go out.';

/**
 * Kp right now, from the minute by minute estimate when there is one.
 *
 * NOAA publishes both an estimated Kp updated every minute and a forecast in
 * three hour blocks, and during the hour a storm arrives they disagree by a
 * whole level. Without one definition of "now", storm_status answered 3.7 while
 * can_i_run answered 3.3 in the same minute, which is the kind of thing that
 * makes someone stop believing the rest of it.
 */
function kpRightNow(): { kp: number; observed: boolean; source: string } | null {
  const estimated = solarwind.estimatedKp();
  if (estimated) return { kp: estimated.kp, observed: true, source: 'estimated, one minute' };
  const block = swpc.kpAt(new Date());
  return block ? { ...block, source: 'forecast block, three hours' } : null;
}

/** Times are said where the field is, or in UTC and labelled so, never in the server's own zone. */
const localTime = (iso: string, timeZone?: string | null) => spokenTime(iso, timeZone);

/** Unique even after removals. Counting the list reused ids once a field or machine had been removed. */
/** "about 5 hours", or "for less than an hour" where rounding would say zero. */
const forHours = (h: number) => (h < 1 ? 'for less than an hour' : `about ${Math.round(h)} hour${Math.round(h) === 1 ? '' : 's'}`);

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Look the field's timezone up in the background; the answer does not wait for it. */
export function resolveFieldTimeZone(farmId: string, fieldId: string, lat: number, lon: number): void {
  void lookupTimeZone(lat, lon).then((zone) => {
    if (!zone) return;
    store.update(farmId, (x) => {
      const hit = x.fields.find((y) => y.id === fieldId);
      if (hit) hit.timeZone = zone;
    });
  });
}

/**
 * Text a person said, as the model hands it over: control characters and angle
 * brackets removed, whitespace collapsed, and capped.
 *
 * Without this, whatever arrives is spoken back and then stored forever. A probe
 * registered a five thousand character field name and heard all five thousand
 * characters read back, and a name containing a script tag came back verbatim.
 * Neither is dangerous on a speaker, both are wrong.
 */
const clean = (value: unknown, max = 80): string =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/**
 * Whether the same request has just arrived twice.
 *
 * A host retries a call it believes failed, and people repeat themselves. A
 * probe sent one job log twice and got two entries, and registered one field
 * twice and got two fields with the same name, which is exactly the duplicate
 * that Amazon's certification notes call out. Two minutes is the window: a
 * retry lands within seconds, and nobody does the same work twice that fast.
 */
const REPEAT_WINDOW_MS = 2 * 60 * 1000;
const justNow = (iso: string): boolean => Math.abs(Date.now() - new Date(iso).getTime()) < REPEAT_WINDOW_MS;

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A fresh start is asked for twice.
 *
 * The Alexa+ functional requirements ask for two things that pull against each
 * other: clear all accumulated context when the customer explicitly requires a
 * fresh start, and require explicit confirmation before any high-consequence
 * action. A speaker mishearing one sentence should not wipe everything, so the
 * first ask says exactly what would go and the second one does it.
 */
const CONFIRM_WINDOW_MS = 5 * 60 * 1000;
const asked = (at?: string | null): boolean => !!at && Date.now() - new Date(at).getTime() < CONFIRM_WINDOW_MS;
const andList = (parts: string[]): string =>
  parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
const count = (n: number, one: string, many = `${one}s`): string => (n === 1 ? `1 ${one}` : `${n} ${many}`);

export function registerTools(server: McpServer, farmOf: () => string): void {
  /*
   * What each tool does to the world, declared rather than left to be guessed.
   *
   * The specification carries four hints, and a host uses them to decide what it
   * may call speculatively and what it must confirm first. readOnly means nothing
   * in the store changes. destructive means it can remove something the customer
   * would miss. idempotent means saying it twice leaves the same state, which is
   * true here because repeats are folded rather than appended. openWorld means
   * the answer depends on something outside this process: NOAA, a weather
   * service, openFDA, a geocoder, or an email leaving the building.
   */
  server.registerTool(
    'register_field',
    {
      title: 'Add a field',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: 'Register a field so its location can be used to judge storm impact. Latitude matters a lot, auroral-zone fields are hit far harder.',
      inputSchema: {
        name: z.string().describe('What it is called on site, for example "North 40", "Lot 12" or "the south cut"'),
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
        crop: z.string().optional(),
        acres: z.number().optional(),
        baselineKm: z.number().optional().describe('Distance to the RTK base station or network reference, km'),
      },
    },
    async (args) => {
      const id = farmOf();
      const field = { ...args, id: newId('field'), name: clean(args.name), crop: args.crop ? clean(args.crop, 40) : undefined };
      // A field is its name. Registering it again corrects the one already
      // there, rather than leaving the customer with two North 40s.
      const known = store.get(id).fields.find((f) => sameName(f.name, field.name));
      if (known) {
        store.update(id, (f) => {
          const hit = f.fields.find((x) => x.id === known.id);
          if (!hit) return;
          const moved = hit.lat !== field.lat || hit.lon !== field.lon;
          // The name they first gave it wins: a transcript's capitalisation
          // should not quietly rename a field they already have.
          Object.assign(hit, field, { id: known.id, name: hit.name, timeZone: moved ? undefined : hit.timeZone });
        });
        resolveFieldTimeZone(id, known.id, field.lat, field.lon);
        return say(`You already have ${field.name}, so I've updated it instead of adding a second one.`, {
          fieldId: known.id,
          updated: true,
        });
      }
      store.update(id, (f) => void f.fields.push(field));
      resolveFieldTimeZone(id, field.id, field.lat, field.lon);
      return say(`Added ${field.name}.`, { fieldId: field.id });
    },
  );

  server.registerTool(
    'register_equipment',
    {
      title: 'Add a machine',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: 'Register a machine and the GNSS correction it uses. RTK gives centimetres on a quiet day but degrades hardest in a storm.',
      inputSchema: {
        name: z.string().describe('e.g. "the planter"'),
        correction: z.enum(CORRECTIONS).describe(
          'The GNSS correction the machine runs. rtk, also called RTK, network RTK, VRS, a base station or centimetre correction. ' +
          'ppp, also PPP or precise point positioning, decimetre. ' +
          'sbas, also WAAS in North America, EGNOS in Europe, MSAS in Japan, GAGAN in India, sub-metre. ' +
          'autonomous for no correction at all, plain GPS, metres.',
        ),
      },
    },
    async (args) => {
      const id = farmOf();
      const eq = { ...args, id: newId('eq'), name: clean(args.name), correction: args.correction as Correction };
      const known = store.get(id).equipment.find((x) => sameName(x.name, eq.name));
      if (known) {
        store.update(id, (f) => {
          const hit = f.equipment.find((x) => x.id === known.id);
          if (hit) Object.assign(hit, eq, { id: known.id });
        });
        return say(`You already have ${eq.name}, so I've set it to ${eq.correction.toUpperCase()} rather than adding a second one.`, {
          equipmentId: known.id,
          updated: true,
        });
      }
      store.update(id, (f) => void f.equipment.push(eq));
      return say(`Added ${eq.name} on ${eq.correction.toUpperCase()}.`, { equipmentId: eq.id });
    },
  );

  /* ---------------------------------------------------------------- *
   * The question the whole thing exists to answer.
   * ---------------------------------------------------------------- */
  server.registerTool(
    'can_i_run',
    {
      title: 'Can I run this job today?',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'Go or no go for a GPS-guided field operation right now or at a given time, based on the NOAA geomagnetic ' +
        'forecast, the field location, and the accuracy the job actually needs. Also answers how long it stays clear, ' +
        'and when the next clear stretch starts if it is blocked now, so it covers "can I run this", "when does it ' +
        'clear" and "how long have I got". Always read the reason aloud, it names the binding constraint.',
      inputSchema: {
        operation: z.enum(OPERATIONS).describe(OPERATION_HINT),
        field: z.string().optional().describe('Field name as spoken; defaults to the only/first field'),
        equipment: z.string().optional().describe('Machine name; defaults to the first registered'),
        when: z.string().optional().describe('ISO timestamp; defaults to now'),
        deadline: z
          .string()
          .optional()
          .describe(
            'Optional date the job has to be finished by, ISO or a plain date. Say this when the work cannot simply ' +
            'be postponed: a crop insurance planting date, a closing date on a survey, a contract handover, rain coming. ' +
            'It changes the answer from whether accuracy holds to whether waiting is even available.',
          ),
      },
      _meta: { ui: { resourceUri: UI }, 'openai/outputTemplate': UI },
    },
    async ({ operation, field, equipment, when, deadline }) => {
      const farm = store.get(farmOf());
      if (!farm.fields.length) return say(NO_FIELDS);
      if (!farm.equipment.length) return say(NO_EQUIP);

      const f = store.findField(farm, field ?? '');
      if (!f) return say(`I don't have a field called "${field}".`);
      const eq = store.findEquipment(farm, equipment);
      if (!eq) return say(NO_EQUIP);

      const at = when ? new Date(when) : new Date();
      const kp = when ? swpc.kpAt(at) : kpRightNow() ?? swpc.kpAt(at);
      const age = swpc.ageMinutes();
      const snap = swpc.current();

      if (!kp) {
        return say(
          NOAA_DOWN,
          { unavailable: true, reason: snap?.error ?? 'no forecast available' },
        );
      }

      const verdict = assess(operation as Operation, kp.kp, eq, f);
      const win = nextWindow(snap?.slots ?? [], operation as Operation, eq, f, at);

      let text = verdict.reason;
      // How long the yes lasts. Without this, "can I plant" and "how long have
      // I got" were two tools answering one question.
      if (verdict.go && win) {
        const openNow = new Date(win.start).getTime() <= at.getTime() + 60_000;
        text += openNow
          ? ` Clear until ${localTime(win.end, f.timeZone)}, ${forHours(win.hours)}.`
          : ` The next clear stretch starts ${localTime(win.start, f.timeZone)}.`;
      }
      // A go that the solar wind is about to take away is worth saying out
      // loud, because the job that gets started is the one that gets ruined.
      const upstream = solarwind.incoming();
      if (verdict.go && upstream?.level === 'likely') {
        text += ` Watch this one though: ${upstream.say.charAt(0).toLowerCase()}${upstream.say.slice(1)}`;
      }
      // Only talk about waiting when waiting would actually help.
      if (!verdict.go && verdict.limitedBy === 'space_weather') {
        text += win
          ? ` Next clear window opens ${localTime(win.start, f.timeZone)} and runs ${forHours(win.hours)}.`
          : ` Nothing clear in the next three days on this forecast.`;
      }
      // If the job cannot simply be postponed, say whether waiting is even on offer,
      // and if it is not, what is still runnable rather than a bare refusal.
      // Both of these only make sense when the sun is the binding constraint.
      // If the rig simply cannot hit that tolerance, waiting is irrelevant and
      // saying so anyway would contradict the sentence just spoken.
      let pressure = null;
      let degraded = null;
      if (verdict.limitedBy === 'space_weather') {
        if (deadline) {
          const by = new Date(deadline);
          if (!Number.isNaN(by.getTime())) {
            pressure = deadlinePressure(snap?.slots ?? [], operation as Operation, eq, f, at, by);
            text += ` ${pressure.reason}`;
          }
        }
        if (pressure?.verdict === 'no_window_left' || (!win && !verdict.go)) {
          degraded = degradedOptions(kp.kp, eq, f, operation as Operation);
          // Speak the short form. The reasoning behind it rides in the payload
          // for a screen, because a listener will not sit through a paragraph.
          text += ` ${degraded.spoken}`;
        }
      }

      if (snap?.stale && age != null && age > 60) {
        text += ` Note: my NOAA data is ${age} minutes old.`;
      }

      return say(text, {
        ...verdict,
        pressure,
        stillRunnable: degraded?.stillRunnable?.slice(0, 5) ?? null,
        tierChangeWarning: degraded?.advice ?? null,
        field: f.name,
        equipment: eq.name,
        correction: eq.correction,
        observed: kp.observed,
        window: win,
        slots: (snap?.slots ?? []).slice(0, 24),
        thresholdKp: thresholdKp(operation as Operation, eq, f),
        toleranceM: TOLERANCE_M[operation as Operation],
        dataAgeMinutes: age,
      });
    },
  );

  server.registerTool(
    'storm_status',
    {
      title: 'What is the sun doing',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description: 'Current geomagnetic conditions and any active NOAA alerts, in plain language.',
      inputSchema: {},
      _meta: { ui: { resourceUri: UI } },
    },
    async () => {
      const snap = swpc.current();
      const age = swpc.ageMinutes();
      if (!snap?.slots.length) return say(NOAA_DOWN, { unavailable: true });

      const now = kpRightNow();
      // The three hour block is the forecast. The one minute estimate is what
      // is actually happening, and they can disagree by a whole level during
      // the hour a storm arrives.
      const estimated = solarwind.estimatedKp();
      const upstream = solarwind.incoming();
      // The feed carries the past week too, so the forecast peak comes only from blocks not yet over.
      const ahead = snap.slots.filter((s) => new Date(s.time).getTime() + 3 * 3_600_000 > Date.now());
      const peak = ahead.length ? ahead.reduce((a, b) => (b.kp > a.kp ? b : a)) : null;
      const lines = [
        estimated
          ? `Kp is ${estimated.kp.toFixed(1)} right now, estimated a minute ago${snap.scales.g > 0 ? `, storm level G${snap.scales.g}` : ''}.`
          : `Kp is ${now?.kp.toFixed(1) ?? '?'} right now${snap.scales.g > 0 ? `, storm level G${snap.scales.g}` : ''}.`,
        upstream && upstream.level !== 'quiet' ? upstream.say : null,
        peak ? `Peak in the forecast is ${peak.kp.toFixed(1)} around ${localTime(peak.time, store.get(farmOf()).fields[0]?.timeZone)}.` : null,
        // R and S do not change a field verdict, but a farmer with an HF set or a
        // neighbour flying a polar route deserves to hear that they are running.
        snap.scales.r > 0 ? `Radio blackout at R${snap.scales.r}, so HF is degraded on the daylit side.` : null,
        snap.scales.s > 0 ? `Solar radiation storm at S${snap.scales.s}, mainly a polar and high-altitude concern.` : null,
        snap.alerts.length ? `Latest NOAA alert: ${snap.alerts[0].summary}` : 'No active alerts.',
      ].filter(Boolean) as string[];
      return say(lines.join(' '), {
        kpNow: estimated?.kp ?? now?.kp ?? null,
        kpSource: estimated ? 'estimated, one minute' : 'forecast block, three hours',
        solarWind: solarwind.wind(),
        incoming: upstream && upstream.level !== 'quiet' ? { level: upstream.level, minutes: upstream.minutes } : null,
        peak: peak ? { kp: peak.kp, time: peak.time } : null,
        scales: snap.scales,
        impacts: activeImpacts(snap.scales).map((i) => ({ scale: i.scale, system: i.system, audience: i.audience })),
        alerts: snap.alerts.slice(0, 3),
        slots: snap.slots.slice(0, 24),
        dataAgeMinutes: age,
        stale: snap.stale,
      });
    },
  );

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
        'If the conditions were quiet, say so plainly rather than inventing a cause.',
      inputSchema: {
        when: z.string().describe('When it happened, spoken or ISO, e.g. "last Tuesday", "10 May 2024"'),
        operation: z.enum(OPERATIONS).optional().describe(OPERATION_HINT),
        field: z.string().optional(),
        equipment: z.string().optional(),
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
        'when a watched job clears.',
      inputSchema: {
        action: z.enum(['start', 'check', 'stop']).describe(
          'start to wait on a job, check to hear which are clear, stop to cancel',
        ),
        operation: z.enum(OPERATIONS).optional().describe(`${OPERATION_HINT} Required when starting a watch.`),
        field: z.string().optional(),
        equipment: z.string().optional(),
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

  /* ---------------------------------------------------------------- *
   * The crew. Staged, confirmed, and only then emailed.
   * ---------------------------------------------------------------- */
  const describeCrew = (reasons: store.NotifyReason[]) =>
    [
      reasons.includes('window_clear') ? 'when a watched job clears' : '',
      reasons.includes('storm') ? 'the day before a storm puts your jobs outside tolerance' : '',
    ]
      .filter(Boolean)
      .join(', and ');

  /*
   * One door for the crew list, not three.
   *
   * Published benchmarks put tool selection above 90 percent up to about twenty
   * tools and falling away after that, and three tools that all mean "the crew
   * list" spend that budget on a distinction the customer never makes. The
   * action is a word they already say: add, confirm, remove.
   */
  server.registerTool(
    'crew_contact',
    {
      title: 'Who to email about a job',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      description:
        'Manage who gets emailed when a watched job clears or a storm is coming. action add stages someone, and ' +
        'nothing is ever sent until action confirm, which the customer has to say yes to first. action remove stops ' +
        'emailing them. Call this when someone says to tell, notify, add, confirm or stop telling a crew member, ' +
        'operator or manager.',
      inputSchema: {
        action: z.enum(['add', 'confirm', 'remove']).describe(
          'add to stage someone new, confirm after the customer says yes to adding them, remove to stop emailing them',
        ),
        name: z.string().describe('Who, as spoken'),
        email: z.string().email().optional().describe('Required when adding'),
        role: z.string().optional().describe('e.g. "planter operator", "crew lead", "survey party chief"'),
        when: z.enum(['window_clear', 'storm', 'both']).optional().describe('both by default, only used when adding'),
      },
    },
    async ({ action, name, email, role, when }) => {
      const id = farmOf();
      name = clean(name, 60);

      if (action === 'add') {
        if (!email) {
          return say(`I need an email address for ${name} before I can add them.`, { staged: false, needs: 'email' });
        }
        role = role ? clean(role, 60) : undefined;
        const notifyOn: store.NotifyReason[] =
          when === 'window_clear' ? ['window_clear'] : when === 'storm' ? ['storm'] : ['window_clear', 'storm'];
        store.update(id, (x) => {
          x.crew = x.crew.filter((c) => !sameName(c.name, name) && c.email.toLowerCase() !== email.toLowerCase());
          x.crew.push({ name, email, role: role ?? null, notifyOn, addedAt: new Date().toISOString(), confirmedAt: null });
        });
        return say(
          `I'll email ${name}${role ? `, your ${role},` : ''} at ${email} ${describeCrew(notifyOn)}. ` +
            `Nothing is sent until you confirm. Should I add ${name}?`,
          { staged: true, name, notifyOn },
        );
      }

      if (action === 'confirm') {
        const contact = store.get(id).crew.find((c) => sameName(c.name, name));
        if (!contact) return say(`I don't have anyone called ${name} waiting to be added.`, { confirmed: false });
        store.update(id, (x) => {
          const c = x.crew.find((y) => sameName(y.name, name));
          if (c && !c.confirmedAt) c.confirmedAt = new Date().toISOString();
        });
        return say(
          `Done. ${contact.name} will get an email ${describeCrew(contact.notifyOn)}.` +
            (emailConfigured() ? '' : " Email isn't switched on for this server yet, so nothing can actually be sent until it is."),
          { confirmed: true, emailConfigured: emailConfigured() },
        );
      }

      if (!store.get(id).crew.some((c) => sameName(c.name, name))) {
        return say(`${name} isn't on your crew list.`, { removed: false });
      }
      store.update(id, (x) => void (x.crew = x.crew.filter((c) => !sameName(c.name, name))));
      return say(`Removed ${name}. They won't be emailed.`, { removed: true });
    },
  );

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
        'crew, a client or an insurer. Call this when the customer says they planted, sprayed, surveyed or ran a job.',
      inputSchema: {
        operation: z.enum(OPERATIONS).describe(OPERATION_HINT),
        field: z.string().optional(),
        equipment: z.string().optional(),
        when: z.string().optional().describe('When it ran, ISO or spoken like "yesterday"; defaults to now'),
        acres: z.number().optional(),
        note: z.string().optional(),
      },
    },
    async ({ operation, field, equipment, when, acres, note }) => {
      const id = farmOf();
      const farm = store.get(id);
      if (!farm.fields.length) return say(NO_FIELDS);
      if (!farm.equipment.length) return say(NO_EQUIP);
      const f = store.findField(farm, field ?? '');
      if (!f) return say(`I don't have a field called "${field}".`);
      const eq = store.findEquipment(farm, equipment);
      if (!eq) return say(NO_EQUIP);
      const at = when ? history.parseWhen(when) : new Date();
      if (!at) return say(`I couldn't work out when "${when}" was. Try a day name or a date.`);

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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        'Summarise logged jobs over recent days, and which ran while space weather put them outside tolerance. Name a ' +
        'confirmed crew contact in emailTo and the same report is emailed to them, for a client, an insurer or the ' +
        'office. Call this when the customer asks for a report, a record, or to send one to someone.',
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
        const contact = farm.crew.find((c) => sameName(c.name, emailTo));
        if (!contact) return say(`${emailTo} isn't on your crew list. Add them first.`, { sent: false });
        if (!contact.confirmedAt) return say(`${contact.name} hasn't been confirmed yet, so I won't email them.`, { sent: false });
        if (!emailConfigured()) return say("I can't email the report yet, because email isn't set up on this server.", { sent: false });
        const lines = entries.map(
          (j) =>
            `${j.at.slice(0, 16).replace('T', ' ')} UTC  ${j.operation.replace(/_/g, ' ')}  ${j.fieldName}  ${j.equipmentName}  ` +
            `Kp ${j.kp == null ? 'unknown' : j.kp.toFixed(1)}  ` +
            `${j.go == null ? 'no record' : j.go ? 'inside tolerance' : j.limitedBy === 'space_weather' ? 'outside tolerance, space weather' : 'outside tolerance, equipment'}` +
            `${j.acres ? `  ${j.acres} acres` : ''}${j.note ? `  ${j.note}` : ''}`,
        );
        void sendEmail({
          to: contact.email,
          reason: 'job_report',
          subject: `Orbita job report, last ${span} days`,
          text: `${lines.length} jobs logged.\n\n${lines.join('\n')}\n\nKp from NOAA SWPC. Tolerances are the ones Orbita uses for each job.`,
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
      return say(parts.join(' '), { days: span, entries, outside, unknown });
    },
  );

  server.registerTool(
    'farm_status',
    {
      title: 'What can I run right now',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description: 'Every registered field and job, and whether accuracy holds for it at the moment.',
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
      const eq = farm.equipment[0];
      if (!eq) return say(NO_EQUIP);
      const rows = farm.fields.flatMap((f) =>
        (statusOperations(eq.correction) as Operation[]).map((op) => {
          const v = assess(op, kp.kp, eq, f);
          return { field: f.name, operation: op, go: v.go, errorM: v.expectedErrorM };
        }),
      );
      const blocked = rows.filter((r) => !r.go);
      const text = blocked.length
        ? `Kp ${kp.kp.toFixed(1)}. ${blocked.length} of ${rows.length} jobs are outside tolerance right now, tightest first: ${blocked.slice(0, 3).map((b) => `${b.operation} on ${b.field}`).join(', ')}.`
        : `Kp ${kp.kp.toFixed(1)}. Everything is inside tolerance.`;
      return say(text, { kp: kp.kp, rows, slots: (snap?.slots ?? []).slice(0, 24) });
    },
  );

  /* ---------------------------------------------------------------- *
   * What to do about it. The same forecast means planting waits, a
   * satellite team defers ground maintenance, a grid control room checks
   * black start units and a dispatcher plans a lower track. Timed to how
   * far off the storm is, because most of these only help a day early.
   * ---------------------------------------------------------------- */
  server.registerTool(
    'what_should_i_do',
    {
      title: 'What should I do about the space weather',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'Protective steps for the person asking, by what they look after: flying drones, running satellites, the power ' +
        'grid, flight operations, HF radio, GPS timing, pipeline surveys, directional drilling, railway signalling, ' +
        'holding a vessel on position, automated mining, tracking a vehicle fleet, watching for aurora, or a ' +
        'household. Timed to the NOAA forecast: a day ahead, hours ahead, during and after. ' +
        'Call this when someone asks what they should do, how to protect something, whether to postpone, or asks for ' +
        'the rest of the steps. Read the answer aloud as given.',
      inputSchema: {
        role: z.enum(ROLES).optional().describe(ROLE_HINT),
        step: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Where to continue from when the customer asks for the rest; use nextStep from the last answer'),
      },
    },
    async ({ role, step }) => {
      const id = farmOf();
      const farm = store.get(id);
      const chosen = (role ?? farm.role) as Role | undefined;
      if (!chosen) {
        return say(
          'Tell me what you look after, for example flying drones, running satellites, the power grid, flights or HF ' +
            'radio, and I will tell you what to do about the space weather.',
          { needsRole: true },
        );
      }
      if (role && role !== farm.role) store.update(id, (f) => void (f.role = role));

      const snap = swpc.current();
      if (!snap?.slots.length) return say(NOAA_DOWN, { unavailable: true });

      // Exposure follows the magnetic field, so use the first registered site when there is one.
      const site = farm.fields[0];
      const gmLat = site ? geomagneticLatitude(site.lat, site.lon) : null;
      const advice = advise(
        chosen,
        {
          now: new Date(),
          levels: { g: snap.scales.g, s: snap.scales.s, r: snap.scales.r },
          yesterday: snap.scales.yesterday,
          days: snap.scales.days,
          slots: snap.slots,
        },
        gmLat,
        step ?? 0,
      );
      return say(advice.spoken, { ...advice, geomagneticLatitude: gmLat, dataAgeMinutes: swpc.ageMinutes() });
    },
  );

  /* ---------------------------------------------------------------- *
   * Certification asks that an add-on can answer what it does, and that
   * every example phrase it offers actually works. Both matter more on a
   * screenless Echo, where there is nothing to read and no menu to browse.
   * ---------------------------------------------------------------- */
  server.registerTool(
    'what_can_you_do',
    {
      title: 'What can this do',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      description:
        'Explain what this add-on is for and how to ask for it. Call this when the customer asks what you can do, ' +
        'what this is, how to use it, or opens with something too vague to route.',
      inputSchema: {},
    },
    async () => {
      const farm = store.get(farmOf());
      const setup =
        !farm.fields.length || !farm.equipment.length
          ? ' First tell me where you work and what correction you run, and I can answer for your own sites.'
          : '';
      return say(
        'I tell you whether satellite guidance will hold the accuracy your job needs, using the NOAA space weather ' +
          'forecast, where you are, and how tight that particular job has to be. Geomagnetic storms push GPS error ' +
          'from centimetres to metres, and the same storm hits a site near the poles far harder than one near the ' +
          'equator. Ask me can I plant the north forty today, or when does it clear for the survey crew, or what is ' +
          'the sun doing, or why did that job go wrong on Tuesday. It works for planting, spraying, harvest and ' +
          'tillage, and for cadastral survey, drone mapping and machine control on grade. And if you fly drones, run ' +
          'satellites, operate the grid, dispatch flights, use HF radio or just want to see the aurora, ask me what you ' +
          'should do about the space weather. I can also watch a blocked job and email your crew when it clears, and ' +
          'keep a log of the jobs you run for a report later.' + setup,
        {
          examplePhrases: [
            'Can I plant the north forty today?',
            'When does it clear for the survey crew?',
            'What is the sun doing?',
          ],
          fieldsRegistered: farm.fields.length,
          equipmentRegistered: farm.equipment.length,
        },
      );
    },
  );

  /* ---------------------------------------------------------------- *
   * "My guidance is out, what else is out?" The scales file already in
   * memory answers this; until now only G was read and the other two
   * were fetched and dropped.
   * ---------------------------------------------------------------- */
  server.registerTool(
    'what_else_is_affected',
    {
      title: 'What else does this storm hit',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'What a space weather event affects besides satellite guidance: the power grid, shortwave radio, polar flights, ' +
        'satellite timing, pipelines and rail. Call this when someone asks what else is going on, whether it is safe, ' +
        'whether it will affect the power or the radio or their phone, or how bad it is generally.',
      inputSchema: {},
      _meta: { ui: { resourceUri: UI } },
    },
    async () => {
      const snap = swpc.current();
      if (!snap) return say(NOAA_DOWN, { unavailable: true });
      const active = activeImpacts(snap.scales);
      return say(speakImpacts(snap.scales), {
        scales: snap.scales,
        impacts: active,
        // Worth stating plainly, because it is the thing people most often get wrong.
        householdElectronics: 'unaffected',
      });
    },
  );
}
