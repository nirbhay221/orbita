// End-to-end against the running server and LIVE NOAA data.
const URL = 'http://localhost:8788/mcp';
let id = 0;

async function call(name, args = {}) {
  const t0 = Date.now();
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const json = JSON.parse(raw.includes('data: ') ? raw.split('data: ')[1] : raw);
  if (json.error) throw new Error(`${name}: ${json.error.message}`);
  return {
    text: json.result?.content?.[0]?.text ?? '',
    s: json.result?.structuredContent,
    ms: Date.now() - t0,
  };
}

const show = (label, r) => {
  console.log(`\n${label}  ${r.ms}ms${r.ms > 400 ? '  !! OVER BUDGET' : ''}`);
  console.log(`   ${r.text}`);
};

console.log('='.repeat(74));
console.log('  Orbita, live NOAA space weather, real farm geometry');
console.log('='.repeat(74));

// A real Midwest corn belt location, and a high-latitude one for contrast.
await call('register_field', { name: 'North 40', lat: 42.03, lon: -93.62, crop: 'corn', acres: 40, baselineKm: 18 });
await call('register_field', { name: 'Red River', lat: 47.92, lon: -97.03, crop: 'wheat', acres: 320, baselineKm: 65 });
await call('register_equipment', { name: 'the planter', correction: 'rtk' });
await call('register_equipment', { name: 'the sprayer', correction: 'sbas' });
console.log('\nRegistered 2 fields (Iowa 42.0N, North Dakota 47.9N) and 2 machines.');

show('1. What is the sun doing right now', await call('storm_status'));

const p = await call('can_i_run', { operation: 'planting', field: 'north', equipment: 'planter' });
show('2. Can I plant the North 40 today? (RTK, 18km baseline, Iowa)', p);
console.log(`   go=${p.s.go}  Kp=${p.s.kp}  drift=${p.s.expectedErrorM}m  tolerance=${p.s.toleranceM}m`);

const s = await call('can_i_run', { operation: 'spraying', field: 'north', equipment: 'sprayer' });
show('3. Same moment, but spraying on SBAS, looser tolerance', s);

const rr = await call('can_i_run', { operation: 'planting', field: 'red river', equipment: 'planter' });
show('4. Same job, high-latitude field, 65km baseline, harder hit', rr);
console.log(`   Iowa drift ${p.s.expectedErrorM}m  vs  North Dakota drift ${rr.s.expectedErrorM}m`);

show('5. When does it clear for planting?', await call('can_i_run', { operation: 'planting', field: 'north' }));
show('6. Whole farm at a glance', await call('farm_status'));

// Storm simulation: what the May 2024 event would have said.
console.log('\n' + '-'.repeat(74));
console.log('  Counterfactual: what this would have said on 10 May 2024 (Kp 9, G5)');
console.log('-'.repeat(74));
const { assess } = await import('./dist/domain.js');
const iowa = { id: 'f', name: 'North 40', lat: 42.03, lon: -93.62, baselineKm: 18 };
const planter = { id: 'e', name: 'the planter', correction: 'rtk' };
for (const op of ['planting', 'spraying', 'tillage']) {
  const v = assess(op, 9.0, planter, iowa);
  console.log(`\n  ${v.reason}`);
}

console.log('\n' + '='.repeat(74));

console.log('\n' + '-'.repeat(74));
console.log('  Beyond the field: what each role should do, from the same live forecast');
console.log('-'.repeat(74));
for (const role of ['satellite_operator', 'grid_operator', 'airline', 'hf_radio', 'timing', 'drone_pilot', 'aurora', 'household']) {
  show(`What should I do, ${role}`, await call('what_should_i_do', { role }));
}
show('What else is this storm hitting', await call('what_else_is_affected'));

console.log('\n' + '-'.repeat(74));
console.log('  Counterfactual: the same roles under a G5 storm with R3 blackouts and an S2 radiation storm');
console.log('-'.repeat(74));
const { advise } = await import('./dist/playbook.js');
const severe = {
  now: new Date('2024-05-10T20:00:00Z'),
  levels: { g: 5, s: 2, r: 3 },
  yesterday: { g: 0, s: 0, r: 0 },
  days: [],
  slots: [{ time: '2024-05-10T18:00:00.000Z', kp: 9, observed: true }],
};
for (const role of ['satellite_operator', 'grid_operator', 'airline', 'aurora', 'household']) {
  console.log(`\n  [${role}] ${advise(role, severe, null).spoken}`);
}
console.log('\n' + '='.repeat(74));
