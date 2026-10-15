/**
 * The gaps the 2026 research pointed at, tested here as closed.
 *
 *   Spoofing. Where the FAA and EASA say GPS is jammed and spoofed as a matter of course, a position is told to
 *   verify, and a job and a past day say so.
 *   Receivers built for scintillation. A machine with that protection is not held by the evening bubble hours or
 *   a measured disturbed sky; it is told to watch the fix instead.
 *   Holdover. Timing and data-centre operators hear how long a clock keeps time without GPS, by oscillator.
 *   Aircraft reports. GPSJAM publishes no licence, so it is off unless switched on.
 */
import { mkdirSync, rmSync } from 'node:fs';

const DIR = './data/test-gaps';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.ORBITA_DATA = `${DIR}/farms.json`;
process.env.ORBITA_OUTBOX = `${DIR}/outbox.jsonl`;
delete process.env.ORBITA_DATA_KEY;
delete process.env.ORBITA_SCOPE;
delete process.env.ORBITA_GPSJAM;

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

globalThis.fetch = async () => { throw new Error('offline in this test'); };

const swpc = await import('./dist/swpc.js');
const solarwind = await import('./dist/solarwind.js');
const interference = await import('./dist/interference.js');
const spoofing = await import('./dist/spoofing.js');
const domain = await import('./dist/domain.js');
const geo = await import('./dist/geocode.js');
const { advise } = await import('./dist/playbook.js');
const { registerTools } = await import('./dist/tools.js');
const { configureForTest: fakeZones } = await import('./dist/timezone.js');
fakeZones(async () => 'America/Sao_Paulo');
geo.configureForTest(async (q) => (/odesa|odessa/i.test(q)
  ? { name: 'Odesa', region: 'Odesa Oblast', country: 'Ukraine', countryCode: 'UA', lat: 46.48, lon: 30.72 }
  : { name: 'Grand Island', region: 'Nebraska', country: 'United States', countryCode: 'US', lat: 40.92, lon: -98.34 }));

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

