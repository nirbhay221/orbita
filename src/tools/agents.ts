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
import { expectedErrorM, equatorialEvening, bubbleSeason, G_SCALE, rtkMultiplier, clearWindows, stormMargin, type Correction, type Field } from '../domain.js';
import { spokenTime } from '../timezone.js';
import * as swpc from '../swpc.js';
import * as roti from '../roti.js';
import * as solarwind from '../solarwind.js';
import * as interference from '../interference.js';
import * as spoofing from '../spoofing.js';
import * as particles from '../particles.js';
import * as spacecraft from '../spacecraft.js';
import * as store from '../store.js';
import { NOAA_DOWN, say, kpRightNow } from './shared.js';
import * as deps from '../dependencies.js';
import { geocode, GeocoderDown, lookupDown } from '../geocode.js';
import * as webhooks from '../webhooks.js';
import * as machineAlerts from '../machinealerts.js';

export type Trust = 'trust' | 'verify' | 'do_not_trust';

/** What a receiver with no correction is good for on a quiet day decides the default need: a few metres. */
const DEFAULT_NEED_M = 5;
/** 14 CFR 91.227: ADS-B position uncertainty under 0.05 nautical miles. */
const ADSB_NEED_M = 92.6;
/** A drone show is about a thousand drones; past this a caller should split the list. */
const MAX_POINTS = 1000;
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
        'receiver and charging. Name what else it relies on in dependsOn, a satellite link, HF radio, grid power, ' +
        'electronics at altitude, a compass, GPS time or traffic awareness, and each is judged the same way. For a fleet ' +
        'or swarm, give every position in points; for a scheduler, give windowsHours for the clear windows ahead. ' +
        'Call this when an agent or machine asks ' +
        'whether to rely on its position or on anything else the sun can reach, or whether ' +
        'GPS is reliable somewhere. It is not for whether a farm or survey job can run (use can_i_run), nor for ' +
        'what went wrong earlier (use what_happened).',
      inputSchema: {
        lat: z.number().min(-90).max(90).optional().describe('Latitude of the position in decimal degrees'),
        lon: z.number().min(-180).max(180).optional().describe('Longitude of the position in decimal degrees'),
        field: z.string().optional().describe('A saved field, by name or id, in place of latitude and longitude'),
        place: z.string().optional().describe('A town, as spoken, in place of latitude and longitude, e.g. "Fargo, North Dakota"'),
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
        dependsOn: z.array(z.enum(deps.DEPENDENCIES)).max(8).optional().describe(deps.DEPENDENCY_HINT),
        points: z
          .array(z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), name: z.string().max(60).optional() }))
          .min(1)
          .max(MAX_POINTS)
          .optional()
          .describe('For a fleet, a swarm or many sites at once: each position, with a name if it has one. One verdict each, and the worst of them'),
        windowsHours: z
          .number()
          .int()
          .min(3)
          .max(72)
          .optional()
          .describe('For a scheduler planning ahead: how many hours of the forecast to search for clear windows at this position, up to 72'),
      },
    },
    async (args) => {
      // A town said in place of coordinates: "a delivery robot in Fargo". Without this the saved field was judged
      // instead, which answered for Nebraska. Looked up, or said plainly when it cannot be found.
      if (args.place && (args.lat == null || args.lon == null) && !args.points?.length) {
        try {
          const found = await geocode(args.place);
          if (!found) return say(`I couldn't find ${String(args.place).slice(0, 60)}. Tell me the nearest town with its state or country.`, { verdict: null, reason: 'place_not_found' });
          args = { ...args, lat: found.lat, lon: found.lon };
        } catch (err) {
          if (err instanceof GeocoderDown) return say(lookupDown(String(args.place).slice(0, 60)), { verdict: null, reason: 'lookup_down' });
          throw err;
        }
      }
      if (args.points?.length) return fleet(args, args.points);
      if (args.windowsHours) return plan(args, args.windowsHours);
      // The position alone, as it always was, unless the caller names more it depends on. See dependencies.ts.
      const wanted = [...new Set(args.dependsOn ?? ['satellite_position'])];
      const others = wanted.filter((d): d is Exclude<deps.Dependency, 'satellite_position'> => d !== 'satellite_position');
      const base = wanted.includes('satellite_position') ? await position(args) : null;
      if (!others.length && base) return base;
      const farm = store.get(farmOf());
      const saved = args.field ? store.findField(farm, args.field) : farm.fields[0];
      const at = args.lat != null && args.lon != null ? { lat: args.lat, lon: args.lon } : saved ? { lat: saved.lat, lon: saved.lon } : null;
      const judged = others.map((d) => (d === 'traffic_awareness' ? traffic(at, args) : deps.judge(d, at, args.altitudeKm)));
      const sc = (base?.structuredContent ?? {}) as Record<string, unknown>;
      const own = typeof sc.verdict === 'string' ? [sc.verdict as Trust] : [];
      const verdict = deps.worst([...own, ...judged.map((j) => j.verdict)]);
      // A voice answer is three sentences, so the verdict for each comes first in one, then the reasons, worst first.
      const baseText = (base?.content?.[0] as { text?: string } | undefined)?.text ?? '';
      const items = [
        ...(base && own.length ? [{ name: 'position', verdict: own[0], why: Array.isArray(sc.reasons) && sc.reasons.length ? `${(sc.reasons as string[]).join('; ')}.` : baseText.split(/(?<=\.)\s/)[0] }] : []),
        ...judged.map((j) => ({ name: deps.NAMES[j.dependency], verdict: j.verdict, why: deps.say(j) })),
      ];
      const rank = { do_not_trust: 2, verify: 1, trust: 0 } as const;
      const summary = `${deps.LEAD[verdict]} ${items.map((i) => `${i.name}: ${deps.VERB[i.verdict]}`).join('; ')}.`;
      const spoken = [summary, ...[...items].filter((i) => i.verdict !== 'trust').sort((x, y) => rank[y.verdict] - rank[x.verdict]).map((i) => (i.name === 'position' ? `Position: ${i.why}` : i.why))].join(' ');
      return say(spoken, {
        ...sc,
        verdict,
        confidence: verdict === 'trust' ? 'high' : verdict === 'verify' ? 'reduced' : 'low',
        ...(base ? { positionVerdict: sc.verdict } : {}),
        dependencies: judged,
        recheckInMinutes: verdict === 'trust' ? 30 : 10,
        sources: [...new Set([...((sc.sources as string[] | undefined) ?? []), ...judged.map((j) => j.source)])],
      });
    },
  );

  /* ---------------------------------------------------------------- *
   * Telling a fleet's software, not a person. The alert machinealerts.ts builds for every account (orbita://alerts),
   * pushed when it changes: a storm due within a day or three for this account's machines, the solar wind turning
   * south an hour out, and the all clear after. Safety and signing are in webhooks.ts.
   * ---------------------------------------------------------------- */
  server.registerTool(
    'alert_my_machines',
    {
      title: 'Push storm alerts to a fleet\'s own software',
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true, destructiveHint: false },
      description:
        'For robots, drones, vehicles or any machines that cannot read an email: sends this account\'s machine alert ' +
        'to the fleet\'s own web address whenever it changes, a storm due within a day or three for the saved fields ' +
        'and the place given to what_should_i_do, the solar wind turning south about an hour out, and the all clear. ' +
        'Messages are signed (Standard Webhooks). action set with an https url, then a signed test is sent; status; ' +
        'test; remove. Call this when someone wants their machines, not a person, told before a storm.',
      inputSchema: {
        action: z.enum(['set', 'status', 'test', 'remove']).describe('set saves the address and sends a signed test; status says what is set; test sends one again; remove stops it'),
        url: z.string().max(300).optional().describe('For set: the https address the fleet\'s software listens on'),
        needMeters: z.number().positive().max(1000).optional().describe('For set: the accuracy the machines need, in metres; 5 when not given, 0.05 for machines on RTK that work to the centimetre'),
        correction: z.enum(['rtk', 'ppp', 'sbas', 'autonomous']).optional().describe('For set: how the machines\' receivers are corrected; autonomous when not given'),
      },
    },
    async ({ action, url, needMeters, correction }) => {
      const id = farmOf();
      const farm = store.get(id);
      const hook = farm.machineHook ?? null;
      const demo = id.startsWith('demo:');
      const sample = () => machineAlerts.forFarm(store.get(id));
      if (action === 'status') {
        if (!hook) return say('No address is set for your machines. Give me an https address and I will push storm alerts to it.', { set: false });
        return say(`Storm alerts for your machines go to ${new URL(hook.url).host}. ${hook.lastResult ? `The last one: ${hook.lastResult}` : 'Nothing has needed sending yet.'}`, { set: true, host: new URL(hook.url).host, lastResult: hook.lastResult ?? null });
      }
      if (action === 'remove') {
        store.update(id, (f) => void (f.machineHook = null));
        return say(hook ? 'Done. Nothing more will be pushed to your machines.' : 'There was no address set.', { set: false });
      }
      const target = action === 'set' ? url : hook?.url;
      if (!target) return say(action === 'set' ? 'Give me the https address your fleet\'s software listens on.' : 'No address is set yet. Give me one with action set.', { set: Boolean(hook), needs: 'url' });
      const checked = await webhooks.checkUrl(target);
      if (!checked.ok) return say(`I can't use that address. ${checked.why}`, { set: Boolean(hook), refused: checked.why });
      const secret = action === 'set' || !hook ? webhooks.newSecret() : hook.secret;
      const test = { type: 'orbita.alerts.test', ...sample() };
      // The demo page never calls out, as it never sends email: what would be sent is shown instead.
      const result = demo ? { ok: true, status: 0, why: 'not sent from the demo page' } : await webhooks.push(target, secret, test);
      if (action === 'set') {
        store.update(id, (f) => void (f.machineHook = { url: checked.url.href, secret, addedAt: new Date().toISOString(), ...(needMeters ? { needM: needMeters } : {}), ...(correction ? { correction } : {}), lastEtag: null, lastResult: null, failures: 0 }));
      }
      const host = checked.url.host;
      const said = demo
        ? `Saved ${host}. From this page nothing is sent to other addresses; the message it would have sent comes back with this answer.`
        : result.ok
          ? `Saved. I sent a signed test to ${host} and it answered ${result.status}. From now on it gets an alert whenever a storm changes the picture for your machines.`
          : `Saved, but the signed test to ${host} did not arrive: ${result.why} Fix that and ask me to test it again.`;
      return say(said, {
        set: true,
        host,
        tested: !demo,
        delivered: demo ? null : result.ok,
        ...(action === 'set' ? { signingSecret: secret, signing: 'Standard Webhooks: webhook-id, webhook-timestamp, webhook-signature (v1, HMAC-SHA256 over id.timestamp.body)' } : {}),
        ...(demo ? { wouldSend: test } : {}),
      });
    },
  );

  /*
   * What other aircraft see of this one. ADS-B Out and Remote ID broadcast the GNSS position, and 14 CFR 91.227 asks
   * ADS-B for a position uncertainty under 0.05 nautical miles, 92.6 metres. So this is the position check run at that
   * accuracy: a fix good enough to steer by is usually good enough to be seen by, and when it is not, the aircraft
   * around it are looking at the wrong place.
   */
  function traffic(at: { lat: number; lon: number } | null, args: { correction?: string; hardened?: boolean; inMinutes?: number }): deps.Judged {
    const source = 'https://www.ecfr.gov/current/title-14/chapter-I/subchapter-F/part-91/subpart-C/section-91.227';
    if (!at) return { dependency: 'traffic_awareness', verdict: 'verify', reason: 'I need a position to judge what other aircraft will see', source };
    const g = groundTrust({ id: 'traffic', name: 'this aircraft', lat: at.lat, lon: at.lon }, { ...args, needMeters: ADSB_NEED_M });
    if (!g) return { dependency: 'traffic_awareness', verdict: 'verify', reason: 'I could not read the space weather forecast', source };
    const why = (g.data.reasons as string[] | undefined)?.[0];
    return g.verdict === 'trust'
      ? { dependency: 'traffic_awareness', verdict: 'trust', reason: 'the position it broadcasts should be inside the 92.6 metres ADS-B asks for', source }
      : g.verdict === 'verify'
        ? { dependency: 'traffic_awareness', verdict: 'verify', reason: `confirm what other aircraft see before relying on it, because ${why ?? 'the fix is in doubt'}`, source }
        : { dependency: 'traffic_awareness', verdict: 'do_not_trust', reason: `other aircraft may be seeing it in the wrong place: ${why ?? 'the fix is in doubt'}`, source };
  }

  /*
   * A fleet, a swarm, or every site a co-op runs, in one call. Each point is judged exactly as a single call would
   * judge it; the answer leads with the counts and the worst, and names the points that are not "trust", worst first,
   * so a scheduler can act on the list and a person can hear the shape of it.
   */
  function fleet(args: { needMeters?: number; correction?: string; hardened?: boolean; inMinutes?: number }, points: { lat: number; lon: number; name?: string }[]) {
    const judged = points.map((p, i) => {
      const name = p.name?.trim() || `position ${i + 1}`;
      const g = groundTrust({ id: `p${i}`, name, lat: p.lat, lon: p.lon }, args);
      return { name, lat: p.lat, lon: p.lon, verdict: (g?.verdict ?? 'verify') as Trust, reasons: (g?.data.reasons as string[] | undefined) ?? ['no forecast could be read'] };
    });
    if (!swpc.current()) return say(NOAA_DOWN, { unavailable: true, verdict: 'verify' as Trust, reason: 'no_forecast' });
    const count = (v: Trust) => judged.filter((j) => j.verdict === v).length;
    const verdict = deps.worst(judged.map((j) => j.verdict));
    const rank = { do_not_trust: 2, verify: 1, trust: 0 } as const;
    const flagged = judged.filter((j) => j.verdict !== 'trust').sort((a, b) => rank[b.verdict] - rank[a.verdict]);
    const head = `Of ${judged.length} positions, ${count('trust')} trust, ${count('verify')} verify and ${count('do_not_trust')} do not trust.`;
    const worst = flagged[0];
    const named = flagged.slice(0, 3).map((j) => j.name).join(', ');
    const tail = worst
      ? ` ${flagged.length > 3 ? `The worst include ${named}` : `Not trusted fully: ${named}`}. For ${worst.name}, ${worst.reasons[0]}.`
      : ' Every one of them can act on its position.';
    return say(head + tail, {
      verdict,
      confidence: verdict === 'trust' ? 'high' : verdict === 'verify' ? 'reduced' : 'low',
      counts: { trust: count('trust'), verify: count('verify'), do_not_trust: count('do_not_trust') },
      positions: judged,
      recheckInMinutes: verdict === 'trust' ? 30 : 10,
      sources: ['https://www.swpc.noaa.gov', ...interference.SOURCES],
    });
  }

  /*
   * The clear windows ahead, for a scheduler or for anything with a fixed date. Searched over the Kp forecast in its
   * three hour blocks, so it is as good as NOAA's three day forecast and no better, and it says so. What only exists
   * now, the measured sky and a solar wind an hour upstream, is not in it.
   */
  function plan(args: { lat?: number; lon?: number; field?: string; needMeters?: number; correction?: string; hardened?: boolean }, hours: number) {
    const snap = swpc.current();
    if (!snap?.slots.length) return say(NOAA_DOWN, { unavailable: true, verdict: 'verify' as Trust, reason: 'no_forecast' });
    const farm = store.get(farmOf());
    const saved = args.field ? store.findField(farm, args.field) : args.lat == null || args.lon == null ? farm.fields[0] : undefined;
    const where: Field | null = args.lat != null && args.lon != null ? { id: 'point', name: 'this position', lat: args.lat, lon: args.lon } : saved ?? null;
    if (!where) return say('I need a latitude and longitude, or the name of a saved field, to plan around.', { unavailable: true, reason: 'no_position' });
    const need = args.needMeters ?? DEFAULT_NEED_M;
    const eq = { id: 'caller', name: 'the receiver', correction: (args.correction ?? 'autonomous') as Correction, ...(args.hardened ? { hardened: true } : {}) };
    const now = new Date();
    const last = Math.max(...snap.slots.map((x) => new Date(x.time).getTime())) + 3 * 3_600_000;
    const covered = Math.max(0, Math.min(hours, Math.floor((last - now.getTime()) / 3_600_000)));
    const windows = clearWindows(snap.slots, eq, where, need, now, covered);
    const zone = 'timeZone' in where ? where.timeZone : undefined;
    const when = (w: { start: string; end: string }) => `${spokenTime(w.start, zone)} to ${spokenTime(w.end, zone)}`;
    const total = windows.reduce((a, w) => a + w.hours, 0);
    const spoken = !windows.length
      ? `No clear window in the next ${covered} hours for ${metres(need)} at this position. The forecast does not reach further than that, so ask again tomorrow.`
      : total >= covered - 0.01
        ? `Clear for the whole ${covered} hours the forecast covers, for ${metres(need)}.`
        : `Clear windows for ${metres(need)} in the next ${covered} hours: ${windows.slice(0, 3).map(when).join('; ')}${windows.length > 3 ? `, and ${windows.length - 3} more` : ''}.`;
    return say(`${spoken} This is from NOAA's three hour Kp forecast; check position_trust again just before acting.`, {
      windows,
      hoursSearched: covered,
      needM: need,
      correction: eq.correction,
      position: { lat: where.lat, lon: where.lon },
      forecastOnly: true,
      sources: ['https://www.swpc.noaa.gov/products/3-day-forecast'],
    });
  }

  async function position({ lat, lon, field, needMeters, correction, altitudeKm, hardened, inMinutes }: {
    lat?: number; lon?: number; field?: string; needMeters?: number; correction?: string; altitudeKm?: number; hardened?: boolean; inMinutes?: number;
  }) {
    {
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
      const judged = groundTrust(where, { needMeters, correction, hardened, inMinutes });
      if (!judged) return say(NOAA_DOWN, { unavailable: true, verdict: 'verify' as Trust, reason: 'no_forecast' });
      return say(judged.spoken, judged.data);
    }
  }
}

