/**
 * What every tool group needs.
 *
 * tools.ts reached 1,324 lines and fifteen tools in one function, which is the
 * point at which a reader stops being able to find anything and a reviewer stops
 * reading the diff. The tools are now grouped by what they are for, one file
 * each, and this holds the parts they all reach for: the response shape, the
 * operation and correction vocabularies, the refusal sentences, and the small
 * phrasing helpers that keep "about 3 hours" and "North 40 and Lot 12" reading
 * the same wherever they are said.
 *
 * Nothing here changed in the move. It is the same code in a smaller room.
 */

import { secondChoice } from '../region.js';
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

export const UI = 'ui://orbita/window.html';
/** The view for tasks that are not a chart: a list being watched, a report, somebody being confirmed. */
export const CARD = 'ui://orbita/card.html';

/**
 * What every answer from this server contains, declared so a host can rely on it.
 *
 * Alexa+'s functional requirements ask for "well-formed responses that conform to your declared schema", and
 * a tool that publishes no outputSchema gives a host nothing to check. The schema is deliberately loose
 * about the rest: each tool adds its own fields (a verdict, a window, the next step) and those stay free to
 * grow, so only the part that is true of every answer is promised, which is the sentence to say aloud.
 */
export const SPOKEN_ANSWER = z.object({ spoken: z.string().describe('The answer to say aloud, as written') }).passthrough();

export const say = (text: string, structured?: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text }],
  // Always present, so the declared outputSchema is true of every answer and a host that reads
  // structured data never has to fall back to parsing the text.
  structuredContent: { spoken: text, ...(structured ?? {}) },
});

/**
 * The blocks still to come, which is what a panel titled "72-hour accuracy window" has to draw.
 *
 * NOAA's file starts a week in the past: about fifty observed blocks, then the forecast. Every tool used to
 * send `slots.slice(0, 24)`, the OLDEST three days, so the chart showed last week and none of the forecast.
 */
export const upcomingSlots = <T extends { time: string }>(slots: T[], from = Date.now(), limit = 24): T[] =>
  slots.filter((s) => new Date(s.time).getTime() + 3 * 3_600_000 > from).slice(0, limit);

/** A job id said aloud: "machine control", never "machine_control". */
export const spokenJob = (operation: string): string => operation.replace(/_/g, ' ');

/** The names somebody could have meant, for a refusal that leaves them a next step. Five at most, as voice requires. */
export const namesOf = (items: { name: string }[]): string =>
  items.length ? ` You have ${items.slice(0, 5).map((x) => x.name).join(', ')}${items.length > 5 ? ', and more' : ''}.` : '';

