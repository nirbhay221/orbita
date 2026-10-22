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
import { sendEmail, canEmailFor, toDemoPhone, type Delivery, type Email } from './notify.js';
import { spokenTime } from './timezone.js';
import { reachable, stopFooter } from './consent.js';
import { adviceNow } from './trade.js';
import { advise, type Role } from './playbook.js';
import { geomagneticLatitude } from './domain.js';
import * as machineAlerts from './machinealerts.js';
import * as webhooks from './webhooks.js';

const HOUR = 3_600_000;
const label = (op: string) => op.replace(/_/g, ' ');
const inches = (m: number) => Math.max(1, Math.round(m * 39.37));
const recipients = (farm: store.Farm, reason: store.NotifyReason) =>
  farm.crew.filter((c) => reachable(c) && c.notifyOn.includes(reason));

/**
 * Marks an alert as sent (`mark` returns false when it already was), and says whether this run is the one that marked it.
 *
 * EventBridge Scheduler delivers at least once, so the scheduled check can run twice for one slot, and both
 * runs read the table before either has written. The second write is refused on its version, store.ts makes it
 * again on top of the first, and this change then finds the key already there: that run sends nothing.
 * On the table before anything is sent, when there is a table. See flush() in store.ts.
 */
async function claim(id: string, mark: (f: store.Farm) => boolean): Promise<boolean> {
  let mine = true;
  store.update(id, (x) => {
    if (!mark(x)) mine = false;
  });
  await store.flush();
  return mine;
}

/**
 * `which` splits the work when the scheduled check runs in Lambda (sweep.ts): it takes the accounts, and the
 * server keeps the sandboxes, whose messages go to the phone on the demo page, which only the server holds.
 */
