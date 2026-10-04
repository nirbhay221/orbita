// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.ORBITA_SCOPE ??= 'all';
/**
 * A plan for a season, not an answer for an afternoon.
 *
 * The thing worth pinning here is agreement. `plan` calls the same `assess` the
 * go/no-go answer uses, so a season plan and "can I plant now" cannot disagree
 * about the same field at the same Kp. Two code paths computing tolerance
 * separately is how a product ends up saying different things on Tuesday and
 * Friday, and a farmer who is told both stops trusting either.
 *
 * The second is the distinction between "wait for a quiet week" and "this rig
 * will never hold that tolerance". A 45 day outlook full of empty windows reads
 * like bad luck. It is often not bad luck: it is a machine on a correction that
 * cannot hit the number, and no quiet week will fix it. Those two have to come
 * back as different fields, not as a short list.
 *
 * Nothing here touches the network; the outlook is seeded.
 */
let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const season = await import('./dist/season.js');
const swpcplus = await import('./dist/swpcplus.js');
const { assess, TOLERANCE_M } = await import('./dist/domain.js');

const day = (n, kp) => ({
  date: new Date(Date.now() + n * 864e5).toISOString().slice(0, 10),
  ap: 5, kp, f107: 95,
});
const seed = (days) => { swpcplus.resetForTest(); swpcplus.seedForTest({ outlook: days }); };

const field = { id: 'f1', name: 'North 40', lat: 40.92, lon: -98.34, baselineKm: 30 };
const rtk = { id: 'e1', name: 'the planter', correction: 'rtk' };
const waas = { id: 'e2', name: 'the old sprayer', correction: 'sbas' };

console.log('\nNo outlook, no plan, rather than an empty one');
{
  swpcplus.resetForTest();
  check('a missing outlook returns null', season.plan([field], [rtk], ['planting']) === null);
  seed([day(0, 2)]);
  check('no fields returns null', season.plan([], [rtk], ['planting']) === null);
  check('no equipment returns null', season.plan([field], [], ['planting']) === null);
}

console.log('\nQuiet days become one run, not many');
{
  seed(Array.from({ length: 10 }, (_, i) => day(i, 1)));
  const p = season.plan([field], [rtk], ['planting']);
  check('the horizon is the number of future days', p.horizon === 10, String(p.horizon));
  const runs = p.plans[0].windows.planting;
  check('ten clear days are one run of ten', runs.length === 1 && runs[0].days === 10, JSON.stringify(runs));
  check('and the run reports the worst Kp inside it', runs[0].worstKp === 1, String(runs[0].worstKp));
}

console.log('\nA storm splits a run, and short fragments are not offered');
{
  // 4 clear, 1 storm, 4 clear, 1 storm, 1 clear. The trailing single day is
  // below the minimum worth mobilising for.
  seed([day(0, 1), day(1, 1), day(2, 1), day(3, 1), day(4, 9), day(5, 1), day(6, 1), day(7, 1), day(8, 1), day(9, 9), day(10, 1)]);
  const runs = season.plan([field], [rtk], ['planting']).plans[0].windows.planting;
  check('two usable runs come back', runs.length === 2, JSON.stringify(runs.map((r) => r.days)));
  check('each is four days', runs.every((r) => r.days === 4), JSON.stringify(runs.map((r) => r.days)));
  check('the one day tail is dropped', !runs.some((r) => r.days === 1));
}

