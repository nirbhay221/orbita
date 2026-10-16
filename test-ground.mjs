/**
 * The roles answered from what is measured where they are, not only from the storm level.
 *
 * what_should_i_do used to give a grid room in Fargo and one in Dallas the same sentences. It now reads NOAA's
 * modelled ground electric field and HF absorption map for the place they name, and the nearest magnetometer, and
 * says what those show. What matters here is as much when it stays quiet as when it speaks: a few millivolts on a
 * calm day, or the ordinary daytime absorption at the bottom of the band, read aloud is noise.
 *
 * The maps are built here in NOAA's own formats, so nothing touches the network.
 */
import { mkdirSync, rmSync } from 'node:fs';

const DIR = './data/test-ground';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.ORBITA_DATA = `${DIR}/farms.json`;
delete process.env.ORBITA_DATA_KEY;
delete process.env.ORBITA_SCOPE;

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';

const ground = await import('./dist/ground.js');
const geomag = await import('./dist/geomag.js');
const swpc = await import('./dist/swpc.js');
const swpcplus = await import('./dist/swpcplus.js');
const solarwind = await import('./dist/solarwind.js');
const store = await import('./dist/store.js');
const geo = await import('./dist/geocode.js');
const { registerTools } = await import('./dist/tools.js');
const { configureForTest: fakeZones } = await import('./dist/timezone.js');
fakeZones(async () => 'America/Chicago');

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

/** NOAA's D-RAP text layout: a header, a row of longitudes, then "lat | values". */
function drapText(valueAt, { xray = 'Normal X-ray Background', recovery = 'No Estimate' } = {}) {
  const lons = [];
  for (let lon = -178; lon <= 178; lon += 4) lons.push(lon);
  const rows = [];
  for (let lat = 89; lat >= -89; lat -= 2) rows.push(`${String(lat).padStart(3)} | ${lons.map((lon) => valueAt(lat, lon).toFixed(1).padStart(4)).join(' ')}`);
  return [
    '# DRAP Tabular Values',
    '# Product Valid At : 2026-10-16 01:02 UTC',
    '#',
    `# Estimated Recovery Time : ${recovery}`,
    '#',
    `#  X-RAY Message : ${xray}`,
    '#',
    '#  Proton Message : Normal Proton Background',
    '#',
    '# Frequency (MHz) as a function of Latitude and Longitude',
    '#',
    `     ${lons.map((l) => String(l).padStart(4)).join(' ')}`,
    '-'.repeat(200),
    ...rows,
  ].join('\n');
}

/** NOAA's geoelectric GeoJSON: half degree points, Ex and Ey in mV/km. */
function efieldJson(mvAt, west = -125, east = -65) {
  const features = [];
  for (let lon = west; lon <= east; lon += 0.5) {
    for (let lat = 25; lat <= 60; lat += 0.5) {
      const mv = mvAt(lat, lon);
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { Ex: mv * 0.6, Ey: -mv * 0.8, quality_flag: 5 } });
    }
  }
  return { time_tag: '2026-10-16', type: 'FeatureCollection', features };
}

const FARGO = { lat: 46.88, lon: -96.79 };
const DALLAS = { lat: 32.78, lon: -96.8 };
const LEEDS = { lat: 53.8, lon: -1.55 };

