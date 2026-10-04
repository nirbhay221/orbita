// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.ORBITA_SCOPE ??= 'all';
/**
 * What Orbita now does, not just says: watches that report back, crews that
 * are emailed only once confirmed, a job log that turns a bad week into a
 * report, and taking fields and machines back out.
 *
 * NOAA is seeded and emails go through a fake transport, so nothing touches
 * the network.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

mkdirSync('./data', { recursive: true });
rmSync('./data/test-actions.json', { force: true });
rmSync('./data/test-outbox.jsonl', { force: true });
process.env.ORBITA_DATA = './data/test-actions.json';
process.env.ORBITA_OUTBOX = './data/test-outbox.jsonl';

const store = await import('./dist/store.js');
const swpc = await import('./dist/swpc.js');
const notify = await import('./dist/notify.js');
const { checkFieldAlerts } = await import('./dist/alerts.js');
const { registerTools } = await import('./dist/tools.js');
const { spokenTime, configureForTest: fakeZones } = await import('./dist/timezone.js');
const zoneLookups = [];
fakeZones(async (lat, lon) => { zoneLookups.push([lat, lon]); return lat > 40 && lon < -90 ? 'America/Chicago' : null; });

const mails = [];
notify.configureForTest({ from: 'orbita@example.com', transport: async (email) => { mails.push(email); } });

const tools = {};
registerTools({ registerTool: (name, _cfg, handler) => { tools[name] = handler; } }, () => 'crew-test');
const text = (r) => r.content[0].text;

/** Three hour blocks starting an hour ago, so the first one is "now". */
function seedKp(kps) {
  const t0 = Date.now() - 3600e3;
  swpc.seedForTest({
    fetchedAt: new Date().toISOString(),
    slots: kps.map((kp, i) => ({ time: new Date(t0 + i * 3 * 3600e3).toISOString(), kp, observed: i === 0 })),
    alerts: [],
    scales: { g: 0, s: 0, r: 0, yesterday: { g: 0, s: 0, r: 0 }, days: [] },
    stale: false,
  });
}
const stormThenClear = [7.3, 7.3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2];
const quiet = Array(24).fill(2);

await tools.register_field({ name: 'North 40', lat: 42.03, lon: -93.62, baselineKm: 18 });
await tools.register_equipment({ name: 'the planter', correction: 'rtk' });

console.log('\nTaking things back out');
await tools.register_field({ name: 'Red River', lat: 47.92, lon: -97.03, baselineKm: 65 });
check('a field can be removed by name', /Removed Red River/.test(text(await tools.remove({ what: 'field', name: 'Red River' }))) &&
  store.get('crew-test').fields.length === 1);
check('"the field" is too vague to delete anything', /Which field/.test(text(await tools.remove({ what: 'field', name: 'the field' }))) &&
  store.get('crew-test').fields.length === 1);
