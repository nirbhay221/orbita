// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.ORBITA_SCOPE ??= 'all';
import { assess, expectedErrorM, nextWindow, TOLERANCE_M, geomagneticLatitude, auroralBoundaryDeg, degradedOptions, deadlinePressure, rtkMultiplier, dayShiftDeg } from './dist/domain.js';
import { activeImpacts, speakImpacts } from './dist/impacts.js';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const iowa   = { id: 'f1', name: 'North 40',  lat: 42.03, lon: -93.62, baselineKm: 18 };
const dakota = { id: 'f2', name: 'Red River', lat: 47.92, lon: -97.03, baselineKm: 65 };
const gulf   = { id: 'f3', name: 'Delta',     lat: 30.10, lon: -91.00, baselineKm: 12 };
const rtk    = { id: 'e1', name: 'the planter', correction: 'rtk' };
const sbas   = { id: 'e2', name: 'the sprayer', correction: 'sbas' };

console.log('\nQuiet conditions, normal work must not be blocked');
check('RTK plants fine at Kp 2', assess('planting', 2, rtk, iowa).go);
check('SBAS sprays fine at Kp 2', assess('spraying', 2, sbas, iowa).go,
  JSON.stringify(assess('spraying', 2, sbas, iowa).reason));
check('SBAS tills fine at Kp 2', assess('tillage', 2, sbas, iowa).go);

console.log('\nStorm conditions, the May 2024 event (Kp 9) must block precision work');
const g5 = assess('planting', 9, rtk, iowa);
check('Kp 9 blocks RTK planting', !g5.go);
check('...and blames space weather, not the rig', g5.limitedBy === 'space_weather', g5.limitedBy);
check('...with drift over half a metre', g5.expectedErrorM > 0.5, `${g5.expectedErrorM}m`);
check('Kp 9 blocks spraying too', !assess('spraying', 9, sbas, iowa).go);

console.log('\nThe distinction that matters: storm vs equipment');
const wrongRig = assess('planting', 2, sbas, iowa);
check('SBAS cannot plant even on a quiet day', !wrongRig.go);
check('...and it says so is NOT the storm', wrongRig.limitedBy === 'equipment', wrongRig.limitedBy);
check('...and never promises a clear window', !/window|wait|clear/i.test(wrongRig.reason.split('.')[0]));

console.log('\nGeometry actually changes the answer');
const a = expectedErrorM(6, rtk, gulf), b = expectedErrorM(6, rtk, iowa), c = expectedErrorM(6, rtk, dakota);
check('higher latitude means more error', a < b && b < c, `${a} < ${b} < ${c}`);
check('long baseline hurts RTK', expectedErrorM(6, rtk, { ...iowa, baselineKm: 90 }) > expectedErrorM(6, rtk, { ...iowa, baselineKm: 5 }));
check('baseline is irrelevant to SBAS',
  expectedErrorM(6, sbas, { ...iowa, baselineKm: 90 }) === expectedErrorM(6, sbas, { ...iowa, baselineKm: 5 }));

console.log('\nMonotonicity, a worse storm is never a better answer');
let mono = true;
for (let kp = 0; kp <= 8.5; kp += 0.5) {
  if (expectedErrorM(kp + 0.5, rtk, iowa) < expectedErrorM(kp, rtk, iowa)) mono = false;
}
check('error never decreases as Kp rises', mono);

console.log('\nTolerances are ordered the way the jobs are');
check('planting tighter than spraying', TOLERANCE_M.planting < TOLERANCE_M.spraying);
check('spraying tighter than tillage', TOLERANCE_M.spraying < TOLERANCE_M.tillage);

