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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
