/**
 * The scheduled alert check, on its own, for AWS Lambda.
 *
 * The crew emails nobody asks for in that moment (a watched job that has cleared, a
 * storm inside the next day that puts a usual job out of tolerance) used to be checked
 * by a timer inside the web server. That timer only ran while the server did: a crash,
 * a stuck deploy or a second copy meant no email, or two. A storm warning that silently
 * stops is the failure nobody notices until a crew loses its line.
 *
 * So EventBridge Scheduler runs this every fifteen minutes (infra/), on its own, reading
 * the same DynamoDB table the server writes. It reads NOAA's forecast and the solar
 * wind once, runs the same check in alerts.ts for every account, and writes back what
 * it sent before it sends it. The server leaves accounts to it when
 * ORBITA_ALERTS=scheduler, and keeps the sandboxes, whose messages go to the phone on
 * the demo page that only the server holds.
 */

import * as store from './store.js';
import * as swpc from './swpc.js';
import * as solarwind from './solarwind.js';
import { canEmailFor, type Delivery } from './notify.js';
import { reachable } from './consent.js';
import { checkFieldAlerts } from './alerts.js';

export type SweepResult = {
  farms: number;
  forecastSlots: number;
  sent: Record<'windowClear' | 'storm', number>;
  failed: number;
  /** Refused by the SES sandbox because the address is not verified. Logged, never a failure. */
  unverified: number;
};

const sent = (d: Delivery[], reason: string) => d.filter((x) => x.status === 'sent' && x.reason === reason).length;

/** `read: false` uses the forecast already held, for a test that has seeded one. */
export async function sweep(now = new Date(), { read = true } = {}): Promise<SweepResult> {
  await store.init();
  // Somebody to email, or a fleet's own software to push to (alert_my_machines). See alerts.ts.
  const farms = store.allEntries().filter(([id, f]) => canEmailFor(id) && (f.crew.some(reachable) || Boolean(f.machineHook)));
  // Both read even when nobody needs them, so a broken feed shows up here and not only on a storm day.
  if (read) await Promise.all([swpc.refresh(), solarwind.refresh()]);
  const snap = swpc.current() ?? { slots: [] };
  const done = farms.length ? await checkFieldAlerts(now, 'accounts') : [];
  await store.flush();
  return {
    farms: farms.length,
    forecastSlots: snap.slots.length,
    sent: { windowClear: sent(done, 'window_clear'), storm: sent(done, 'storm') },
    failed: done.filter((d) => d.status === 'failed').length,
    unverified: done.filter((d) => d.status === 'unverified').length,
  };
}
