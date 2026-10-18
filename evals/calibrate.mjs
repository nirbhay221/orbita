/**
 * Fitting the model to real receivers, and testing the fit on a year it never saw.
 *
 * receivers.mjs scores the model against permanent GPS stations for one planting season. This goes a step
 * further. The one piece of geometry the model sets by judgement is how far poleward of NOAA's aurora view
 * line the disturbed sky really is (OVERHEAD_OFFSET_DEG in src/domain.ts). Here every whole-degree value
 * from 0 to 10 is scored against all of 2024 at four stations, which includes the storms of 10 May (Kp 9)
 * and 10 October (Kp 8.7), and the best is chosen there. Then the chosen value and the one in the code are
 * both scored against all of 2025 at the three stations that published it, which includes 1 January,
 * 1 June and 12 November. Nothing from 2025 is used to choose.
 *
 * What is measured, and what is not. The stations are processed afterwards from both GPS frequencies, which
 * removes most of the ionosphere (Nevada Geodetic Laboratory, five-minute positions). So a block counts as
 * degraded when fewer than half its positions exist or their 95th percentile is more than 5 cm out, which is
 * precise positioning being lost. It is not a measurement of how many centimetres an RTK rover drifts, and
 * nothing here fits those centimetres. What is calibrated is the go or no-go: when the model says hold, were
 * receivers really losing their fix.
 *
 * Scored as balanced accuracy, the mean of the share of degraded blocks the model held and the share of fine
 * blocks it cleared, because fine blocks outnumber degraded ones twenty to one and a model that always said
 * yes would otherwise look 95 percent right.
 *
 *   node evals/calibrate.mjs        # downloads about 30 MB into .receivers/, prints, writes CALIBRATION.md
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, inflateRawSync } from 'node:zlib';

const history = await import('../dist/history.js');
const { assess, setOverheadOffsetForCalibration } = await import('../dist/domain.js');

const SITES = [
  { sta: 'SKSK', name: 'Saskatoon', lat: 52.15, lon: -106.67 },
  { sta: 'NDFG', name: 'Fargo', lat: 46.88, lon: -96.8 },
  { sta: 'NEGI', name: 'Grand Island', lat: 40.92, lon: -98.33 },
  { sta: 'TXLU', name: 'Lubbock', lat: 33.54, lon: -101.84 },
];
const DIR = '.receivers';
const RIG = { id: 'r', name: 'rover', correction: 'rtk' };
const BLOCK = 3 * 3_600_000;
const OFFSETS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const IN_CODE = 0;
/** What the code used before this calibration, kept in the tables for comparison. */
const BEFORE = 4;

mkdirSync(DIR, { recursive: true });

/** A zip file read with nothing but zlib, as in receivers.mjs. */
function unzip(buf) {
  const out = [];
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('not a zip file');
  let at = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i += 1) {
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    if (!name.endsWith('/')) out.push([name, method === 0 ? raw : inflateRawSync(raw)]);
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return out;
}

