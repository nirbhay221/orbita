// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.ORBITA_SCOPE ??= 'all';
/**
 * The playbook: what each kind of person should do, timed to NOAA's forecast.
 *
 * The expensive mistakes here are all quiet ones: telling someone to act on a
 * storm that is not coming, staying silent on one that is, reading advice
 * aloud that belongs to a scale that is not even active, or reading the NOAA
 * feed wrong so every real storm looks calm. Each gets a test.
 */
import { advise, PLAYBOOKS, ROLES, gFromKp, PREPARE_AT_PERCENT } from './dist/playbook.js';
import { levelOf, activeImpacts, speakImpacts } from './dist/impacts.js';
import { geomagneticLatitude } from './dist/domain.js';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const NOW = new Date('2026-09-14T12:00:00Z');
const Q = { g: 0, s: 0, r: 0 };
/** 25 three hour blocks from 3 hours ago to 72 hours ahead, all Kp 2 unless overridden by hour offset. */
function slots(overrides = {}) {
  return Array.from({ length: 25 }, (_, i) => {
    const offset = -3 + i * 3;
    return {
      time: new Date(NOW.getTime() + offset * 3600e3).toISOString(),
      kp: overrides[offset] ?? 2,
      observed: offset < 0,
    };
  });
}
const sky = (over = {}) => ({ now: NOW, levels: Q, yesterday: Q, days: [], slots: slots(), ...over });
const says = (a, re) => re.test(a.spoken);

console.log('\nReading NOAA the way NOAA actually writes it');
check('the word NOAA sends for G2 reads as 2', levelOf('moderate') === 2);
check('digits, codes and numbers all read the same', levelOf('3') === 3 && levelOf('G3') === 3 && levelOf(3) === 3);
check('quiet and nonsense read as 0', levelOf('none') === 0 && levelOf(null) === 0 && levelOf('banana') === 0);
check('the live feed word now raises impacts, where it used to raise nothing',
  activeImpacts({ g: 'moderate' }).length > 0, JSON.stringify(activeImpacts({ g: 'moderate' }).map((i) => i.system)));
check('G2 as a number reaches orbit predictions and drilling surveys',
  activeImpacts({ g: 2 }).some((i) => i.system.includes('orbit predictions')) &&
  activeImpacts({ g: 2 }).some((i) => i.system.includes('drilling')));
check('a quiet sky still answers in words', speakImpacts({ g: 0, s: 0, r: 0 }).length > 40);

console.log('\nKp to G, NOAA thresholds');
check('Kp 5 minus is not yet G1', gFromKp(4.67) === 0);
check('Kp 5 is G1', gFromKp(5) === 1);
check('Kp 9 minus is G4, not G5', gFromKp(8.67) === 4);
check('Kp 9 is G5', gFromKp(9) === 5);

console.log('\nA quiet sky tells nobody to do anything, but nobody gets silence either');
for (const role of ROLES) {
  const a = advise(role, sky(), null);
  check(`${role}: quiet, no steps, still a sentence`, a.phase === 'quiet' && a.actions.length === 0 && a.spoken.length > 20,
    `${a.phase} ${a.actions.length} "${a.spoken}"`);
}

console.log('\nLead time decides the advice: a day ahead is not the same as hours ahead');
const g3Soon = sky({ slots: slots({ 9: 7.3 }) });
const gridSoon = advise('grid_operator', g3Soon, null);
check('G3 in nine hours puts a grid control room in the imminent phase', gridSoon.phase === 'imminent', gridSoon.phase);
check('...and says to watch reactive reserves', says(gridSoon, /reactive reserves/i), gridSoon.spoken);
check('...with the time in UTC, the way operators run', says(gridSoon, /UTC/));
const g3Later = sky({ slots: slots({ 45: 7.0 }) });
const gridLater = advise('grid_operator', g3Later, null);
check('the same storm two days out is a watch', gridLater.phase === 'watch', gridLater.phase);
check('...and a watch is when to check black start units', gridLater.actions.some((x) => /black start/i.test(x.say)));
check('...not when to start redispatching', !gridLater.actions.some((x) => /take load off/i.test(x.say)));

