/**
 * Everyone else the same storm reaches.
 *
 * One of the grouped tool modules split out of tools.ts. The code is unchanged
 * from when it lived there; only the file it lives in is new.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  assess, nextWindow, thresholdKp, TOLERANCE_M, degradedOptions, deadlinePressure, geomagneticLatitude,
  auroralBoundaryDeg, equatorialEvening, bubbleSeason,
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
import { advise, ROLES, ROLE_HINT, ORBITS, type Role } from '../playbook.js';
import * as particles from '../particles.js';
import { sendEmail, emailConfigured } from '../notify.js';
import { lookupTimeZone, spokenTime } from '../timezone.js';
import { geocode, spoken as spokenPlace, GeocoderDown, lookupDown } from '../geocode.js';
import * as ground from '../ground.js';
import { nextPage } from '../brief.js';
import {
  NOAA_DOWN,
  clean,
  kpRightNow,
  say,
} from './shared.js';

/** Roles with a long conductor in the ground or on poles, which the geoelectric field drives current into. */
const CONDUCTORS: readonly Role[] = ['grid_operator', 'pipeline', 'rail'];

/** Roles that steer by a precise satellite fix, which the evening plasma bubbles near the magnetic equator break. */
const FIX_ROLES: readonly Role[] = ['drone_pilot', 'robots', 'field_crew', 'mining', 'fleet', 'maritime_dp'];

/**
 * What is measured where they are, for the roles a map or a magnetometer speaks to. Nothing when there is no
 * place, nothing when the feed is missing or old, and nothing when the reading has nothing to add, so the advice
 * is never padded with a number that is not there.
 */
function measuredHere(role: Role, site: { lat: number; lon: number } | undefined, stormOn: boolean): { said: string; data: Record<string, unknown> } {
  const said: string[] = [];
  const data: Record<string, unknown> = {};
  const kp = kpRightNow()?.kp ?? 0;
  if (CONDUCTORS.includes(role) && site) {
    const e = ground.efield(site.lat, site.lon);
    if (e) {
      data.geoelectric = e;
      if (stormOn || e.mvPerKm >= ground.SAY_FROM_MV) said.push(ground.sayEfield(e));
    }
  }
  if ((CONDUCTORS.includes(role) || role === 'drilling') && site) {
    const c = geomag.corroboration(site.lat, site.lon, kp);
    if (c) { said.push(c); data.magnetometer = geomag.reading(site.lat, site.lon); }
  }
  // Kp says nothing about these. Asked from Hong Kong at ten at night in October, a drone pilot was told positioning
  // should behave, in the hours that called off the 2024 National Day shows there. See equatorialEvening.
  if (FIX_ROLES.includes(role) && site && equatorialEvening({ id: 'site', name: 'site', ...site }, new Date())) {
    said.push(
      `But here it is the evening plasma bubble hours near the magnetic equator, ${bubbleSeason(site.lon).words}, when ` +
        'precise satellite fixes drop out even with Kp low. Hold work that needs RTK until after midnight or the morning.',
    );
    data.equatorialEvening = true;
  }
  if (role === 'magnetic_survey' && site) {
    const r = geomag.reading(site.lat, site.lon);
    if (r && r.km <= geomag.NEAR_KM) {
      said.push(
        `The nearest magnetometer, ${r.observatory.name}, ${r.km} km away, has moved up to ${r.rate} nanotesla in a ` +
          `minute lately and sits ${Math.abs(r.deltaH)} off its quiet level. Check that against your contract's tolerance.`,
      );
      data.magnetometer = r;
    }
  }
  if (role === 'hf_radio' || role === 'airline') {
    const a = site ? ground.absorption(site.lat, site.lon) : null;
    if (a) data.absorption = a;
    const line = a ? ground.sayAbsorption(a) : '';
    if (line) said.push(line);
    // An airline told "nothing calls for HF contingencies" and then about flare odds hears a contradiction, so for
    // dispatch the odds wait for a storm phase. An HF operator plans on them either way.
    const flares = swpcplus.flareSentence();
    if (flares) data.flareRisk = swpcplus.flareRisk();
    if (flares && (role === 'hf_radio' || stormOn)) said.push(flares);
  }
  return { said: said.join(' '), data };
}