async function connect(id) {
  const server = new McpServer({ name: 't', version: '1' }, { capabilities: { tools: {}, resources: {} } });
  registerTools(server, () => id);
  const client = new Client({ name: 'c', version: '1' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { said: (r.content ?? []).map((c) => c.text ?? '').join(' '), data: r.structuredContent ?? {} };
  };
}

const HOUR = 3_600_000;
function sky(kpNow, kpLater = kpNow) {
  const start = Math.floor(Date.now() / (3 * HOUR)) * 3 * HOUR;
  const slots = [];
  for (let i = -24; i < 24; i += 1) slots.push({ time: new Date(start + i * 3 * HOUR).toISOString(), kp: i < 4 ? kpNow : kpLater, observed: i < 0 });
  const g = kpNow >= 9 ? 5 : kpNow >= 8 ? 4 : kpNow >= 7 ? 3 : kpNow >= 6 ? 2 : kpNow >= 5 ? 1 : 0;
  swpc.seedForTest({ fetchedAt: new Date().toISOString(), slots, alerts: [], scales: { g, s: 0, r: 0, yesterday: { g: 0, s: 0, r: 0 }, days: [] }, stale: false });
}
sky(2);
solarwind.seedForTest({ wind: null, kp: null });
interference.seedForTest({ tests: [], satellites: [], jam: {} });

console.log('\nWhere the regulators say GPS is jammed and spoofed');
{
  check('Odesa, on the Black Sea, is in a listed region, and the FAA and EASA both list it', spoofing.zoneAt(46.48, 30.72)?.name === 'the Black Sea' && spoofing.zoneAt(46.48, 30.72)?.source === 'FAA and EASA');
  check('Kaliningrad is in the Baltic region', spoofing.zoneAt(54.71, 20.51)?.name === 'the Baltic region');
  check('Lahore is on the India and Pakistan border, from the FAA', spoofing.zoneAt(31.52, 74.36)?.source === 'FAA');
  check('Nebraska, Sao Paulo and Iowa are in none', [spoofing.zoneAt(40.92, -98.34), spoofing.zoneAt(-23.55, -46.63), spoofing.zoneAt(42.0, -93.6)].every((z) => z === null));

  const robot = await connect('acct:spoof-robot');
  const odesa = await robot('position_trust', { lat: 46.48, lon: 30.72, needMeters: 5 });
  check('a position in Odesa on a quiet day is "verify", not "trust"', odesa.data.verdict === 'verify', `${odesa.data.verdict} | ${odesa.said}`);
  check('...because the FAA and EASA list it for spoofing, which gives a wrong position with no warning', /the FAA and EASA list the Black Sea as an area where GPS is regularly jammed and spoofed/.test(odesa.said) && /no warning/.test(odesa.said), odesa.said);
  check('...with the region in the checks an agent reads', odesa.data.checks?.spoofingRegion?.name === 'the Black Sea');
  check('...and the same call named to make again', odesa.data.nextAction?.tool === 'position_trust');
  const nebraska = await robot('position_trust', { lat: 40.92, lon: -98.34, needMeters: 5 });
  check('the same quiet day in Nebraska is "trust", with no region', nebraska.data.verdict === 'trust' && nebraska.data.checks?.spoofingRegion === null, `${nebraska.data.verdict} | ${nebraska.said}`);

  const farm = await connect('acct:spoof-farm');
  await farm('my_farm', { fieldName: 'River field', place: 'Odesa, Ukraine', machineName: 'planter', correction: 'rtk' });
  const job = await farm('can_i_run', { operation: 'planting' });
  check('a job in Odesa is told to check its line against a marker, as a thing that is not the sun', /One thing that is not the sun: the FAA and EASA list the Black Sea for regular GPS jamming and spoofing, so check your line against a marker you know before you trust it\./.test(job.said), job.said);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const back = await farm('what_happened', { when: yesterday, operation: 'planting' });
  check('a bad day there names the region as a possible cause', /regularly jammed and spoofed, so that may explain it/.test(back.said), back.said);
  check('...and does not claim it ruled everything out', !/I checked the other published causes/.test(back.said));
}

console.log('\nA receiver built to ride out scintillation');
{
  // Near Brasilia, 21:00 local solar time on 9 November: the evening bubble hours, in South America's season.
  const field = { id: 'f', name: 'Cerrado', lat: -12.0, lon: -47.0 };
  const at = new Date('2026-11-10T00:10:00Z');
  check('the test moment is the evening bubble hours there', domain.equatorialEvening(field, at) === true);
  const plain = domain.assess('planting', 2, { id: 'a', name: 'planter', correction: 'rtk' }, field, at);
  const hard = domain.assess('planting', 2, { id: 'b', name: 'planter', correction: 'rtk', hardened: true }, field, at);
  check('an ordinary RTK planter is held', plain.go === false && /Hold off planting until after midnight/.test(plain.reason), plain.reason);
  check('a planter with scintillation protection goes ahead', hard.go === true, hard.reason);
  check('...told it is the bubble hours, and to watch the fix, because the makers report fewer dropouts, not none', /evening plasma bubble hours/.test(hard.reason) && /keep an eye on the fix status/.test(hard.reason) && /not none/.test(hard.reason), hard.reason);
  const stormy = domain.assess('planting', 8, { id: 'b', name: 'planter', correction: 'rtk', hardened: true }, { id: 'n', name: 'North 40', lat: 46.9, lon: -96.8 }, new Date('2026-11-10T18:00:00Z'));
  check('a severe storm still holds it: a storm\'s own error is not scintillation', stormy.go === false, stormy.reason);

  const owner = await connect('acct:hardened');
  const saved = await owner('my_farm', { machineName: 'planter', correction: 'rtk', hardened: true });
  check('saying the receiver has protection is kept with the machine, and said back', /Added planter on RTK, with scintillation protection\./.test(saved.said), saved.said);
  const again = await owner('my_farm', { machineName: 'planter', correction: 'rtk', hardened: false });
  check('...and taken off again when they say it does not', !/scintillation protection/.test(again.said));

  const agent = await connect('acct:hardened-agent');
  // The verdict for an agent reads the measured sky too; with no reading the evening rule decides.
  const plainAgent = await agent('position_trust', { lat: -12.0, lon: -47.0, needMeters: 0.1, correction: 'rtk' });
  const hardAgent = await agent('position_trust', { lat: -12.0, lon: -47.0, needMeters: 0.1, correction: 'rtk', hardened: true });
  if (domain.equatorialEvening({ lat: -12.0, lon: -47.0 }, new Date())) {
    check('an agent needing 10 cm in the bubble hours: "do not trust" plain, "verify" with protection', plainAgent.data.verdict === 'do_not_trust' && hardAgent.data.verdict === 'verify', `${plainAgent.data.verdict} / ${hardAgent.data.verdict}`);
  } else {
    check('an agent with protection is never judged more harshly than one without', ['trust', 'verify', 'do_not_trust'].indexOf(hardAgent.data.verdict) <= ['trust', 'verify', 'do_not_trust'].indexOf(plainAgent.data.verdict), `${plainAgent.data.verdict} / ${hardAgent.data.verdict}`);
  }
}

console.log('\nHow long a clock keeps time without GPS');
{
  const NOW = new Date();
  const slots = (kp) => Array.from({ length: 25 }, (_, i) => ({ time: new Date(NOW.getTime() + (-3 + i * 3) * HOUR).toISOString(), kp, observed: i === 0 }));
  const Q = { g: 0, s: 0, r: 0 };
  const watch = { now: NOW, levels: Q, yesterday: Q, days: [], slots: slots(2).map((s, i) => (i === 4 ? { ...s, kp: 7 } : s)) };
  const g4 = { now: NOW, levels: { g: 4, s: 0, r: 0 }, yesterday: Q, days: [], slots: slots(8) };
  for (const role of ['timing', 'data_centre']) {
    const a = advise(role, g4, null);
    const all = a.actions.map((x) => x.say).join(' ');
    check(`${role}: at G4 it is said that hours of degraded GPS is within rubidium and past standard quartz`, /within what rubidium rides out and past what a standard quartz oscillator does/.test(all), all.slice(0, 300));
    check(`${role}: ...with the 100 nanoseconds for 14 days of the ITU standard`, /100 nanoseconds for 14 days/.test(all));
    check(`${role}: ...and every line carries its source`, a.actions.every((x) => x.sources.length > 0));
    const w = advise(role, watch, null);
    const said = w.actions.map((x) => x.say).join(' ');
    check(`${role}: ahead of a storm, the time each kind of oscillator holds, as a vendor's table`, /A vendor table puts drifting past the 1.5 microseconds mobile networks allow at about 16 hours/.test(said) && /4 days for rubidium/.test(said), said.slice(0, 300));
  }
}

console.log('\nAircraft reports are off unless switched on');
{
  interference.seedForTest({ tests: [], satellites: [], jam: { [new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)]: { x: [1, 99] } } });
  const found = interference.near(40.92, -98.34);
  check('with nothing set, aircraft reports are neither read nor missed', found.reported === null && !found.unchecked.includes('aircraft interference reports'), JSON.stringify(found));
  check('...and nothing about aircraft is said as ruled out', !/aircraft/.test(interference.ruledOut(found)), interference.ruledOut(found));
  process.env.ORBITA_GPSJAM = 'on';
  check('switched on, they are read', !interference.near(40.92, -98.34).unchecked.includes('aircraft interference reports'));
  delete process.env.ORBITA_GPSJAM;
}