export async function checkFieldAlerts(now = new Date(), which: 'all' | 'accounts' | 'demo' = 'all'): Promise<Delivery[]> {
  const snap = swpc.current();
  // The same "right now" the tools use, so an email cannot contradict the
  // answer the customer just heard.
  const estimated = solarwind.estimatedKp();
  const kpNow = estimated ? { kp: estimated.kp, observed: true } : swpc.kpAt(now);
  if (!snap?.slots.length || !kpNow) return [];
  const attempted: Delivery[] = [];

  for (const [id, farm] of store.allEntries()) {
    // A sandbox never causes an email. What its crew would have been sent goes to the phone on the demo
    // page, word for word, where only that visitor can read it. See notify.ts.
    const demo = !canEmailFor(id);
    if ((which === 'accounts' && demo) || (which === 'demo' && !demo)) continue;
    const out = async (c: store.CrewContact, email: Email): Promise<void> => {
      if (demo) toDemoPhone(id, { to: c.name, reason: email.reason, subject: email.subject, text: email.text.split('\n\nTo stop these emails')[0], stop: c.stopId ?? undefined });
      else attempted.push(await sendEmail(email));
    };
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
        const mine = await claim(id, (x) => {
          const hit = x.waiting.find((y) => y.id === w.id);
          if (!hit || hit.notifiedAt) return false;
          hit.notifiedAt = now.toISOString();
          return true;
        });
        if (!mine) continue;
        for (const c of clearTo) {
          await out(c, {
              to: c.email,
          sender: id,
              reason: 'window_clear',
              subject: `Clear now: ${label(w.operation)} on ${f.name}`,
              text:
                `Space weather has settled enough for ${label(w.operation)} on ${f.name} with ${eq.name}. ` +
                `Kp is ${kpNow.kp.toFixed(1)}, so expected drift is about ${inches(v.expectedErrorM)} inches against a ` +
                `${inches(v.toleranceM)} inch tolerance.\n\nYou are getting this because you were added as a crew contact and agreed to it.${stopFooter(c)}`,
            });
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
    let first: { time: string; kp: number; jobs: string[]; ops: Operation[] } | null = null;
    for (const s of upcoming) {
      const jobs: string[] = [];
      const ops: Operation[] = [];
      for (const f of farm.fields) {
        for (const eq of farm.equipment) {
          for (const op of statusOperations(eq.correction) as Operation[]) {
            const v = assess(op, s.kp, eq, f, new Date(new Date(s.time).getTime() + 90 * 60_000));
            // The nightly plasma bubbles near the magnetic equator are not a storm, and are not emailed as one.
            if (!v.go && v.limitedBy === 'space_weather' && !v.equatorial) {
              jobs.push(`${label(op)} on ${f.name} with ${eq.name}`);
              if (!ops.includes(op)) ops.push(op);
            }
          }
        }
      }
      if (jobs.length) {
        first = { time: s.time, kp: s.kp, jobs, ops };
        break;
      }
    }
    if (!first) continue;
    // Said where the farm is, as the spoken answers are, or in UTC and labelled so.
    const when = spokenTime(first.time, farm.fields[0]?.timeZone);
    // When it is over is the other half of the plan: the first block after it in which every one of those
    // jobs is back inside tolerance, as far ahead as NOAA forecasts. Unknown is said as unknown.
    const startMs = new Date(first.time).getTime();
    const clears = snap.slots.find((s) => {
      if (new Date(s.time).getTime() <= startMs) return false;
      const mid = new Date(new Date(s.time).getTime() + 90 * 60_000);
      return farm.fields.every((f) => farm.equipment.every((eq) => (statusOperations(eq.correction) as Operation[]).every((op) => {
        const v = assess(op, s.kp, eq, f, mid);
        return v.go || v.limitedBy !== 'space_weather';
      })));
    });
    const until = clears
      ? `The forecast has them back inside tolerance from ${spokenTime(clears.time, farm.fields[0]?.timeZone)}.`
      : 'The forecast does not yet show when it clears.';
    // What it means for the work this crew does: points to re-observe, a flight not to make, a blade to hold.
    const forTrade = first.ops.map((op) => adviceNow(op, false, first!.kp, 'space_weather')).filter(Boolean).slice(0, 2).join(' ');
    const key = `storm:${first.time.slice(0, 10)}`;
    if (farm.alertsSent.includes(key)) continue;
    if (!(await claim(id, (x) => {
      if (x.alertsSent.includes(key)) return false;
      x.alertsSent = [...x.alertsSent.slice(-29), key];
      return true;
    }))) continue;
    for (const c of stormTo) {
      await out(c, {
          to: c.email,
          sender: id,
          reason: 'storm',
          subject: `Storm ahead: ${first.jobs.length} job${first.jobs.length === 1 ? '' : 's'} outside tolerance from ${when}`,
          text:
            `NOAA's forecast reaches Kp ${first.kp.toFixed(1)} around ${when}. At that level these jobs go outside ` +
            `tolerance: ${first.jobs.slice(0, 6).join('; ')}.\n\n${until}${forTrade ? `\n\n${forTrade}` : ''}\n\nAsk Orbita what to do about it.\n\n` +
            'You are getting this because you were added as a crew contact for storms and agreed to it.' +
            stopFooter(c),
        });
    }
  }
  attempted.push(...(await checkRoleAlerts(now, which)));
  if (which !== 'demo') await pushMachineAlerts(now);
  return attempted;
}

/**
 * The same warning for everybody else Orbita serves, not only farms: a grid control room, a drone operator, a fleet
 * of delivery robots, a ship holding position, a satellite team. Two moments, each sent once.
 *
 * The day before. The person's own playbook (playbook.ts) reads NOAA's forecast for their role at their geomagnetic
 * latitude, and calls it imminent when a storm that matters to them is due within the day: the same reading the
 * spoken answer gives, so the email cannot disagree with it.
 *
 * The last hour. The solar wind measured at L1, a million and a half kilometres upstream, turns hard south, the
 * shape that drives a storm. NOAA says that gives 15 to 60 minutes' notice, and it can still turn back north before
 * it arrives, which the message says. Sent to farms too, at most once in six hours.
 * https://www.nesdis.noaa.gov/our-satellites/currently-flying/dscovr-deep-space-climate-observatory
 */
export async function checkRoleAlerts(now = new Date(), which: 'all' | 'accounts' | 'demo' = 'all'): Promise<Delivery[]> {
  const snap = swpc.current();
  if (!snap?.slots.length) return [];
  const sky = {
    now,
    levels: { g: snap.scales.g, s: snap.scales.s, r: snap.scales.r },
    yesterday: snap.scales.yesterday,
    days: snap.scales.days,
    slots: snap.slots,
    kpNow: solarwind.estimatedKp()?.kp ?? null,
  };
  const arriving = solarwind.incoming();
  const attempted: Delivery[] = [];
  for (const [id, farm] of store.allEntries()) {
    const demo = !canEmailFor(id);
    if ((which === 'accounts' && demo) || (which === 'demo' && !demo)) continue;
    const to = recipients(farm, 'storm');
    if (!to.length || (!farm.role && !farm.fields.length)) continue;
    const send = async (key: string, subject: string, body: string): Promise<void> => {
      if (farm.alertsSent.includes(key)) return;
      if (!(await claim(id, (x) => {
        if (x.alertsSent.includes(key)) return false;
        x.alertsSent = [...x.alertsSent.slice(-29), key];
        return true;
      }))) return;
      for (const c of to) {
        const email: Email = { to: c.email, sender: id, reason: 'storm', subject, text: `${body}\n\nYou are getting this because you were added as a contact for storms and agreed to it.${stopFooter(c)}` };
        if (demo) toDemoPhone(id, { to: c.name, reason: 'storm', subject, text: body, stop: c.stopId ?? undefined });
        else attempted.push(await sendEmail(email));
      }
    };
    const site = farm.rolePlace ?? farm.fields[0];
    const where = farm.rolePlace ? ` near ${farm.rolePlace.name}` : '';
    // ---- the day before, for a role ----
    // A farm with fields already has its own storm email above, job by job; the field crew playbook would repeat it.
    if (farm.role && !(farm.role === 'field_crew' && farm.fields.length)) {
      const advice = advise(farm.role as Role, sky, site ? geomagneticLatitude(site.lat, site.lon) : null);
      if (advice.phase === 'imminent' || advice.phase === 'during') {
        const day = (advice.reading.peak?.time ?? now.toISOString()).slice(0, 10);
        const steps = advice.actions.slice(0, 3).map((a) => `- ${a.say}`).join('\n');
        await send(
          `role:${farm.role}:${day}`,
          `Space weather ahead for ${advice.label}${where}`,
          `${advice.situation}\n\n${steps ? `What to do:\n${steps}\n\n` : ''}Ask Orbita for the rest, or whether it has eased.`,
        );
      }
    }
    // ---- the last hour, for everybody watching ----
    if (arriving?.level === 'likely') {
      const block = Math.floor(now.getTime() / (6 * HOUR));
      await send(
        `arriving:${block}`,
        `Arriving in about ${arriving.minutes} minutes: solar wind turned south`,
        `${arriving.say}\n\nIf it holds, the next hour is when positions, radio and power lines are hit first. Anything that can wait an hour should.`,
      );
    }
  }
  return attempted;
}

/** After ten failures in a row the address is no longer tried; status says so, and set or test starts it again. */
const MAX_HOOK_FAILURES = 10;

/**
 * The machine alert, pushed to the fleets that asked for it (alert_my_machines), whenever it changes: a storm comes
 * into the three day forecast, moves within a day, the solar wind turns south, or it all clears. A first look that is
 * all clear sends nothing. Only real accounts: the demo page's sandboxes never call out. See webhooks.ts.
 */
export async function pushMachineAlerts(now = new Date()): Promise<number> {
  let pushed = 0;
  for (const [id, farm] of store.allEntries()) {
    const hook = farm.machineHook;
    if (!hook || !canEmailFor(id) || (hook.failures ?? 0) >= MAX_HOOK_FAILURES) continue;
    const feed = machineAlerts.forFarm(farm, now);
    if (feed.etag === 'no-forecast' || feed.etag === hook.lastEtag) continue;
    const matters = Boolean(feed.arriving) || feed.alerts.some((a) => a.phase !== 'clear');
    if (!hook.lastEtag && !matters) {
      store.update(id, (x) => void (x.machineHook && (x.machineHook.lastEtag = feed.etag)));
      continue;
    }
    // Claimed first, as the emails are, so two overlapping runs cannot both push the same change.
    if (!(await claim(id, (x) => {
      if (!x.machineHook || x.machineHook.lastEtag === feed.etag) return false;
      x.machineHook.lastEtag = feed.etag;
      return true;
    }))) continue;
    const r = await webhooks.push(hook.url, hook.secret, { type: 'orbita.alerts', ...feed });
    const at = spokenTime(now.toISOString(), farm.fields[0]?.timeZone);
    store.update(id, (x) => {
      if (!x.machineHook) return;
      x.machineHook.lastResult = r.ok ? `delivered ${at}` : `failed ${at}: ${r.why}`;
      x.machineHook.failures = r.ok ? 0 : (x.machineHook.failures ?? 0) + 1;
      // Not delivered: forget the etag, so the next run tries the same change again.
      if (!r.ok) x.machineHook.lastEtag = hook.lastEtag ?? null;
    });
    if (r.ok) pushed++;
  }
  return pushed;
}
