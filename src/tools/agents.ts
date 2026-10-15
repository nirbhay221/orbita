/**
 * For software that acts on a position: can it be trusted right now?
 *
 * Every other tool here answers a person about a job. More and more of what depends on a GNSS position is not a
 * person: a drone's flight controller, a tractor's autosteer, a delivery robot, an agent dispatching a fleet.
 * Those act on the number they are given, and the dangerous case is not a lost fix, which a machine notices. It
 * is a fix that still reports itself good while it is wrong: scintillation during a storm, a plasma bubble after
 * sunset near the magnetic equator, a jamming exercise, a spoofer. The resilient positioning guidance DHS
 * publishes for critical infrastructure says the same thing in its own words: do not assume the position, verify
 * it against something independent before acting on it.
 *
 * So this tool takes a place, the accuracy the caller needs and how its receiver is corrected, and returns one
 * of three words an agent can branch on, with the reasons and what was and was not checked:
 *
 *   trust          the expected error is inside what was asked for and nothing published says otherwise
 *   verify         it is probably fine, and something says to check against a second source before acting
 *   do_not_trust   the expected error is outside what was asked for, or receivers there lose their fix
 *
 * It is every check Orbita has, in one call: the Kp forecast and nowcast, the measured sky overhead (ROTI), the
 * equatorial evening season, planned military GPS tests, aircraft-reported interference and the feeds' own age.
 * A source that could not be read moves the answer to verify, never to trust.
 *
 * Source: https://www.dhs.gov/sites/default/files/2022-06/22_0609_st_resilient_pnt_ra.pdf
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { expectedErrorM, equatorialEvening, bubbleSeason, G_SCALE, rtkMultiplier, type Correction, type Field } from '../domain.js';
import * as swpc from '../swpc.js';
import * as roti from '../roti.js';
import * as solarwind from '../solarwind.js';
import * as interference from '../interference.js';
import * as spoofing from '../spoofing.js';
import * as particles from '../particles.js';
import * as spacecraft from '../spacecraft.js';
import * as store from '../store.js';
import { NOAA_DOWN, say, kpRightNow } from './shared.js';

export type Trust = 'trust' | 'verify' | 'do_not_trust';

/** What a receiver with no correction is good for on a quiet day decides the default need: a few metres. */
const DEFAULT_NEED_M = 5;
const metres = (m: number): string => (m >= 1 ? `${m.toFixed(1)} metres` : `${Math.round(m * 100)} centimetres`);