console.log('\nWindow finding');
const now = new Date('2026-09-09T00:00:00Z');
const slots = [2, 7, 8, 8, 3, 2, 2, 6].map((kp, i) => ({
  time: new Date(now.getTime() + i * 3 * 3600e3).toISOString(), kp, observed: false,
}));
const w = nextWindow(slots, 'planting', rtk, iowa, now);
check('finds the first clear stretch', w !== null && w.start === slots[0].time, JSON.stringify(w));
const w2 = nextWindow(slots, 'planting', rtk, iowa, new Date(now.getTime() + 3 * 3600e3));
check('skips the storm and finds the later window', w2 !== null && w2.start === slots[4].time, JSON.stringify(w2));
check('returns null when the rig can never qualify', nextWindow(slots, 'planting', sbas, iowa, now) === null);
const mid = new Date(now.getTime() + 3600e3);
const w3 = nextWindow(slots, 'planting', rtk, iowa, mid);
check('an hour into a clear block the window opens now, for the two hours left',
  w3 !== null && w3.start === mid.toISOString() && w3.hours === 2, JSON.stringify(w3));


console.log('\nGeomagnetic latitude, because storms follow the field and not the map');
// Winnipeg and Kyiv sit at the same geographic latitude on opposite sides of the
// planet. The magnetic pole leans towards Winnipeg, so it takes the worse hit.
const winnipeg  = { id: 'f4', name: 'Prairie',   lat:  49.90, lon: -97.14, baselineKm: 18 };
const kyiv      = { id: 'f5', name: 'Chornozem', lat:  49.90, lon:  30.52, baselineKm: 18 };
check('same geographic latitude, different geomagnetic latitude',
  Math.abs(geomagneticLatitude(49.90, -97.14)) > Math.abs(geomagneticLatitude(49.90, 30.52)),
  `${geomagneticLatitude(49.90, -97.14).toFixed(1)} vs ${geomagneticLatitude(49.90, 30.52).toFixed(1)}`);
check('...and the Canadian site takes the bigger hit from the same storm',
  expectedErrorM(6, rtk, winnipeg) > expectedErrorM(6, rtk, kyiv),
  `${expectedErrorM(6, rtk, winnipeg)} vs ${expectedErrorM(6, rtk, kyiv)}`);

console.log('\nThe southern hemisphere is not an afterthought');
const pampas    = { id: 'f6', name: 'Pampas',    lat: -34.60, lon: -58.38, baselineKm: 18 };
const patagonia = { id: 'f7', name: 'Patagonia', lat: -51.62, lon: -69.22, baselineKm: 18 };
check('southern sites get a real verdict', typeof assess('planting', 6, rtk, pampas).go === 'boolean');
// In a severe storm. At Kp 6 both are far from the oval and both hold, which is what measurements show.
check('higher southern magnetic latitude means more error in a severe storm',
  expectedErrorM(8, rtk, patagonia) > expectedErrorM(8, rtk, pampas),
  `${expectedErrorM(8, rtk, patagonia)} vs ${expectedErrorM(8, rtk, pampas)}`);
check('...and at Kp 6, far from the oval, both still hold planting tolerance',
  assess('planting', 6, rtk, pampas).go && assess('planting', 6, rtk, patagonia).go);

console.log('\nTrades beyond agriculture share the engine');
check('cadastral survey is the tightest tolerance of all',
  TOLERANCE_M.surveying === Math.min(...Object.values(TOLERANCE_M)));
check('survey and grade work are tighter than spraying',
  TOLERANCE_M.surveying < TOLERANCE_M.spraying && TOLERANCE_M.machine_control < TOLERANCE_M.spraying);
check('a storm that stops planting also stops the survey crew',
  !assess('planting', 8, rtk, iowa).go && !assess('surveying', 8, rtk, iowa).go);
check('survey work blames the storm when the rig is fine on a quiet day',
  assess('surveying', 8, rtk, iowa).limitedBy === 'space_weather',
  assess('surveying', 8, rtk, iowa).limitedBy);
check('SBAS can never do cadastral survey, storm or no storm',
  assess('surveying', 1, sbas, iowa).limitedBy === 'equipment');


console.log('\nWhat else the storm hits, from scales already in memory');
check('a quiet sky claims nothing', activeImpacts({ g: 'none', s: 'none', r: 'none' }).length === 0);
check('G1 raises the grid but not pipelines yet',
  activeImpacts({ g: 'G1' }).some(i => i.system.includes('power grid')) &&
  !activeImpacts({ g: 'G1' }).some(i => i.system.includes('pipelines')));
