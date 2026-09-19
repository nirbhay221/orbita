/**
 * The extra half hour of warning.
 *
 * NOAA measures the solar wind at L1, about 1.5 million kilometres upstream, so
 * what the spacecraft sees reaches Earth later. That gap is the whole feature,
 * and the arithmetic behind it has to be right: a wrong travel time is a wrong
 * promise about how long someone has.
 *
 * Nothing here touches the network. The feeds are seeded.
 */
import { mkdirSync, rmSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

mkdirSync('./data', { recursive: true });
rmSync('./data/test-solarwind.json', { force: true });
process.env.ORBITA_DATA = './data/test-solarwind.json';

const solarwind = await import('./dist/solarwind.js');
const swpc = await import('./dist/swpc.js');
const { registerTools } = await import('./dist/tools.js');

const tools = {};
registerTools({ registerTool: (name, _cfg, handler) => { tools[name] = handler; } }, () => 'wind-test');
const text = (r) => r.content[0].text;

const seedWind = (bzNt, speedKms = 500, kp = 3.3, ageMs = 0) =>
  solarwind.seedForTest({
    wind: { speedKms, bzNt, btNt: Math.abs(bzNt) + 2, at: new Date().toISOString() },
    kp: { kp, at: new Date().toISOString() },
    fetchedAt: Date.now() - ageMs,
  });

/** A quiet sky in three hour blocks, so the forecast disagrees with the minute. */
const seedForecast = (kp = 2) => {
  const t0 = Date.now() - 3600e3;
  swpc.seedForTest({
    fetchedAt: new Date().toISOString(),
    slots: Array.from({ length: 24 }, (_, i) => ({ time: new Date(t0 + i * 3 * 3600e3).toISOString(), kp, observed: i === 0 })),
    alerts: [],
    scales: { g: 0, s: 0, r: 0, yesterday: { g: 0, s: 0, r: 0 }, days: [] },
    stale: false,
  });
};

console.log('\nHow long what the satellite sees takes to arrive');
check('slow wind, 300 km/s, is about 83 minutes away', solarwind.travelMinutes(300) === 83, String(solarwind.travelMinutes(300)));
check('average wind, 500 km/s, is 50 minutes', solarwind.travelMinutes(500) === 50, String(solarwind.travelMinutes(500)));
check('fast wind, 800 km/s, is about half an hour', solarwind.travelMinutes(800) === 31, String(solarwind.travelMinutes(800)));
check('a nonsense speed does not produce a nonsense promise', solarwind.travelMinutes(0) === 60);

console.log('\nWhat is worth interrupting someone for');
seedWind(-1);
check('a northward or flat field says nothing at all', solarwind.incoming().level === 'quiet' && solarwind.incoming().say === '');
seedWind(-6);
check('a field leaning south is a watch, not an alarm', solarwind.incoming().level === 'watch', solarwind.incoming().level);
check('...and says it is not a storm yet', /Not a storm yet/.test(solarwind.incoming().say), solarwind.incoming().say);
seedWind(-14, 700);
const likely = solarwind.incoming();
check('a strongly southward field is called likely', likely.level === 'likely', likely.level);
check('...and says how many minutes are left', /about 36 minutes/.test(likely.say), likely.say);
check('...and never promises a storm', /can still turn back north/.test(likely.say), likely.say);
check('...and gives the number a person can check', /14 nanotesla south at 700 kilometres a second/.test(likely.say), likely.say);

console.log('\nOld readings are not current readings');
seedWind(-14, 700, 3.3, 25 * 60 * 1000);
check('a reading half an hour old is not offered as now', solarwind.wind() === null && solarwind.incoming() === null);
check('...and the estimated Kp goes with it', solarwind.estimatedKp() === null);

console.log('\nOne definition of right now');
seedForecast(2);
seedWind(-1, 500, 4.7);
await tools.register_field({ name: 'North 40', lat: 42.03, lon: -93.62, baselineKm: 18 });
await tools.register_equipment({ name: 'the planter', correction: 'rtk' });
const status = text(await tools.storm_status({}));
check('the status uses the minute estimate, and says so', /Kp is 4\.7 right now, estimated a minute ago/.test(status), status);
const run = text(await tools.can_i_run({ operation: 'planting', field: 'north' }));
check('the go or no go uses the same number, not the three hour block', /Kp 4\.7/.test(run), run);
const later = text(await tools.can_i_run({ operation: 'planting', field: 'north', when: new Date(Date.now() + 6 * 3600e3).toISOString() }));
check('a question about later still uses the forecast', /Kp 2\.0/.test(later), later);
const logged = text(await tools.log_job({ operation: 'planting', field: 'north', acres: 12 }));
check('a job logged right now is written down at that same number', /Kp was 4\.7/.test(logged), logged);
const past = text(await tools.log_job({ operation: 'planting', field: 'north', acres: 12, when: 'yesterday' }));
check('...while yesterday is written down at the block that covered yesterday', !/Kp was 4\.7/.test(past), past);

console.log('\nA clear answer that is about to stop being clear');
seedWind(-15, 600, 2);
const warned = text(await tools.can_i_run({ operation: 'planting', field: 'north' }));
check('a go with a storm inbound says to watch it', /Watch this one though/.test(warned), warned);
check('...and still gives the verdict first', /^Clear for planting/.test(warned), warned.slice(0, 40));
seedWind(-1, 600, 2);
check('a go with a quiet sky says nothing extra', !/Watch this one though/.test(text(await tools.can_i_run({ operation: 'planting', field: 'north' }))));

console.log('\nWhen the feed is not there at all');
solarwind.seedForTest({ wind: null, kp: null, fetchedAt: Date.now() });
const fallback = text(await tools.storm_status({}));
check('it falls back to the three hour forecast rather than going silent', /Kp is 2\.0 right now\./.test(fallback), fallback);
check('...and does not claim a minute old estimate it does not have', !/estimated a minute ago/.test(fallback));

rmSync('./data/test-solarwind.json', { force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