export function register(server: McpServer, farmOf: () => string): void {
  server.registerTool(
    'position_trust',
    {
      title: 'Can a machine trust its GPS position right now',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'For a software agent, robot, drone, autonomous machine or spacecraft about to act on its position: whether ' +
        'that position can be trusted right now, or a set number of minutes ahead (inMinutes, judged from the forecast), as one of three verdicts (trust it, verify it first, or do not ' +
        'trust it), with the reasons. On the ground it combines space weather, the measured sky, planned military ' +
        'GPS tests and aircraft-reported jamming; for a spacecraft, give its altitude and it judges drag, its own ' +
        'receiver and charging. Call this when an agent or machine asks whether to rely on its position or whether ' +
        'GPS is reliable somewhere. It is not for whether a farm or survey job can run (use can_i_run), nor for ' +
        'what went wrong earlier (use what_happened).',
      inputSchema: {
        lat: z.number().min(-90).max(90).optional().describe('Latitude of the position in decimal degrees'),
        lon: z.number().min(-180).max(180).optional().describe('Longitude of the position in decimal degrees'),
        field: z.string().optional().describe('A saved field, by name or id, in place of latitude and longitude'),
        altitudeKm: z
          .number()
          .min(0)
          .max(500_000)
          .optional()
          .describe('For a spacecraft, its altitude in kilometres: about 400 to 550 for low orbit, 20,200 for a navigation satellite, 35,786 for geostationary. With it, latitude and longitude are the point on the ground below, and are optional'),
        needMeters: z.number().positive().max(1000).optional().describe('The accuracy the action needs, in metres. 5 when not given'),
        inMinutes: z
          .number()
          .int()
          .min(0)
          .max(360)
          .optional()
          .describe('How many minutes from now the action will happen, when it is not now, e.g. 10 for "and in ten minutes". Judged from the forecast for that time; up to six hours'),
        hardened: z.boolean().optional().describe('true when the receiver has scintillation protection, such as Trimble IonoGuard or a scintillation-resistant PPP service'),
        correction: z
          .enum(['rtk', 'ppp', 'sbas', 'autonomous'])
          .optional()
          .describe('How the receiver is corrected: rtk, ppp, sbas, or autonomous for none. Autonomous when not given'),
      },
    },
    async ({ lat, lon, field, needMeters, correction, altitudeKm, hardened, inMinutes }) => {
      // A spacecraft is judged differently: drag and its own receiver in low orbit, charging above it. See spacecraft.ts.
      if (altitudeKm != null && altitudeKm >= 100) {
        const snap = swpc.current();
        if (!snap) return say(NOAA_DOWN, { unavailable: true, verdict: 'verify' as Trust, reason: 'no_forecast' });
        const live = particles.now();
        const judged = spacecraft.judge({ altitudeKm, lat, lon, g: snap.scales.g ?? 0, s: snap.scales.s ?? 0, particles: live });
        return say(judged.spoken, {
          verdict: judged.verdict,
          confidence: judged.verdict === 'trust' ? 'high' : judged.verdict === 'verify' ? 'reduced' : 'low',
          spacecraft: true,
          altitudeKm,
          orbit: judged.regime,
          ...(lat != null && lon != null ? { position: { lat, lon } } : {}),
          reasons: [...judged.against, ...judged.caution],
          checks: {
            spaceWeather: { g: snap.scales.g ?? 0, s: snap.scales.s ?? 0, ageMinutes: swpc.ageMinutes() },
            particles: live,
            unchecked: judged.unchecked,
          },
          recheckInMinutes: judged.verdict === 'trust' ? 30 : 10,
          sources: [
            'https://www.swpc.noaa.gov/noaa-scales-explanation',
            'https://www.swpc.noaa.gov/products/goes-electron-flux',
            'https://arxiv.org/html/2406.08617v1',
            'https://www.esa.int/Applications/Observing_the_Earth/FutureEO/Swarm/Swarm_reveals_why_satellites_lose_track',
          ],
        });
      }
      const farm = store.get(farmOf());
      const saved = field ? store.findField(farm, field) : lat == null || lon == null ? farm.fields[0] : undefined;
      const where: Field | null =
        lat != null && lon != null ? { id: 'point', name: 'this position', lat, lon } : saved ? saved : null;
      if (!where) {
        return say('I need a latitude and longitude, or the name of a saved field, to judge a position.', { unavailable: true, reason: 'no_position' });
      }
      /*
       * Now, or a few minutes ahead. A machine planning its next move asks "and in ten minutes?", and the conversation
       * tests found the tool could only say "I can't tell you that ahead of time". Ahead, the Kp forecast for that
       * time, the test schedule and the equatorial evening are judged at that time. What cannot be known ahead is not
       * pretended: the sky can only be measured now, and the solar wind warns at most an hour out.
       */
      const ahead = Math.max(0, Math.min(360, Math.round(inMinutes ?? 0)));
      const now = new Date(Date.now() + ahead * 60_000);
      const kp = ahead ? swpc.kpAt(now) : kpRightNow() ?? swpc.kpAt(now);
      if (!kp) return say(NOAA_DOWN, { unavailable: true, verdict: 'verify' as Trust, reason: 'no_forecast' });

      const corr = (correction ?? 'autonomous') as Correction;
      const need = needMeters ?? DEFAULT_NEED_M;
      const eq = { id: 'caller', name: 'the receiver', correction: corr };
      const err = expectedErrorM(kp.kp, eq, where, now);
      const carrier = corr === 'rtk' || corr === 'ppp';

      const against: string[] = [];
      const caution: string[] = [];

      // Outside what was asked for: the storm itself, or a level at which carrier-phase receivers lose the fix.
      const lost = corr === 'rtk' && rtkMultiplier(kp.kp, where.lat, where.lon, now) >= 25;
      if (lost) against.push(`Kp ${kp.kp.toFixed(1)} (${G_SCALE(kp.kp)}) is strong enough that RTK receivers there lose their fix altogether`);
      else if (err > need) against.push(`the expected error is about ${metres(err)} at Kp ${kp.kp.toFixed(1)}, outside the ${metres(need)} needed`);

      // The sky measured over the point in the last few minutes, for receivers that hold a carrier-phase fix.
      const sky = carrier && !ahead ? roti.over(where.lat, where.lon) : null;
      if (sky?.state === 'disturbed') {
        (need < 0.3 && !hardened ? against : caution).push(`${Math.round(sky.activeShare * 100)} percent of the satellite signals over the point are disturbed right now, which in published tests halves how long RTK holds a fix`);
      }
      // After sunset near the magnetic equator, in that longitude's season: bubbles, on quiet days too.
      if (carrier && equatorialEvening(where, now)) {
        (need < 0.3 && !hardened ? against : caution).push(`it is the evening plasma bubble hours near the magnetic equator, ${bubbleSeason(where.lon).words}, when carrier-phase receivers lose their fix on quiet days too`);
      }
      // What is not the sun.
      const other = interference.near(where.lat, where.lon, now);
      const test = other.tests[0];
      if (test) caution.push(`a military GPS interference test near ${test.place} is scheduled until ${test.end.slice(0, 10)} and the point is inside its reach on the ground`);
      if (other.reported?.level === 'high') caution.push(`${other.reported.pct} percent of aircraft over the area reported degraded GPS on ${other.reported.date}, a sign of jamming or interference`);
      if (other.satellites.length >= 3) caution.push(`${other.satellites.length} GPS satellites are out of service at once`);
      // Where the regulators say GPS is jammed and spoofed as a matter of course. See spoofing.ts.
      if (other.zone) caution.push(spoofing.reason(other.zone));
      // A storm about to arrive on a position just called good.
      const upstream = ahead <= 60 ? solarwind.incoming() : null;
      if (upstream?.level === 'likely') caution.push('the solar wind upstream says a disturbance is likely within the hour');
      // What could not be read never counts as clear.
      const age = swpc.ageMinutes();
      const unchecked = [...other.unchecked];
      if (age != null && age > 45) unchecked.push('a current space weather reading');
      if (unchecked.length) caution.push(`I could not check ${unchecked.join(' or ')}`);

      const verdict: Trust = against.length ? 'do_not_trust' : caution.length ? 'verify' : 'trust';
      const reasons = [...against, ...caution];
      const lead =
        verdict === 'trust'
          ? `Trust it. The expected error is about ${metres(err)}, inside the ${metres(need)} needed, at Kp ${kp.kp.toFixed(1)}, and nothing published says otherwise.`
          : verdict === 'verify'
            ? `Verify before acting. The expected error is about ${metres(err)}, inside the ${metres(need)} needed, but ${caution.join('; ')}.`
            : `Do not trust it. ${against.join('; ').replace(/^./, (c) => c.toUpperCase())}.${caution.length ? ` Also, ${caution.join('; ')}.` : ''}`;
      const how =
        verdict === 'trust'
          ? ''
          : verdict === 'verify'
            ? ' Check the position against something independent, inertial sensors, a camera, a known landmark or a second constellation, and stop if they disagree.'
            : ' Hold the action, or fall back to a source that does not depend on GPS, until this clears.';

      const when = ahead ? `From the forecast for ${ahead} minutes from now: ` : '';
      return say(`${when}${lead}${how}`, {
        verdict,
        ...(ahead ? { inMinutes: ahead, at: now.toISOString(), forecastOnly: true } : {}),
        // The same three words as a number an agent can threshold on.
        confidence: verdict === 'trust' ? 'high' : verdict === 'verify' ? 'reduced' : 'low',
        expectedErrorM: err,
        needM: need,
        correction: corr,
        position: { lat: where.lat, lon: where.lon },
        reasons,
        checks: {
          spaceWeather: { kp: kp.kp, g: G_SCALE(kp.kp), observed: kp.observed, ageMinutes: age },
          measuredSky: sky ? { state: sky.state, disturbedShare: sky.activeShare, links: sky.links } : null,
          equatorialEvening: carrier ? equatorialEvening(where, now) : null,
          gpsTests: other.tests.map((t) => ({ name: t.name, place: t.place, milesAway: Math.round(t.milesAway ?? 0), until: t.end })),
          aircraftReports: other.reported,
          satellitesOut: other.satellites.map((s) => s.prn),
          spoofingRegion: other.zone ?? null,
          unchecked,
        },
        // When to ask again: sooner when something is moving.
        recheckInMinutes: verdict === 'trust' ? 30 : 10,
        mustSay: [],
        sources: ['https://www.swpc.noaa.gov', ...interference.SOURCES, 'https://www.dhs.gov/sites/default/files/2022-06/22_0609_st_resilient_pnt_ra.pdf'],
      });
    },
  );
}
