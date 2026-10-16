/**
 * What else a machine relies on that the sun can reach, judged the same way as its position.
 *
 * position_trust answers one question, whether a GNSS fix can be trusted. A machine built next year, a home robot
 * on a remote operator, an air taxi, a delivery drone, depends on more than its fix, and naming every kind of machine
 * as a role would never finish. So this goes by dependency instead. There are five ways the sun reaches a machine
 * besides its position, and each is checked from data Orbita already reads:
 *
 *   satellite_link            internet or links over satellites, Starlink or L-band. The geomagnetic level.
 *   hf_radio                  HF radio. NOAA's absorption map over the point, the R level, the high latitude fade.
 *   grid_power                charging or running from the grid. The G level as NOAA describes it, the ground field.
 *   electronics_at_altitude   electronics at flight altitude or in orbit. The S level and the protons GOES measures.
 *   compass                   a magnetometer used for heading. The nearest observatory, then the G level.
 *   gps_time                  a clock disciplined to GPS, as robot fleets and 5G sites are. The G level and planned
 *                             GPS tests nearby, with how long a clock holds time without it.
 *   traffic_awareness         reporting position to other aircraft, ADS-B or Remote ID. A position check at the
 *                             accuracy ADS-B rules ask for; judged in tools/agents.ts.
 *
 * Each returns the same three words position_trust does, and never stronger than its evidence: the grid kept its
 * lights on through the G5 of May 2024, so grid power is never "do not trust"; a compass has no published storm
 * threshold for small machines, so it is never more than "verify". A dependency that cannot be checked is
 * "verify", never "trust".
 */

import { gFromKp } from './playbook.js';
import * as swpc from './swpc.js';
import * as ground from './ground.js';
import * as geomag from './geomag.js';
import * as particles from './particles.js';
import * as interference from './interference.js';
import { geomagneticLatitude } from './domain.js';
import { kpRightNow } from './tools/shared.js';
import type { Trust } from './tools/agents.js';

export const DEPENDENCIES = [
  'satellite_position', 'satellite_link', 'hf_radio', 'grid_power', 'electronics_at_altitude', 'compass', 'gps_time', 'traffic_awareness',
] as const;
export type Dependency = (typeof DEPENDENCIES)[number];
type Other = Exclude<Dependency, 'satellite_position'>;
/** Judged in tools/agents.ts, because it is a position check at the accuracy collision avoidance needs. */
export type Local = Exclude<Other, 'traffic_awareness'>;

export const DEPENDENCY_HINT =
  'What the machine relies on besides being told its position, when the caller says: satellite_position for a GNSS fix ' +
  '(the default), satellite_link for internet or links over satellites such as Starlink, hf_radio for HF radio, ' +
  'grid_power for charging or running from the grid, electronics_at_altitude for electronics in a drone, aircraft or ' +
  'air taxi at height or in orbit (give altitudeKm), compass for a magnetometer used for heading, gps_time for a clock ' +
  'synced to GPS, traffic_awareness for broadcasting position to other aircraft by ADS-B or Remote ID';

export type Judged = { dependency: Other; verdict: Trust; reason: string; source: string; data?: Record<string, unknown> };

const SRC = {
  noaa: 'https://www.swpc.noaa.gov/noaa-scales-explanation',
  starlink: 'https://www.theregister.com/2024/05/13/starlink_solar_storm/',
  drap: 'https://www.spaceweather.gov/products/d-region-absorption-predictions-d-rap',
  nerc: 'https://www.nerc.com/globalassets/programs/rapa/gmd/reference-documents/may-2024-gmd-event-review.pdf',
  bgs: 'https://geomag.bgs.ac.uk/data_service/directionaldrilling/home.html',
  holdover: 'https://www.microchip.com/content/dam/mchp/documents/FTD/ProductDocuments/Brochures/TimeProvider-4500-Series-Release-3.0-DS00005123.pdf',
};

const levels = () => {
  const snap = swpc.current();
  if (!snap) return null;
  const kp = kpRightNow()?.kp ?? 0;
  return { g: Math.max(snap.scales.g ?? 0, gFromKp(kp)), s: snap.scales.s ?? 0, r: snap.scales.r ?? 0 };
};