console.log('\nA machine asking about a few minutes ahead');
{
  // Quiet for the next two hours, then a severe storm.
  const now = Date.now();
  const slots = [];
  for (let i = -8; i < 24; i += 1) {
    const t = Math.floor(now / (3 * HOUR)) * 3 * HOUR + i * 3 * HOUR;
    slots.push({ time: new Date(t).toISOString(), kp: t >= now + 2 * HOUR ? 8 : 2, observed: t < now });
  }
  swpc.seedForTest({ fetchedAt: new Date().toISOString(), slots, alerts: [], scales: { g: 0, s: 0, r: 0, yesterday: { g: 0, s: 0, r: 0 }, days: [] }, stale: false });
  interference.seedForTest({ tests: [], satellites: [], jam: {} });
  const robot = await connect('acct:ahead');
  const nowSaid = await robot('position_trust', { lat: 40.92, lon: -98.34, needMeters: 5, correction: 'rtk' });
  const later = await robot('position_trust', { lat: 40.92, lon: -98.34, needMeters: 5, correction: 'rtk', inMinutes: 300 });
  check('now, with a quiet sky, the receiver can be trusted', nowSaid.data.verdict === 'trust', `${nowSaid.data.verdict} | ${nowSaid.said}`);
  check('five hours on, into the forecast storm, it cannot', later.data.verdict === 'do_not_trust', `${later.data.verdict} | ${later.said}`);
  check('...said as the forecast for that time, and marked as forecast only', /^From the forecast for 300 minutes from now: /.test(later.said) && later.data.forecastOnly === true && later.data.inMinutes === 300, later.said.slice(0, 120));
  check('...and the same call, with the same minutes, is the one to make again', later.data.nextAction?.tool === 'position_trust' && later.data.nextAction.arguments.inMinutes === 300);
  const roti = await import('./dist/roti.js');
  roti.seedForTest({ links: Array.from({ length: 40 }, (_, i) => ({ lat: 40.9 + i * 0.01, lon: -98.3, roti: 0.5 })), fetchedAt: Date.now() });
  const soon = await robot('position_trust', { lat: 40.92, lon: -98.34, needMeters: 5, correction: 'rtk', inMinutes: 30 });
  check('the sky measured now is not passed off as the sky in half an hour', soon.data.checks?.measuredSky === null && !/satellite signals over the point are disturbed/.test(soon.said), soon.said);
  roti.resetForTest();
  sky(2);
}