check('G2 reaches pipelines, rail and timing',
  activeImpacts({ g: 'G2' }).some(i => i.system.includes('pipelines')) &&
  activeImpacts({ g: 'G2' }).some(i => i.system.includes('timing')));
check('R1 raises shortwave without touching the grid',
  activeImpacts({ r: 'R1' }).some(i => i.system.includes('shortwave')) &&
  !activeImpacts({ r: 'R1' }).some(i => i.system.includes('power grid')));
check('S1 raises polar flights', activeImpacts({ s: 'S1' }).some(i => i.system.includes('polar')));
check('the spoken answer never claims your phone is at risk',
  !/phone|laptop|car\b/i.test(speakImpacts({ g: 'G4', s: 'S2', r: 'R3' }).replace(/does not touch phones, cars[^.]*\./, '')));
check('a quiet sky says so plainly rather than staying silent',
  speakImpacts({ g: 'none' }).length > 40);

console.log('\nThe auroral oval moves, and the answer moves with it');
check('the oval edge sits near 66 degrees on a quiet day', Math.abs(auroralBoundaryDeg(0) - 66.5) < 0.01);
check('...and reaches the high forties in a G5', Math.abs(auroralBoundaryDeg(9) - 48.5) < 0.01);
check('...and never runs past the ends of the scale',
  auroralBoundaryDeg(-3) === auroralBoundaryDeg(0) && auroralBoundaryDeg(12) === auroralBoundaryDeg(9));
// Iowa sits at about 50.7 degrees geomagnetic, so the edge passes over it
// somewhere around Kp 8. That is what the November 2025 superstorm did in real
// life, when mid-latitude sites that are unremarkable at Kp 4 saw errors over
// ten metres for hours.
const quietGrowth = expectedErrorM(8, rtk, gulf) / expectedErrorM(4, rtk, gulf);
const midGrowth = expectedErrorM(8, rtk, iowa) / expectedErrorM(4, rtk, iowa);
check('a superstorm costs a mid-latitude field more than it costs a Gulf one',
  midGrowth > quietGrowth, `${midGrowth.toFixed(2)} vs ${quietGrowth.toFixed(2)}`);
check('...while under a quiet sky neither is degraded by the sky at all',
  rtkMultiplier(2, iowa.lat, iowa.lon) === 1 && rtkMultiplier(2, gulf.lat, gulf.lon) === 1);

