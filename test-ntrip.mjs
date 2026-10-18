// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.ORBITA_SCOPE ??= 'all';
/**
 * Where the corrections actually come from.
 *
 * `baselineKm` multiplies the measured ionospheric gradient, so it is the number
 * that decides whether a job is clear or blocked. This module exists to stop it
 * being a guess, and the test that matters most is about restraint rather than
 * capability: when the customer has told us their baseline, this must say nothing.
 *
 * The first version did not. It compared their number against the nearest public
 * stream and offered a correction when theirs looked optimistic, which would have
 * told a farmer with a base station on a grain bin 18 km away that they were
 * wrong. They are not wrong; a private base is an ordinary thing to own. That
 * branch is gone and this pins its absence.
 *
 * Nothing here reaches the caster; the sourcetable is seeded.
 */
let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const ntrip = await import('./dist/ntrip.js');

/** A sourcetable in the caster's real format, including lines that must be skipped. */
const SAMPLE = [
  'CAS;rtk2go.com;2101;RTK2go;SNIP;0;USA;40.0;-100.0;0.0.0.0;0;http://rtk2go.com',
  'NET;SNIP;SNIP;B;N;none;none;none;none',
  'STR;BargInput;Bremen, Kansas;RTCM 3.2;1005(1), 1077(1);2;GPS+GLO+GAL+BeiDou;SNIP;USA;39.80;-96.62;1;0;SNIP;none;B;N;5200;',
  'STR;BrandtFarms;Titonka, Iowa;RTCM 3.2;1005(1), 1074(1);2;GPS+GLO;SNIP;USA;43.15;-94.05;1;0;SNIP;none;N;N;4800;',
  'STR;OpenOne;Somewhere Open;RTCM 3.3;1005(1);2;GPS;SNIP;USA;41.00;-98.00;1;0;SNIP;none;N;N;5000;',
  // Must be dropped: no position.
  'STR;NoPos;Broken;RTCM 3.2;1005(1);2;GPS;SNIP;USA;;;1;0;SNIP;none;N;N;100;',
  // Must be dropped: exactly 0,0 is "not reported", not the Gulf of Guinea.
  'STR;ZeroZero;Null Island;RTCM 3.2;1005(1);2;GPS;SNIP;XXX;0;0;1;0;SNIP;none;N;N;100;',
  // Must be dropped: impossible latitude.
  'STR;Impossible;Bad;RTCM 3.2;1005(1);2;GPS;SNIP;XXX;991;-96;1;0;SNIP;none;N;N;100;',
  // Must be dropped: too few fields to carry a position.
  'STR;Truncated;Short;RTCM 3.2',
].join('\r\n');

console.log('\nThe sourcetable parser keeps only records with a real position');
{
  const st = ntrip.parseSourcetable(SAMPLE);
  const names = st.map((s) => s.mountpoint);
  check('three usable stations', st.length === 3, names.join(','));
  check('CAS and NET records are not streams', !names.includes('rtk2go.com'));
  check('a station with no coordinates is dropped', !names.includes('NoPos'));
  check('0,0 is treated as unreported, not as Null Island', !names.includes('ZeroZero'));
  check('an impossible latitude is dropped', !names.includes('Impossible'));
  check('a truncated line is dropped', !names.includes('Truncated'));

  const barg = st.find((s) => s.mountpoint === 'BargInput');
  check('the human name is kept', barg.name === 'Bremen, Kansas', barg.name);
  check('the position is parsed', barg.lat === 39.8 && barg.lon === -96.62, `${barg.lat},${barg.lon}`);
  check('the RTCM format is kept', barg.format === 'RTCM 3.2', barg.format);
  check('the constellations are kept', barg.systems.includes('GAL'), barg.systems);
  check('an auth flag of B means not open', barg.open === false);
  check('an auth flag of N means open', st.find((s) => s.mountpoint === 'OpenOne').open === true);
}

console.log('\nNearest is by great circle distance, and bounded');
{
  ntrip.resetForTest();
  ntrip.seedForTest({ stations: ntrip.parseSourcetable(SAMPLE) });

  // A Nebraska field: OpenOne at 41.00,-98.00 is closest.
  const n = ntrip.nearest(40.92, -98.34);
  check('it finds the closest station', n.mountpoint ?? n.station.mountpoint === 'OpenOne', JSON.stringify(n.station.mountpoint));
  check('the distance is plausible', n.km > 10 && n.km < 60, String(n.km));
  check('it counts the alternatives within range', n.alternatives >= 1, String(n.alternatives));

  // Mid Pacific: nothing within the useful radius.
  check('nothing useful means null, not the least bad option', ntrip.nearest(0, -150) === null);
  check(`the bound is ${ntrip.limits.MAX_USEFUL_KM} km`, ntrip.limits.MAX_USEFUL_KM === 500);
}

