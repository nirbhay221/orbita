// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.ORBITA_SCOPE ??= 'all';
/**
 * The demo must never be a way to send words to a stranger.
 *
 * A sandbox visitor can add any address to a crew list and confirm it themselves,
 * because the confirmation is on the caller's side and not the recipient's. There
 * are then two routes to an inbox. The storm and clear-window alerts, which carry
 * job and field names the caller chose, and the job report, which carries each
 * job's free-text note and is emailed on demand. SES sandbox mode, which only
 * delivers to verified recipients, is what has been standing in the way, and it is
 * a setting somebody changes the day they ask for production access.
 *
 * Tested with a fake transport configured as if email were fully set up, which is
 * the situation the guard exists for. Every negative has a positive control beside
 * it: an account farm built identically must DO the thing, or "the sandbox sent
 * nothing" could just mean nothing ever ran.
 */
import { mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const DIR = './data/test-email-guard';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.ORBITA_DATA = `${DIR}/farms.json`;
process.env.ORBITA_AUTH_DATA = `${DIR}/auth.json`;
delete process.env.ORBITA_DATA_KEY;

const store = await import('./dist/store.js');
const swpc = await import('./dist/swpc.js');
const notify = await import('./dist/notify.js');
const { checkFieldAlerts } = await import('./dist/alerts.js');
const { registerTools } = await import('./dist/tools.js');
const { configureForTest: fakeZones } = await import('./dist/timezone.js');
fakeZones(async () => 'America/Chicago');

const mails = [];
notify.configureForTest({ from: 'orbita@example.com', transport: async (email) => { mails.push(email); } });

const text = (r) => r.content[0].text;
const toolsFor = (farmId) => {
  const t = {};
  registerTools({ registerTool: (name, _cfg, handler) => { t[name] = handler; } }, () => farmId);
  return t;
};

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

const DEMO = 'demo:' + 'a'.repeat(32);
const ACCT = 'acct:red river';
const words = 'click here to claim your prize at http://example.invalid';

/** An identical farm for either identity, with a confirmed crew member at `email`. */
const build = async (id, email) => {
  const t = toolsFor(id);
  await t.register_field({ name: 'North 40', lat: 42.03, lon: -93.62, baselineKm: 18 });
  await t.register_equipment({ name: 'the planter', correction: 'rtk' });
  await t.crew_contact({ action: 'add', name: 'Sam', email, role: 'planter operator' });
  await t.crew_contact({ action: 'confirm', name: 'sam' });
  return t;
};

console.log('\nThe predicate itself');
{
  check('a sandbox may not cause email', notify.canEmailFor(DEMO) === false);
  check('a linked account may', notify.canEmailFor(ACCT) === true);
  check('local development may', notify.canEmailFor('local-dev') === true);
  check('a name merely containing "demo" is not a sandbox', notify.canEmailFor('acct:demo:fake') === true);
  check('the refusal is a plain sentence', /public page/.test(notify.DEMO_NO_EMAIL) && !/Error|at /.test(notify.DEMO_NO_EMAIL));
}

console.log('\nThe storm and clear-window alerts skip a sandbox entirely');
{
  mails.length = 0;
  const demo = await build(DEMO, 'sandbox-victim@example.com');
  const acct = await build(ACCT, 'crew@example.com');
  seedKp(stormThenClear);
  await demo.watch_jobs({ action: 'start', operation: 'planting', field: 'north' });
  await acct.watch_jobs({ action: 'start', operation: 'planting', field: 'north' });
  await checkFieldAlerts();
  await new Promise((r) => setTimeout(r, 100));

  const toCrew = mails.filter((m) => m.to === 'crew@example.com');
  const toSandbox = mails.filter((m) => m.to === 'sandbox-victim@example.com');
  // The positive control: the account farm is identical and must be emailed.
  check('the linked account crew WAS emailed, so the sweep really ran', toCrew.length >= 1, JSON.stringify(mails.map((m) => m.to)));
  check('the sandbox crew was not', toSandbox.length === 0, JSON.stringify(toSandbox.map((m) => m.subject)));
}

console.log('\nThe job report does not carry a sandbox visitor words to an inbox');
{
  mails.length = 0;
  const demo = toolsFor(DEMO);
  const acct = toolsFor(ACCT);
  seedKp(Array(24).fill(2));
  await demo.log_job({ operation: 'planting', field: 'north', note: words });
  await acct.log_job({ operation: 'planting', field: 'north', note: words });

  const refused = text(await demo.job_report({ days: 30, emailTo: 'Sam' }));
  await new Promise((r) => setTimeout(r, 50));
  check('a sandbox is told email is off, in plain words', refused.includes('public page'), refused);
  check('nothing was sent to the sandbox crew', !mails.some((m) => m.to === 'sandbox-victim@example.com'));
  check('in particular, no mail carrying the attacker text went to the sandbox address',
    !mails.some((m) => m.to === 'sandbox-victim@example.com' && m.text.includes('claim your prize')));

  const sent = text(await acct.job_report({ days: 30, emailTo: 'Sam' }));
  await new Promise((r) => setTimeout(r, 50));
  check('the linked account report IS emailed, so the path works', /emailing the report/.test(sent), sent);
  check('to the account crew member', mails.some((m) => m.to === 'crew@example.com' && /job report/i.test(m.subject)),
    JSON.stringify(mails.map((m) => `${m.to}:${m.subject}`)));
}

console.log('\nEvery call site of sendEmail is behind the guard');
{
  const files = ['./src/alerts.ts', ...readdirSync('./src/tools').map((f) => `./src/tools/${f}`)];
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    if (/sendEmail\(/.test(src) && !/canEmailFor/.test(src)) offenders.push(f);
  }
  check('no file calls sendEmail without referring to canEmailFor', offenders.length === 0, offenders.join(', '));
}

{
  // The SES sandbox refuses an address nobody has verified. That is the account's setting, not a broken send,
  // so it must not count as failed, or the scheduled check would report itself failed every run.
  const refuse = (name, message) => async () => { const e = new Error(message); e.name = name; throw e; };
  notify.configureForTest({ from: 'orbita@example.com', transport: refuse('MessageRejected', 'Email address is not verified. The following identities failed the check in region US-EAST-1: someone@example.net') });
  const d1 = await notify.sendEmail({ to: 'unverified-1@example.net', subject: 's', text: 't', reason: 'test' });
  check('a sandbox refusal is unverified, not failed', d1.status === 'unverified', d1.status);
  notify.configureForTest({ from: 'orbita@example.com', transport: refuse('MessageRejected', 'Email address is blacklisted.') });
  const d2 = await notify.sendEmail({ to: 'unverified-2@example.net', subject: 's', text: 't', reason: 'test' });
  check('any other refusal is still failed', d2.status === 'failed', d2.status);
  notify.configureForTest({ from: 'orbita@example.com', transport: refuse('ThrottlingException', 'Rate exceeded') });
  const d3 = await notify.sendEmail({ to: 'unverified-3@example.net', subject: 's', text: 't', reason: 'test' });
  check('a throttled send is still failed', d3.status === 'failed', d3.status);
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