/** One dependency, at a point when there is one. */
export function judge(dep: Local, where: { lat: number; lon: number } | null, altitudeKm?: number): Judged {
  const lv = levels();
  if (!lv) return { dependency: dep, verdict: 'verify', reason: 'I could not read the space weather forecast', source: SRC.noaa };
  const gm = where ? geomagneticLatitude(where.lat, where.lon) : null;
  const high = gm != null && Math.abs(gm) >= 55;

  switch (dep) {
    case 'satellite_link':
      return lv.g >= 4
        ? { dependency: dep, verdict: 'verify', reason: `links over satellites can be slow or drop at G${lv.g}; Starlink reported degraded service in the May 2024 storm`, source: SRC.starlink }
        : { dependency: dep, verdict: 'trust', reason: `nothing at G${lv.g} is known to upset satellite internet`, source: SRC.starlink };

    case 'hf_radio': {
      const a = where ? ground.absorption(where.lat, where.lon) : null;
      if (a && a.mhz >= ground.SAY_FROM_MHZ) {
        return { dependency: dep, verdict: 'do_not_trust', reason: `HF up to ${a.mhz.toFixed(0)} megahertz is being absorbed over the point right now`, source: SRC.drap, data: { absorption: a } };
      }
      if (lv.r >= 1) return { dependency: dep, verdict: 'verify', reason: `a radio blackout at R${lv.r} is running on the sunlit side`, source: SRC.noaa };
      if (high && lv.g >= 2) return { dependency: dep, verdict: 'verify', reason: `HF fades at high latitudes in a G${lv.g} storm`, source: SRC.noaa };
      if (!a && where) return { dependency: dep, verdict: 'verify', reason: "I could not read NOAA's absorption map", source: SRC.drap };
      return { dependency: dep, verdict: 'trust', reason: 'no radio blackout is running and nothing is being absorbed over the point', source: SRC.drap, ...(a ? { data: { absorption: a } } : {}) };
    }

    case 'grid_power': {
      const e = where ? ground.efield(where.lat, where.lon) : null;
      const data = e ? { geoelectric: e } : undefined;
      if (lv.g >= 5 || (lv.g >= 4 && high)) {
        return { dependency: dep, verdict: 'verify', reason: `NOAA expects voltage control problems on some grids at G${lv.g}, though North America kept its lights on through the G5 of May 2024, so have a safe stop if power drops`, source: SRC.nerc, data };
      }
      return { dependency: dep, verdict: 'trust', reason: `nothing at G${lv.g} is expected to take grid power away`, source: SRC.noaa, data };
    }

    case 'electronics_at_altitude': {
      const alt = altitudeKm ?? 0;
      const p = particles.now();
      const s = Math.max(lv.s, p?.protons10 != null ? (p.protons10 >= 1e4 ? 4 : p.protons10 >= 1e3 ? 3 : p.protons10 >= 100 ? 2 : p.protons10 >= 10 ? 1 : 0) : 0);
      if (alt < 8) return { dependency: dep, verdict: 'trust', reason: 'below flight altitude the atmosphere shields electronics from a radiation storm', source: SRC.noaa };
      if (s >= 3) return { dependency: dep, verdict: 'verify', reason: `a radiation storm at S${s} is running, the level at which NOAA puts single event upsets in satellite electronics; expect the same at height`, source: SRC.noaa, data: { particles: p } };
      if (s >= 1 && high) return { dependency: dep, verdict: 'verify', reason: `a radiation storm at S${s} raises radiation at height most at high latitude`, source: SRC.noaa, data: { particles: p } };
      return { dependency: dep, verdict: 'trust', reason: 'no radiation storm is running', source: SRC.noaa, ...(p ? { data: { particles: p } } : {}) };
    }

    case 'gps_time': {
      const holdover = 'a standard oven quartz clock holds within 1.5 microseconds for about 16.5 hours without GPS, rubidium about 4 days, by one vendor\'s table';
      const test = where ? interference.near(where.lat, where.lon).tests[0] : undefined;
      if (test) return { dependency: dep, verdict: 'verify', reason: `a military GPS test near ${test.place} runs until ${test.end.slice(0, 10)}; ${holdover}`, source: SRC.holdover };
      return lv.g >= 3
        ? { dependency: dep, verdict: 'verify', reason: `GPS can be lost for hours at G${lv.g}, so make sure the clock can run on holdover; ${holdover}`, source: SRC.holdover }
        : { dependency: dep, verdict: 'trust', reason: `nothing at G${lv.g} should take GPS time away`, source: SRC.noaa };
    }

    case 'compass': {
      const r = where ? geomag.reading(where.lat, where.lon) : null;
      if (r && r.km <= geomag.NEAR_KM) {
        return r.level === 'quiet'
          ? { dependency: dep, verdict: 'trust', reason: `the magnetometer at ${r.observatory.name}, ${r.km} km away, is quiet`, source: SRC.bgs, data: { magnetometer: r } }
          : { dependency: dep, verdict: 'verify', reason: `the magnetometer at ${r.observatory.name}, ${r.km} km away, is ${r.level}, so cross-check heading against something not magnetic`, source: SRC.bgs, data: { magnetometer: r } };
      }
      return lv.g >= 3
        ? { dependency: dep, verdict: 'verify', reason: `the field is disturbed at G${lv.g} and there is no magnetometer near enough to say how much here, so cross-check heading`, source: SRC.bgs }
        : { dependency: dep, verdict: 'trust', reason: `nothing at G${lv.g} should move a compass much`, source: SRC.bgs };
    }
  }
  // Anything not judged here is never reported as clear.
  return { dependency: dep, verdict: 'verify', reason: 'this cannot be judged on its own', source: SRC.noaa };
}

const RANK: Record<Trust, number> = { trust: 0, verify: 1, do_not_trust: 2 };
export const worst = (vs: Trust[]): Trust => vs.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'trust' as Trust);

export const NAMES: Record<Other, string> = {
  satellite_link: 'satellite link', hf_radio: 'HF radio', grid_power: 'grid power',
  electronics_at_altitude: 'electronics at altitude', compass: 'compass',
  gps_time: 'GPS time', traffic_awareness: 'traffic awareness',
};
export const VERB: Record<Trust, string> = { trust: 'fine', verify: 'verify', do_not_trust: 'do not rely on it' };
export const LEAD: Record<Trust, string> = {
  trust: 'Everything it relies on looks fine.',
  verify: 'Check before acting.',
  do_not_trust: 'Do not rely on all of it.',
};

/** One spoken sentence per dependency, in the order asked. */
export const say = (j: Judged): string => `${NAMES[j.dependency][0].toUpperCase()}${NAMES[j.dependency].slice(1)}: ${VERB[j.verdict]}, ${j.reason}.`;