console.log('\nReading the maps');
{
  ground.resetForTest();
  check('nothing loaded is no reading, not a zero', ground.efield(FARGO.lat, FARGO.lon) === null && ground.absorption(FARGO.lat, FARGO.lon) === null);
  ground.seedForTest({ drapText: drapText((lat) => (lat > 40 ? 12 : 0), { xray: 'X-ray Event in progress', recovery: '45 minutes' }), oneD: efieldJson((lat) => (lat > 45 ? 1500 : 5)) });
  const a = ground.absorption(FARGO.lat, FARGO.lon);
  check('absorption is read at the right cell', a && a.mhz === 12, JSON.stringify(a));
  check('...with NOAA\'s recovery estimate', a && a.recovery === '45 minutes');
  check('...and "No Estimate" is not passed on as an estimate', ground.parseDrap(drapText(() => 0)).recovery === null);
  const e = ground.efield(FARGO.lat, FARGO.lon);
  check('the field is the size of Ex and Ey together', e && Math.abs(e.mvPerKm - 1500) < 1, JSON.stringify(e));
  check('...from the 1D model when there is no 3D one', e && e.model === '1D');
  check('Dallas, on the same map, reads its own ground', Math.round(ground.efield(DALLAS.lat, DALLAS.lon).mvPerKm) === 5);
  check('Leeds is off the map, so there is no reading rather than the nearest edge', ground.efield(LEEDS.lat, LEEDS.lon) === null);
  check('a longitude past 180 finds its cell', ground.absorption(50, 182) !== null && ground.absorption(50, 182).mhz === 12);

  ground.seedForTest({ threeD: efieldJson(() => 300, -100, -90) });
  const e3 = ground.efield(FARGO.lat, FARGO.lon);
  check('the 3D model is used where it covers, as NOAA recommends', e3.model === '3D empirical' && Math.round(e3.mvPerKm) === 300, JSON.stringify(e3));
  check('...and the 1D one outside it', ground.efield(45.5, -120).model === '1D');

  const names = ground.newestFiles('<a href="20261016T005830-15-Efield-US-Canada.json"> <a href="20261016T005930-15-Efield-US-Canada.json"> <a href="20261016T005930-15-Efield-empirical-EMTF-2022.12-0.5x0.5.json">');
  check('the newest file of each model is the one read', names.oneD === '20261016T005930-15-Efield-US-Canada.json' && /EMTF/.test(names.threeD));
  check('a damaged map is not a map', ground.parseEfield({ features: [] }) === null && ground.parseDrap('garbage') === null);
}

console.log('\nWhat is said');
{
  const say = ground.sayEfield({ mvPerKm: 1500, model: '1D', km: 10, worst: 1500, at: '' });
  check('a field over a volt is said in volts', /1\.5 volts per kilometre/.test(say), say);
  check('...next to NERC\'s benchmark, and NOAA\'s caution', /8 volts per kilometre/.test(say) && /caution/.test(say));
  check('a small one is said in millivolts', /7 millivolts/.test(ground.sayEfield({ mvPerKm: 7.2, model: '1D', km: 1, worst: 7, at: '' })));
  const hf = ground.sayAbsorption({ mhz: 12, worst: { mhz: 12, lat: 41, lon: -98 }, recovery: '45 minutes', xray: 'X-ray Event', protons: 'Normal' });
  check('absorption over the station names the frequency to work above', /up to 12 megahertz/.test(hf) && /45 minutes/.test(hf), hf);
  check('the ordinary daytime absorption at the bottom of the band is not read out',
    ground.sayAbsorption({ mhz: 1.1, worst: { mhz: 4.1, lat: 3, lon: 162 }, recovery: null, xray: 'Normal X-ray Background', protons: 'Normal Proton Background' }) === '');
  const elsewhere = ground.sayAbsorption({ mhz: 0, worst: { mhz: 20, lat: -11, lon: 30 }, recovery: null, xray: 'X-ray Event in progress', protons: 'Normal' });
  check('during a flare, a station on the night side hears where it is bad', /Nothing is being absorbed over you/.test(elsewhere) && /11 degrees south/.test(elsewhere), elsewhere);
}

