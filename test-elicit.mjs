// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.ORBITA_SCOPE ??= 'all';
/**
 * Asking, and the three different things a host can do about it.
 *
 * Elicitation is a client capability, so the interesting cases are not the happy
 * one. They are: a host that cannot be asked at all, which must get exactly the
 * behaviour that existed before this file; a customer who is asked and says no,
 * which must not then be overridden by a default; and a host that answers with
 * something that was never on the menu, which must be treated as not having
 * answered rather than as having chosen.
 *
 * The regression this guards is the original bug. `store.findField(farm, '')`
 * returns `farm.fields[0]`, so a farm with three fields asking "can I plant?"
 * used to get a verdict about whichever was registered first, silently. Either
 * the customer is asked, or the sentence says which field it answered about.
 * Never neither.
 */
import { mkdirSync, rmSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

mkdirSync('./data', { recursive: true });
rmSync('./data/test-elicit.json', { force: true });
process.env.ORBITA_DATA = './data/test-elicit.json';

const { canAsk, chooseOne } = await import('./dist/elicit.js');
const store = await import('./dist/store.js');
const swpc = await import('./dist/swpc.js');
const { registerTools } = await import('./dist/tools.js');

/** A host that supports elicitation and answers however the test says. */
const host = (respond) => {
  const asked = [];
  return {
    asked,
    server: {
      getClientCapabilities: () => ({ elicitation: {} }),
      elicitInput: async (params) => { asked.push(params); return respond(params); },
    },
  };
};

console.log('\ncanAsk refuses everything that cannot actually be asked');
{
  check('a bare object', canAsk({}) === false);
  check('undefined', canAsk(undefined) === false);
  check('the test harness shape, with only registerTool', canAsk({ registerTool() {} }) === false);
  check('a server with elicitInput but no declared capability',
    canAsk({ server: { elicitInput: async () => ({}), getClientCapabilities: () => ({}) } }) === false);
  check('a server that declares it', canAsk(host(async () => ({ action: 'decline' }))) === true);
}

console.log('\nchooseOne maps every host response to one of three outcomes');
{
  const values = ['North 40', 'South Cut', 'Lot 12'];
  const askFor = (respond) => chooseOne(host(respond), { message: 'Which field?', label: 'Field', values });

  check('accept with a listed value is chosen',
    (await askFor(async () => ({ action: 'accept', content: { choice: 'Lot 12' } }))).value === 'Lot 12');
  check('decline is declined', (await askFor(async () => ({ action: 'decline' }))).kind === 'declined');
  check('cancel is also declined', (await askFor(async () => ({ action: 'cancel' }))).kind === 'declined');
  check('accept with a value never offered is NOT treated as a choice',
    (await askFor(async () => ({ action: 'accept', content: { choice: 'Some Other Field' } }))).kind === 'unsupported');
  check('accept with nothing in it is not a choice',
    (await askFor(async () => ({ action: 'accept', content: {} }))).kind === 'unsupported');
  check('a host that throws leaves the caller where it was',
    (await askFor(async () => { throw new Error('no'); })).kind === 'unsupported');
  check('a host that answers nonsense is unsupported',
    (await askFor(async () => ({ action: 'something-else' }))).kind === 'unsupported');
  check('an empty option list is never asked about',
    (await chooseOne(host(async () => ({ action: 'accept' })), { message: 'x', label: 'y', values: [] })).kind === 'unsupported');
}

console.log('\nThe question it sends is a titled enum, not free text');
{
  const h = host(async () => ({ action: 'accept', content: { choice: 'North 40' } }));
  await chooseOne(h, { message: 'Which field?', label: 'Field', values: ['North 40', 'Lot 12'] });
  const sent = h.asked[0];
  check('it asks in form mode', sent.mode === 'form');
  check('the message is carried', sent.message === 'Which field?');
  const prop = sent.requestedSchema.properties.choice;
  check('the answer is constrained to an enum', Array.isArray(prop.enum) && prop.enum.length === 2, JSON.stringify(prop));
  check('the choice is required', sent.requestedSchema.required.includes('choice'));
  check('and it carries display names', Array.isArray(prop.enumNames));
}

console.log('\nIn can_i_run: three fields, no name spoken');
{
  const quiet = () => {
    const t0 = Date.now() - 3600e3;
    swpc.seedForTest({
      fetchedAt: new Date().toISOString(),
      slots: Array.from({ length: 24 }, (_, i) => ({ time: new Date(t0 + i * 3 * 3600e3).toISOString(), kp: 1, observed: i === 0 })),
      alerts: [],
      scales: { g: 0, s: 0, r: 0, yesterday: { g: 0, s: 0, r: 0 }, days: [] },
      stale: false,
    });
  };

  const build = (server) => {
    const tools = {};
    registerTools({ ...server, registerTool: (name, _cfg, handler) => { tools[name] = handler; } }, () => 'elicit-test');
    return tools;
  };
  const text = (r) => r.content[0].text;

  const setup = async (tools) => {
    await tools.register_field({ name: 'North 40', lat: 40.9, lon: -98.3, baselineKm: 10 });
    await tools.register_field({ name: 'South Cut', lat: 41.9, lon: -97.3, baselineKm: 10 });
    await tools.register_field({ name: 'Lot 12', lat: 42.9, lon: -96.3, baselineKm: 10 });
    await tools.register_equipment({ name: 'the planter', correction: 'rtk' });
  };

  // A host that can be asked, and picks the third field.
  store.forget('elicit-test');
  quiet();
  const h = host(async () => ({ action: 'accept', content: { choice: 'Lot 12' } }));
  let tools = build(h);
  await setup(tools);
  const answered = text(await tools.can_i_run({ operation: 'planting' }));
  check('it asked rather than guessing', h.asked.length >= 1, JSON.stringify(h.asked.length));
  check('the question names the field', h.asked[0].message.toLowerCase().includes('field'));
  check('and the answer does not carry the "that is for" disclosure',
    !answered.includes('name a different one'), answered);

  // Declining must stop, not fall through to a default.
  store.forget('elicit-test');
  const d = host(async () => ({ action: 'decline' }));
  tools = build(d);
  await setup(tools);
  const declined = text(await tools.can_i_run({ operation: 'planting' }));
  check('declining gets an invitation to name one, not a verdict',
    declined.includes('name the field'), declined);
  check('and no accuracy verdict is given', !/Clear for planting|Hold off/.test(declined), declined);

  // A host that cannot be asked keeps the old behaviour, but must disclose it.
  store.forget('elicit-test');
  tools = build({});
  await setup(tools);
  const guessed = text(await tools.can_i_run({ operation: 'planting' }));
  check('it still answers when nobody can be asked', /Clear for planting|Hold off/.test(guessed), guessed);
  check('but it says which field and machine it assumed',
    // The field registered last is the one assumed: the one just spoken about.
    guessed.includes('That is for Lot 12 with the planter'), guessed);

  // One field only: nothing ambiguous, so nothing to ask and nothing to disclose.
  store.forget('elicit-test');
  const one = host(async () => ({ action: 'accept', content: { choice: 'North 40' } }));
  tools = build(one);
  await one.server.getClientCapabilities();
  await tools.register_field({ name: 'North 40', lat: 40.9, lon: -98.3, baselineKm: 10 });
  await tools.register_equipment({ name: 'the planter', correction: 'rtk' });
  const single = text(await tools.can_i_run({ operation: 'planting' }));
  check('one field is never asked about', one.asked.length === 0, JSON.stringify(one.asked));
  check('and carries no disclosure', !single.includes('That is for'), single);

  // Naming the field explicitly must never trigger a question.
  store.forget('elicit-test');
  const named = host(async () => ({ action: 'accept', content: { choice: 'Lot 12' } }));
  tools = build(named);
  await setup(tools);
  const explicit = text(await tools.can_i_run({ operation: 'planting', field: 'South Cut', equipment: 'the planter' }));
  check('naming both asks nothing', named.asked.length === 0, JSON.stringify(named.asked.length));
  check('and answers about what was named', !explicit.includes('That is for'), explicit);
}

store.forget('elicit-test');
rmSync('./data/test-elicit.json', { force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