console.log('\nThe RTK model, against what was measured');
const lowLat = { id: 'c', name: 'low', lat: 23, lon: 113 };
const norway = { id: 'n', name: 'Tromso', lat: 69.6, lon: 18.9 };
const fargo = { id: 'fg', name: 'Fargo', lat: 46.88, lon: -96.79 };
const flat = (kp, f) => 0.02 * rtkMultiplier(kp, f.lat, f.lon);
check('Kp 7.3 at low latitude is about 8 cm, as a network there measured', Math.abs(flat(7.3, lowLat) - 0.08) < 0.005, String(flat(7.3, lowLat)));
check('inside the oval in a storm it is a metre, as a Norwegian network measured', flat(6, norway) >= 1, String(flat(6, norway)));
check('Kp 9 puts the central United States at a metre', flat(9, iowa) >= 1, String(flat(9, iowa)));
check('Kp 4 at Fargo holds planting tolerance: the replay of 2025 had this as a no', assess('planting', 4, { id: 'r', name: 'p', correction: 'rtk' }, fargo).go === true);
check('...and so does Kp 5, a minor storm', assess('planting', 5, { id: 'r', name: 'p', correction: 'rtk' }, fargo).go === true);
check('...and Kp 7 does not', assess('planting', 7, { id: 'r', name: 'p', correction: 'rtk' }, fargo).go === false);
const saskatoon = { id: 'sk', name: 'Saskatoon', lat: 52.13, lon: -106.67 };
const noonThere = new Date('2026-06-01T19:00:00Z'); // about local solar noon at 107 west
const midnightThere = new Date('2026-06-01T07:00:00Z');
check('the oval sits eight degrees further north at local noon than at local midnight', Math.abs(dayShiftDeg(noonThere, -106.67) - 8) < 0.2 && dayShiftDeg(midnightThere, -106.67) < 0.2, `${dayShiftDeg(noonThere, -106.67)} ${dayShiftDeg(midnightThere, -106.67)}`);
check('with no time given, nothing is shifted: the cautious answer', dayShiftDeg(undefined, -106.67) === 0 && dayShiftDeg(new Date('nonsense'), 0) === 0);
check('the same Kp 6 at Saskatoon is a no at midnight and a yes at noon', assess('planting', 6, { id: 'r', name: 'p', correction: 'rtk' }, saskatoon, midnightThere).go === false && assess('planting', 6, { id: 'r', name: 'p', correction: 'rtk' }, saskatoon, noonThere).go === true);
check('...and an extreme storm is a no at any hour', assess('planting', 8.5, { id: 'r', name: 'p', correction: 'rtk' }, saskatoon, noonThere).go === false);
check('daylight never makes it worse', [iowa, gulf, fargo, norway, saskatoon].every((f) => [2, 4, 6, 8].every((k) => rtkMultiplier(k, f.lat, f.lon, noonThere) <= rtkMultiplier(k, f.lat, f.lon))));
check('a site the oval sits over at night is not told its equipment is the problem', assess('planting', 3, { id: 'r', name: 'p', correction: 'rtk' }, norway, new Date('2026-06-01T22:00:00Z')).limitedBy === 'space_weather');
check('it never gets better as the storm gets worse', [iowa, gulf, fargo, norway, lowLat].every((f) => [0, 1, 2, 3, 4, 5, 6, 7, 8].every((k) => rtkMultiplier(k + 1, f.lat, f.lon) >= rtkMultiplier(k, f.lat, f.lon))));
check('...and the same field is worse at Kp 8 than at Kp 7, not merely different',
  expectedErrorM(8, rtk, iowa) > expectedErrorM(7, rtk, iowa));

console.log('\nWorking anyway: never recommend a tier change');
const d = degradedOptions(8, rtk, iowa, 'planting');
check('refuses to suggest dropping correction tier', /do not drop to a lower correction tier/i.test(d.advice));
check('...and says why, the corrections are computed through the same ionosphere',
  /same disturbed ionosphere/i.test(d.advice));
check('offers looser jobs that genuinely still clear',
  d.stillRunnable.every(op => expectedErrorM(8, rtk, iowa) <= TOLERANCE_M[op]),
  JSON.stringify(d.stillRunnable));
check('never offers the blocked job back', !d.stillRunnable.includes('planting'));
check('the spoken line stays short enough to hear', d.spoken.length < 160, `${d.spoken.length} chars`);
check('the tier warning is kept off the spoken line', !/correction tier/i.test(d.spoken));
check('substitutes are offered tightest first, closest to the blocked job',
  TOLERANCE_M[d.stillRunnable[0]] <= TOLERANCE_M[d.stillRunnable[d.stillRunnable.length - 1]]);
// On the Gulf Coast, SBAS in a G5 runs about 1.5 m, which still clears
// scouting's 3 m. That is the loosest job on the board and the answer is correct.
const gulfCoast = { lat: 29.7, lon: -95.4, baselineKm: 18 };
const dLoose = degradedOptions(9, sbas, gulfCoast, 'planting');
check('finds the loosest job that genuinely survives a G5', dLoose.stillRunnable.includes('scouting'),
  JSON.stringify(dLoose.stillRunnable));
// The same storm in the Red River valley, on RTK: at Kp 9 that rig is a metre out, past every job but
// the loosest, and what it is offered must be a job that really still holds.
const dValley = degradedOptions(9, rtk, dakota, 'planting');
check('...and only offers jobs that genuinely still hold, never one that fails',
  dValley.stillRunnable.every((op) => assess(op, 9, rtk, dakota).go), JSON.stringify(dValley.stillRunnable));

