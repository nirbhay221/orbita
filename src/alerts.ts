/**
 * The two moments a crew should hear something without asking.
 *
 * A watched job clears: the customer held planting on the North 40 and asked
 * to be told when accuracy came back. Confirmed crew contacts are emailed once
 * when it does.
 *
 * A storm is coming: within the next day, space weather will put one of this
 * farm's usual jobs outside tolerance. Confirmed contacts are told once per
 * storm day, while there is still time to plan around it.
 *
 * Both run on the NOAA refresh cadence, after the add-on has already answered
 * whoever asked, because an email can take longer than Alexa+ allows for a turn.
 */

import * as store from './store.js';
import * as swpc from './swpc.js';
import * as solarwind from './solarwind.js';
import { assess, type Operation } from './domain.js';
import { statusOperations } from './tools.js';
import { sendEmail, canEmailFor, type Delivery } from './notify.js';
import { spokenTime } from './timezone.js';
import { reachable, stopFooter } from './consent.js';

const HOUR = 3_600_000;
const label = (op: string) => op.replace(/_/g, ' ');
const inches = (m: number) => Math.max(1, Math.round(m * 39.37));
const recipients = (farm: store.Farm, reason: store.NotifyReason) =>
  farm.crew.filter((c) => reachable(c) && c.notifyOn.includes(reason));

export async function checkFieldAlerts(now = new Date()): Promise<Delivery[]> {
  const snap = swpc.current();
  // The same "right now" the tools use, so an email cannot contradict the
  // answer the customer just heard.
  const estimated = solarwind.estimatedKp();
  const kpNow = estimated ? { kp: estimated.kp, observed: true } : swpc.kpAt(now);
  if (!snap?.slots.length || !kpNow) return [];
  const attempted: Delivery[] = [];

  for (const [id, farm] of store.allEntries()) {
    // A sandbox never causes an email. See canEmailFor in notify.ts for the reason.
    if (!canEmailFor(id)) continue;
    // ---- watched jobs that have cleared ----
    const clearTo = recipients(farm, 'window_clear');
    if (clearTo.length) {
      for (const w of farm.waiting.filter((x) => !x.notifiedAt)) {
        const f = farm.fields.find((x) => x.id === w.fieldId);
        const eq = farm.equipment.find((x) => x.id === w.equipmentId);
        if (!f || !eq) continue;
        const v = assess(w.operation as Operation, kpNow.kp, eq, f, now);
        if (!v.go) continue;
        // Marked before sending, so a slow or failing send can never turn into repeated emails.
        store.update(id, (x) => {
          const hit = x.waiting.find((y) => y.id === w.id);
          if (hit) hit.notifiedAt = now.toISOString();
        });
        for (const c of clearTo) {
          attempted.push(
            await sendEmail({
              to: c.email,
          sender: id,
              reason: 'window_clear',
              subject: `Clear now: ${label(w.operation)} on ${f.name}`,
              text:
                `Space weather has settled enough for ${label(w.operation)} on ${f.name} with ${eq.name}. ` +
                `Kp is ${kpNow.kp.toFixed(1)}, so expected drift is about ${inches(v.expectedErrorM)} inches against a ` +
                `${inches(v.toleranceM)} inch tolerance.\n\nYou are getting this because you were added as a crew contact and agreed to it.${stopFooter(c)}`,
            }),
          );
        }
      }
    }

    // ---- a storm inside the next day that puts a usual job outside tolerance ----
    const stormTo = recipients(farm, 'storm');
    if (!stormTo.length || !farm.fields.length || !farm.equipment.length) continue;
    const t = now.getTime();
    const upcoming = snap.slots.filter((s) => {
      const start = new Date(s.time).getTime();
      return start + 3 * HOUR > t && start - t <= 24 * HOUR;
    });
    let first: { time: string; kp: number; jobs: string[] } | null = null;
    for (const s of upcoming) {
      const jobs: string[] = [];
      for (const f of farm.fields) {
        for (const eq of farm.equipment) {
          for (const op of statusOperations(eq.correction) as Operation[]) {
            const v = assess(op, s.kp, eq, f, new Date(new Date(s.time).getTime() + 90 * 60_000));
            if (!v.go && v.limitedBy === 'space_weather') jobs.push(`${label(op)} on ${f.name} with ${eq.name}`);
          }
        }
      }
      if (jobs.length) {
        first = { time: s.time, kp: s.kp, jobs };
        break;
      }
    }
    if (!first) continue;
    // Said where the farm is, as the spoken answers are, or in UTC and labelled so.
    const when = spokenTime(first.time, farm.fields[0]?.timeZone);
    const key = `storm:${first.time.slice(0, 10)}`;
    if (farm.alertsSent.includes(key)) continue;
    store.update(id, (x) => void (x.alertsSent = [...x.alertsSent.slice(-29), key]));
    for (const c of stormTo) {
      attempted.push(
        await sendEmail({
          to: c.email,
          sender: id,
          reason: 'storm',
          subject: `Storm ahead: ${first.jobs.length} job${first.jobs.length === 1 ? '' : 's'} outside tolerance from ${when}`,
          text:
            `NOAA's forecast reaches Kp ${first.kp.toFixed(1)} around ${when}. At that level these jobs go outside ` +
            `tolerance: ${first.jobs.slice(0, 6).join('; ')}.\n\nAsk Orbita when it clears, or what to do about it.\n\n` +
            'You are getting this because you were added as a crew contact for storms and agreed to it.' +
            stopFooter(c),
        }),
      );
    }
  }
  return attempted;
}
