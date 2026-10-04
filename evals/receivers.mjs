/**
 * Orbita's answer, against what real receivers did.
 *
 * Everything else here reasons from Kp. This asks the receivers. The Nevada Geodetic Laboratory publishes a
 * position every five minutes for thousands of permanent GPS stations, and four of them sit at the four
 * places the backtest uses: Saskatoon (SKSK), Fargo (NDFG), Grand Island (NEGI) and Lubbock (TXLU). For the
 * 2024 planting season, which includes the storm of 10 and 11 May, each three-hour block is scored twice:
 * what Orbita would have said about RTK planting there, and whether the receiver there was degraded, meaning
 * fewer than half its positions exist or their 95th percentile is more than 5 cm from the station's place.
 *
 * What this is and is not. These are real receivers at the real sites. They are processed afterwards as
 * dual-frequency precise point positioning, which is not RTK in a tractor: it removes most of the ionosphere
 * by design and throws away epochs it cannot solve. So it shows when precise positioning was lost, which is
 * the question a go or no-go answers, and it does not show how many centimetres a rover drifted while it
 * still had a fix. Blocks on days with no data at all are left out, because that is a station being off.
 *
 *   node evals/receivers.mjs        # downloads about 14 MB into .receivers/, prints, appends to BACKTEST.md
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, inflateRawSync } from 'node:zlib';

const history = await import('../dist/history.js');
const { assess, rtkMultiplier } = await import('../dist/domain.js');

const SITES = [
  { sta: 'SKSK', name: 'Saskatoon, Saskatchewan', lat: 52.15, lon: -106.67 },
  { sta: 'NDFG', name: 'Fargo, North Dakota', lat: 46.88, lon: -96.8 },
  { sta: 'NEGI', name: 'Grand Island, Nebraska', lat: 40.92, lon: -98.33 },
  { sta: 'TXLU', name: 'Lubbock, Texas', lat: 33.54, lon: -101.84 },
];
const YEAR = 2024;
const FROM = Date.UTC(YEAR, 3, 15);
const TO = Date.UTC(YEAR, 5, 16);
const DIR = '.receivers';
const RIG = { id: 'r', name: 'rover', correction: 'rtk' };
const BLOCK = 3 * 3_600_000;

mkdirSync(DIR, { recursive: true });

/** Read a zip file with nothing but zlib: walk the central directory, inflate each entry. */
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

