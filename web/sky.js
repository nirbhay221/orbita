/*
 * The sky behind the page.
 *
 * Stars that drift a little with the pointer, an aurora whose brightness follows the live Kp this server reads
 * (from /health, NOAA's predicted Kp), and a few satellites crossing. Bring the pointer near one and it draws the
 * line a receiver would: a fix. It is decoration, so it is never in the way: behind everything, ignored by
 * assistive technology, still for anyone who asked for reduced motion, and paused when the tab is not showing.
 */
const canvas = document.createElement('canvas');
canvas.className = 'sky';
canvas.setAttribute('aria-hidden', 'true');
document.body.prepend(canvas);
const ctx = canvas.getContext('2d');

const still = window.matchMedia('(prefers-reduced-motion: reduce)');
const prefersLight = window.matchMedia('(prefers-color-scheme: light)');
const isLight = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'light' : prefersLight.matches;
};

let w = 0, h = 0, dpr = 1;
let stars = [];
let sats = [];
let kp = 2;
const pointer = { x: -9999, y: -9999, tx: 0, ty: 0, px: 0, py: 0 };

function seed() {
  dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  w = window.innerWidth;
  h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const n = Math.round(Math.min(260, (w * h) / 6500));
  stars = Array.from({ length: n }, () => ({
    x: Math.random() * w,
    y: Math.random() * h,
    r: Math.random() * 1.1 + 0.25,
    depth: [0.2, 0.5, 1][Math.floor(Math.random() * 3)],
    phase: Math.random() * Math.PI * 2,
    speed: 0.4 + Math.random() * 1.2,
  }));
  sats = Array.from({ length: 3 }, (_, i) => newSat(i));
}

function newSat(i = 0) {
  // A shallow arc across the upper sky, each at its own pace, staggered so they are not in step.
  const fromLeft = Math.random() < 0.5;
  return {
    t: -0.15 - i * 0.35 - Math.random() * 0.3,
    speed: 0.00006 + Math.random() * 0.00005,
    fromLeft,
    y0: h * (0.12 + Math.random() * 0.4),
    lift: h * (0.05 + Math.random() * 0.12),
  };
}

function satPos(s) {
  const x = s.fromLeft ? -40 + s.t * (w + 80) : w + 40 - s.t * (w + 80);
  const y = s.y0 - Math.sin(Math.min(Math.max(s.t, 0), 1) * Math.PI) * s.lift;
  return { x, y };
}

function aurora(time, light) {
  // Two soft curtains across the top. Quiet at Kp 1, plainly there at Kp 5, bright in a storm.
  const strength = Math.min(1, 0.4 + Math.max(0, kp) / 8);
  const bands = light
    ? [[255, 181, 71], [255, 214, 140]]
    : [[64, 220, 160], [120, 140, 255]];
  for (let b = 0; b < bands.length; b++) {
    const [r, g, bl] = bands[b];
    const base = h * (0.1 + b * 0.09);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    for (let x = 0; x <= w + 40; x += 40) {
      const y = base + Math.sin(x / 260 + time * 0.00018 * (b + 1) + b) * 26 + Math.sin(x / 120 - time * 0.00025) * 10;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, 0);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, base + 60);
    const a = (light ? 0.12 : 0.2) * strength;
    grad.addColorStop(0, `rgba(${r},${g},${bl},0)`);
    grad.addColorStop(0.55, `rgba(${r},${g},${bl},${a})`);
    grad.addColorStop(1, `rgba(${r},${g},${bl},0)`);
    ctx.fillStyle = grad;
    ctx.fill();
  }
}

function frame(time) {
  const light = isLight();
  ctx.clearRect(0, 0, w, h);

  // The pointer eases, so the sky follows it gently rather than snapping.
  pointer.px += (pointer.tx - pointer.px) * 0.05;
  pointer.py += (pointer.ty - pointer.py) * 0.05;

  aurora(time, light);

  for (const s of stars) {
    const twinkle = still.matches ? 0.8 : 0.55 + 0.45 * Math.sin(time * 0.001 * s.speed + s.phase);
    const x = s.x + pointer.px * 14 * s.depth;
    const y = s.y + pointer.py * 10 * s.depth;
    ctx.beginPath();
    ctx.arc(x, y, s.r * (light ? 0.9 : 1), 0, Math.PI * 2);
    ctx.fillStyle = light ? `rgba(20,40,80,${0.18 * twinkle * s.depth + 0.04})` : `rgba(235,240,255,${0.75 * twinkle * (0.4 + s.depth * 0.6)})`;
    ctx.fill();
  }

  for (let i = 0; i < sats.length; i++) {
    const s = sats[i];
    if (!still.matches) s.t += s.speed * 16;
    if (s.t > 1.15) sats[i] = newSat();
    if (s.t < 0 || s.t > 1) continue;
    const p = satPos(s);
    // A short trail behind it.
    const back = satPos({ ...s, t: s.t - 0.02 });
    const trail = ctx.createLinearGradient(back.x, back.y, p.x, p.y);
    trail.addColorStop(0, 'rgba(255,181,71,0)');
    trail.addColorStop(1, light ? 'rgba(168,90,0,0.5)' : 'rgba(255,200,120,0.6)');
    ctx.strokeStyle = trail;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(back.x, back.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
    ctx.fillStyle = light ? 'rgba(168,90,0,0.85)' : 'rgba(255,214,150,0.95)';
    ctx.fill();

    // Near the pointer, the satellite "locks": a fine line to the cursor and a ring that pulses.
    const dx = pointer.x - p.x, dy = pointer.y - p.y;
    const d = Math.hypot(dx, dy);
    if (d < 220) {
      const a = 1 - d / 220;
      ctx.strokeStyle = light ? `rgba(168,90,0,${0.45 * a})` : `rgba(255,190,90,${0.5 * a})`;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(pointer.x, pointer.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6 + 4 * Math.sin(time * 0.006), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

let raf = 0;
function loop(time) {
  frame(time);
  raf = still.matches || document.hidden ? 0 : requestAnimationFrame(loop);
}
function start() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  if (still.matches) frame(performance.now());
  else raf = requestAnimationFrame(loop);
}

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { seed(); start(); }, 150);
});
window.addEventListener('pointermove', (e) => {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.tx = e.clientX / Math.max(1, w) - 0.5;
  pointer.ty = e.clientY / Math.max(1, h) - 0.5;
}, { passive: true });
window.addEventListener('pointerleave', () => { pointer.x = pointer.y = -9999; });
document.addEventListener('visibilitychange', () => { if (!document.hidden) start(); });
still.addEventListener?.('change', start);
prefersLight.addEventListener?.('change', start);
// The theme button changes data-theme; redraw once at once so a still sky changes colour too.
new MutationObserver(() => { if (still.matches) frame(performance.now()); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

async function readKp() {
  try {
    const health = await (await fetch('/health', { cache: 'no-store' })).json();
    const v = Number(health?.swpc?.predictedKp);
    if (Number.isFinite(v)) kp = v;
    if (still.matches) frame(performance.now());
  } catch { /* the sky stays as it was */ }
}

seed();
start();
void readKp();
setInterval(readKp, 10 * 60_000);
