/**
 * The rest of the NOAA catalogue.
 *
 * Six independent feeds behind one timer. The behaviour worth pinning down is
 * not any single parser but the rule that binds them: one feed failing must not
 * take the other five with it, and an empty advisory list is a quiet day rather
 * than a fault. Both are easy to get wrong in a way that looks fine until the
 * afternoon it matters.
 *
 * The Ap to Kp conversion is checked against the published table, because every
 * day of the 45 day outlook passes through it and a wrong curve there would
 * quietly mis-plan a season.
 *
 * Nothing here touches the network.
 */
let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const p = await import('./dist/swpcplus.js');

console.log('\nAp converts to Kp on the published table');
{
  // Pairs straight out of the standard conversion.
  const pairs = [[0, 0], [4, 1], [7, 2], [15, 3], [27, 4], [48, 5], [80, 6], [132, 7], [207, 8], [400, 9]];
  for (const [ap, kp] of pairs) {
    check(`ap ${ap} -> kp ${kp}`, Math.abs(p.apToKp(ap) - kp) < 0.01, String(p.apToKp(ap)));
  }
  check('it interpolates between table rows', p.apToKp(10) > 2.33 && p.apToKp(10) < 2.67, String(p.apToKp(10)));
  check('above the table it saturates at 9', p.apToKp(9999) === 9);
  check('nonsense gives 0 rather than NaN', p.apToKp(NaN) === 0 && p.apToKp(-5) === 0);
}

console.log('\nStale state answers null, not a stale number');
{
  p.resetForTest();
  check('no Dst before any fetch', p.dst() === null);
  check('no predicted Kp', p.predictedKp() === null);
  check('no flare risk', p.flareRisk() === null);
  check('outlook is empty', p.outlook().length === 0);
  check('advisories are empty', p.advisories().length === 0);
  check('nextQuietRun has nothing to offer', p.nextQuietRun() === null);
}

console.log('\nDst and the local ground are read together, which is the point');
{
  p.resetForTest();
  p.seedForTest({ dst: { now: -80, low: -95, trend: -1, at: 'x' } });
  const said = p.whereIsIt('quiet');
  check('a deep Dst with quiet ground says it has not arrived', said.includes('not reached your longitude'), said);

  p.seedForTest({ dst: { now: -5, low: -8, trend: 0, at: 'x' } });
  const local = p.whereIsIt('strong');
  check('a calm Dst with violent ground says substorm, not storm', local.includes('substorm overhead'), local);

  p.seedForTest({ dst: { now: -90, low: -90, trend: -12, at: 'x' } });
  check('a still-falling Dst says it has not bottomed out', p.whereIsIt('disturbed').includes('not bottomed out'));

  p.seedForTest({ dst: { now: -3, low: -5, trend: 0, at: 'x' } });
  check('a quiet sky and quiet ground says nothing at all', p.whereIsIt('quiet') === '');
  check('and no local reading means no claim', p.whereIsIt(null) === '');
}

console.log('\nThe 45 day outlook finds a run long enough to plan around');
{
  const day = (n, kp) => ({
    date: new Date(Date.now() + n * 864e5).toISOString().slice(0, 10),
    ap: 5, kp, f107: 95,
  });
  // Three quiet, one rough, then eight quiet. The answer should be the eight.
  p.resetForTest();
  p.seedForTest({ outlook: [day(0, 2), day(1, 2), day(2, 2), day(3, 6), ...Array.from({ length: 8 }, (_, i) => day(4 + i, 2))] });
  const run = p.nextQuietRun(5, 4);
  check('a five day minimum skips the three day run', run !== null && run.days === 8, JSON.stringify(run));
  check('and it starts the day after the rough one', run?.from === day(4, 2).date, JSON.stringify(run));

  p.resetForTest();
  p.seedForTest({ outlook: Array.from({ length: 10 }, (_, i) => day(i, 6)) });
  check('an all-rough outlook offers nothing', p.nextQuietRun(5, 4) === null);

  p.resetForTest();
  p.seedForTest({ outlook: [day(-5, 2), day(-4, 2), day(-3, 2), day(-2, 2), day(-1, 2)] });
  check('past days are not offered as a plan', p.nextQuietRun(5, 4) === null);
}

