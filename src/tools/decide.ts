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
import * as ntrip from '../ntrip.js';
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
  asked,
  forHours,
  kpRightNow,
  localTime,
  say,
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
        'clear" and "how long have I got". Always read the reason aloud, it names the binding constraint. Use it for '
        + 'a single question about one job. To be told later when a blocked job clears, or to be emailed, use watch_jobs; '
        + 'for the weather in general with no job in mind, use storm_status.',
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
      if (!f) return say(`I don't have a field called "${field}".`);

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
      // The measured half. Everything above reasons from Kp through a table;
      // this is the electron content actually over the field, and the part of it
      // the base station cannot difference away across this rig's baseline. It
      // speaks only when that residual alone passes the job's tolerance, which
      // is a thing the forecast genuinely cannot know.
      const measured = glotec.explain(f.lat, f.lon, f.baselineKm, TOLERANCE_M[operation as Operation]);
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
      const oval = aurora.explain(f.lat, f.lon, geomagneticLatitude(f.lat, f.lon) - auroralBoundaryDeg(kp.kp));
      if (oval) text += ` ${oval}`;
      // Days of notice rather than minutes. Only on a go: telling someone who
      // already cannot run today about Thursday is noise, and the window
      // sentence above already covers when it clears.
      if (verdict.go) {
        const inbound = swpcplus.cmeSentence();
        if (inbound) text += ` ${inbound}`;
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

      if (assumed) {
        text += ` That is for ${f.name} with ${eq.name}; name a different one and I will check that instead.`;
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
      description:
        'Current geomagnetic conditions and any active NOAA alerts, in plain language: the Kp index, the storm scale, ' +
        'and whether anything is happening right now. Call this when someone asks what the sun or space weather is doing, ' +
        'whether a storm is coming, or for the Kp. It does not say whether a job can run; use can_i_run for that, and ' +
        'what_should_i_do when they say what they operate.',
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

}