console.log('\nWhen the customer has told us their baseline, it says nothing');
{
  ntrip.resetForTest();
  ntrip.seedForTest({ stations: ntrip.parseSourcetable(SAMPLE) });

  // This is the regression that matters. A private base 18 km away, against a
  // nearest public stream far further, must not be second-guessed.
  check('a stored 18 km baseline is believed', ntrip.explain(40.92, -98.34, 18) === '',
    ntrip.explain(40.92, -98.34, 18));
  check('a stored 2 km baseline is believed', ntrip.explain(40.92, -98.34, 2) === '');
  check('even a stored 200 km baseline is believed', ntrip.explain(40.92, -98.34, 200) === '');
  check('and a stored 0 is still a statement, not an absence', ntrip.explain(40.92, -98.34, 0) === '');
}

console.log('\nWhen nobody has said, it offers the network as the floor');
{
  ntrip.resetForTest();
  ntrip.seedForTest({ stations: ntrip.parseSourcetable(SAMPLE) });
  const said = ntrip.explain(40.92, -98.34, undefined);
  check('it speaks', said.length > 0);
  check('it names the station', said.includes('Somewhere Open') || said.includes('Bremen'), said.slice(0, 90));
  check('it gives a distance', /\d+ km/.test(said));
  check('it counts the alternatives', said.includes('other stations inside 500 km'));
  check('it allows that they may have their own base', said.includes('own base station'));
  check('and explains why the distance matters', said.includes('same at both ends'));

  // Beyond the network entirely: still useful, differently.
  const far = ntrip.explain(0, -150, undefined);
  check('a site with no stream nearby is told so', far.includes('no public correction stream'), far.slice(0, 80));
}

console.log('\nAn auth-required stream is flagged, because it is not just a distance');
{
  ntrip.resetForTest();
  ntrip.seedForTest({ stations: ntrip.parseSourcetable(SAMPLE).filter((s) => s.mountpoint === 'BargInput') });
  check('a closed stream says credentials are needed',
    ntrip.explain(39.9, -96.7, undefined).includes('needs credentials'), ntrip.explain(39.9, -96.7, undefined).slice(0, 120));

  ntrip.resetForTest();
  ntrip.seedForTest({ stations: ntrip.parseSourcetable(SAMPLE).filter((s) => s.mountpoint === 'OpenOne') });
  check('an open stream does not', !ntrip.explain(41.1, -98.1, undefined).includes('needs credentials'));
}

console.log('\nNo directory means silence, and a failure keeps the last one');
{
  ntrip.resetForTest();
  check('no stations means no nearest', ntrip.nearest(40.92, -98.34) === null);
  check('and nothing is said, even with no baseline', ntrip.explain(40.92, -98.34, undefined) === '');

  ntrip.seedForTest({ stations: ntrip.parseSourcetable(SAMPLE) });
  const before = ntrip.status().stations;
  ntrip.seedForTest({ load: async () => { throw new Error('caster down'); } });
  await ntrip.refresh();
  check('the directory survives a failed refresh', ntrip.status().stations === before, String(ntrip.status().stations));
  check('and the failure is visible to an operator', String(ntrip.status().error).includes('caster down'));

  ntrip.seedForTest({ load: async () => [] });
  await ntrip.refresh();
  check('an empty sourcetable is recorded rather than adopted',
    ntrip.status().stations === before && String(ntrip.status().error).includes('no usable stations'),
    JSON.stringify(ntrip.status()));
}

console.log('\nMore than one network, as each country has its own');
{
  const lyon = { mountpoint: 'VILLEUR', name: 'Villeurbanne', country: 'FRA', lat: 45.77, lon: 4.88, format: 'RTCM3', systems: 'GPS', open: false, fee: false, network: 'Centipede', signup: 'a free Centipede login' };
  const paid = { mountpoint: 'WAGG', name: 'Wagga Wagga', country: 'AUS', lat: -35.11, lon: 147.36, format: 'RTCM 3.3', systems: 'GPS', open: false, fee: true, network: 'Geoscience Australia', signup: 'free registration with Geoscience Australia' };
  ntrip.seedForTest({ stations: [lyon, paid] });
  const fr = ntrip.explain(45.76, 4.84, undefined);
  check('a field near Lyon is told its nearest base on the network that runs it, and what it takes', /Villeurbanne, on the Centipede network, about \d+ km/.test(fr) && /needs a free Centipede login/.test(fr), fr);
  const au = ntrip.explain(-35.12, 147.37, undefined);
  check('a stream marked as charged for is said as charged for, not as free', /charged for, through Geoscience Australia/.test(au), au);
  let calls = 0;
  ntrip.resetForTest();
  ntrip.seedForTest({ load: async () => { calls += 1; return [lyon]; } });
  await ntrip.refresh();
  check('the merged directories load as one list', calls === 1 && ntrip.status().stations === 1);
}

ntrip.resetForTest();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