console.log('\nFlare probabilities speak only when they are worth acting on');
{
  p.resetForTest();
  p.seedForTest({ flares: { date: 'x', cClass: 40, mClass: 10, xClass: 1, protons: 1 } });
  check('an ordinary day is silent', p.flareSentence() === '', p.flareSentence());

  p.seedForTest({ flares: { date: 'x', cClass: 80, mClass: 55, xClass: 5, protons: 5 } });
  check('a likely M class is mentioned as HF fadeouts', p.flareSentence().includes('M class'), p.flareSentence());

  p.seedForTest({ flares: { date: 'x', cClass: 95, mClass: 75, xClass: 25, protons: 20 } });
  const big = p.flareSentence();
  check('an X class risk names both percentages', big.includes('25 percent') && big.includes('20 percent'), big);
  check('and says it arrives without warning', big.includes('no warning'), big);
}

console.log('\nOne feed failing must not take the other five with it');
{
  p.resetForTest();
  p.seedForTest({
    dst: { now: -40, low: -44, trend: -2, at: 'x' },
    flares: { date: 'x', cClass: 10, mClass: 1, xClass: 1, protons: 1 },
    outlook: [{ date: '2099-01-01', ap: 5, kp: 1.33, f107: 95 }],
    advisories: [],
    errors: ['electrons: boom'],
  });
  check('Dst survives a sibling failure', p.dst()?.now === -40);
  check('flares survive', p.flareRisk()?.cClass === 10);
  check('outlook survives', p.outlook().length === 1);
  check('and the failure is visible to an operator', JSON.stringify(p.status()).includes('electrons: boom'));
}

console.log('\nAn empty advisory list is a quiet day, not a missing feed');
{
  p.resetForTest();
  p.seedForTest({ advisories: [] });
  check('no advisories reads as zero, not as unknown', p.advisories().length === 0);
  p.seedForTest({ advisories: [{ kind: 'GNSS' }] });
  check('and a real advisory comes through', p.advisories().length === 1);
}

console.log('\nA modelled CME arrival, and the sheath that would hide it');
{
  p.resetForTest();
  const h = (hours) => new Date(Date.now() + hours * 3.6e6).toISOString().slice(0, 19);
  p.seedForTest({ cme: { arrives: h(58), hours: 58, peakSpeed: 422, peakDensity: 15.7, ambientSpeed: 330 } });
  const said = p.cmeSentence();
  check('a real arrival is announced in days, with a day name',
    /in about 2 days, (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/.test(said), said);
  check('it never renders a date as "02th"', !/\d\dth/.test(said), said);
  check('it names both speeds', said.includes('422') && said.includes('330'), said);
  check('and it hedges, because Enlil misses', said.includes('rather than cancelling on'), said);

  // Regression guard for the bug that silenced a live arrival: the compressed
  // sheath ahead of the cloud read 408 km/s where true ambient was 330, turning
  // a 92 km/s jump into 14 and producing no sentence at all. The estimator in
  // parseEnlil is what prevents this; this asserts the consequence is real.
  p.seedForTest({ cme: { arrives: h(58), hours: 58, peakSpeed: 422, peakDensity: 15.7, ambientSpeed: 408 } });
  check('a sheath-inflated ambient is exactly what silences it', p.cmeSentence() === '', p.cmeSentence());

  p.seedForTest({ cme: { arrives: h(10), hours: 10, peakSpeed: 700, peakDensity: 30, ambientSpeed: 350 } });
  check('inside 36 hours it speaks in hours', p.cmeSentence().includes('in about 10 hours'), p.cmeSentence());

  p.seedForTest({ cme: { arrives: h(-4), hours: -4, peakSpeed: 700, peakDensity: 30, ambientSpeed: 350 } });
  check('one already passed is not announced as coming', p.cmeSentence() === '');

  p.seedForTest({ cme: { arrives: h(50), hours: 50, peakSpeed: 360, peakDensity: 8, ambientSpeed: 340 } });
  check('a cloud barely faster than the wind stays quiet', p.cmeSentence() === '', p.cmeSentence());

  p.resetForTest();
  check('no CME means no sentence', p.cmeSentence() === '');
}

p.resetForTest();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
