// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.ORBITA_SCOPE ??= 'all';
/**
 * Fitting jobs into the clear hours, and counting the hours the sky took before.
 *
 * schedule_jobs and outage_patterns were added beside the other tools. NOAA is seeded and the GFZ archive is a
 * fake answer, so nothing touches the network, and every block the scheduler uses is one clearWindows calls clear.
 */
import { mkdirSync, rmSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

mkdirSync('./data', { recursive: true });
rmSync('./data/test-schedule.json', { force: true });
process.env.ORBITA_DATA = './data/test-schedule.json';

const swpc = await import('./dist/swpc.js');
const { scheduleJobs, lostHours, speakLost } = await import('./dist/schedule.js');
const { clearWindows, TOLERANCE_M } = await import('./dist/domain.js');
const { registerTools } = await import('./dist/tools.js');
const { configureForTest: fakeZones } = await import('./dist/timezone.js');
fakeZones(async (lat) => (lat > 30 ? 'America/Chicago' : lat < -5 ? 'America/Cuiaba' : null));

const HOUR = 3600e3;
const nebraska = { id: 'f1', name: 'North 40', lat: 40.93, lon: -98.34, baselineKm: 18, timeZone: 'America/Chicago' };
const sorriso = { id: 'f2', name: 'Sorriso Block', lat: -12.55, lon: -55.71, baselineKm: 18, timeZone: 'America/Cuiaba' };
const planter = { id: 'e1', name: 'planter', correction: 'rtk' };
const sprayer = { id: 'e2', name: 'sprayer', correction: 'sbas' };

/** Three hour blocks starting on a block boundary at or before now, Kp from the list. */
function slotsOf(kps, start = Math.floor(Date.now() / (3 * HOUR)) * 3 * HOUR) {
  return kps.map((kp, i) => ({ time: new Date(start + i * 3 * HOUR).toISOString(), kp, observed: false }));
}
const now = new Date();
const quiet = slotsOf(Array(24).fill(2));

console.log('\nFitting jobs into the clear hours');
{
  const one = scheduleJobs(quiet, [{ operation: 'planting', hours: 6, eq: planter, field: nebraska }], now);
  check('a quiet sky gives the job its hours', one.placed[0].placed === 6, JSON.stringify(one.placed[0]));
  check('they start at the first whole hour from now', Date.parse(one.placed[0].blocks[0].start) - now.getTime() < HOUR && Date.parse(one.placed[0].blocks[0].start) >= now.getTime() - 1, one.placed[0].blocks[0].start);
  check('the answer names the job, the hours and the machine', /^Planting, 6 hours on the planter: \w{3} \d+ (AM|PM) to/.test(one.spoken), one.spoken);
  check('the time zone is said once per stretch', (one.spoken.match(/C[SD]T/g) ?? []).length === one.placed[0].blocks.length, one.spoken);

  // A severe storm across blocks 2 to 5: nothing goes into it.
  const storm = slotsOf(Array(24).fill(2).map((k, i) => (i >= 2 && i <= 5 ? 8.3 : k)));
  const fit = scheduleJobs(storm, [{ operation: 'planting', hours: 20, eq: planter, field: nebraska }], now);
  const stormFrom = Date.parse(storm[2].time), stormTo = Date.parse(storm[5].time) + 3 * HOUR;
  const inStorm = fit.placed[0].blocks.some((b) => Date.parse(b.start) < stormTo && Date.parse(b.end) > stormFrom);
  check('no work is put into the storm blocks', !inStorm, JSON.stringify(fit.placed[0].blocks));
  const clear = clearWindows(storm, planter, nebraska, TOLERANCE_M.planting, now, 72);
  check('every hour it uses is inside a window clearWindows calls clear', fit.placed[0].blocks.every((b) => clear.some((w) => Date.parse(b.start) >= Date.parse(w.start) && Date.parse(b.end) <= Date.parse(w.end))));

  const two = scheduleJobs(quiet, [{ operation: 'planting', hours: 4, eq: planter, field: nebraska }, { operation: 'surveying', hours: 4, eq: planter, field: nebraska }], now);
  const hours = (p) => p.blocks.flatMap((b) => Array.from({ length: b.hours }, (_, i) => Date.parse(b.start) + i * HOUR));
  const overlap = hours(two.placed[0]).some((h) => hours(two.placed[1]).includes(h));
  check('one machine never does two jobs in the same hour', !overlap);
  check('the tighter job (surveying) is fitted first, so it gets the earliest hours', Math.min(...hours(two.placed[1])) < Math.min(...hours(two.placed[0])));
  check('they are said in the order they were asked for', /^Planting/.test(two.spoken) && two.spoken.indexOf('Surveying') > 0);
  const side = scheduleJobs(quiet, [{ operation: 'planting', hours: 4, eq: planter, field: nebraska }, { operation: 'spraying', hours: 4, eq: sprayer, field: nebraska }], now);
  check('two machines work side by side', hours(side.placed[0])[0] === hours(side.placed[1])[0]);

  const day = scheduleJobs(quiet, [{ operation: 'planting', hours: 10, eq: planter, field: nebraska }], now, { fromHour: 6, toHour: 20 });
  const local = (ms) => Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/Chicago' }).format(new Date(ms)));
  check('working hours are kept, in the field\'s own time', hours(day.placed[0]).every((h) => local(h) >= 6 && local(h) < 20), JSON.stringify(hours(day.placed[0]).map(local)));

  const short = scheduleJobs(slotsOf(Array(24).fill(8.3)), [{ operation: 'planting', hours: 5, eq: planter, field: nebraska }], now);
  check('a job with no clear hours says so', /no clear hours in the next three days/.test(short.spoken), short.spoken);
  const partial = scheduleJobs(slotsOf([2, 2, 8.3, 8.3, 8.3, 8.3, 8.3, 8.3, 8.3, 8.3, 8.3, 8.3, 8.3, 8.3, 8.3, 8.3, 8.3, 8.3, 8.3, 8.3, 8.3, 8.3, 8.3, 8.3]), [{ operation: 'planting', hours: 20, eq: planter, field: nebraska }], now);
  check('a job that only partly fits says how much, and where to look for the rest', /of the 20 you need/.test(partial.spoken) && /which weeks are clear/.test(partial.spoken), partial.spoken);
}

console.log('\nNear the magnetic equator, the evenings');
{
  const rtk = scheduleJobs(quiet, [{ operation: 'planting', hours: 48, eq: planter, field: sorriso }], now);
  const local = (ms) => Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/Cuiaba' }).format(new Date(ms)));
  const hrs = rtk.placed[0].blocks.flatMap((b) => Array.from({ length: b.hours }, (_, i) => local(Date.parse(b.start) + i * HOUR)));
  check('RTK planting in Sorriso is kept out of the evening bubble hours', !hrs.some((h) => h >= 20 && h <= 23), JSON.stringify([...new Set(hrs)].sort((a, b) => a - b)));
  const waas = scheduleJobs(quiet, [{ operation: 'spraying', hours: 48, eq: sprayer, field: sorriso }], now);
  check('WAAS spraying there is not, because the bubbles do not hold it', waas.placed[0].placed === 48);
}

console.log('\nThe hours already lost');
{
  const past = slotsOf(Array(56).fill(2).map((k, i) => (i >= 10 && i <= 13 ? 8.7 : k)), Math.floor((Date.now() - 7 * 86_400e3) / (3 * HOUR)) * 3 * HOUR);
  const [lost] = lostHours(past, [{ operation: 'planting', eq: planter }], nebraska, 'week', now);
  check('a storm in the week is counted, three hours a block', lost.lostHours === 12, String(lost.lostHours));
  check('its worst day is named with its Kp', lost.worst && lost.worst.peakKp >= 8.7, JSON.stringify(lost.worst));
  check('none of it is put down to the bubbles in Nebraska', lost.bubbleHours === 0);
  const spoken = speakLost([lost], 'North 40', 'week');
  check('it is said in hours and days', /held for about 12 hours, on \d day/.test(spoken), spoken);
  const [calm] = lostHours(slotsOf(Array(56).fill(2), Math.floor((Date.now() - 7 * 86_400e3) / (3 * HOUR)) * 3 * HOUR), [{ operation: 'planting', eq: planter }], nebraska, 'week', now);
  check('a quiet week costs nothing, and says so', /would not have stopped planting on the planter for a single hour/.test(speakLost([calm], 'North 40', 'week')));
  const [brazil] = lostHours(slotsOf(Array(56).fill(2), Math.floor((Date.now() - 7 * 86_400e3) / (3 * HOUR)) * 3 * HOUR), [{ operation: 'planting', eq: planter }], sorriso, 'week', now);
  check('in Sorriso a quiet week still loses its evenings, and says they were the bubbles', brazil.lostHours > 0 && brazil.bubbleHours === brazil.lostHours && /All of those were the evening plasma bubble hours/.test(speakLost([brazil], 'Sorriso Block', 'week')));
}

console.log('\nThe tools, end to end');
{
  const tools = {};
  registerTools({ registerTool: (name, _cfg, handler) => { tools[name] = handler; } }, () => 'schedule-test');
  const text = (r) => r.content[0].text;
  check('both tools are registered', typeof tools.schedule_jobs === 'function' && typeof tools.outage_patterns === 'function');
  check('with no field, it asks for one', /where the field is first/.test(text(await tools.schedule_jobs({ jobs: [{ operation: 'planting', hours: 4 }] }))));
  await tools.register_field({ name: 'North 40', lat: 40.93, lon: -98.34, baselineKm: 18 });
  await tools.register_equipment({ name: 'the planter', correction: 'rtk' });
  swpc.seedForTest({ fetchedAt: new Date().toISOString(), slots: quiet, alerts: [], scales: { g: 0, s: 0, r: 0, yesterday: { g: 0, s: 0, r: 0 }, days: [] }, stale: false });
  const r = await tools.schedule_jobs({ jobs: [{ operation: 'planting', hours: 6 }] });
  check('schedule_jobs answers from the seeded forecast', /^Planting, 6 hours on the planter/.test(text(r)) && r.structuredContent.jobs[0].placed === 6, text(r));
  const noCombine = await tools.schedule_jobs({ jobs: [{ operation: 'planting', hours: 6, equipment: 'combine' }] });
  check('a machine it does not have is asked about, not swapped for the planter', /don't have a machine called "combine"/.test(text(noCombine)), text(noCombine));
  const noCombineBack = await tools.outage_patterns({ period: 'week', equipment: 'combine' });
  check('...and the same when looking back', /don't have a machine called "combine"/.test(text(noCombineBack)), text(noCombineBack));
  const twice = await tools.schedule_jobs({ jobs: [{ operation: 'planting', hours: 3 }, { operation: 'planting', hours: 3 }] });
  const [j1, j2] = twice.structuredContent.jobs;
  check('the same job asked twice on one machine gets two different stretches, and says both', j1.blocks[0].start !== j2.blocks[0].start, JSON.stringify([j1.blocks, j2.blocks]));
  const unknown = await tools.schedule_jobs({ jobs: [{ operation: 'planting', hours: 6 }], field: 'Back 80' });
  check('a field it does not have is asked about, not guessed', /don't have a field called "Back 80"/.test(text(unknown)));

  // "My field is near Sorriso" names a town and no field. my_farm used to save only the machine and ask for the town.
  {
    const t2 = {};
    // my_farm is on the default surface, which is what a customer gets; this file otherwise runs with every tool.
    process.env.ORBITA_SCOPE = 'default';
    registerTools({ registerTool: (name, _cfg, handler) => { t2[name] = handler; } }, () => 'schedule-test-town');
    process.env.ORBITA_SCOPE = 'all';
    const { configureForTest: fakeGeo } = await import('./dist/geocode.js');
    fakeGeo?.(async () => ({ name: 'Sorriso', region: 'Mato Grosso', country: 'Brazil', countryCode: 'BR', lat: -12.55, lon: -55.71 }));
    const saved = await t2.my_farm({ place: 'Sorriso, Brazil', machineName: 'planter', correction: 'rtk' });
    check('a town with no field name saves the field, named for the town', /Added your field near Sorriso/.test(text(saved)) && !/what town is it near/.test(text(saved)), text(saved));
    fakeGeo?.(null);
  }

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('kp.gfz.de')) {
      const start = Math.floor((Date.now() - 31 * 86_400e3) / (3 * HOUR)) * 3 * HOUR;
      const datetime = Array.from({ length: 31 * 8 }, (_, i) => new Date(start + i * 3 * HOUR).toISOString());
      return new Response(JSON.stringify({ datetime, Kp: datetime.map((_, i) => (i >= 100 && i <= 102 ? 8.3 : 1.7)) }), { status: 200 });
    }
    throw new Error('network is off for this test');
  };
  const back = await tools.outage_patterns({ period: 'month' });
  check('outage_patterns reads the archive and counts the storm', /planting on the planter would have been held for about 9 hours/.test(text(back)), text(back));
  globalThis.fetch = async () => { throw new Error('down'); };
  // GFZ down and no network: a year still answers from NOAA's stored quarters, and names NOAA as its source.
  const year = await tools.outage_patterns({ period: 'year' });
  check('with GFZ down, a year is counted from the NOAA days kept here', /Over the last year at North 40/.test(text(year)) && /swpc\.noaa\.gov/.test(JSON.stringify(year.structuredContent ?? {})), text(year));
  const history = await import('./dist/history.js');
  const may = await history.fetchRange(new Date(Date.UTC(2024, 4, 10)), new Date(Date.UTC(2024, 4, 10, 23, 59)));
  check('the May 2024 storm is kept here: eight blocks, peaking at Kp 9', may.length === 8 && Math.max(...may.map((s) => s.kp)) === 9, JSON.stringify(may));
  // The last week is in neither GFZ nor the stored quarters, and NOAA's live file is unreachable too: it says so.
  const down = await tools.outage_patterns({ period: 'week' });
  check('with every archive down, it says so', /can't reach the Kp archive/.test(text(down)), text(down));
  globalThis.fetch = realFetch;
}

rmSync('./data/test-schedule.json', { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