console.log('\nThrough the tool');
async function connect(id) {
  const server = new McpServer({ name: 't', version: '1' }, { capabilities: { tools: {}, resources: {}, tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } }, taskStore: new InMemoryTaskStore(), taskMessageQueue: new InMemoryTaskMessageQueue() });
  registerTools(server, () => id);
  const client = new Client({ name: 'c', version: '1' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return async (args) => {
    const r = await client.callTool({ name: 'what_should_i_do', arguments: args });
    return { said: (r.content ?? []).map((c) => c.text ?? '').join(' '), data: r.structuredContent ?? {} };
  };
}
const HOUR = 3_600_000;
const sky = (kp, g) => {
  const start = Math.floor(Date.now() / (3 * HOUR)) * 3 * HOUR;
  const slots = [];
  for (let i = -8; i < 24; i += 1) slots.push({ time: new Date(start + i * 3 * HOUR).toISOString(), kp, observed: i < 0 });
  swpc.seedForTest({ fetchedAt: new Date().toISOString(), slots, alerts: [], scales: { g, s: 0, r: 0, yesterday: { g, s: 0, r: 0 }, days: [] }, stale: false });
  solarwind.seedForTest({ wind: null, kp: null });
};
const places = { 'Fargo, North Dakota': { name: 'Fargo', region: 'North Dakota', country: 'United States', lat: FARGO.lat, lon: FARGO.lon }, 'Denver, Colorado': { name: 'Denver', region: 'Colorado', country: 'United States', lat: 39.74, lon: -104.99 }, 'Leeds': { name: 'Leeds', region: 'England', country: 'United Kingdom', lat: LEEDS.lat, lon: LEEDS.lon } };
geo.configureForTest(async (q) => places[q] ?? null);
{
  ground.resetForTest();
  ground.seedForTest({ drapText: drapText(() => 0), oneD: efieldJson(() => 6) });
  sky(2, 0);
  const ask = await connect('acct:grid');
  const calm = await ask({ role: 'grid_operator', place: 'Fargo, North Dakota' });
  check('a calm day: the grid room hears the quiet line, not a few millivolts', !/millivolts/.test(calm.said), calm.said);
  check('...though the reading is in the data', calm.data.measuredHere?.geoelectric?.mvPerKm > 0, JSON.stringify(calm.data.measuredHere));
  check('...and the place is remembered', store.get('acct:grid').rolePlace?.name === 'Fargo, North Dakota' && calm.data.place === 'Fargo, North Dakota', JSON.stringify(store.get('acct:grid').rolePlace));

  ground.seedForTest({ oneD: efieldJson((lat) => (lat > 45 ? 1800 : 20)) });
  sky(7.3, 3);
  const storm = await ask({ role: 'grid_operator' });
  check('a storm: the same room, no place repeated, hears its own ground', /1\.8 volts per kilometre/.test(storm.said), storm.said);
  check('...after the advice, not instead of it', storm.said.indexOf('volts') > storm.said.indexOf('G3'), storm.said);
  const pipe = await ask({ role: 'pipeline' });
  check('a pipeline at the same place hears the same field', /1\.8 volts/.test(pipe.said), pipe.said);
  const rest = await ask({ role: 'grid_operator', step: 3 });
  check('asking for the rest does not read the reading again', !/volts per kilometre/.test(rest.said), rest.said);

  const leeds = await connect('acct:leeds');
  const uk = await leeds({ role: 'grid_operator', place: 'Leeds' });
  check('off the map, nothing is made up', !/volts|millivolts/.test(uk.said) && !uk.data.measuredHere?.geoelectric, uk.said);
  const lost = await leeds({ role: 'grid_operator', place: 'Atlantis' });
  check('a place that cannot be found is said back, not answered for somewhere else', /could not find Atlantis/.test(lost.said) && store.get('acct:leeds').rolePlace?.name === 'Leeds, England', lost.said);

  ground.seedForTest({ drapText: drapText((lat) => (lat > 40 ? 14 : 0), { xray: 'X-ray Event in progress', recovery: '1 hour' }) });
  swpcplus.seedForTest({ flares: { date: '2026-10-16', cClass: 99, mClass: 60, xClass: 20, protons: 5 } });
  const radio = await connect('acct:radio');
  const hf = await radio({ role: 'hf_radio', place: 'Fargo, North Dakota' });
  check('an HF station hears which frequencies are dead over it', /up to 14 megahertz/.test(hf.said) && /1 hour/.test(hf.said), hf.said);
  check('...and tomorrow\'s flare odds', /20 percent chance of an X class flare/.test(hf.said), hf.said);
  sky(2, 0);
  const calmAir = await radio({ role: 'airline' });
  check('a dispatcher on a quiet day is not told about flare odds after "nothing calls for HF contingencies"', !/X class flare/.test(calmAir.said) && calmAir.data.measuredHere?.flareRisk, calmAir.said);
  sky(7.3, 3);
  const field = await radio({ role: 'field_crew' });
  check('a field crew is not told about HF', !/megahertz/.test(field.said), field.said);

  geomag.resetForTest();
  const start = Date.now() - 180 * 60_000;
  const samples = [];
  for (let i = 0; i < 180; i += 1) samples.push({ at: new Date(start + i * 60_000).toISOString(), h: 20600 - (i > 170 ? 60 : 0) });
  geomag.seedForTest({ readings: [{ id: 'BOU', samples }] });
  const survey = await connect('acct:survey');
  const mag = await survey({ role: 'magnetic_survey', place: 'Denver, Colorado' });
  check('a magnetic survey near Boulder hears that magnetometer, by name and distance', /nearest magnetometer, Boulder, \d+ km away/.test(mag.said) && /nanotesla in a minute/.test(mag.said), mag.said);
  const far = await survey({ role: 'magnetic_survey', place: 'Fargo, North Dakota' });
  check('...and one in Fargo, 1,000 km from it, is not handed Boulder as its own', !/magnetometer/.test(far.said), far.said);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