/** What position_trust says about a point on the ground, for any tool that needs the same answer. Null without a forecast. */
export function groundTrust(
  where: Field,
  { needMeters, correction, hardened, inMinutes }: { needMeters?: number; correction?: string; hardened?: boolean; inMinutes?: number },
): { verdict: Trust; spoken: string; data: Record<string, unknown> } | null {
  /*
   * Now, or a few minutes ahead. A machine planning its next move asks "and in ten minutes?", and the conversation
   * tests found the tool could only say "I can't tell you that ahead of time". Ahead, the Kp forecast for that
   * time, the test schedule and the equatorial evening are judged at that time. What cannot be known ahead is not
   * pretended: the sky can only be measured now, and the solar wind warns at most an hour out.
   */
  const ahead = Math.max(0, Math.min(360, Math.round(inMinutes ?? 0)));
  const now = new Date(Date.now() + ahead * 60_000);
  const kp = ahead ? swpc.kpAt(now) : kpRightNow() ?? swpc.kpAt(now);
  if (!kp) return null;

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
  // Inside, but with less than twice the room, in a storm that takes the fix away in bursts. See stormMargin.
  else if (stormMargin(kp.kp, corr, err, need)) against.push(`at Kp ${kp.kp.toFixed(1)} (${G_SCALE(kp.kp)}) RTK drops its fix in bursts as storm waves pass, and an expected ${metres(err)} leaves too little room inside the ${metres(need)} needed`);

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
  return { verdict, spoken: `${when}${lead}${how}`, data: {
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
  } };
}
