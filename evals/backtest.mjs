/**
 * What Orbita would have said, on days that already happened.
 *
 * The routing evaluation shows a host picks the right tool. This asks the other question: is the answer worth
 * having? It replays the observed Kp record (GFZ Potsdam, the definitive index) through the same decision code
 * the server runs, for three planting seasons at four real places, and counts the three-hour blocks where
 * planting on RTK would have been called outside tolerance.
 *
 * Nothing here is forecast or simulated: the Kp values are what was measured. What it does NOT show is that a
 * receiver in those fields actually drifted by that much. The Kp-to-drift model is a calibrated approximation
 * that has not been checked against a receiver, and this replay inherits that.
 *
 *   node evals/backtest.mjs          # prints the table and writes BACKTEST.md
 */
import { writeFileSync } from 'node:fs';

const history = await import('../dist/history.js');
const { assess } = await import('../dist/domain.js');

const PLACES = [
  { name: 'Fargo, North Dakota', lat: 46.88, lon: -96.79 },
  { name: 'Grand Island, Nebraska', lat: 40.92, lon: -98.34 },
  { name: 'Saskatoon, Saskatchewan', lat: 52.13, lon: -106.67 },
  { name: 'Lubbock, Texas', lat: 33.58, lon: -101.85 },
];
const SEASONS = [2023, 2024, 2025];
const RIG = { id: 'r', name: 'planter', correction: 'rtk' };

const rows = [];
const worst = [];
for (const year of SEASONS) {
  const slots = await history.fetchRange(new Date(Date.UTC(year, 3, 15)), new Date(Date.UTC(year, 5, 15)));
  if (!slots.length) { console.error(`no Kp record for ${year}`); process.exit(1); }
  for (const place of PLACES) {
    const field = { id: 'f', name: place.name, lat: place.lat, lon: place.lon };
    // Each block is judged at its own middle, so the hour of day counts, as it does on the server.
    const out = slots.filter((s) => !assess('planting', s.kp, RIG, field, new Date(new Date(s.time).getTime() + 90 * 60_000)).go);
    const days = new Set(out.map((s) => s.time.slice(0, 10)));
    rows.push({ year, place: place.name, blocks: slots.length, out: out.length, days: days.size });
    if (place === PLACES[0]) {
      const peak = slots.reduce((a, b) => (b.kp > a.kp ? b : a));
      worst.push({ year, when: peak.time.slice(0, 16).replace('T', ' '), kp: peak.kp });
    }
  }
}

// Every kind of job, not only planting: one season, the same four places.
const CASES = [
  ['planting', 'rtk'], ['surveying', 'rtk'], ['drone_survey', 'rtk'], ['machine_control', 'rtk'],
  ['spraying', 'sbas'], ['harvest', 'sbas'], ['tillage', 'sbas'], ['spraying', 'ppp'], ['scouting', 'autonomous'],
  ['surveying', 'ppp'], ['tillage', 'autonomous'],
];
const season = await history.fetchRange(new Date(Date.UTC(2025, 3, 15)), new Date(Date.UTC(2025, 5, 15)));
const byJob = CASES.map(([op, correction]) => {
  const rig = { id: 'r', name: 'rig', correction };
  const cells = PLACES.map((place) => {
    const field = { id: 'f', name: place.name, lat: place.lat, lon: place.lon };
    if (assess(op, 0, rig, field).limitedBy === 'equipment') return 'never, on this correction';
    const out = season.filter((s) => !assess(op, s.kp, rig, field, new Date(new Date(s.time).getTime() + 90 * 60_000)).go).length;
    return `${((100 * out) / season.length).toFixed(1)}%`;
  });
  return `| ${op.replace(/_/g, ' ')} | ${correction === 'sbas' ? 'WAAS' : correction === 'autonomous' ? 'none' : correction.toUpperCase()} | ${cells.join(' | ')} |`;
});

const lines = [
  '# Backtest: three planting seasons, replayed',
  '',
  'Observed Kp (GFZ Potsdam), 15 April to 15 June, through the same decision code the server runs.',
  'The job is planting on RTK, which needs about two inches. A block is three hours.',
  '',
  '| Season | Place | Blocks | Outside tolerance | Days affected |',
  '|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.year} | ${r.place} | ${r.blocks} | ${r.out} (${((100 * r.out) / r.blocks).toFixed(1)}%) | ${r.days} |`),
  '',
  '## Every kind of job, 2025 season',
  '',
  'Share of three-hour blocks where the answer would have been "not now".',
  '',
  `| Job | Correction | ${PLACES.map((p) => p.name).join(' | ')} |`,
  `|---|---|${PLACES.map(() => '---').join('|')}|`,
  ...byJob,
  '',
  'The first run of this table found a second fault. The rules for WAAS, PPP and no correction made every northern',
  'site 60 percent worse on a quiet day, so a sprayer on WAAS at Fargo was told it could never hold spraying',
  'tolerance, and walking a field with a phone was called impossible in Saskatchewan. Every correction is now judged',
  'from the same measure of how disturbed the sky is. Only the RTK row is anchored to published measurements; the',
  'others are scaled from it.',
  '',
  'Strongest block in each season:',
  '',
  ...worst.map((w) => `* ${w.year}: Kp ${w.kp.toFixed(1)} at ${w.when} UTC`),
  '',
  '**What this replay was for.** The first run of it showed the earlier model calling RTK planting outside tolerance',
  'from Kp 4 at northern sites: 26 percent of all blocks at Fargo in 2025. Growers do not lose guidance a quarter of',
  'the time, so the model was wrong, and it was rebuilt around how far the auroral oval has come instead of Kp alone,',
  'anchored to three published measurements (see rtkMultiplier in src/domain.ts). The table above is the rebuilt',
  'model: a few percent of blocks, on the days that had real storms.',
  '',
  'What this shows: how often, and where, the answer would have been "not now". What it does not show: that a',
  'receiver in these fields drifted by the modelled amount. The Kp-to-drift model has not been checked against a receiver.',
  '',
  `Generated ${new Date().toISOString().slice(0, 10)} by \`node evals/backtest.mjs\`.`,
  '',
];
writeFileSync('BACKTEST.md', lines.join('\n'));
console.log(lines.join('\n'));