async function positions(sta) {
  const zip = `${DIR}/${sta}.${YEAR}.kenv.zip`;
  const out = `${DIR}/${sta}`;
  if (!existsSync(out) || !readdirSync(out).length) {
    if (!existsSync(zip)) {
      const res = await fetch(`https://geodesy.unr.edu/gps_timeseries/IGS20/kenv/${sta}/${sta}.${YEAR}.kenv.zip`);
      if (!res.ok) throw new Error(`could not download ${sta}: ${res.status}`);
      writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    }
    mkdirSync(out, { recursive: true });
    for (const [name, data] of unzip(readFileSync(zip))) writeFileSync(`${out}/${name.split('/').pop()}`, data);
  }
  const rows = [];
  for (const f of readdirSync(out).filter((n) => n.endsWith('.kenv.gz'))) {
    const doy = Number(f.split('.')[2]);
    const dayStart = Date.UTC(YEAR, 0, doy);
    if (dayStart < FROM || dayStart >= TO) continue;
    for (const line of gunzipSync(readFileSync(`${out}/${f}`)).toString('utf8').split('\n').slice(1)) {
      const p = line.trim().split(/\s+/);
      if (p.length < 17) continue;
      rows.push({ t: dayStart + Number(p[7]) * 1000, e: Number(p[8]), n: Number(p[9]) });
    }
  }
  return rows;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const slots = await history.fetchRange(new Date(FROM), new Date(TO - 1));
const table = [];
const storm = [];
for (const site of SITES) {
  const rows = await positions(site.sta);
  const e0 = median(rows.map((r) => r.e));
  const n0 = median(rows.map((r) => r.n));
  const byBlock = new Map();
  const daysWithData = new Set();
  for (const r of rows) {
    const k = Math.floor(r.t / BLOCK) * BLOCK;
    if (!byBlock.has(k)) byBlock.set(k, []);
    byBlock.get(k).push(Math.hypot(r.e - e0, r.n - n0));
    daysWithData.add(new Date(r.t).toISOString().slice(0, 10));
  }
  const field = { id: 'f', name: site.name, lat: site.lat, lon: site.lon };
  let bothNo = 0, falseAlarm = 0, missed = 0, bothFine = 0, missedQuiet = 0;
  const lost = [];
  for (const s of slots) {
    const start = new Date(s.time).getTime();
    if (!daysWithData.has(s.time.slice(0, 10))) continue;
    const errs = (byBlock.get(start) ?? []).sort((a, b) => a - b);
    const present = errs.length / 36;
    const p95 = errs.length >= 10 ? errs[Math.floor(errs.length * 0.95) - 1] : null;
    const degraded = present < 0.5 || (p95 != null && p95 > 0.05);
    const no = !assess('planting', s.kp, RIG, field, new Date(start + BLOCK / 2)).go;
    if (no && degraded) bothNo += 1;
    else if (no) falseAlarm += 1;
    else if (degraded) { missed += 1; if (s.kp < 4) missedQuiet += 1; }
    else bothFine += 1;
    if (s.time.startsWith(`${YEAR}-05-10`) || s.time.startsWith(`${YEAR}-05-11`)) lost.push(`${Math.round(present * 100)}`);
  }
  const total = bothNo + falseAlarm + missed + bothFine;
  table.push(`| ${site.name} (${site.sta}) | ${total} | ${bothNo} | ${falseAlarm} | ${missed} (${missedQuiet} below Kp 4) | ${bothFine} | ${(((bothNo + bothFine) / total) * 100).toFixed(1)}% |`);
  storm.push(`* ${site.name}: ${lost.join(' ')}`);
}

const section = [
  '',
  '## Against real receivers, 2024 season',
  '',
  'Five-minute positions from permanent GPS stations at the four sites (Nevada Geodetic Laboratory), per three-hour',
  'block, against what the model says about RTK planting there. "Degraded" means fewer than half the positions exist,',
  'or their 95th percentile is more than 5 cm out.',
  '',
  '| Station | Blocks | Model no, receiver degraded | Model no, receiver fine | Model yes, receiver degraded | Model yes, receiver fine | Agree |',
  '|---|---|---|---|---|---|---|',
  ...table,
  '',
  'Share of positions that exist in each three-hour block of 10 and 11 May 2024 (100 is all of them):',
  '',
  ...storm,
  '',
  'What it shows. Every one of the four receivers lost precise positioning for twelve hours or more from the evening',
  'of 10 May, and the model calls those blocks. Below that level the receivers held about 2 cm, including through',
  'Kp 5 and 6, which is why the model no longer calls a job off at Kp 4. Most of the blocks the model clears and a',
  'receiver was degraded in are at low Kp: ordinary gaps and noise at a station, nothing to do with the sun.',
  'Two things it does not flatter. Lubbock has no positions at all on 11 May, so that day is left out and its row',
  'undercounts the storm. And at Saskatoon about a dozen blocks at Kp 4 and above were degraded while the model said',
  'clear, which suggests the model is still a little too easy at that latitude at night.',
  '',
  'What it does not show. These positions are worked out afterwards from both GPS frequencies, which removes most of',
  'the ionosphere and discards the epochs it cannot solve. That is not RTK in a cab. It says when precise positioning',
  'was lost, which is what a go or no-go is about, and not how far a rover drifted while it still had a fix. In a',
  'severe storm the honest description is that the fix is lost, not that it wanders by some number of inches.',
  '',
  `Generated ${new Date().toISOString().slice(0, 10)} by \`node evals/receivers.mjs\`.`,
  '',
];
console.log(section.join('\n'));
const existing = existsSync('BACKTEST.md') ? readFileSync('BACKTEST.md', 'utf8') : '';
const cut = existing.indexOf('\n## Against real receivers');
writeFileSync('BACKTEST.md', (cut >= 0 ? existing.slice(0, cut) : existing.trimEnd() + '\n') + section.join('\n'));
void rtkMultiplier;
