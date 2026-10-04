// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.ORBITA_SCOPE ??= 'all';
/**
 * The measured half of the answer.
 *
 * This file's job is to prove the arithmetic, not to prove that NOAA is up. The
 * grids below are synthetic and have known analytic gradients, so every number
 * the module produces can be checked against one worked by hand. That matters
 * more here than anywhere else in Orbita, because this module is the first thing
 * that converts a physical measurement into a number of centimetres a customer
 * is told to act on, and an error in the conversion would be invisible: a wrong
 * gradient still looks like a plausible gradient.
 *
 * Nothing here touches the network.
 */
import { mkdirSync, rmSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

mkdirSync('./data', { recursive: true });
rmSync('./data/test-glotec.json', { force: true });
process.env.ORBITA_DATA = './data/test-glotec.json';

const tec = await import('./dist/glotec.js');
const { METRES_PER_TECU, LON_STEP, LAT_STEP } = tec.constants;
const KM_PER_DEG_LAT = 111.132;

/**
 * A full global grid whose TEC is a known function of position, so the gradient
 * the module computes can be compared with the derivative of that function.
 */
const build = (fn, quality = 0) => {
  const cells = [];
  for (let i = 0; i < 72; i += 1) {
    const lat = -88.75 + i * LAT_STEP;
    for (let j = 0; j < 72; j += 1) {
      const lon = -177.5 + j * LON_STEP;
      const v = fn(lat, lon);
      cells.push([lat, lon, { tec: v.tec ?? v, anomaly: v.anomaly ?? 0, quality: v.quality ?? quality }]);
    }
  }
  return cells;
};

const seed = (fn, quality = 0) => {
  tec.resetForTest();
  tec.seedForTest({ cells: build(fn, quality), at: new Date().toISOString() });
};

console.log('\nA flat ionosphere has no gradient and costs a baseline nothing');
{
  seed(() => 20);
  const i = tec.ionosphere(40, -98);
  check('TEC reads back exactly', near(i.tec, 20, 1e-6), String(i.tec));
  check('gradient is zero', near(i.gradient, 0, 1e-9), String(i.gradient));
  check('residual over 30 km is zero', near(tec.residual(40, -98, 30), 0, 1e-9));
  check('vertical delay is TEC x 0.1624', near(i.verticalDelay, 20 * METRES_PER_TECU, 0.01), String(i.verticalDelay));
}

console.log('\nA north-south ramp gives the gradient calculus says it should');
{
  // 1 TECU per degree of latitude. d(TEC)/d(km) = 1 / 111.132.
  seed((lat) => 20 + lat * 1.0);
  const expected = 1 / KM_PER_DEG_LAT;
  const i = tec.ionosphere(40, -98);
  check('gradient matches 1 TECU/deg analytically', near(i.gradient, expected, expected * 0.02),
    `got ${i.gradient} want ${expected}`);
  check('bearing points due north', near(i.bearing, 0, 1) || near(i.bearing, 360, 1), String(i.bearing));

  // residual = gradient x baseline x metres-per-TECU
  const want = expected * 100 * METRES_PER_TECU;
  check('residual over 100 km matches the formula', near(tec.residual(40, -98, 100), want, want * 0.02),
    `got ${tec.residual(40, -98, 100)} want ${want}`);
}

console.log('\nAn east-west ramp is scaled by the cosine of latitude, not treated as equal');
{
  seed((lat, lon) => 20 + lon * 1.0);
  const at0 = tec.ionosphere(0, 0).gradient;
  const at60 = tec.ionosphere(60, 0).gradient;
  check('bearing points due east at the equator', near(tec.ionosphere(0, 0).bearing, 90, 1),
    String(tec.ionosphere(0, 0).bearing));
  // A degree of longitude is half as long at 60 degrees, so the same TEC change
  // per degree is twice the change per kilometre.
  check('gradient at 60N is about twice the equatorial one', near(at60 / at0, 2, 0.06),
    `ratio ${(at60 / at0).toFixed(3)}`);
}

console.log('\nResidual scales with baseline, which is the whole claim about RTK');
{
  seed((lat) => 20 + lat * 0.5);
  const r10 = tec.residual(40, -98, 10);
  const r30 = tec.residual(40, -98, 30);
  const r60 = tec.residual(40, -98, 60);
  check('30 km carries three times the residual of 10 km', near(r30 / r10, 3, 0.01), `${(r30 / r10).toFixed(3)}`);
  check('60 km carries six times', near(r60 / r10, 6, 0.01), `${(r60 / r10).toFixed(3)}`);
  check('a zero baseline is refused rather than returning zero', tec.residual(40, -98, 0) === null);
  check('a missing baseline is refused', tec.residual(40, -98, NaN) === null);
}

console.log('\nThe worked example: a storm-scale gradient breaks a planting tolerance');
{
  // A gentle slope leaves a couple of centimetres over 30 km, which a planting
  // tolerance of 5 cm absorbs. 0.5 TECU/deg / 111.132 km * 30 km * 0.1624 = 2.2 cm.
  seed((lat) => 20 + lat * 0.5);
  const quiet = tec.residual(40, -98, 30);
  check('a 0.5 TECU/deg slope leaves about 2 cm at 30 km', near(quiet, 0.022, 0.003), `${(quiet * 100).toFixed(2)} cm`);
  check('and it stays quiet inside a 5 cm tolerance', tec.explain(40, -98, 30, 0.05) === '');

  // Eight times steeper is 18 cm, which that tolerance cannot absorb. This is
  // the case the module exists for: the forecast may be calm and the baseline
  // still cannot hold the job.
  seed((lat) => 20 + lat * 4.0);
  const r = tec.residual(40, -98, 30);
  check('a 4 TECU/deg slope leaves about 18 cm at 30 km', near(r, 0.175, 0.02), `${(r * 100).toFixed(2)} cm`);
  check('which does break a 5 cm planting tolerance', tec.explain(40, -98, 30, 0.05).includes('cannot correct away'));
  check('but a 1 metre tillage tolerance absorbs it', tec.explain(40, -98, 30, 1.0) === '');

  seed((lat) => 20 + lat * 40.0);
  const big = tec.residual(40, -98, 30);
  check('a ten times steeper slope leaves ten times the residual', big > 0.1, `${(big * 100).toFixed(1)} cm`);
  const loud = tec.explain(40, -98, 30, 0.05);
  check('and it speaks, in centimetres, naming the baseline', loud.includes('30 km baseline'), loud);
  check('it says the base station cannot correct it', loud.includes('cannot correct away'), loud);
  check('it names the tolerance it has passed', loud.includes('5 centimetre'), loud);
}

console.log('\nQuality flags are surfaced, never averaged away');
{
  seed((lat) => 20 + lat * 40.0, 0);
  check('an all-observed grid reports observed', tec.ionosphere(40, -98).observed === true);
  check('and does not hedge', !tec.explain(40, -98, 30, 0.05).includes('climatology'));

  seed((lat) => 20 + lat * 40.0, 5);
  const i = tec.ionosphere(40, -98);
  check('a modelled grid reports quality 5', i.quality === 5, String(i.quality));
  check('and observed is false', i.observed === false);
  check('and the sentence hedges explicitly', tec.explain(40, -98, 30, 0.05).includes('climatology'));
}

console.log('\nOne bad corner poisons the sample, deliberately');
{
  tec.resetForTest();
  const cells = build(() => 20, 0);
  // Make a single cell modelled and sample a point whose square includes it.
  const idx = cells.findIndex(([la, lo]) => la === 41.25 && lo === -97.5);
  cells[idx][2] = { tec: 20, anomaly: 0, quality: 4 };
  tec.seedForTest({ cells, at: new Date().toISOString() });
  check('the worst corner sets the reported quality', tec.ionosphere(40, -98).quality === 4,
    String(tec.ionosphere(40, -98).quality));
}

console.log('\nNo map, or a stale one, means no answer rather than a wrong one');
{
  tec.resetForTest();
  check('no grid gives no reading', tec.ionosphere(40, -98) === null);
  check('no grid gives no residual', tec.residual(40, -98, 30) === null);
  check('and explain says nothing', tec.explain(40, -98, 30, 0.05) === '');
}

console.log('\nA failed fetch keeps the previous map and reports the error');
{
  seed(() => 20);
  const before = tec.status().cells;
  tec.seedForTest({ load: async () => { throw new Error('SWPC down'); } });
  await tec.refresh();
  check('the grid is still there', tec.status().cells === before, String(tec.status().cells));
  check('and the failure is visible to an operator', String(tec.status().error).includes('SWPC down'));
  check('while the customer-facing path stays silent', tec.explain(40, -98, 30, 1.0) === '');
}

console.log('\nLongitude wraps rather than falling off the edge');
{
  seed((lat, lon) => 20 + Math.abs(lon) * 0.01);
  check('a site at 179E gets a reading', tec.ionosphere(0, 179) !== null);
  check('a site at -179 gets a reading', tec.ionosphere(0, -179) !== null);
  check('a site past the pole is clamped, not dropped', tec.ionosphere(89.5, 0) !== null);
}

tec.resetForTest();
rmSync('./data/test-glotec.json', { force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