console.log('\nWaiting is distinguished from never holding');
{
  seed(Array.from({ length: 20 }, (_, i) => day(i, 0)));
  // At Kp 0 the sky is as good as it gets, so anything failing here is the rig.
  const p = season.plan([field], [waas], [...Object.keys(TOLERANCE_M)]);
  const fp = p.plans[0];
  const quietGo = (op) => assess(op, 0, waas, field).go;

  check('every never-holds entry genuinely fails at Kp 0',
    fp.neverHolds.every((op) => !quietGo(op)), JSON.stringify(fp.neverHolds));
  check('every feasible entry genuinely passes at Kp 0',
    fp.feasible.every((op) => quietGo(op)), JSON.stringify(fp.feasible));
  check('the two lists do not overlap',
    !fp.feasible.some((op) => fp.neverHolds.includes(op)));
  check('a never-holds operation gets no window at all',
    fp.neverHolds.every((op) => fp.windows[op] === undefined));
  check('and a note explains that waiting will not fix those',
    p.notes.some((n) => n.includes('waiting for a quiet week will not change them')), JSON.stringify(p.notes));
}

console.log('\nThe plan and the live go/no-go cannot disagree');
{
  seed([day(0, 4.5), day(1, 4.5), day(2, 4.5)]);
  const p = season.plan([field], [rtk], ['planting', 'tillage']);
  for (const op of ['planting', 'tillage']) {
    const inPlan = (p.plans[0].windows[op] ?? []).length > 0;
    const live = assess(op, 4.5, rtk, field).go;
    check(`${op}: plan agrees with assess at Kp 4.5`, inPlan === live, `plan=${inPlan} assess=${live}`);
  }
}

console.log('\nEvery field and machine pairing is planned, not just the first');
{
  seed(Array.from({ length: 6 }, (_, i) => day(i, 1)));
  const second = { ...field, id: 'f2', name: 'South Cut', baselineKm: 5 };
  const p = season.plan([field, second], [rtk, waas], ['planting']);
  check('two fields by two machines is four plans', p.plans.length === 4, String(p.plans.length));
  const names = p.plans.map((x) => `${x.field}/${x.equipment}`);
  check('each pairing appears once', new Set(names).size === 4, JSON.stringify(names));
}

console.log('\nDays nothing can run on are named separately');
{
  seed([day(0, 1), day(1, 9), day(2, 9), day(3, 1)]);
  const p = season.plan([field], [rtk], ['planting']);
  check('the two storm days are listed as write-offs', p.writeOffDays.length === 2, JSON.stringify(p.writeOffDays));
  check('and they are the storm dates', p.writeOffDays.includes(day(1, 9).date));
}

console.log('\nPast days are not planned around');
{
  seed([day(-5, 1), day(-4, 1), day(0, 1), day(1, 1), day(2, 1)]);
  const p = season.plan([field], [rtk], ['planting']);
  check('the horizon counts only future days', p.horizon === 3, String(p.horizon));
  check('and it starts today or later', p.from >= new Date().toISOString().slice(0, 10), p.from);
}

console.log('\nThe spoken summary stays one sentence, and is honest when empty');
{
  seed(Array.from({ length: 12 }, (_, i) => day(i, 1)));
  const said = season.summarise(season.plan([field], [rtk], ['planting']));
  check('it names the longest run', said.includes('12 days'), said);
  check('it names the field', said.includes('North 40'), said);
  check('it never points at a screen, which a voice-only device does not have', !/on screen|on the screen|see the table/i.test(said) && /Ask about a field or a job/.test(said), said);

  seed(Array.from({ length: 12 }, (_, i) => day(i, 9)));
  const none = season.summarise(season.plan([field], [rtk], ['planting']));
  check('nothing holding says so plainly', none.includes('Nothing in the next'), none);
}

console.log('\nEvery plan carries the caveat about what a 45 day forecast is');
{
  seed(Array.from({ length: 45 }, (_, i) => day(i, 2)));
  const p = season.plan([field], [rtk], ['planting']);
  check('a note says it is a statistical outlook',
    p.notes.some((n) => n.includes('statistical outlook')), JSON.stringify(p.notes));
  check('and says to choose between weeks, not commit to a morning',
    p.notes.some((n) => n.includes('not to') && n.includes('commit to a morning')), JSON.stringify(p.notes));
}

swpcplus.resetForTest();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
