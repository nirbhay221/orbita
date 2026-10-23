/**
 * The question the whole thing exists to answer.
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
import * as roti from '../roti.js';
import { HARDENED_WATCH } from '../domain.js';
import * as interference from '../interference.js';
import * as crewheat from '../crewheat.js';
import * as crewday from '../crewday.js';
import { adviceNow } from '../trade.js';
import * as ntrip from '../ntrip.js';
import * as swpcplus from '../swpcplus.js';
import * as aurora from '../aurora.js';
import { chooseOne, canAsk } from '../elicit.js';
import * as season from '../season.js';
import * as store from '../store.js';
import { sentences } from '../brief.js';
import { geocode, spoken as spokenPlace, GeocoderDown, lookupDown } from '../geocode.js';
import * as history from '../history.js';
import { advise, ROLES, ROLE_HINT, type Role } from '../playbook.js';
import { sendEmail, emailConfigured } from '../notify.js';
import { lookupTimeZone, spokenTime } from '../timezone.js';
import {
  CORRECTIONS,
  NOAA_DOWN,
  NO_EQUIP,
  NO_FIELDS,
  OPERATIONS,
  OPERATION_HINT,
  UI,
  asked,
  clean,
  forHours,
  kpRightNow,
  localTime,
  namesOf,
  say,
  spokenJob,
  upcomingSlots,
} from './shared.js';

export function register(server: McpServer, farmOf: () => string): void {
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
        'clear" and "how long have I got". Only the job is needed; the saved field and machine are used. ' +
        'Read the reason aloud. Use it for '
        + 'a single question about one job. To be told later when a blocked job clears, or to be emailed, use watch_jobs; '
        + 'for the weather in general with no job in mind, use storm_status.',
      inputSchema: {
        operation: z.enum(OPERATIONS).describe(OPERATION_HINT),
        field: z.string().optional().describe('Field name as spoken, or the fieldId from an earlier answer; defaults to the only or first field'),
        equipment: z.string().optional().describe('Machine name as spoken, or the equipmentId from an earlier answer; defaults to the first registered'),
        place: z.string().optional().describe('The nearest town, as spoken: for somebody with no field registered yet, or for a job somewhere other than their saved fields. Judged there, and nothing is saved'),
        correction: z.enum(CORRECTIONS).optional().describe('Only for somebody with no machine registered yet: the correction they say they run. rtk, ppp, sbas (also WAAS or EGNOS) or autonomous for none'),
        when: z.string().optional().describe('When, if not now: ISO, or as spoken, such as "tomorrow morning", "Thursday" or "this afternoon". The forecast reaches about three days ahead.'),
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
    async ({ operation, field, equipment, when, deadline, place, correction }) => {
      const held = store.get(farmOf());
      // A first question should get an answer, not a form. Somebody who says "can I plant near Fargo on RTK"
      // has given everything the verdict needs, so it is judged for that town and that correction without
      // anything being registered. Nothing is stored: the answer ends by offering to remember it.
      let farm = held;
      let trial = false;
      // A town asked about by somebody who already has fields is a question about that town, unless it is one of
      // their fields by name. It used to be dropped, and "a drone show in Hong Kong tonight" was answered for a
      // field in Iowa.
      const elsewhere = !!place && !field && held.fields.length > 0 &&
        !held.fields.some((x) => x.name.toLowerCase() === clean(place, 80).toLowerCase());
      if (place && !field && held.fields.length && !elsewhere) field = clean(place, 80);
      if ((!held.fields.length || elsewhere) && place) {
        const found = await geocode(clean(place, 80)).catch((err) => (err instanceof GeocoderDown ? 'down' as const : Promise.reject(err)));
        if (found === 'down') return say(lookupDown(clean(place, 80)), { unavailable: true });
        if (!found) return say(`I couldn't find ${clean(place, 80)}. Try the nearest town with its state or country.`, { unavailable: true });
        // The lookup that found the town also says what time zone it keeps. Without it a first answer gave
        // "clear until Wed 3 AM UTC" to somebody in Arizona.
        // "The North 40, near Grand Island" with nothing saved names the field too. The town was judged as a field
        // named after the town, and the name said with it then matched nothing: "I need to know where the field is".
        farm = { ...farm, fields: [{ id: 'trial-field', name: field && !held.fields.length ? clean(field, 60) : spokenPlace(found), lat: found.lat, lon: found.lon, ...(found.timeZone ? { timeZone: found.timeZone } : {}), ...(found.countryCode ? { countryCode: found.countryCode } : {}) }] };
        trial = true;
      }
      if (!held.equipment.length && correction) {
        // Named as they named it, so "the planter's on RTK" is not answered "I don't have a machine called planter".
        farm = { ...farm, equipment: [{ id: 'trial-machine', name: equipment ? clean(equipment, 40) : 'your machine', correction: correction as Correction }] };
        trial = true;
      }
      if (!farm.fields.length) return say(NO_FIELDS, { needs: 'field' });
      if (!farm.equipment.length) return say(NO_EQUIP, { needs: 'equipment' });

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
      if (!f) return say(`I don't have a field called "${clean(field)}".${namesOf(farm.fields)} Which one did you mean?`);

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
      // A machine that was named and not found is answered for the first machine, which is only honest if
      // the answer says so. Otherwise "can I run the drill" is silently a verdict about the planter.
      const guessedMachine = !!chosenEquip && !store.equipmentNamed(farm, chosenEquip);

      // When nobody could be asked, the answer still has to say which field and
      // machine it is about, because the customer named neither and the old
      // behaviour was to pick silently.
      const assumed = !field && farm.fields.length > 1 && chosenName === undefined;

      // "when" arrives as speech as often as it arrives as a timestamp. It used to go straight into
      // new Date(), so "tomorrow morning" became an invalid date, and an invalid date was then answered with
      // the oldest block in NOAA's file: a week-old Kp, stated as the answer for tomorrow.
      const now = new Date();
      const at = when ? history.parseWhen(when, now, { prefer: 'future', timeZone: f.timeZone, country: f.countryCode }) : now;
      if (!at) {
        return say(`I could not work out when "${clean(when)}" is. Say a day, like tomorrow or Thursday, or ask about right now.`, { unavailable: true });
      }
      if (when && at.getTime() < now.getTime() - 3 * 3_600_000) {
        return say('That is in the past. Ask me what happened that day and I will look it up.', { unavailable: true });
      }
      const age = swpc.ageMinutes();
      const snap = swpc.current();
      const until = swpc.horizon();
      if (when && until && at.getTime() >= until.getTime()) {
        return say(
          `NOAA's forecast only reaches ${localTime(until.toISOString(), f.timeZone)}, so I cannot judge that far ahead. ` +
            'Ask me nearer the time, or ask me to plan the season for a rougher look at the weeks ahead.',
          { unavailable: true, forecastEnds: until.toISOString() },
        );
      }
      const asksAboutNow = !when || Math.abs(at.getTime() - now.getTime()) < 30 * 60_000;
      const kp = asksAboutNow ? kpRightNow() ?? swpc.kpAt(at) : swpc.kpAt(at);

      if (!kp) {
        return say(
          NOAA_DOWN,
          { unavailable: true, reason: snap?.error ?? 'no forecast available' },
        );
      }

      const verdict = assess(operation as Operation, kp.kp, eq, f, at);
      let measuredBlock = false;
      const win = nextWindow(snap?.slots ?? [], operation as Operation, eq, f, at);

      /*
       * What is measured over the field right now outranks a forecast that says clear.
       *
       * NOAA's ionosphere map is the electron content actually overhead, ten minutes old. When the slope of it
       * across this rig's baseline leaves more uncorrected error than the job tolerates, the job is not clear,
       * whatever Kp says: that is a measurement against a table. It only ever turns a yes into a no. The map
       * is too coarse to see the small structure that does much of the damage, so a calm map is not evidence
       * of a calm sky and never clears a job the forecast has blocked. Only for a question about now, only
       * from a cell that was observed and not filled from climatology, and only for RTK, which is what a
       * baseline means.
       */
      const iono = asksAboutNow && eq.correction === 'rtk' && f.baselineKm ? glotec.ionosphere(f.lat, f.lon) : null;
      const leftOver = iono?.observed && f.baselineKm ? glotec.residual(f.lat, f.lon, f.baselineKm) : null;
      const tolM = TOLERANCE_M[operation as Operation];
      if (verdict.go && leftOver != null && leftOver > tolM) {
        const cm = Math.round(leftOver * 100);
        verdict.go = false;
        verdict.limitedBy = 'space_weather';
        verdict.expectedErrorM = Number(Math.max(verdict.expectedErrorM, leftOver).toFixed(3));
        verdict.reason =
          `Hold off ${spokenJob(operation)} for now. The forecast alone would call it clear at Kp ${kp.kp.toFixed(1)}, but what is measured over the field is not: ` +
          `the ionosphere across your ${Math.round(f.baselineKm as number)} kilometre baseline is leaving about ${cm} centimetres your base station cannot correct, ` +
          `and this job needs it inside ${Math.round(tolM * 100)}.`;
        measuredBlock = true;
      }

      /*
       * The sky over the field, measured in the last few minutes, from about four thousand satellite links
       * worldwide. See roti.ts. This one can go both ways, because it measures the small fast structure that
       * actually breaks a fix rather than a planetary average:
       *   disturbed overhead turns a forecast yes into a no;
       *   calm overhead, with plenty of links, turns a forecast no into a yes for now, below Kp 8, saying
       *   plainly that it is a measurement of the last few minutes and can change.
       * Only for a question about now, and only for receivers that hold a carrier-phase fix (RTK, PPP).
       */
      let measuredClear = false;
      const sky = asksAboutNow && (eq.correction === 'rtk' || eq.correction === 'ppp') ? roti.over(f.lat, f.lon) : null;
      if (sky?.state === 'disturbed' && verdict.go && verdict.limitedBy !== 'equipment' && eq.hardened) {
        // Built for exactly this. See Equipment.hardened.
        verdict.reason = `${verdict.reason} ${roti.say(sky)} ${HARDENED_WATCH}`;
        measuredBlock = true;
      } else if (sky?.state === 'disturbed' && verdict.go && verdict.limitedBy !== 'equipment') {
        verdict.go = false;
        verdict.limitedBy = 'space_weather';
        verdict.reason =
          `Hold off ${spokenJob(operation)} for now. The forecast alone would call it clear at Kp ${kp.kp.toFixed(1)}, but ${roti.say(sky).charAt(0).toLowerCase()}${roti.say(sky).slice(1)}`;
        measuredBlock = true;
      } else if (sky?.state === 'quiet' && !verdict.go && verdict.limitedBy === 'space_weather' && kp.kp < 8) {
        verdict.go = true;
        verdict.reason =
          `You can run ${spokenJob(operation)} now. The forecast at Kp ${kp.kp.toFixed(1)} says hold off, but ${roti.say(sky).charAt(0).toLowerCase()}${roti.say(sky).slice(1)} ` +
          'That is a measurement of the last few minutes, so check your fix status as you go and stop if it drops.';
        measuredBlock = true;
        measuredClear = true;
      }

      let text = verdict.reason;
      // When it clears is the second thing anybody wants to know, so it is said second. It used to come after
      // the ionosphere, the magnetometer and the aurora, by which time nobody was listening.
      if (!verdict.go && verdict.limitedBy === 'space_weather') {
        text += win
          ? ` Next clear window opens ${localTime(win.start, f.timeZone)} and runs ${forHours(win.hours)}.`
          : ` Nothing clear in the next three days on this forecast.`;
      }
      // How long the yes lasts. Without this, "can I plant" and "how long have
      // I got" were two tools answering one question.
      if (verdict.go && win && !measuredClear) {
        const openNow = new Date(win.start).getTime() <= at.getTime() + 60_000;
        text += openNow
          ? ` Clear until ${localTime(win.end, f.timeZone)}, ${forHours(win.hours)}.`
          : ` The next clear stretch starts ${localTime(win.start, f.timeZone)}.`;
      }
      // The one sentence about this trade's own risk: points to re-observe, a flight that cannot be redone,
      // grade somebody will build on. Said with the verdict when the answer is no. See trade.ts.
      const trade = adviceNow(operation as Operation, verdict.go, kp.kp, verdict.limitedBy, verdict.equatorial === true);
      if (trade) text += ` ${trade}`;
      // A go that the solar wind is about to take away is worth saying out
      // loud, because the job that gets started is the one that gets ruined.
      const upstream = solarwind.incoming();
      const mustSay: string[] = [];
      if (trade && !verdict.go) mustSay.push(trade);
      if (verdict.go && upstream?.level === 'likely') {
        const warning = `Watch this one though: ${upstream.say.charAt(0).toLowerCase()}${upstream.say.slice(1)}`;
        text += ` ${warning}`;
        // A storm about to arrive on a job just called clear is not detail. It is said even when the rest waits.
        mustSay.push(sentences(warning)[0]);
      }
      // What is not the sun: a military GPS test scheduled over the field, or aircraft reporting interference.
      // Said with a yes and with a no, because a crew told "the sky is quiet" will otherwise blame the forecast.
      const other = interference.near(f.lat, f.lon, at);
      const otherSaid = interference.sayAhead(other);
      if (otherSaid) {
        text += ` ${otherSaid}`;
        mustSay.push(sentences(otherSaid)[0]);
      }
      // The measured half. Everything above reasons from Kp through a table;
      // this is the electron content actually over the field, and the part of it
      // the base station cannot difference away across this rig's baseline. It
      // speaks only when that residual alone passes the job's tolerance, which
      // is a thing the forecast genuinely cannot know.
      // Already the reason for the answer when the measurement is what blocked it.
      const overhead = measuredBlock ? '' : roti.say(sky);
      if (overhead) text += ` ${overhead}`;
      const measured = measuredBlock ? '' : glotec.explain(f.lat, f.lon, f.baselineKm, TOLERANCE_M[operation as Operation]);
      if (measured) text += ` ${measured}`;
      // Where the corrections come from, when nobody has said. This matters
      // because baselineKm is what the residual above is multiplied by.
      const corrections = ntrip.explain(f.lat, f.lon, f.baselineKm);
      if (corrections) text += ` ${corrections}`;
      // And whether the ground near the field has felt the storm the forecast
      // is describing, plus where the disturbance actually is.
      const ground = geomag.corroboration(f.lat, f.lon, kp.kp);
      if (ground) text += ` ${ground}`;
      const placed = swpcplus.whereIsIt(geomag.reading(f.lat, f.lon)?.level ?? null);
      if (placed) text += ` ${placed}`;
      // Where the oval actually is, which the linear Kp rule cannot know,
      // because the oval is offset towards the night side.
      // Positive means the Kp rule puts the field clear of the oval, on its equatorward side, which is the
      // case aurora.explain is written for. This used to pass the opposite sign, and the signed latitude, so the
      // sentence fired for fields the rule already put inside the oval and never for the southern hemisphere.
      const oval = aurora.explain(f.lat, f.lon, auroralBoundaryDeg(kp.kp) - Math.abs(geomagneticLatitude(f.lat, f.lon)));
      if (oval) text += ` ${oval}`;
      // Days of notice rather than minutes. Only on a go: telling someone who
      // already cannot run today about Thursday is noise, and the window
      // sentence above already covers when it clears.
      if (verdict.go) {
        const inbound = swpcplus.cmeSentence();
        if (inbound) text += ` ${inbound}`;
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
      // A date they have to be done by, on a clear day: it was dropped without a word, so the answer sounded like
      // it had not heard. A bare date is a calendar day, read as written, not shifted into the field's time zone.
      if (deadline && verdict.go) {
        const by = new Date(deadline);
        const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(deadline.trim());
        if (!Number.isNaN(by.getTime()) && by.getTime() + (dateOnly ? 86_400_000 : 0) > at.getTime()) {
          const day = by.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: dateOnly ? 'UTC' : f.timeZone ?? 'UTC' });
          const line = `That's ahead of ${day}, the date you need it done by, so there's no reason to wait.`;
          text += ` ${line}`;
          mustSay.push(line);
        }
      }

      // The people on the machine, for the hours the job would actually run: from now while it is clear, or
      // the clear window it is waiting for. Nothing is said for a job the rig can never hold. See crewheat.ts.
      const workFrom = verdict.go ? at : win ? new Date(win.start) : null;
      const workHours = Math.min(12, verdict.go ? (win && new Date(win.start).getTime() <= at.getTime() + 60_000 ? win.hours : 8) : win?.hours ?? 0);
      const crew = workFrom && verdict.limitedBy !== 'equipment' ? crewheat.during(f.lat, f.lon, workFrom, workHours) : null;
      if (crew) {
        const line = crewheat.sentence(crew, (iso) => localTime(iso, f.timeZone));
        text += ` ${line}`;
        // Past 90 is a decision about people, so it is heard with the verdict. Past 80 waits to be asked for.
        if (crew.level === 'high') mustSay.push(line);
      }
      // Rain over the field, for the two jobs it ruins; GPS is not one of them. See crewheat.ts.
      if (workFrom && (operation === 'spraying' || operation === 'drone_survey')) {
        const rain = crewheat.rainAhead(f.lat, f.lon, workFrom, Math.max(3, Math.min(workHours, 6)));
        if (rain) {
          const line = crewheat.rainSentence(operation, rain, (iso) => localTime(iso, f.timeZone));
          text += ` ${line}`;
          mustSay.push(sentences(line)[0]);
        }
      }
      // And the people by name, for a job that would run today: whoever is still getting used to the heat,
      // and whoever it turns risky for earlier. Asked of the heat safety server in the background. See crewday.ts.
      const named = asksAboutNow && workFrom ? crewday.sentences(held.crew.map((c) => ({ name: c.name, link: c.dayLink }))) : [];
      for (const line of named) {
        text += ` ${line}`;
        mustSay.push(line);
      }

      if (assumed) {
        const note = `That is for ${f.name} with ${eq.name}; name a different one and I will check that instead.`;
        text += ` ${note}`;
        mustSay.push(note);
      } else if (guessedMachine) {
        const note = `I don't have a machine called "${clean(chosenEquip)}", so that is for ${eq.name}.`;
        text += ` ${note}`;
        mustSay.push(note);
      }

      if (snap?.stale && age != null && age > 60) {
        text += ` Note: my NOAA data is ${age} minutes old.`;
      }

      // The step that finishes the job, put as one question. A blocked job that will clear can be watched;
      // somebody trying it out can have it remembered.
      const watching = held.waiting.some((w) => w.operation === operation && w.fieldId === f.id && w.equipmentId === eq.id);
      const offer = trial
        ? 'Want me to remember this field and machine?'
        : !verdict.go && verdict.limitedBy === 'space_weather' && win && !watching && asksAboutNow
          ? 'Want me to watch it and tell you when it clears?'
          : '';

      return say(text, {
        ...verdict,
        ...(offer ? { offer } : {}),
        ...(mustSay.length ? { mustSay } : {}),
        ...(trial ? { trial: true } : {}),
        // What is not the sun, with where each fact came from. See interference.ts.
        ...(otherSaid
          ? {
              otherCauses: {
                gpsTests: other.tests.map((t) => ({ name: t.name, id: t.id, place: t.place, milesAway: Math.round(t.milesAway ?? 0), until: t.end })),
                aircraftReports: other.reported,
                satellitesOut: other.satellites.map((x) => x.prn),
                sources: interference.SOURCES,
              },
            }
          : {}),
        nextAction:
          offer && !trial
            ? { tool: 'watch_jobs', arguments: { action: 'start', operation, field: f.id, equipment: eq.id } }
            : trial && place
              ? { tool: 'my_farm', arguments: { fieldName: f.name, place: clean(place, 80), ...(correction ? { machineName: 'my machine', correction } : {}) } }
              : null,
        pressure,
        stillRunnable: degraded?.stillRunnable?.slice(0, 5) ?? null,
        tierChangeWarning: degraded?.advice ?? null,
        field: f.name,
        ...(f.countryCode ? { countryCode: f.countryCode } : {}),
        equipment: eq.name,
        // Stable handles for the next call, so a follow-up does not depend on a name being heard the same way twice.
        ...(trial ? {} : { fieldId: f.id, equipmentId: eq.id }),
        correction: eq.correction,
        observed: kp.observed,
        window: win,
        slots: upcomingSlots(snap?.slots ?? [], at.getTime()),
        thresholdKp: thresholdKp(operation as Operation, eq, f),
        toleranceM: TOLERANCE_M[operation as Operation],
        dataAgeMinutes: age,
        // Null with checked true means under 80. Checked false means no forecast was held, which is not the same as fine.
        crewHeat: crew ? { ...crew, rule: 'https://www.osha.gov/heat-exposure/rulemaking' } : null,
        crewHeatChecked: crewheat.known(f.lat, f.lon),
        crewDays: named.length,
        ...(trade ? { tradeAdvice: trade } : {}),
        decidedBy: measuredBlock ? 'measured' : 'forecast',
        ...(sky ? { skyOverField: { ...sky, source: roti.SOURCE } } : {}),
        ...(measuredClear ? { measuredClear: true } : {}),
      });
    },
  );

  server.registerTool(
    'storm_status',
    {
      title: 'What is the sun doing',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'Current geomagnetic conditions and any active NOAA alerts, in plain language: the Kp index, the storm scale, ' +
        'and whether anything is happening right now. Call this when someone asks what the sun or space weather is doing, ' +
        'whether a storm is coming, or for the Kp. It does not say whether a job can run; use can_i_run for that.',
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
          ? `Kp is ${estimated.kp.toFixed(1)} right now, from the one minute estimate${snap.scales.g > 0 ? `, storm level G${snap.scales.g}` : ''}.`
          : `Kp is ${now?.kp.toFixed(1) ?? '?'} right now${snap.scales.g > 0 ? `, storm level G${snap.scales.g}` : ''}.`,
        upstream && upstream.level !== 'quiet' ? upstream.say : null,
        peak ? `Peak in the forecast is ${peak.kp.toFixed(1)} around ${localTime(peak.time, store.get(farmOf()).fields[0]?.timeZone)}.` : null,
        // R and S do not change a field verdict, but a farmer with an HF set or a
        // neighbour flying a polar route deserves to hear that they are running.
        snap.scales.r > 0 ? `Radio blackout at R${snap.scales.r}, so HF is degraded on the daylit side.` : null,
        snap.scales.s > 0 ? `Solar radiation storm at S${snap.scales.s}, mainly a polar and high-altitude concern.` : null,
        snap.alerts.length ? `Latest NOAA alert: ${snap.alerts[0].summary}.` : 'No recent NOAA alerts.',
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
        slots: upcomingSlots(snap.slots),
        dataAgeMinutes: age,
        stale: snap.stale,
      });
    },
  );

}
