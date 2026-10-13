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
import { advise, ROLES, ROLE_HINT, ORBITS, type Role } from '../playbook.js';
import * as particles from '../particles.js';
import { sendEmail, emailConfigured } from '../notify.js';
import { lookupTimeZone, spokenTime } from '../timezone.js';
import {
  NOAA_DOWN,
  say,
} from './shared.js';

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
        'holding position, automated mining, a vehicle fleet, aurora watching, or a household. Timed to the NOAA ' +
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
      },
    },
    async ({ role, step, orbit }) => {
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
        orbit,
      );
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
      const spoken = measured ? `${advice.spoken} ${measured}` : advice.spoken;
      return say(spoken, {
        ...advice,
        spoken,
        ...(orbit ? { orbit } : {}),
        ...(measured && live ? { measuredNow: live, mustSay: [measured.split('. ')[0] + '.'] } : {}),
        geomagneticLatitude: gmLat,
        dataAgeMinutes: swpc.ageMinutes(),
      });
    },
  );

}
