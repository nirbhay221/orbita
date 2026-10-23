/**
 * Bugs found by reading the code against what the services it calls really send, each tested as fixed.
 * No network: every service answer here is a copy of a real one, cut down.
 *
 *   1. A town with a state abbreviation ("Ames, IA", "Fargo ND") was found in the wrong country or not at all.
 */
let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const geo = await import('./dist/geocode.js');

console.log('\nA town and its state, as a farmer says them');
{
  // What the geocoder gave for "Ames" worldwide, in its own order.
  const ames = [
    { name: 'Ames', admin1: 'Galicia', country: 'Spain', country_code: 'ES', latitude: 42.9, longitude: -8.66 },
    { name: 'Ames', admin1: 'Iowa', country: 'United States', country_code: 'US', latitude: 42.03, longitude: -93.62 },
  ];
  check('"Ames, IA" is Ames, Iowa, not Ames in Galicia', geo.pick('Ames, IA', ames)?.region === 'Iowa');
  check('"Ames, Iowa" still is', geo.pick('Ames, Iowa', ames)?.region === 'Iowa');
  check('"Germany" is DE, not the retired East German code that shares its name', geo.narrowing('Germany').country === 'DE');
  const wagga = [{ name: 'Wagga Wagga', admin1: 'Western Australia', country_code: 'AU', latitude: -28.33, longitude: 116.94 }, { name: 'Wagga Wagga', admin1: 'New South Wales', country_code: 'AU', latitude: -35.13, longitude: 147.35, population: 57000 }];
  check('"Wagga Wagga, Australia" is the city in New South Wales, not the first locality the lookup lists', geo.pick('Wagga Wagga, Australia', wagga)?.region === 'New South Wales');
  // Town, region, country: everything after the first comma was read as one name and matched nothing.
  const sorriso = [{ name: 'Sorriso', admin1: 'Lombardy', country: 'Italy', country_code: 'IT', latitude: 45.6, longitude: 9.9 }, { name: 'Sorriso', admin1: 'Mato Grosso', country: 'Brazil', country_code: 'BR', latitude: -12.55, longitude: -55.71 }];
  check('"Sorriso, Mato Grosso, Brazil" is found, in Brazil', geo.pick('Sorriso, Mato Grosso, Brazil', sorriso)?.region === 'Mato Grosso');
  check('"Saskatoon, Saskatchewan, Canada" is read by its province', geo.narrowing('Saskatchewan, Canada').region === 'Saskatchewan');
  check('"Ludhiana, Punjab, India" narrows to India and looks for Punjab', geo.narrowing('Punjab, India').country === 'IN' && geo.narrowing('Punjab, India').said === 'Punjab');
  const fargo = [
    { name: 'Fargo', admin1: 'Indiana', country: 'United States', country_code: 'US', latitude: 38.4, longitude: -86.48 },
    { name: 'Fargo', admin1: 'North Dakota', country: 'United States', country_code: 'US', latitude: 46.88, longitude: -96.79 },
  ];
  check('"Fargo, ND" is North Dakota, not Indiana (which has "nd" in it)', geo.pick('Fargo, ND', fargo)?.region === 'North Dakota');
  check('a province said short: "Regina, SK"', geo.pick('Regina, SK', [{ name: 'Regina', admin1: 'Saskatchewan', country: 'Canada', country_code: 'CA', latitude: 50.45, longitude: -104.62 }])?.region === 'Saskatchewan');
  const london = [
    { name: 'London', admin1: 'England', country: 'United Kingdom', country_code: 'GB', latitude: 51.51, longitude: -0.13 },
    { name: 'London', admin1: 'Ontario', country: 'Canada', country_code: 'CA', latitude: 42.98, longitude: -81.25 },
  ];
  check('"London, UK" is found', geo.pick('London, UK', london)?.countryCode === 'GB');
  // The geocoder gives Puerto Rico a code and no country name.
  const sanJuan = [{ name: 'San Juan', admin1: 'San Juan', country_code: 'PR', latitude: 18.47, longitude: -66.11 }];
  check('"San Juan, Puerto Rico" is found, and named', geo.pick('San Juan, Puerto Rico', sanJuan)?.country === 'Puerto Rico');
  check('a region nothing matches is still not answered elsewhere', geo.pick('Ames, Texas', ames) === null);
  check('"France" is FR, not the FX code that also reads "France"', geo.narrowing('France').country === 'FR');
  check('a region not in the tables still matches by whole word', geo.pick('Ludhiana, Punjab', [{ name: 'Ludhiana', admin1: 'Punjab', country: 'India', country_code: 'IN', latitude: 30.9, longitude: 75.85 }])?.region === 'Punjab');

  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => { asked.push(String(url)); return new Response(JSON.stringify({ results: fargo })); };
  await geo.geocode('Fargo ND');
  check('"Fargo ND" is searched within the United States', asked.some((u) => u.includes('countryCode=US')), asked.join(' '));
  globalThis.fetch = async () => { throw new Error('timeout'); };
  let down = false;
  try { await geo.geocode('Ames, IA'); } catch (err) { down = err instanceof geo.GeocoderDown; }
  check('a geocoder that does not answer is "down", not "no such town"', down);
  globalThis.fetch = async () => new Response(JSON.stringify({}));
  check('a town the geocoder does not know is still null', (await geo.geocode('Xyzzyville, IA')) === null);

  // And the farmer is told which it was.
  globalThis.fetch = async () => { throw new Error('timeout'); };
  process.env.ORBITA_DATA = './data/test-hunt/farms.json';
  process.env.ORBITA_OUTBOX = './data/test-hunt/outbox.jsonl';
  process.env.ORBITA_AUTH_DATA = './data/test-hunt/auth.json';
  const { registerTools } = await import('./dist/tools.js');
  const t = {};
  registerTools({ registerTool: (name, _cfg, handler) => { t[name] = handler; } }, () => 'acct:hunt');
  const r = await t.register_field({ name: 'North 40', place: 'Ames, IA' });
  check('adding a field while the lookup is down says so, and asks again', /can't reach the map service/.test(r.content[0].text) && r.structuredContent.reason === 'lookup_down', r.content[0].text);
  globalThis.fetch = realFetch;

  console.log('\nGuessing a share code from the sandbox');
  const { requestCaller } = await import('./dist/caller.js');
  const { randomBytes } = await import('node:crypto');
  let who = '';
  const s = {};
  registerTools({ registerTool: (name, _cfg, handler) => { s[name] = handler; } }, () => who);
  const answers = [];
  for (let i = 0; i < 7; i++) {
    who = `demo:${randomBytes(16).toString('hex')}`;
    answers.push(await requestCaller.run('ip:203.0.113.9', () => s.share_access({ action: 'join', code: String(10_000_000 + i) })));
  }
  check('a new sandbox id for every guess does not buy new guesses', answers.slice(5).every((a) => a.structuredContent.reason === 'limit'), answers.map((a) => a.structuredContent.reason).join(','));
  who = `demo:${randomBytes(16).toString('hex')}`;
  const elsewhere = await requestCaller.run('ip:198.51.100.4', () => s.share_access({ action: 'join', code: '12345678' }));
  check('...while somebody at another address still gets theirs', elsewhere.structuredContent.reason !== 'limit', elsewhere.structuredContent.reason);
  (await import('node:fs')).rmSync('./data/test-hunt', { recursive: true, force: true });
}

console.log('\nNOAA, when one of its three files does not answer');
{
  const swpc = await import('./dist/swpc.js');
  const realFetch = globalThis.fetch;
  const now = Date.now();
  const kp = Array.from({ length: 8 }, (_, i) => ({ time_tag: new Date(now - 3600e3 + i * 3 * 3600e3).toISOString().slice(0, 19), kp: i === 1 ? 7.33 : 2, observed: i === 0 ? 'observed' : 'predicted' }));
  const scales = { '-1': { G: { Scale: '0' } }, 0: { G: { Scale: '0' }, S: { Scale: '0' }, R: { Scale: '0' } }, 1: { DateStamp: '2026-10-18', G: { Scale: '3' }, R: {}, S: {} } };
  globalThis.fetch = async (url) => /alerts\.json/.test(url) ? new Response('', { status: 504 }) : new Response(JSON.stringify(/k-index/.test(url) ? kp : scales));
  const snap = await swpc.refresh();
  check('a new Kp forecast is kept when only the alerts file failed', !snap.stale && snap.slots.length === 8 && snap.slots[1].kp === 7.33, JSON.stringify({ stale: snap.stale, n: snap.slots.length }));
  check('...and the scales still came through', snap.scales.days[0]?.g === 3);
  globalThis.fetch = async (url) => new Response(JSON.stringify(/k-index/.test(url) ? [] : /alerts/.test(url) ? [] : scales));
  const after = await swpc.refresh();
  check('an empty forecast file does not replace the last good one', after.slots.length === 8 && after.stale, JSON.stringify({ stale: after.stale, n: after.slots.length }));
  globalThis.fetch = realFetch;
}

console.log('\nOnly a state or a province, as somebody running a control room says it');
{
  // What the geocoder gave for "Minnesota": places with that name, none of them the state, the first in Georgia.
  const minnesota = [
    { name: 'Minnesota', admin1: 'Georgia', country: 'United States', country_code: 'US', latitude: 31.31, longitude: -83.91 },
    { name: 'Minnesota Lake', admin1: 'Minnesota', country: 'United States', country_code: 'US', latitude: 43.84, longitude: -93.83, population: 662 },
  ];
  const mn = geo.regionOnly('Minnesota', minnesota);
  check('"Minnesota" is the middle of Minnesota, not the hamlet in Georgia', mn && mn.lat > 45 && mn.lat < 48 && mn.lon < -92 && mn.countryCode === 'US', JSON.stringify(mn));
  check('...and is said as that', mn?.name === 'central Minnesota' && geo.spoken(mn) === 'central Minnesota, United States', mn && geo.spoken(mn));
  check('"Saskatchewan" is the middle of the province', geo.regionOnly('Saskatchewan', [])?.countryCode === 'CA');
  check('"near Iowa" is read the same way', geo.regionOnly('near Iowa', [])?.name === 'central Iowa');
  const ny = [{ name: 'New York', admin1: 'New York', country: 'United States', country_code: 'US', latitude: 40.71, longitude: -74.01, population: 8_804_190 }];
  check('"New York" stays the city people mean by it', geo.regionOnly('New York', ny)?.lat === 40.71);
  check('a town with its state is not touched', geo.regionOnly('Fargo, North Dakota', []) === null);
  check('a town that is not a state is not touched', geo.regionOnly('Grand Island', []) === null);
  check('two letters alone are not read as a state', geo.regionOnly('MN', []) === null);
}

console.log('\nA whole address, as written on an envelope');
{
  const s = (q) => geo.simplify(q);
  check('the street and the zip are taken off', s('3130 W Stolley Park Rd, Grand Island, Nebraska 68801, USA').query === 'Grand Island, Nebraska, USA');
  check('...and the zip is kept to fall back on', s('3130 W Stolley Park Rd, Grand Island, Nebraska 68801, USA').postal === '68801');
  check('a zip after the state', s('Grand Island, NE 68801').query === 'Grand Island, NE');
  check('a street that starts with its word, abroad', s('Avenida Blumenau 1000, Sorriso, Mato Grosso, Brazil').query === 'Sorriso, Mato Grosso, Brazil');
  check('"St. Paul" is a town, not a street', s('St. Paul, Minnesota').query === 'St. Paul, Minnesota');
  check('an Indian PIN code', s('Ludhiana, Punjab 141001, India').query === 'Ludhiana, Punjab, India' && s('Ludhiana, Punjab 141001, India').postal === '141001');
  check('a zip on its own is the place', s('68801').query === '' && s('68801').postal === '68801');
  check('a town alone is left alone', s('Fargo, North Dakota').query === 'Fargo, North Dakota' && s('Fargo, North Dakota').postal === null);
}

console.log('\nField and machine names as speech recognition writes them');
{
  const store = await import('./dist/store.js');
  const farm = { fields: [{ id: 'f2', name: 'Lot 12', lat: 0, lon: 0 }, { id: 'f5', name: 'Lot 1', lat: 0, lon: 0 }, { id: 'f1', name: 'North 40', lat: 0, lon: 0 }, { id: 'f4', name: 'Section 21', lat: 0, lon: 0 }], equipment: [{ id: 'e2', name: 'John Deere 8R', correction: 'rtk' }, { id: 'e1', name: 'planter', correction: 'rtk' }, { id: 'e4', name: 'planter 2', correction: 'sbas' }] };
  const field = (q) => store.findField(farm, q)?.name ?? null;
  const machine = (q) => store.equipmentNamed(farm, q)?.name ?? null;
  check('"north forty" is North 40', field('north forty') === 'North 40', field('north forty'));
  check('"North40" is North 40', field('North40') === 'North 40', field('North40'));
  check('"lot twelve" is Lot 12', field('lot twelve') === 'Lot 12', field('lot twelve'));
  check('"section twenty-one" is Section 21', field('section twenty-one') === 'Section 21', field('section twenty-one'));
  check('"lot 1" is Lot 1, not Lot 12', field('lot 1') === 'Lot 1', field('lot 1'));
  check('"the Deere" is the John Deere 8R', machine('the Deere') === 'John Deere 8R', machine('the Deere'));
  check('"planter number two" is planter 2', machine('planter number two') === 'planter 2', machine('planter number two'));
  check('"planters" is the planter', machine('planters') === 'planter', machine('planters'));
  check('a machine never named is not found', machine('tractor') === null, machine('tractor'));
}

console.log('\nTimes said the way people say them');
{
  const { parseWhen } = await import('./dist/history.js');
  const now = new Date('2026-10-23T02:00:00Z'); // Thursday 22 October 2026, 9 PM in Nebraska
  const tz = 'America/Chicago';
  const at = (q, prefer = 'future', country = 'US', zone = tz) => {
    const d = parseWhen(q, now, { prefer, timeZone: zone, country });
    return d ? d.toLocaleString('en-US', { timeZone: zone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  };
  check('"in two hours"', at('in two hours') === 'Oct 22, 2026, 11:00 PM', at('in two hours'));
  check('"in half an hour"', at('in half an hour') === 'Oct 22, 2026, 9:30 PM', at('in half an hour'));
  check('"three hours ago"', at('three hours ago', 'past') === 'Oct 22, 2026, 6:00 PM', at('three hours ago', 'past'));
  check('"3 o\'clock tomorrow" keeps the hour, in the afternoon', at("3 o'clock tomorrow") === 'Oct 23, 2026, 3:00 PM', at("3 o'clock tomorrow"));
  check('"half past three tomorrow"', at('half past three tomorrow') === 'Oct 23, 2026, 3:30 PM', at('half past three tomorrow'));
  check('"quarter to ten tomorrow"', at('quarter to ten tomorrow') === 'Oct 23, 2026, 9:45 AM', at('quarter to ten tomorrow'));
  check('"yesterday at 3" is the afternoon', at('yesterday at 3', 'past') === 'Oct 21, 2026, 3:00 PM', at('yesterday at 3', 'past'));
  check('"nine o\'clock tonight" is the evening', at("9 o'clock tonight") === 'Oct 22, 2026, 9:00 PM', at("9 o'clock tonight"));
  check('"tomorrow at 03:00" is a 24 hour clock', at('tomorrow at 03:00') === 'Oct 23, 2026, 3:00 AM', at('tomorrow at 03:00'));
  check('"at 3 o\'clock" alone is the next one', at("at 3 o'clock") === 'Oct 23, 2026, 3:00 PM', at("at 3 o'clock"));
  check('"midnight" is the coming one', at('midnight') === 'Oct 23, 2026, 12:00 AM', at('midnight'));
  check('"this weekend" is Saturday', /^Oct 24, 2026/.test(at('this weekend') ?? ''), at('this weekend'));
  check('"10/05/2024" from the United States is 5 October', /^Oct 5, 2024/.test(at('10/05/2024', 'past') ?? ''), at('10/05/2024', 'past'));
  check('"10/05/2024" from India is 10 May', /^May 10, 2024/.test(at('10/05/2024', 'past', 'IN', 'Asia/Kolkata') ?? ''), at('10/05/2024', 'past', 'IN', 'Asia/Kolkata'));
  check('"10.05.2024" is 10 May anywhere', /^May 10, 2024/.test(at('10.05.2024', 'past') ?? ''), at('10.05.2024', 'past'));
  check('"25/12/2025" settles itself', /^Dec 25, 2025/.test(at('25/12/2025', 'past') ?? ''), at('25/12/2025', 'past'));
  check('what worked before still does: "May 10th 2024 at 7pm"', at('May 10th 2024 at 7pm', 'past') === 'May 10, 2024, 7:00 PM', at('May 10th 2024 at 7pm', 'past'));
  check('...and "tomorrow morning"', at('tomorrow morning') === 'Oct 23, 2026, 8:00 AM', at('tomorrow morning'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
