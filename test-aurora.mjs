// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.ORBITA_SCOPE ??= 'all';
/**
 * The oval, and the case the straight line gets wrong.
 *
 * `auroralBoundaryDeg` is a line: 66.5 degrees at Kp 0, two degrees equatorward
 * per Kp step, the same all the way round the Earth. The oval is not the same
 * all the way round. It is pulled towards the night side, so two sites at
 * identical geomagnetic latitude sit differently inside it depending on local
 * time.
 *
 * The test that matters here is therefore not "does it read the feed" but "does
 * it speak when the model and the line disagree, and stay quiet when they do
 * not". A module that fires on every high-latitude field would be noise.
 *
 * Nothing here touches the network.
 */
let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const a = await import('./dist/aurora.js');
const { OVERHEAD, STRONG } = a.thresholds;

/** A band of aurora between two latitudes, at every longitude. */
const band = (from, to, probability) => {
  const cells = [];
  for (let lon = 0; lon < 360; lon += 1) {
    for (let lat = -90; lat <= 90; lat += 1) {
      cells.push([lon, lat, lat >= from && lat <= to ? probability : 0]);
    }
  }
  return cells;
};

/** The same band, but only over one half of the world: the night side. */
const halfBand = (from, to, probability, lonFrom, lonTo) => {
  const cells = [];
  for (let lon = 0; lon < 360; lon += 1) {
    for (let lat = -90; lat <= 90; lat += 1) {
      const inLon = lon >= lonFrom && lon <= lonTo;
      cells.push([lon, lat, inLon && lat >= from && lat <= to ? probability : 0]);
    }
  }
  return cells;
};

const seed = (cells) => { a.resetForTest(); a.seedForTest({ cells, forecast: '2026-09-30T00:09:00Z' }); };

console.log('\nA site inside the band reads as overhead');
{
  seed(band(60, 75, 30));
  const r = a.aurora(65, -100);
  check('probability comes back', r?.probability === 30, JSON.stringify(r));
  check('overhead is true', r?.overhead === true);
  check('distance to the oval is zero', r?.distanceDeg === 0);
}

console.log('\nA site below the band is not overhead, but knows how far it is');
{
  seed(band(60, 75, 30));
  const r = a.aurora(58, -100);
  check('probability is zero at the site', r?.probability === 0);
  check('overhead is false', r?.overhead === false);
  check('the edge is two degrees away', r?.distanceDeg === 2, String(r?.distanceDeg));
  check('and the nearby peak is the band value', r?.nearby === 30, String(r?.nearby));
}

console.log('\nFar from the oval it says nothing at all');
{
  seed(band(60, 75, 30));
  const r = a.aurora(30, -100);
  check('no probability', r?.probability === 0);
  check('no distance within five degrees', r?.distanceDeg === null);
  check('and explain is silent', a.explain(30, -100, 30) === '');
}

console.log('\nThe disagreement case: the Kp line says clear, the model says overhead');
{
  seed(band(40, 75, 10));
  // boundaryMargin positive means the linear rule puts the site clear of the oval.
  const said = a.explain(45, -100, 8);
  check('it speaks when the line and the model disagree', said.includes('aurora model has precipitation over you'), said);
  check('it quotes the margin the rule claimed', said.includes('8 degrees clear'), said);
  check('and explains why the line is wrong', said.includes('offset towards the'), said);

  // When the line already agrees the site is inside, there is nothing to add.
  check('it stays quiet when the rule already says inside', a.explain(45, -100, -5) === '');
}

console.log('\nStrong precipitation overhead outranks the disagreement wording');
{
  seed(band(40, 75, 45));
  const said = a.explain(45, -100, 8);
  check('it leads with the model being on top of the field', said.includes('directly over you'), said);
  check('it names the percentage', said.includes('45 percent'), said);
  check('and the forecast time', said.includes('00:09'), said);
}

console.log('\nAn oval just poleward and running hot is a warning, not a verdict');
{
  seed(band(50, 75, 40));
  const said = a.explain(48, -100, 5);
  check('it reports the edge is close', said.includes('poleward of you'), said);
  check('and says a substorm can bring it down inside the hour', said.includes('inside the hour'), said);
}

console.log('\nThe night-side offset: same latitude, different longitude, different answer');
{
  // The oval covers 60-75 only between longitudes 180 and 300.
  seed(halfBand(60, 75, 35, 180, 300));
  const night = a.aurora(65, 240 - 360); // inside the covered longitudes
  const day = a.aurora(65, 20);          // same latitude, outside them
  check('the night-side site is overhead', night?.overhead === true, JSON.stringify(night));
  check('the day-side site at the same latitude is not', day?.overhead === false, JSON.stringify(day));
  check('which is the thing a latitude-only rule cannot express', night.probability !== day.probability);
}

console.log('\nLongitude wraps and latitude clamps');
{
  seed(band(60, 75, 30));
  check('a site at 179E resolves', a.aurora(65, 179) !== null);
  check('a site at -179 resolves', a.aurora(65, -179) !== null);
  check('the pole resolves rather than falling off', a.aurora(90, 0) !== null);
}

console.log('\nNo feed means the linear rule keeps the answer, silently');
{
  a.resetForTest();
  check('no grid gives no reading', a.aurora(65, -100) === null);
  check('and explain says nothing', a.explain(65, -100, 5) === '');

  a.seedForTest({ load: async () => { throw new Error('ovation down'); } });
  await a.refresh();
  check('a failed fetch is visible to an operator', String(a.status().error).includes('ovation down'));
  check('while the customer path stays silent', a.explain(65, -100, 5) === '');
}

a.resetForTest();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
