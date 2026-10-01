/**
 * Ground truth, and the distance at which it stops being truth.
 *
 * Everything else in Orbita forecasts. This module measures, and a measurement
 * carries an implied claim about where it applies. The tests that matter most
 * here are the ones that prove it refuses to make that claim too widely: a
 * magnetometer in Japan must say nothing about a field in Punjab, however
 * disturbed Japan is, because the alternative is a confident wrong answer
 * dressed up as evidence.
 *
 * Nothing here touches the network. Every window is synthesised.
 */
import { mkdirSync, rmSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

mkdirSync('./data', { recursive: true });
rmSync('./data/test-geomag.json', { force: true });
process.env.ORBITA_DATA = './data/test-geomag.json';

const geomag = await import('./dist/geomag.js');

/**
 * A window of H, in nanotesla, at one sample a minute.
 *
 * `drift` is added linearly across the whole window, so it shows up as a
 * depression without producing a large minute-to-minute step. `jolt` is a single
 * step near the end, which is what a substorm onset looks like to this.
 */
const window = ({ baseline = 20600, minutes = 180, drift = 0, jolt = 0 } = {}) => {
  const start = Date.now() - minutes * 60_000;
  const out = [];
  for (let i = 0; i < minutes; i += 1) {
    let h = baseline + (drift * i) / minutes;
    if (jolt && i === minutes - 5) h += jolt;
    if (jolt && i > minutes - 5) h += jolt;
    out.push({ at: new Date(start + i * 60_000).toISOString(), h });
  }
  return out;
};

const seed = (id, samples) => {
  geomag.resetForTest();
  geomag.seedForTest({ readings: [{ id, samples }] });
};

// Sites used throughout. Grand Island is 589 km from Boulder, inside the local
// limit; Winnipeg is 1258 km from it, inside the regional one; Punjab is 5886 km
// from Kakioka, outside both.
const GRAND_ISLAND = [40.92, -98.34];
const WINNIPEG = [49.9, -97.1];
const PUNJAB = [30.9, 75.8];

console.log('\nThe observatory list is only observatories that actually serve data');
{
  const ids = geomag.observatories().map((o) => o.id);
  check('the Canadian partner observatories are not in the list', !ids.includes('OTT') && !ids.includes('BRD'),
    ids.join(','));
  check('Hartland, which also answers 422, is not in the list', !ids.includes('HAD'));
  check('the duplicate College record is gone', !ids.includes('CMT'));
  check('Boulder and Tucson are', ids.includes('BOU') && ids.includes('TUC'));
}

console.log('\nNearest observatory is chosen by ground distance');
{
  const near = geomag.nearest(...GRAND_ISLAND);
  check('a Nebraska field routes to Boulder', near.observatory.id === 'BOU', near.observatory.id);
  check('and the distance is reported, not hidden', near.km > 500 && near.km < 700, String(near.km));

  const phoenix = geomag.nearest(33.45, -112.07);
  check('Phoenix routes to Tucson, not Boulder', phoenix.observatory.id === 'TUC', phoenix.observatory.id);
}

console.log('\nA quiet window reads as quiet');
{
  seed('BOU', window({ drift: -5 }));
  const r = geomag.reading(...GRAND_ISLAND);
  check('a reading comes back', r !== null);
  check('level is quiet', r?.level === 'quiet', r?.level);
  check('the rate is small', (r?.rate ?? 99) < 1, String(r?.rate));
  check('it says nothing against a calm forecast', geomag.corroboration(...GRAND_ISLAND, 2) === '');
  check('and nothing against a storm forecast except "not here yet"',
    geomag.corroboration(...GRAND_ISLAND, 6).includes('not felt it yet'));
}

console.log('\nA depressed window reads as disturbed, and corroborates a storm');
{
  seed('BOU', window({ drift: -140 }));
  const r = geomag.reading(...GRAND_ISLAND);
  check('H is depressed by roughly the drift', r.deltaH < -100 && r.deltaH > -160, String(r.deltaH));
  check('level is strong', r.level === 'strong', r.level);
  const said = geomag.corroboration(...GRAND_ISLAND, 6);
  check('it confirms the storm is over this longitude', said.includes('Confirmed on the ground'), said);
  check('and it names the observatory and the distance', said.includes('Boulder') && said.includes('km'));
}

console.log('\nA fast jolt is caught even when the depression is shallow');
{
  seed('BOU', window({ drift: -10, jolt: -45 }));
  const r = geomag.reading(...GRAND_ISLAND);
  check('the rate picks up the step', r.rate >= 20, String(r.rate));
  check('level is strong on rate alone', r.level === 'strong', `${r.level} dH=${r.deltaH}`);
  const said = geomag.corroboration(...GRAND_ISLAND, 2);
  check('a calm forecast plus a violent ground reading is worth saying',
    said.includes('forecast is calm but the ground is not'), said);
}

console.log('\nDistance is a hard limit, and this is the part that must not regress');
{
  // Kakioka having a genuinely bad day says nothing about a field in Punjab.
  seed('KAK', window({ drift: -300, jolt: -90 }));
  const r = geomag.reading(...PUNJAB);
  check('a reading exists at 5886 km', r !== null);
  check('and it is genuinely disturbed', r.level === 'strong', r.level);
  check('but corroboration is silent, against a storm forecast', geomag.corroboration(...PUNJAB, 6) === '');
  check('and silent against a calm one', geomag.corroboration(...PUNJAB, 2) === '');
}

console.log('\nBetween the two limits, only the slow regional part may speak');
{
  seed('BOU', window({ drift: -10, jolt: -60 }));
  const said = geomag.corroboration(...WINNIPEG, 6);
  check('a violent rate 1258 km away does not get quoted as local', !said.includes('nanotesla a minute'), said);

  seed('BOU', window({ drift: -150 }));
  const regional = geomag.corroboration(...WINNIPEG, 6);
  check('but a deep ring current depression does, labelled regional',
    regional.includes('regional rather than local'), regional);
  check('and it says plainly it is not a measurement of their field',
    regional.includes('without being a measurement of your own field'), regional);
}

console.log('\nStale and missing data produce silence, never an all clear');
{
  geomag.resetForTest();
  check('an unwatched site has no reading', geomag.reading(...GRAND_ISLAND) === null);
  check('and says nothing, even under a storm forecast', geomag.corroboration(...GRAND_ISLAND, 6) === '');

  seed('BOU', window({ minutes: 40 }));
  check('a window too short to hold a baseline is refused', geomag.reading(...GRAND_ISLAND) === null);
}

console.log('\nA failing fetch keeps the last good reading rather than inventing one');
{
  geomag.resetForTest();
  geomag.seedForTest({ fetch: async () => { throw new Error('USGS down'); } });
  geomag.watch(...GRAND_ISLAND);
  await geomag.refresh();
  check('no reading is manufactured from a failure', geomag.reading(...GRAND_ISLAND) === null);
  check('and the site still answers, silently', geomag.corroboration(...GRAND_ISLAND, 6) === '');
}

geomag.resetForTest();
rmSync('./data/test-geomag.json', { force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