check('an unknown machine is never swapped for the first one when deleting',
  /don't have a machine/.test(text(await tools.remove({ what: 'machine', name: 'combine' }))) && store.get('crew-test').equipment.length === 1);

console.log('\nWatching a blocked job');
seedKp(stormThenClear);
const watching = text(await tools.watch_jobs({ action: 'start', operation: 'planting', field: 'north' }));
check('a blocked job is watched, with the forecast time it clears', /Watching planting on North 40\. On the current forecast it clears/.test(watching), watching);
check('...and without a crew it says how to hear about it', /add a crew member/.test(watching), watching);
check('the watch is stored once', store.get('crew-test').waiting.length === 1);
await tools.watch_jobs({ action: 'start', operation: 'planting', field: 'north' });
check('watching the same job again does not duplicate it', store.get('crew-test').waiting.length === 1);
const notYet = text(await tools.watch_jobs({ action: 'check' }));
check('"anything clear yet" says when it clears', /planting on North 40 clears/i.test(notYet) && store.get('crew-test').waiting.length === 1, notYet);

console.log('\nThe crew is emailed only once confirmed');
const staged = text(await tools.crew_contact({ action: 'add', name: 'Sam', email: 'sam@example.com', role: 'planter operator' }));
check('adding a crew member only stages them, and asks', /Nothing is sent until you confirm/.test(staged), staged);
await checkFieldAlerts();
check('an unconfirmed crew member is not emailed about the storm', mails.length === 0);
check('confirming says what they will hear', /Done\. Sam will get an email when a watched job clears, and the day before a storm/.test(text(await tools.crew_contact({ action: 'confirm', name: 'sam' }))));
await checkFieldAlerts();
check('a storm putting a usual job outside tolerance emails the crew', mails.length === 1 && /^Storm ahead/.test(mails[0].subject), JSON.stringify(mails.map((m) => m.subject)));
check('...naming the job', /planting on North 40/.test(mails[0].text));
await checkFieldAlerts();
check('...once per storm day, not every refresh', mails.length === 1);
check('nothing clears while the storm is still on', !mails.some((m) => /^Clear now/.test(m.subject)));

seedKp(quiet);
await checkFieldAlerts();
const cleared = mails.filter((m) => /^Clear now/.test(m.subject));
check('when the storm passes, the crew hears the watched job cleared', cleared.length === 1 && /planting on North 40/.test(cleared[0].subject), JSON.stringify(mails.map((m) => m.subject)));
await checkFieldAlerts();
check('...once', mails.filter((m) => /^Clear now/.test(m.subject)).length === 1);
const nowClear = text(await tools.watch_jobs({ action: 'check' }));
check('"anything clear yet" reports it clear and takes it off the list', /Clear now: planting on North 40/.test(nowClear) && store.get('crew-test').waiting.length === 0, nowClear);
check('a job that is already clear is not watched at all', /nothing to wait for/.test(text(await tools.watch_jobs({ action: 'start', operation: 'planting' }))));

console.log('\nA job log that turns a bad week into a report');
seedKp(quiet);
check('a job logged in a quiet sky is inside tolerance', /inside tolerance/.test(text(await tools.log_job({ operation: 'planting', field: 'north', acres: 40 }))));
seedKp(stormThenClear);
const risky = text(await tools.log_job({ operation: 'planting', field: 'north', note: 'rows looked off' }));
check('a job logged during the storm is flagged worth checking', /worth checking/.test(risky), risky);
const report = text(await tools.job_report({ days: 7 }));
check('the report counts the jobs and names the one the storm affected', /logged 2 jobs/.test(report) && /1 ran while space weather put it outside tolerance: planting on North 40/.test(report), report);
mails.length = 0;
check('the report can be emailed to a confirmed crew member', /emailing the report to Sam/.test(text(await tools.job_report({ emailTo: 'Sam' }))));
await tick();
check('...and the email lists both jobs', mails.length === 1 && (mails[0].text.match(/planting/g) || []).length === 2, JSON.stringify(mails));

await tools.crew_contact({ action: 'add', name: 'Alex', email: 'alex@example.com', when: 'storm' });
check('an unconfirmed contact never gets the report', /hasn't been confirmed/.test(text(await tools.job_report({ emailTo: 'Alex' }))));
notify.configureForTest({ from: undefined });
check('without email set up it says so rather than pretending', /isn't set up/.test(text(await tools.job_report({ emailTo: 'Sam' }))));
notify.configureForTest({ from: 'orbita@example.com' });
check('a crew member can be removed', /Removed Alex/.test(text(await tools.crew_contact({ action: 'remove', name: 'Alex' }))));

console.log('\nTimes are said where the field is');
await tick();
check('adding a field looks its timezone up in the background and keeps it',
  zoneLookups.length >= 1 && store.get('crew-test').fields[0].timeZone === 'America/Chicago', JSON.stringify(store.get('crew-test').fields[0]));
check('a field in Iowa hears Central time', spokenTime('2026-09-17T00:00:00Z', 'America/Chicago') === 'Wed 7 PM CDT',
  spokenTime('2026-09-17T00:00:00Z', 'America/Chicago'));
check('an unknown zone is said in UTC and labelled, never guessed', spokenTime('2026-09-17T00:00:00Z') === 'Thu 12 AM UTC' &&
  spokenTime('2026-09-17T00:00:00Z', 'Not/AZone') === 'Thu 12 AM UTC', spokenTime('2026-09-17T00:00:00Z'));
store.update('crew-test', (x) => void (x.fields[0].timeZone = 'America/Chicago'));
seedKp(stormThenClear);
await tools.watch_jobs({ action: 'start', operation: 'planting', field: 'north' });
const zoned = text(await tools.watch_jobs({ action: 'check' }));
check('a watch on a field with a known zone says its time there', /C[DS]T\./.test(zoned), zoned);
await tools.watch_jobs({ action: 'stop' });

console.log('\nIds stay unique after removals');
await tools.register_field({ name: 'Temp One', lat: 41, lon: -95 });
await tools.remove({ what: 'field', name: 'Temp One' });
await tools.register_field({ name: 'Temp Two', lat: 41, lon: -95 });
await tools.register_field({ name: 'Temp Three', lat: 41, lon: -95 });
const ids = store.get('crew-test').fields.map((f) => f.id);
check('adding after removing never reuses a field id', new Set(ids).size === ids.length, JSON.stringify(ids));

console.log('\nThe three hour block already under way counts as now');
{
  const t0 = Date.now() - 100 * 60e3; // a block that began an hour and forty minutes ago
  const mk = (kps, first = t0) => kps.map((kp, i) => ({ time: new Date(first + i * 3 * 3600e3).toISOString(), kp, observed: i === 0 }));
  const base = { fetchedAt: new Date().toISOString(), alerts: [], scales: { g: 0, s: 0, r: 0, yesterday: { g: 0, s: 0, r: 0 }, days: [] }, stale: false };
  swpc.seedForTest({ ...base, slots: mk([2, 8, 8, 2]) });
  check('Kp now comes from the block we are in, not the next one because it starts sooner',
    swpc.kpAt(new Date()).kp === 2, JSON.stringify(swpc.kpAt(new Date())));
  const open = text(await tools.can_i_run({ operation: 'planting', field: 'north' }));
  check('a job clear right now says how long the yes lasts', /Clear until /.test(open), open);
  check('...and never offers a start time that has already gone',
    !/next clear stretch starts/.test(open), open);
  swpc.seedForTest({ ...base, slots: [...mk([8.3], t0 - 30 * 3600e3), ...mk([2, 4, 3, 2])] });
  const status = text(await tools.storm_status({}));
  check('the forecast peak ignores last week, which the feed also carries', /Peak in the forecast is 4\.0/.test(status), status);
}

console.log('\nSaying it twice');
seedKp(quiet);
const farm = () => store.get('crew-test');
const beforeFields = farm().fields.length;
const again = text(await tools.register_field({ name: 'North 40', lat: 42.03, lon: -93.62, baselineKm: 18 }));
check('a field registered twice is updated, not duplicated',
  farm().fields.length === beforeFields && farm().fields.filter((f) => f.name === 'North 40').length === 1,
  JSON.stringify(farm().fields.map((f) => f.name)));
check('...and the answer says so rather than pretending it is new', /already have North 40/.test(again), again);
await tools.register_field({ name: 'north 40', lat: 42.03, lon: -93.62, baselineKm: 40 });
check('...even said back in different case, and the new detail lands',
  farm().fields.filter((f) => /^north 40$/i.test(f.name)).length === 1 &&
  farm().fields.find((f) => /^north 40$/i.test(f.name)).baselineKm === 40,
  JSON.stringify(farm().fields.map((f) => [f.name, f.baselineKm])));
check('...and the name they first gave it is not quietly recapitalised',
  farm().fields.some((f) => f.name === 'North 40'), JSON.stringify(farm().fields.map((f) => f.name)));

const eqAgain = text(await tools.register_equipment({ name: 'the planter', correction: 'ppp' }));
check('a machine registered again is corrected, not duplicated',
  farm().equipment.filter((e) => e.name === 'the planter').length === 1 &&
  farm().equipment.find((e) => e.name === 'the planter').correction === 'ppp', eqAgain);
await tools.register_equipment({ name: 'the planter', correction: 'rtk' });

const beforeJobs = farm().jobLog.length;
const firstLog = text(await tools.log_job({ operation: 'planting', field: 'north', acres: 55 }));
const secondLog = text(await tools.log_job({ operation: 'planting', field: 'north', acres: 55 }));
check('the same job logged twice is written down once', farm().jobLog.length === beforeJobs + 1,
  JSON.stringify(farm().jobLog.slice(beforeJobs).map((j) => [j.at, j.acres])));
check('...the first answer is the normal one', /Logged planting on North 40/.test(firstLog), firstLog);
check('...and the second says it was not written twice', /a moment ago/.test(secondLog), secondLog);
await tools.log_job({ operation: 'planting', field: 'north', acres: 80 });
check('a different number of acres is a different job', farm().jobLog.length === beforeJobs + 2);
await tools.log_job({ operation: 'planting', field: 'north', acres: 55, when: 'yesterday' });
check('the same work on another day is a different job', farm().jobLog.length === beforeJobs + 3,
  JSON.stringify(farm().jobLog.slice(beforeJobs).map((j) => j.at)));
store.update('crew-test', (f) => { for (const j of f.jobLog) j.loggedAt = new Date(Date.now() - 10 * 60e3).toISOString(); });
await tools.log_job({ operation: 'planting', field: 'north', acres: 55 });
check('ten minutes on, the same sentence is a second job, because by then it is one',
  farm().jobLog.length === beforeJobs + 4);

console.log('\nA fresh start, asked for twice');
seedKp(quiet);
await tools.register_field({ name: 'Home Quarter', lat: 42.03, lon: -93.62, baselineKm: 18 });
await tools.register_equipment({ name: 'the drill', correction: 'rtk' });
const firstAsk = text(await tools.remove({ what: 'everything' }));
check('asking to clear everything says what would go, and does not do it yet',
  /can't undo it/.test(firstAsk) && store.get('crew-test').fields.length > 0, firstAsk);
check('...and counts what it holds rather than listing the lot', /\d+ fields?/.test(firstAsk), firstAsk);
const secondAsk = text(await tools.remove({ what: 'everything' }));
const after = store.get('crew-test');
check('asking again clears the farm', /Done\./.test(secondAsk) &&
  !after.fields.length && !after.equipment.length && !after.jobLog.length && !after.crew.length && !after.waiting.length,
  `${secondAsk} // ${JSON.stringify({ f: after.fields.length, e: after.equipment.length, j: after.jobLog.length, c: after.crew.length })}`);
check('...and an empty farm says there is nothing to clear rather than asking again',
  /nothing to clear/.test(text(await tools.remove({ what: 'everything' }))));

await tools.register_field({ name: 'Home Quarter', lat: 42.03, lon: -93.62, baselineKm: 18 });
await tools.remove({ what: 'everything' });
store.update('crew-test', (f) => { f.forgetAskedAt = new Date(Date.now() - 10 * 60e3).toISOString(); });
check('a confirmation from ten minutes ago is not a confirmation',
  /can't undo it/.test(text(await tools.remove({ what: 'everything' }))) && store.get('crew-test').fields.length === 1);
await tools.remove({ what: 'everything' });

console.log('\nWhat the store will and will not hold');
const strangers = Object.keys(JSON.parse(readFileSync('./data/test-actions.json', 'utf8') || '{}')).length;
store.get('demo:someone-who-never-writes');
store.get('demo:another-passer-by');
const afterReads = Object.keys(JSON.parse(readFileSync('./data/test-actions.json', 'utf8') || '{}')).length;
check('reading an id nobody has used does not create a record', afterReads === strangers,
  `${strangers} before, ${afterReads} after`);
check('...and still answers with an empty farm rather than throwing',
  store.get('demo:someone-who-never-writes').fields.length === 0);
store.update('demo:someone-who-writes', (f) => void f.fields.push({ id: 'x', name: 'Test', lat: 41, lon: -95 }));
const written = JSON.parse(readFileSync('./data/test-actions.json', 'utf8'));
check('writing does create one, and the file on disk is valid JSON afterwards',
  !!written['demo:someone-who-writes'], Object.keys(written).join(', '));

console.log('\nWhat the store lets go of');
/*
 * Two things grow for as long as the process lives unless something stops them,
 * and one of them is a stranger's record on a public demo page.
 */
store.update('demo:pruning-test', (f) => {
  for (let i = 0; i < 2100; i++) f.jobLog.push({ id: `j${i}`, at: new Date().toISOString(), loggedAt: new Date().toISOString(), operation: 'planting', fieldId: 'f', fieldName: 'F', equipmentId: 'e', equipmentName: 'E', kp: null, expectedErrorM: null, toleranceM: 0.05, go: null, limitedBy: null, acres: null, note: null });
  for (let i = 0; i < 500; i++) f.alertsSent.push(`storm:2026-01-${i}`);
});
const pruned = store.get('demo:pruning-test');
check('a job log stops growing at the cap, oldest first', pruned.jobLog.length === 2000 && pruned.jobLog[0].id === 'j100',
  `${pruned.jobLog.length} entries, first ${pruned.jobLog[0].id}`);
check('...and the list of alerts already sent is capped too', pruned.alertsSent.length === 400);

store.update('acct:someone-real', (f) => void f.fields.push({ id: 'k', name: 'Kept', lat: 41, lon: -95 }));
const longAgo = Date.now() + 8 * 24 * 60 * 60 * 1000;
const expired = store.expireDemoRecords(longAgo);
check('a demo record untouched for a week is deleted', expired >= 1 && !store.get('demo:pruning-test').fields.length,
  `${expired} expired`);
check('...and a linked account is never swept', store.get('acct:someone-real').fields.length === 1);
check('...and a demo record touched today survives',
  (store.update('demo:still-here', (f) => void f.fields.push({ id: 'z', name: 'Now', lat: 41, lon: -95 })),
    store.expireDemoRecords(),
    store.get('demo:still-here').fields.length === 1));

rmSync('./data/test-actions.json', { force: true });
console.log('\nWhatever the model hands over');
const markup = text(await tools.register_field({ name: '<script>alert(1)</script>', lat: 41, lon: -95 }));
check('markup in a name never reaches the answer or the store',
  !markup.includes('<') && !JSON.stringify(store.get('crew-test').fields).includes('<'), markup);
const huge = text(await tools.register_field({ name: 'x'.repeat(5000), lat: 41, lon: -95 }));
check('a five thousand character name is cut to something speakable', huge.length < 220 && !huge.includes('x'.repeat(81)), String(huge.length));
const spaced = text(await tools.register_equipment({ name: '  the   big  planter  ', correction: 'rtk' }));
check('ragged whitespace is tidied rather than spoken', spaced.includes('Added the big planter on RTK.'), spaced);

rmSync('./data/test-outbox.jsonl', { force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