/** A whole year of five-minute positions for one station, or null where the laboratory has none. */
async function positions(sta, year) {
  const zip = `${DIR}/${sta}.${year}.kenv.zip`;
  const out = `${DIR}/${sta}-${year}`;
  if (!existsSync(out) || !readdirSync(out).length) {
    if (!existsSync(zip)) {
      const res = await fetch(`https://geodesy.unr.edu/gps_timeseries/IGS20/kenv/${sta}/${sta}.${year}.kenv.zip`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`could not download ${sta} ${year}: ${res.status}`);
      writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    }
    mkdirSync(out, { recursive: true });
    for (const [name, data] of unzip(readFileSync(zip))) writeFileSync(`${out}/${name.split('/').pop()}`, data);
  }
  const rows = [];
  for (const f of readdirSync(out).filter((n) => n.endsWith('.kenv.gz'))) {
    const dayStart = Date.UTC(year, 0, Number(f.split('.')[2]));
    for (const line of gunzipSync(readFileSync(`${out}/${f}`)).toString('utf8').split('\n').slice(1)) {
      const p = line.trim().split(/\s+/);
      if (p.length < 17) continue;
      rows.push({ t: dayStart + Number(p[7]) * 1000, e: Number(p[8]), n: Number(p[9]) });
    }
  }
  return rows;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/** Every three-hour block with data at a station: its Kp, and whether the receiver was degraded. */
async function blocks(site, year) {
  const rows = await positions(site.sta, year);
  if (!rows?.length) return null;
  const e0 = median(rows.map((r) => r.e));
  const n0 = median(rows.map((r) => r.n));
  const byBlock = new Map();
  const days = new Set();
  for (const r of rows) {
    const k = Math.floor(r.t / BLOCK) * BLOCK;
    if (!byBlock.has(k)) byBlock.set(k, []);
    byBlock.get(k).push(Math.hypot(r.e - e0, r.n - n0));
    days.add(new Date(r.t).toISOString().slice(0, 10));
  }
  const slots = await history.fetchRange(new Date(Date.UTC(year, 0, 1)), new Date(Date.UTC(year + 1, 0, 1) - 1));
  const out = [];
  for (const s of slots) {
    // A day with no positions at all is a station switched off, not a storm.
    if (!days.has(s.time.slice(0, 10))) continue;
    const start = new Date(s.time).getTime();
    const errs = (byBlock.get(start) ?? []).sort((a, b) => a - b);
    const present = errs.length / 36;
    const p95 = errs.length >= 10 ? errs[Math.floor(errs.length * 0.95) - 1] : null;
    out.push({ site, kp: s.kp, at: new Date(start + BLOCK / 2), degraded: present < 0.5 || (p95 != null && p95 > 0.05) });
  }
  return out;
}

function score(all, offset) {
  setOverheadOffsetForCalibration(offset);
  let tp = 0, fn = 0, fp = 0, tn = 0, stormTp = 0, stormFn = 0;
  for (const b of all) {
    const hold = !assess('planting', b.kp, RIG, { id: 'f', name: b.site.name, lat: b.site.lat, lon: b.site.lon }, b.at).go;
    if (b.degraded && hold) tp += 1;
    else if (b.degraded) fn += 1;
    else if (hold) fp += 1;
    else tn += 1;
    if (b.kp >= 6 && b.degraded) hold ? (stormTp += 1) : (stormFn += 1);
  }
  setOverheadOffsetForCalibration(null);
  const tpr = tp / Math.max(1, tp + fn);
  const tnr = tn / Math.max(1, tn + fp);
  return { offset, tp, fn, fp, tn, balanced: (tpr + tnr) / 2, falseHolds: fp, stormHeld: stormTp, stormMissed: stormFn };
}

/** Per station, with the offset in the code: of the blocks the model held, how many the receiver really lost. */
function perStation(all) {
  return [...new Set(all.map((b) => b.site.sta))].map((sta) => {
    const r = score(all.filter((b) => b.site.sta === sta), IN_CODE);
    return { sta, name: all.find((b) => b.site.sta === sta).site.name, held: r.tp + r.fp, real: r.tp, lost: r.tp + r.fn };
  });
}
const pct = (x) => `${(x * 100).toFixed(1)}%`;

const train = [];
const test = [];
const used = { 2024: [], 2025: [] };
for (const site of SITES) {
  const a = await blocks(site, 2024);
  if (a) { train.push(...a); used[2024].push(site.sta); }
  const b = await blocks(site, 2025);
  if (b) { test.push(...b); used[2025].push(site.sta); }
}

const fits = OFFSETS.map((o) => score(train, o));
const best = fits.reduce((a, b) => (b.balanced > a.balanced ? b : a));
const tested = [...new Set([best.offset, IN_CODE, BEFORE])].map((o) => score(test, o));

// What the receivers did at each level of Kp, pooled, whatever the model says: the measurement itself.
const bins = [[0, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 10]];
const byKp = (all) => bins.map(([lo, hi]) => {
  const inBin = all.filter((b) => b.kp >= lo && b.kp < hi);
  return { label: hi === 10 ? `${lo} and above` : lo === 0 ? `below ${hi}` : `${lo} to ${hi}`, n: inBin.length, lost: inBin.filter((b) => b.degraded).length };
});

const tags = (o) => [o === IN_CODE && 'in the code', o === BEFORE && 'before calibration', o === best.offset && 'best on 2024'].filter(Boolean);
const row = (r) => `| ${r.offset}${tags(r.offset).length ? ` (${tags(r.offset).join(', ')})` : ''} | ${pct(r.balanced)} | ${r.tp} of ${r.tp + r.fn} | ${r.falseHolds} | ${r.stormHeld} of ${r.stormHeld + r.stormMissed} |`;
const lines = [
  '# Calibration against real receivers',
  '',
  'How the one judgement in the storm model was chosen, and how it does on a year it was not chosen on.',
  `Made by \`node evals/calibrate.mjs\` on ${new Date().toISOString().slice(0, 10)}, from Nevada Geodetic Laboratory five-minute`,
  'positions and GFZ Potsdam definitive Kp. See the top of that script for what "degraded" means and what it does',
  'not measure.',
  '',
  `Fitted on 2024 at ${used[2024].join(', ')} (${train.length} three-hour blocks, ${train.filter((b) => b.degraded).length} degraded).`,
  `Tested on 2025 at ${used[2025].join(', ')} (${test.length} blocks, ${test.filter((b) => b.degraded).length} degraded).${used[2025].length < used[2024].length ? ' The laboratory has published no 2025 file for the others.' : ''}`,
  '',
  '## Choosing the offset, on 2024',
  '',
  'Degrees poleward of NOAA\'s aurora view line at which the disturbed sky is taken to be overhead.',
  '',
  '| Offset | Balanced accuracy | Degraded blocks held | Fine blocks held (false holds) | Degraded at Kp 6 and above, held |',
  '|---|---|---|---|---|',
  ...fits.map(row),
  '',
  '## On 2025, which was not used to choose',
  '',
  '| Offset | Balanced accuracy | Degraded blocks held | Fine blocks held (false holds) | Degraded at Kp 6 and above, held |',
  '|---|---|---|---|---|',
  ...tested.map(row),
  '',
  '## Each station, with the offset in the code',
  '',
  'Of the blocks the model held planting on RTK, how many the receiver there really lost.',
  '',
  '| Station | Year | Blocks held | Of those, really lost | Blocks lost in all |',
  '|---|---|---|---|---|',
  ...perStation(train).map((r) => `| ${r.name} (${r.sta}) | 2024 | ${r.held} | ${r.real} | ${r.lost} |`),
  ...perStation(test).map((r) => `| ${r.name} (${r.sta}) | 2025 | ${r.held} | ${r.real} | ${r.lost} |`),
  '',
  '## What the receivers did, by Kp',
  '',
  'Share of three-hour blocks in which a station lost precise positioning, whatever the model said.',
  '',
  '| Kp | 2024 blocks | Lost | 2025 blocks | Lost |',
  '|---|---|---|---|---|',
  ...byKp(train).map((b, i) => { const c = byKp(test)[i]; return `| ${b.label} | ${b.n} | ${b.n ? pct(b.lost / b.n) : '-'} | ${c.n} | ${c.n ? pct(c.lost / c.n) : '-'} |`; }),
  '',
  'The best value is at the edge of the range tried. Below 0 the disturbed sky would sit equatorward of where the',
  'aurora can be seen at all, which is not physical, so the search stops there.',
  '',
  'Reading it. Most degraded blocks are at quiet Kp: a station\'s own gaps and noise, which no space weather model',
  'can or should call. That is why no offset holds more than a minority of all degraded blocks, and why the column',
  'that matters is the last one, the blocks lost in a real storm. The share lost climbs with Kp in both years, which',
  'is the relationship the model is built on, measured rather than assumed.',
  '',
];
const text = lines.join('\n');
writeFileSync('CALIBRATION.md', text);
console.log(text);