console.log('\nEvery job, not only planting');
const fargoSite = { id: 'fa', name: 'Fargo', lat: 46.88, lon: -96.79 };
const sask = { id: 'sa', name: 'Saskatoon', lat: 52.13, lon: -106.67 };
const phone = { id: 'e8', name: 'a phone', correction: 'autonomous' };
check('a sprayer on WAAS at Fargo holds spraying tolerance on a quiet day (the old model said never)', assess('spraying', 2, sbas, fargoSite).go === true && assess('spraying', 2, sbas, fargoSite).limitedBy === 'clear');
check('...and at Saskatoon', assess('spraying', 2, sbas, sask).go === true);
check('walking a field with no correction is possible in Saskatchewan (the old model said never)', assess('scouting', 2, phone, sask).go === true);
check('a harvest on WAAS survives an ordinary active day at Kp 4', assess('harvest', 4, sbas, fargoSite).go === true);
check('...and not a severe storm', assess('harvest', 8, sbas, fargoSite).go === false);
check('survey work on RTK is stricter than planting, so it stops earlier', assess('surveying', 5, rtk, sask).go === false && assess('planting', 5, rtk, sask).go === true);
check('grade control and a drone flight are judged like planting, at two inches', assess('machine_control', 6, rtk, fargoSite).go === assess('planting', 6, rtk, fargoSite).go && assess('drone_survey', 6, rtk, fargoSite).go === assess('planting', 6, rtk, fargoSite).go);
check('a survey on PPP is told it is the equipment, not the sky', assess('surveying', 2, { id: 'p', name: 'rover', correction: 'ppp' }, fargoSite).limitedBy === 'equipment');
const severe = assess('planting', 8.7, rtk, fargoSite);
check('in a severe storm the answer says the fix is lost, as real receivers showed, and gives no drift figure', severe.go === false && /lose their precise fix altogether, as they did in May 2024/.test(severe.reason) && !/expected drift near/.test(severe.reason), severe.reason);
check('...a lesser storm still gives the figure', /expected drift near/.test(assess('planting', 7.2, rtk, fargoSite).reason));
check('the further from RTK, the less a storm changes it', (() => { const k = 8; const q = (c) => expectedErrorM(k, { id: 'x', name: 'x', correction: c }, fargoSite) / expectedErrorM(0, { id: 'x', name: 'x', correction: c }, fargoSite); return q('rtk') > q('ppp') && q('ppp') > q('sbas') && q('sbas') > q('autonomous') && q('autonomous') > 1; })());
// No correction at all in the same storm is metres out, past every tolerance there is.
const none = { id: 'e9', name: 'the old rig', correction: 'autonomous' };
const dNone = degradedOptions(9, none, dakota, 'planting');
check('says plainly when nothing clears', dNone.stillRunnable.length === 0 && /no job to switch to/i.test(dNone.spoken),
  JSON.stringify(dNone.stillRunnable));

console.log('\nDeadlines: waiting is not always free');
const t0 = new Date('2026-09-09T00:00:00Z');
const stormy = [9, 9, 9, 9, 9, 9, 9, 9].map((kp, i) => ({
  time: new Date(t0.getTime() + i * 3 * 3600e3).toISOString(), kp, observed: false,
}));
const calm = [2, 2, 2, 2, 2, 2, 2, 2].map((kp, i) => ({
  time: new Date(t0.getTime() + i * 3 * 3600e3).toISOString(), kp, observed: false,
}));
const pWait = deadlinePressure(calm, 'planting', rtk, iowa, t0, new Date('2026-09-20T00:00:00Z'));
check('a clear window before the date means waiting costs nothing', pWait.verdict === 'wait', pWait.verdict);
const pStuck = deadlinePressure(stormy, 'planting', rtk, iowa, t0, new Date('2026-09-10T00:00:00Z'));
check('no window before the date is called out, not hidden', pStuck.verdict === 'no_window_left', pStuck.verdict);
check('...and it hands the call back to the operator rather than pretending to price it',
  /your call rather than mine/i.test(pStuck.reason));
check('...and admits the three day forecast horizon', /three days/i.test(pStuck.reason));
const pGone = deadlinePressure(calm, 'planting', rtk, iowa, t0, new Date('2026-09-01T00:00:00Z'));
check('a date already gone is handled', pGone.verdict === 'deadline_passed', pGone.verdict);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