export function register(server: McpServer, farmOf: () => string): void {
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
        'Protective steps for somebody who looks after something a solar storm can reach: drones, satellites, the ' +
        'power grid, flights, HF radio, GPS timing, pipelines, directional drilling, railway signalling, a vessel ' +
        'holding position, a ship, an undersea cable, satellite services, automated mining, a vehicle fleet, aurora ' +
        'watching, a household, ' +
        'a small plane, a magnetic survey or robots. Timed to the NOAA ' +
        'forecast. Call this when someone asks what they should do, whether to postpone, or says what they operate ' +
        'and asks whether it will affect them. Read the answer aloud as given. It is not for whether a field job can ' +
        'run (use can_i_run) or for the current Kp (use storm_status).',
      inputSchema: {
        role: z.enum(ROLES).optional().describe(ROLE_HINT),
        orbit: z
          .enum(ORBITS)
          .optional()
          .describe('For satellites and crews, where they are, when said: low for low Earth orbit or a space station, medium for navigation satellites such as GPS or Galileo, high for geostationary, beyond for the Moon or deep space'),
        step: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Where to continue from when the customer asks for the rest; use nextStep from the last answer'),
        place: z
          .string()
          .max(80)
          .optional()
          .describe('Where the thing they look after is, as a town and region, when they say it: "our substation near Fargo", "my station in Leeds". Remembered, so leave it out next time'),
      },
    },
    async ({ role, step, orbit, place }) => {
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

      // Where they said, then where they said last time, then their first field. A place that cannot be found is
      // said back rather than quietly answered for somewhere else.
      if (place) {
        const found = await geocode(clean(place, 80)).catch((err) => (err instanceof GeocoderDown ? 'down' as const : null));
        if (found === 'down') return say(lookupDown(clean(place, 80)), { placeFound: false, unavailable: true });
        if (!found) {
          return say(`I could not find ${clean(place, 80)}. Tell me the nearest town and the state or country.`, { placeFound: false });
        }
        store.update(id, (f) => void (f.rolePlace = { name: spokenPlace(found), lat: found.lat, lon: found.lon }));
        geomag.watch(found.lat, found.lon);
      }
      const site = store.get(id).rolePlace ?? farm.fields[0];
      const gmLat = site ? geomagneticLatitude(site.lat, site.lon) : null;
      const context = {
        now: new Date(),
        levels: { g: snap.scales.g, s: snap.scales.s, r: snap.scales.r },
        yesterday: snap.scales.yesterday,
        days: snap.scales.days,
        slots: snap.slots,
      };
      const advice = advise(chosen, context, gmLat, step ?? 0, orbit);
      // "Go on" or "what else" reaches tell_me_more, so the next page is left there to read. See brief.nextPage.
      const leave = (from: number | null): void => {
        if (from == null) return;
        nextPage(id, async () => {
          const page = advise(chosen, context, gmLat, from, orbit);
          leave(page.nextStep);
          return page.spoken;
        });
      };
      leave(advice.nextStep);
      // What the GOES satellites measure this minute, for the two roles in orbit. Said on the first page only,
      // after the advice, and never when the reading is missing or old. See particles.ts.
      const live = particles.now();
      const measured =
        (step ?? 0) > 0 || !live
          ? ''
          : chosen === 'crewed_spaceflight'
            ? particles.sayCrew(live)
            : chosen === 'satellite_operator'
              ? [orbit === 'low' ? '' : orbit === 'medium' ? particles.sayHighOrbit(live).replace('Measured now at geostationary orbit,', 'Measured now at geostationary orbit, the nearest reading there is for medium orbit,') : particles.sayHighOrbit(live), particles.sayLaunch(live)].filter(Boolean).join(' ')
              : '';
      const local = (step ?? 0) > 0 ? { said: '', data: {} } : measuredHere(chosen, site, advice.phase !== 'quiet');
      const spoken = [advice.spoken, measured, local.said].filter(Boolean).join(' ');
      return say(spoken, {
        ...advice,
        spoken,
        ...(orbit ? { orbit } : {}),
        ...(measured && live ? { measuredNow: live, mustSay: [measured.split('. ')[0] + '.'] } : {}),
        ...(Object.keys(local.data).length ? { measuredHere: local.data } : {}),
        ...(site ? { place: 'name' in site ? site.name : null } : {}),
        ...(site ? { position: { lat: site.lat, lon: site.lon } } : {}),
        geomagneticLatitude: gmLat,
        dataAgeMinutes: swpc.ageMinutes(),
      });
    },
  );

}