console.log('\nMagnetic latitude moves the threshold only where NOAA says it does');
const g2Soon = sky({ slots: slots({ 9: 6.3 }) });
const winnipeg = geomagneticLatitude(49.9, -97.14);
const gulf = geomagneticLatitude(30.1, -91.0);
check('a G2 storm reaches a high latitude grid', advise('grid_operator', g2Soon, winnipeg).phase === 'imminent',
  `${winnipeg.toFixed(1)} ${advise('grid_operator', g2Soon, winnipeg).phase}`);
check('...but not a Gulf Coast grid, which NOAA puts at G3', advise('grid_operator', g2Soon, gulf).phase === 'quiet',
  advise('grid_operator', g2Soon, gulf).phase);

console.log('\nSatellites: drag and radiation are separate drivers');
const g2Now = advise('satellite_operator', sky({ levels: { g: 2, s: 0, r: 0 } }), null);
check('G2 running now is the during phase', g2Now.phase === 'during');
check('...conjunction warnings are flagged low confidence', g2Now.actions.some((x) => /conjunction/i.test(x.say)));
check('...surface charging is not claimed below G3', !g2Now.actions.some((x) => /surface charging/i.test(x.say)));
const g3s2 = advise('satellite_operator', sky({ levels: { g: 3, s: 2, r: 0 } }), null);
check('G3 with S2 adds surface charging and protons',
  g3s2.actions.some((x) => /surface charging/i.test(x.say)) && g3s2.actions.some((x) => /Protons/.test(x.say)));
check('...and puts the safe mode trade in front of the operator rather than deciding it',
  g3s2.actions.some((x) => /Choose deliberately between safe mode and staying in service/.test(x.say)));
const protonsOnly = advise('satellite_operator', sky({ levels: { g: 0, s: 2, r: 0 } }), null);
check('a radiation storm alone still reaches satellite operators', protonsOnly.phase === 'during' && protonsOnly.reading.scale === 'S');
const after = advise('satellite_operator', sky({ yesterday: { g: 3, s: 0, r: 0 } }), null);
check('after a G3 yesterday, the advice is fresh orbit determination', after.phase === 'after' &&
  after.actions.some((x) => /orbit determination/i.test(x.say)), after.phase);

console.log('\nAirlines only hear advice for scales that are actually up');
const s1 = advise('airline', sky({ levels: { g: 0, s: 1, r: 0 } }), null);
check('S1 raises polar routing', s1.actions.some((x) => /polar routes/i.test(x.say)));
check('...but not the HF blackout line, which needs R3', !s1.actions.some((x) => /HF contact/i.test(x.say)));
const s1r3 = advise('airline', sky({ levels: { g: 0, s: 1, r: 3 } }), null);
check('S1 plus R3 adds the HF line', s1r3.actions.some((x) => /HF contact/i.test(x.say)));
const allThree = advise('airline', sky({ levels: { g: 5, s: 2, r: 3 } }), null);
check('with three scales up at once, all three are named, worst first',
  allThree.spoken.startsWith('A geomagnetic storm at G5, a radio blackout at R3 and a solar radiation storm at S2 are running now.'),
  allThree.spoken);
const odds = advise('airline', sky({ days: [{ date: '2026-09-15', g: 0, rMinorProb: 5, rMajorProb: 1, sProb: 30 }] }), null);
check('a 30 percent chance of a radiation storm is a watch, and the number is spoken', odds.phase === 'watch' && says(odds, /30 percent/),
  odds.spoken);
check('...and the United flight from May 2024 is the worked example', odds.actions.some((x) => /UAL 990/.test(x.say)));

console.log('\nHF radio is driven by flares, which only come with odds');
const hfLikely = advise('hf_radio', sky({ days: [{ date: '2026-09-15', g: 0, rMinorProb: 40, rMajorProb: 5, sProb: 1 }] }), null);
check('40 percent chance of a blackout is a watch that says 40 percent', hfLikely.phase === 'watch' && says(hfLikely, /40 percent/),
  hfLikely.spoken);
