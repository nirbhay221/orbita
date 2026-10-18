/**
 * Getting a farm on the books.
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
import * as swpcplus from '../swpcplus.js';
import * as aurora from '../aurora.js';
import { chooseOne, canAsk } from '../elicit.js';
import * as season from '../season.js';
import { geocode, spoken as spokenPlace, GeocoderDown, lookupDown } from '../geocode.js';
import * as store from '../store.js';
import { farmCountry } from '../region.js';
import * as history from '../history.js';
import { advise, ROLES, ROLE_HINT, type Role } from '../playbook.js';
import { sendEmail, emailConfigured } from '../notify.js';
import { lookupTimeZone, spokenTime } from '../timezone.js';
import {
  CORRECTIONS,
  ASK_CORRECTION,
  ASK_FIELD_FOR_MACHINE,
  ASSUMED_RTK,
  OFFER_CHECK,
  clean,
  newId,
  resolveFieldTimeZone,
  sameName,
  say,
} from './shared.js';

export function register(server: McpServer, farmOf: () => string): void {
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
      description:
        'Register a field so its location can be used to judge storm impact. Latitude matters a lot, auroral-zone ' +
        'fields are hit far harder. Call this when the customer adds or names a new field and says where it is: ' +
        'the nearest town is enough, passed as place. Use lat and lon only when they give coordinates themselves. ' +
        'Registering the same name again corrects it rather than adding a second one. ' +
        'It does not register a machine; use register_equipment for that.',
      inputSchema: {
        name: z.string().describe('What it is called on site, for example "North 40", "Lot 12" or "the south cut"'),
        place: z.string().optional().describe('The nearest town, as spoken, with the state or country if they said it: "Grand Island, Nebraska"'),
        lat: z.number().min(-90).max(90).optional().describe('Latitude in decimal degrees, north positive, only if they gave coordinates. Convert spoken numbers, so "forty one point one" is 41.1'),
        lon: z.number().min(-180).max(180).optional().describe('Longitude in decimal degrees, west negative, only if they gave coordinates. "ninety eight point one west" is -98.1'),
        crop: z.string().optional().describe('What is grown there, such as corn or soybeans'),
        acres: z.number().positive().optional().describe('Size in acres'),
        baselineKm: z.number().positive().max(2000).optional().describe('Distance to the RTK base station or network reference, km'),
      },
    },
    async (given) => {
      const id = farmOf();
      // Where it is. Coordinates if they were given; otherwise the town, looked up once, here, and never
      // while answering a question about the field.
      let where: { lat: number; lon: number } | null = given.lat != null && given.lon != null ? { lat: given.lat, lon: given.lon } : null;
      let zone: string | undefined;
      let country: string | undefined;
      let near = '';
      if (!where) {
        const place = clean(given.place ?? '', 80);
        if (!/[a-z0-9]/i.test(place)) {
          return say(`Where is ${clean(given.name) || 'it'}? The nearest town will do.`, { added: false, reason: 'place' });
        }
        let found;
        try {
          found = await geocode(place);
        } catch (err) {
          if (err instanceof GeocoderDown) return say(lookupDown(place), { added: false, reason: 'lookup_down' });
          throw err;
        }
        if (!found) {
          return say(`I couldn't find ${place}. Try the nearest town with its state or country.`, { added: false, reason: 'not_found' });
        }
        where = { lat: found.lat, lon: found.lon };
        near = ` near ${spokenPlace(found)}`;
        // The lookup that found the town also says what time zone it keeps. Without this the first answers
        // about a new field gave times in UTC until the separate zone lookup came back.
        zone = found.timeZone ?? undefined;
        country = found.countryCode ?? undefined;
      }
      const { place: _place, ...rest } = given;
      const args = { ...rest, lat: where.lat, lon: where.lon };
      const field = { ...args, id: newId('field'), name: clean(args.name), crop: args.crop ? clean(args.crop, 40) : undefined, ...(zone ? { timeZone: zone } : {}), ...(country ? { countryCode: country } : {}) };
      // A name that cleans to nothing cannot be asked for by voice again, and it used to match every question.
      if (!/[a-z0-9]/i.test(field.name)) {
        return say('I need a name for the field that I can say back to you, like North 40 or Lot 12. What is it called?', { added: false, reason: 'name' });
      }
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
          // Only what was said this time. Leaving the crop or the baseline out must not erase the one already there.
          const given = Object.fromEntries(Object.entries(field).filter(([, v]) => v !== undefined));
          Object.assign(hit, given, { id: known.id, name: hit.name, timeZone: moved ? undefined : hit.timeZone });
        });
        resolveFieldTimeZone(id, known.id, field.lat, field.lon);
        // Start following the nearest magnetometer. This only notes which one is
        // wanted; the background poll picks it up, so registering stays instant.
        geomag.watch(field.lat, field.lon);
        glotec.watch(field.lat, field.lon);
        crewheat.watch(field.lat, field.lon);
        return say(`You already have ${field.name}, so I've updated it instead of adding a second one.`, {
          fieldId: known.id,
          updated: true,
        });
      }
      // A refusal is spoken once, in plain words, before the store's backstop would
      // quietly drop the oldest. Updating a field that already exists never reaches here.
      if (store.get(id).fields.length >= store.limitsFor(id).fields) {
        return say('That is as many fields as I can keep track of. Take one off the list first if you need to add another.', {
          added: false,
          reason: 'limit',
        });
      }
      store.update(id, (f) => void f.fields.push(field));
      resolveFieldTimeZone(id, field.id, field.lat, field.lon);
      geomag.watch(field.lat, field.lon);
      glotec.watch(field.lat, field.lon);
      crewheat.watch(field.lat, field.lon);
      // The one thing still missing, asked as one question, or the next step once both are known.
      const machines = store.get(id).equipment.length;
      return say(`Added ${field.name}${near}.`, { fieldId: field.id, lat: field.lat, lon: field.lon, ...(machines ? { offer: OFFER_CHECK, nextAction: { tool: 'can_i_run', arguments: { field: field.name } } } : { offer: ASK_CORRECTION(undefined, country), asks: 'correction' }) });
    },
  );

  server.registerTool(
    'register_equipment',
    {
      title: 'Add a machine',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        'Register a machine and the GNSS correction it uses. RTK gives centimetres on a quiet day but degrades hardest ' +
        'in a storm. Call this when the customer names a planter, sprayer, combine, tractor or drone and says how it ' +
        'is corrected: RTK, PPP, SBAS or WAAS, or nothing. It does not register a field; use register_field for that.',
      inputSchema: {
        name: z.string().describe('e.g. "the planter"'),
        correction: z.enum(CORRECTIONS).optional().describe(
          'The GNSS correction the machine runs. rtk, also called RTK, network RTK, VRS, a base station or centimetre correction. ' +
          'ppp, also PPP or precise point positioning, decimetre. ' +
          'sbas, also WAAS in North America, EGNOS in Europe, MSAS in Japan, GAGAN in India, sub-metre. ' +
          'autonomous for no correction at all, plain GPS, metres. Leave it out when they do not know, and set notSure.',
        ),
        notSure: z.boolean().optional().describe('true when they say they do not know or are not sure what correction it runs'),
        hardened: z
          .boolean()
          .optional()
          .describe('true only when the customer says the receiver has scintillation protection, such as Trimble IonoGuard or a scintillation-resistant PPP service'),
      },
    },
    async (args) => {
      const id = farmOf();
      const { hardened, notSure, ...rest } = args as typeof args & { hardened?: boolean; notSure?: boolean };
      // Not knowing is an answer. Without a correction and without that, the question is asked rather than guessed.
      if (!args.correction && !notSure) return say(ASK_CORRECTION(args.name, farmCountry(store.get(id).fields)), { added: false, reason: 'correction', asks: 'correction' });
      const assumed = !args.correction;
      const eq = { ...rest, id: newId('eq'), name: clean(args.name), correction: (args.correction ?? 'rtk') as Correction, ...(assumed ? { assumed: true } : {}), ...(hardened ? { hardened: true } : {}) };
      if (!/[a-z0-9]/i.test(eq.name)) {
        return say('I need a name for the machine that I can say back to you, like the planter or the sprayer. What do you call it?', { added: false, reason: 'name' });
      }
      const known = store.get(id).equipment.find((x) => sameName(x.name, eq.name));
      if (known) {
        store.update(id, (f) => {
          const hit = f.equipment.find((x) => x.id === known.id);
          if (hit) Object.assign(hit, eq, { id: known.id });
          if (hit && hardened === false) delete hit.hardened;
          if (hit && !assumed) delete hit.assumed;
        });
        return say(`You already have ${eq.name}, so I've set it to ${eq.correction.toUpperCase()} rather than adding a second one.${assumed ? ` ${ASSUMED_RTK}` : ''}`, {
          equipmentId: known.id,
          updated: true,
        });
      }
      if (store.get(id).equipment.length >= store.limitsFor(id).equipment) {
        return say('That is as many machines as I can keep track of. Take one off the list first if you need to add another.', {
          added: false,
          reason: 'limit',
        });
      }
      store.update(id, (f) => void f.equipment.push(eq));
      const fields = store.get(id).fields;
      const added = assumed ? `Added ${eq.name}. ${ASSUMED_RTK}` : `Added ${eq.name} on ${eq.correction.toUpperCase()}${eq.hardened ? ', with scintillation protection' : ''}.`;
      return say(added, {
        equipmentId: eq.id,
        ...(assumed ? { assumed: true } : {}),
        ...(eq.hardened ? { hardened: true } : {}),
        ...(fields.length ? { offer: OFFER_CHECK, nextAction: { tool: 'can_i_run', arguments: fields.length === 1 ? { field: fields[0].name } : {} } } : { offer: ASK_FIELD_FOR_MACHINE, asks: 'field' }),
      });
    },
  );

}