export const OPERATIONS = [
  'planting', 'strip_till', 'cultivating', 'spraying', 'harvest', 'tillage', 'scouting',
  'surveying', 'drone_survey', 'drone_show', 'machine_control',
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

export const OPERATION_HINT =
  'The job being done. planting, also called drilling or seeding or putting the crop in. ' +
  'strip_till for strip tilling. cultivating, also row-crop cultivation or inter-row work. ' +
  'spraying, also chemical, herbicide, a spray pass or boom work. ' +
  'harvest, also combining, cutting or picking. ' +
  'tillage, also discing, ripping, ploughing or plowing or working ground. ' +
  'scouting, also walking the field or crop checks. ' +
  'surveying for cadastral, boundary, topo, staking or setting out. ' +
  'drone_survey for UAV, UAS, photogrammetry or a mapping flight. ' +
  'drone_show for a drone light show, a swarm or a formation flight. ' +
  'machine_control for grade control, earthworks, cut and fill, or a dozer, grader or excavator on design grade.';
export const CORRECTIONS = ['rtk', 'ppp', 'sbas', 'autonomous'] as const;

/*
 * The questions that get a farm set up, worded the way Amazon asks for Alexa+ add-ons and its voice design guide:
 * say why first, then ask, so the question is the last thing heard before the microphone opens; one question at a
 * time; no more than three spoken choices, never a menu; and a way to answer "I don't know", because many
 * operators never set the correction themselves.
 *   https://developer.amazon.com/en-US/docs/alexa/alexaplus/add-ons/functional-requirements.html
 *   https://developer.amazon.com/fr/designing-for-voice/what-alexa-says/
 *   https://developer.amazon.com/alexa/alexa-haus/patterns-and-components
 */
/** "sprayer" is said as "the sprayer"; "my planter" and "the rover" are left as they are. */
const theMachine = (name: string): string => (/^(the|my|our|his|her|their)\s/i.test(name) ? name : `the ${name}`);
export const ASK_FIRST_FIELD = 'A storm hits a field harder the further north it is. Which field should I watch, and what town is it near?';
export const ASK_CORRECTION = (machine?: string, country?: string | null): string =>
  `How far a storm throws your guidance depends on the correction ${machine ? theMachine(clean(machine)) : 'your machine'} runs. Is it RTK, ${secondChoice(country)}, or are you not sure?`;
export const ASK_FIELD_FOR_MACHINE = 'Which field is it working, and what town is it near?';
export const OFFER_CHECK = 'Want me to check whether you can run a job there today?';
/** Said when they do not know the correction. RTK is the one a storm degrades first, so nothing is passed that should be held. */
export const ASSUMED_RTK = "I'll judge it as RTK, the most demanding, so I never pass a job I should hold. It's shown on the guidance display's GPS or receiver page, or your dealer will know.";

// Each says what to say next, in words a person has: the nearest town, and how the machine is corrected.
export const NO_FIELDS = 'I need to know where the field is first. Tell me its name and the nearest town, and I will take it from there.';
export const NO_EQUIP = 'I need to know what correction your machine runs. Tell me its name and whether it is on RTK, WAAS, PPP or no correction.';
/**
 * Certification requires an actionable next step on every error, and a wrong
 * go-ahead here costs a season, so this never guesses. It says what is wrong,
 * what to do instead, and when to come back.
 */
export const NOAA_DOWN =
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
export function kpRightNow(): { kp: number; observed: boolean; source: string } | null {
  const estimated = solarwind.estimatedKp();
  if (estimated) return { kp: estimated.kp, observed: true, source: 'estimated, one minute' };
  const block = swpc.kpAt(new Date());
  return block ? { ...block, source: 'forecast block, three hours' } : null;
}

/** Times are said where the field is, or in UTC and labelled so, never in the server's own zone. */
export const localTime = (iso: string, timeZone?: string | null) => spokenTime(iso, timeZone);

/** Unique even after removals. Counting the list reused ids once a field or machine had been removed. */
/** "about 5 hours", or "for less than an hour" where rounding would say zero. */
export const forHours = (h: number) => (h < 1 ? 'for less than an hour' : `about ${Math.round(h)} hour${Math.round(h) === 1 ? '' : 's'}`);

export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

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
export const clean = (value: unknown, max = 80): string =>
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
export const REPEAT_WINDOW_MS = 2 * 60 * 1000;
export const justNow = (iso: string): boolean => Math.abs(Date.now() - new Date(iso).getTime()) < REPEAT_WINDOW_MS;

export const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A fresh start is asked for twice.
 *
 * The Alexa+ functional requirements ask for two things that pull against each
 * other: clear all accumulated context when the customer explicitly requires a
 * fresh start, and require explicit confirmation before any high-consequence
 * action. A speaker mishearing one sentence should not wipe everything, so the
 * first ask says exactly what would go and the second one does it.
 */
export const CONFIRM_WINDOW_MS = 5 * 60 * 1000;
export const asked = (at?: string | null): boolean => !!at && Date.now() - new Date(at).getTime() < CONFIRM_WINDOW_MS;
export const andList = (parts: string[]): string =>
  parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
export const count = (n: number, one: string, many = `${one}s`): string => (n === 1 ? `1 ${one}` : `${n} ${many}`);