const hfUnlikely = advise('hf_radio', sky({ days: [{ date: '2026-09-15', g: 0, rMinorProb: PREPARE_AT_PERCENT - 15, rMajorProb: 1, sProb: 1 }] }), null);
check('a low chance stays quiet', hfUnlikely.phase === 'quiet', hfUnlikely.phase);
const hfNow = advise('hf_radio', sky({ levels: { g: 0, s: 0, r: 2 } }), null);
check('an R2 running now says tens of minutes', hfNow.phase === 'during' && says(hfNow, /tens of minutes/), hfNow.spoken);

console.log('\nOrdinary people get answers too');
const auroraSoon = advise('aurora', g3Soon, null);
check('a G3 on the way names NOAA\'s own places for aurora', says(auroraSoon, /Illinois and Oregon/), auroraSoon.spoken);
check('G5 reaches Florida', says(advise('aurora', sky({ levels: { g: 5, s: 0, r: 0 } }), null), /Florida/));
const homeG3 = advise('household', sky({ levels: { g: 3, s: 0, r: 0 } }), null);
check('a household is not alarmed by a G3', homeG3.phase === 'quiet' && says(homeG3, /do not damage phones/), homeG3.spoken);
const homeG5 = advise('household', sky({ levels: { g: 5, s: 0, r: 0 } }), null);
check('...and is told to charge phones at G5', says(homeG5, /charging phones/i), homeG5.spoken);
/*
 * A household hearing "grids can collapse" and nothing else would be right to
 * panic, and wrong to. It has happened once, in Quebec in 1989, and the G5 of
 * May 2024 passed over North America with the lights on, which NERC's own event
 * review says plainly. Every mention of the grid to a non-operator carries that.
 */
check('...with what has actually happened, not just what the scale allows',
  says(homeG5, /Quebec in 1989/) && says(homeG5, /May 2024/), homeG5.spoken);
check('...and never as a prediction about their own street',
  says(homeG5, /not a prediction about your street/), homeG5.spoken);

console.log('\nVoice rules: at most three steps at a time, and a way to hear the rest');
const long = advise('satellite_operator', sky({ levels: { g: 3, s: 2, r: 0 } }), null);
check('never more than three steps read aloud', long.spokenSteps <= 3, String(long.spokenSteps));
check('...and it offers the rest instead of dropping them', long.actions.length > 3 ? /ask me for the rest/.test(long.spoken) && long.nextStep === 3 : true,
  `${long.actions.length} steps, next ${long.nextStep}`);
const rest = advise('satellite_operator', sky({ levels: { g: 3, s: 2, r: 0 } }), null, long.nextStep ?? 3);
check('asking for the rest skips the opening and reads what is left', !rest.spoken.startsWith(long.situation) && rest.spokenSteps > 0,
  rest.spoken);
check('asking past the end says so plainly', /everything I have/.test(advise('satellite_operator', sky({ levels: { g: 3, s: 2, r: 0 } }), null, 99).spoken));
let screenTalk = false;
for (const role of ROLES) for (const s of [sky(), g3Soon, sky({ levels: { g: 5, s: 3, r: 3 } })]) {
  if (/screen|display|tap |see below/i.test(advise(role, s, null).spoken)) screenTalk = true;
}
check('no spoken answer refers to a screen, which a screenless Echo does not have', !screenTalk);

console.log('\nEvery step says where it comes from');
let unsourced = [];
for (const [role, pb] of Object.entries(PLAYBOOKS)) {
  pb.actions.forEach((a, i) => {
    if (!a.sources.length || !a.sources.every((s) => /^https:\/\//.test(s.url) && s.name.length > 5)) unsourced.push(`${role}#${i}`);
  });
  if (pb.note && !pb.note.sources.every((s) => /^https:\/\//.test(s.url))) unsourced.push(`${role} note`);
}
check('every action and note carries an https source', unsourced.length === 0, unsourced.join(', '));
check('no em dashes in anything spoken or sourced',
  !/[\u2013\u2014]/.test(JSON.stringify(PLAYBOOKS, (k, v) => (typeof v === 'function' ? v({ expected: { g: 3, s: 0, r: 0 } }) : v))));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