console.log('\nOutside the United States, a quiet test schedule is not "no test"');
{
  interference.seedForTest({ tests: [], satellites: [], jam: {} });
  check('Nebraska: the Coast Guard schedule was checked, and said so', /no military GPS test was scheduled over the field/.test(interference.ruledOut(interference.near(40.92, -98.34))));
  const bavaria = interference.ruledOut(interference.near(48.4, 11.7));
  check('Bavaria: never "no test was scheduled", because the schedule is for the United States', !/no military GPS test/.test(bavaria), bavaria);
  check('...and it says where tests are announced instead', /announced to pilots by NOTAM a few days ahead/.test(bavaria), bavaria);
  check('Hawaii and Alaska count as the United States', interference.inUS(21.3, -157.8) && interference.inUS(61.2, -149.9) && !interference.inUS(51.5, -0.1));
}

console.log('\nThe measured sky can be switched off, for anyone running a copy commercially');
{
  const roti = await import('./dist/roti.js');
  const links = Array.from({ length: 40 }, (_, i) => ({ lat: 40.9 + i * 0.01, lon: -98.3, roti: 0.5 }));
  roti.seedForTest({ links, fetchedAt: Date.now() });
  check('on by default, a disturbed sky is read', roti.over(40.92, -98.34)?.state === 'disturbed', JSON.stringify(roti.over(40.92, -98.34)));
  process.env.ORBITA_ROTI = 'off';
  check('with ORBITA_ROTI=off it reads nothing, and the forecast decides alone', roti.over(40.92, -98.34) === null);
  delete process.env.ORBITA_ROTI;
  roti.resetForTest();
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
