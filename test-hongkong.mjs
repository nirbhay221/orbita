/**
 * Hong Kong, National Day 2024: a quiet sky and a cancelled drone show.
 *
 * On 30 September and 1 October 2024 the drone shows over Victoria Harbour were called off minutes before they
 * started, because the drones could not hold a strong satellite fix; the organisers and the government put it down
 * to ionospheric scintillation, and a drone association chairman pointed at the RTK positioning. Kp was 1 and 1.3.
 * Across the border Shenzhen's shows went ahead, because they could be moved to when it was safe.
 *
 * Victoria Harbour sits about 13 degrees from the magnetic equator, and early October is equinox season, the time of
 * evening plasma bubbles. So this is the case a Kp-only answer gets wrong: it says go on a quiet night. Orbita must
 * say hold for those evenings and clear at midday, which is the Shenzhen answer: move it.
 *   https://www.scmp.com/news/hong-kong/society/article/3280850/why-did-shenzhens-national-day-drone-show-go-ahead-not-hong-kongs
 *   https://tyr-jour.hkbu.edu.hk/2024/10/03/national-day-fireworks-light-up-victoria-harbour-but-drone-show-cancelled-again/
 */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const { assess, geomagneticLatitude } = await import('./dist/domain.js');
const { slots } = JSON.parse(readFileSync('./evals/hongkong-2024-kp.json', 'utf8'));
const harbour = { id: 'hk', name: 'Victoria Harbour', lat: 22.29, lon: 114.17 };
const show = { id: 'show', name: 'show drones', correction: 'rtk' };
const kpAt = (iso) => slots.filter((s) => new Date(s.time) <= new Date(iso)).pop().kp;
const judge = (iso) => assess('drone_survey', kpAt(iso), show, harbour, new Date(iso));

console.log('\nThe evenings the shows were cancelled, at 8 pm Hong Kong time');
check('Victoria Harbour is within 15 degrees of the magnetic equator', Math.abs(geomagneticLatitude(harbour.lat, harbour.lon)) < 15);
for (const iso of ['2024-09-30T12:00:00Z', '2024-10-01T12:00:00Z']) {
  const v = judge(iso);
  check(`${iso.slice(0, 10)}: Kp ${kpAt(iso)} is quiet, and still a hold for RTK drones`, kpAt(iso) < 3 && v.go === false && /plasma bubbles/.test(v.reason), v.reason);
}
console.log('\nThe Shenzhen answer: the same drones, moved');
const noon = judge('2024-10-01T04:00:00Z');
check('at midday the same day it is clear', noon.go === true, noon.reason);
const late = judge('2024-10-01T18:00:00Z');
check('...and after midnight it is clear again', late.go === true, late.reason);

console.log('\nThe solar cycle decides how often the bubbles come');
const { setSolarFlux, quietSun } = await import('./dist/domain.js');
setSolarFlux(200);
check('at F10.7 200, near solar maximum, the evening is still a hold', judge('2024-10-01T12:00:00Z').go === false && !quietSun());
setSolarFlux(70);
check('at F10.7 70, the deepest solar minimum, the evening alone is not a hold', quietSun() && judge('2024-10-01T12:00:00Z').go === true);
setSolarFlux(null);
check('with no flux read, the rule stands as it always did', !quietSun() && judge('2024-10-01T12:00:00Z').go === false);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
