/**
 * Everything the server keeps doing between requests: NOAA and the solar wind, the observatories and the
 * ionosphere near every field, the crew's heat and working day, and the crew alerts when this server is the
 * one sending them. Started once, after the store has been read; it waits for the forecast every answer needs.
 */

import * as store from './store.js';
import * as swpc from './swpc.js';
import * as solarwind from './solarwind.js';
import * as geomag from './geomag.js';
import * as glotec from './glotec.js';
import * as crewheat from './crewheat.js';
import * as crewday from './crewday.js';
import * as swpcplus from './swpcplus.js';
import * as aurora from './aurora.js';
import * as ntrip from './ntrip.js';
import * as roti from './roti.js';
import * as interference from './interference.js';
import * as particles from './particles.js';
import * as ground from './ground.js';
import { checkFieldAlerts } from './alerts.js';
import { resolveFieldTimeZone } from './tools.js';

export async function startBackground(): Promise<void> {
  await swpc.start();

  // The minute by minute half: an estimated Kp and the solar wind at L1, which is
  // where the extra half hour of warning comes from. Two of these feeds are about
  // sixty bytes each, so a one minute poll costs nothing.
  await solarwind.start();

  // The ground truth half: INTERMAGNET observatories near fields that already
  // exist. A restart must not lose this, or a farm registered last week would get
  // no corroboration until somebody happened to add a field again, which is the
  // kind of gap nobody notices because it looks exactly like a quiet day.
  for (const [, farm] of store.allEntries()) {
    for (const field of farm.fields) {
      geomag.watch(field.lat, field.lon);
      glotec.watch(field.lat, field.lon);
      crewheat.watch(field.lat, field.lon);
    }
    if (farm.rolePlace) geomag.watch(farm.rolePlace.lat, farm.rolePlace.lon);
  }
  await geomag.start();

  // The measured ionosphere, and the rest of the SWPC catalogue: Dst, the minute
  // cadence Kp nowcast, the 45 day outlook a planting season actually needs, flare
  // and proton probabilities, electron fluence, and the ICAO aviation advisories.
  // These are started after the forecast so a slow 2.5 MB TEC map never delays the
  // thing every answer depends on.
  // Where the RTK base stations actually are, so baselineKm can be measured rather
  // than remembered. Six hourly: the directory changes as volunteers come and go.
  await Promise.allSettled([glotec.start(), swpcplus.start(), aurora.start(), ntrip.start(), roti.start()]);
  // Not awaited: a slow PDF at the Coast Guard must not hold the server from answering.
  void interference.start();
  void particles.start();
  // HF absorption and the ground electric field, for the operators what_should_i_do answers. See ground.ts.
  void ground.start();
  // The crew's half of the same decision: the heat over each field for the hours a job would run. Not awaited,
  // because nothing about whether the receiver holds its line should wait on a weather forecast.
  void crewheat.start();

  // Crew members who shared their working day: asked of the heat safety server every twenty minutes, one at a
  // time, so an answer about a job never waits on another server. A link that server says has stopped is dropped.
  const refreshCrewDays = async () => {
    if (!crewday.configured()) return;
    for (const [id, farm] of store.allEntries()) {
      for (const c of farm.crew) {
        if (!c.dayLink) continue;
        await crewday.refresh(c.dayLink);
        if (crewday.stopped(c.dayLink)) {
          const dead = c.dayLink;
          store.update(id, (x) => {
            const hit = x.crew.find((y) => y.dayLink === dead);
            if (hit) hit.dayLink = null;
          });
        }
      }
    }
  };
  void refreshCrewDays();
  const crewDayTimer = setInterval(() => void refreshCrewDays(), 20 * 60 * 1000);
  crewDayTimer.unref?.();

  /*
   * Who sends the crew emails. "server", the default, is this timer, which only runs while this process does.
   * "scheduler" leaves accounts to the Lambda EventBridge Scheduler starts every fifteen minutes (sweep.ts,
   * infra/), which runs whether or not this server is up and needs the DynamoDB store to see the same farms.
   * The sandboxes stay here either way: what they are sent goes to the phone on the demo page, held in memory.
   */
  const ALERTS_HERE = (process.env.ORBITA_ALERTS ?? 'server').toLowerCase() !== 'scheduler';
  if (!ALERTS_HERE && process.env.ORBITA_STORE?.toLowerCase() !== 'dynamodb') {
    console.error('[alerts] ORBITA_ALERTS=scheduler needs ORBITA_STORE=dynamodb, or the scheduled check cannot see any farm. No crew will be alerted.');
  }

  // Crew emails for watched jobs that clear and storms that are coming, on the NOAA refresh cadence.
  const alertTimer = setInterval(() => {
    checkFieldAlerts(new Date(), ALERTS_HERE ? 'all' : 'demo').catch((err) => console.error('[alerts]', err));
  }, 15 * 60 * 1000);
  alertTimer.unref?.();

  // Fields registered before times were said locally get their timezone looked up once.
  for (const [farmId, farm] of store.allEntries()) {
    for (const field of farm.fields) {
      if (!field.timeZone) resolveFieldTimeZone(farmId, field.id, field.lat, field.lon);
    }
  }
  const snap = swpc.current();
  console.log(
    snap?.slots.length
      ? `NOAA loaded: ${snap.slots.length} Kp slots, ${snap.alerts.length} alerts.`
      : `NOAA unreachable at boot: ${snap?.error ?? 'unknown'}`,
  );

  /*
   * Demo records are swept once a day. A profile made by a stranger on the demo
   * page has no reason to outlive their visit, and this one holds health details.
   */
  const sweepTimer = setInterval(() => {
    const gone = store.expireDemoRecords();
    if (gone) console.log(`[store] expired ${gone} demo record${gone === 1 ? '' : 's'}`);
  }, 24 * 60 * 60 * 1000);
  sweepTimer.unref?.();
  store.expireDemoRecords();
}
