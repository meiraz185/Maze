// Reports how the calibration-free defaults hold up across simulated people with increasingly
// different eyes/setups.  node tests/population-report.mjs     (simulation only — not real users)
import { AutoLock, defaultModel, GazeEstimator, PRIORS } from '../js/gaze.js';
import { syntheticFrame, makeRng, gauss, AVERAGE_PERSON } from '../js/synthetic.js';

const DIRV = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
function person(rnd, s) {
  const f = (k) => Math.exp(gauss(rnd) * k * s);
  return { ...AVERAGE_PERSON, gh: PRIORS.ih * f(0.18), gbh: PRIORS.bh * f(0.25), gv: PRIORS.iv * f(0.25), lidDown: PRIORS.lidDown * f(0.25),
    lidUp: PRIORS.lidUp * f(0.25), gbv: PRIORS.bv * f(0.3), ih0: 0.5 + gauss(rnd) * 0.02, iv0: -0.09 + gauss(rnd) * 0.02,
    open0: 0.33 * f(0.15), bh0: gauss(rnd) * 0.05, bv0: -0.2 + gauss(rnd) * 0.08, edgeX: PRIORS.edgeDegX * f(0.15), edgeY: PRIORS.edgeDegY * f(0.15), noise: f(0.3) };
}
function trial(p, rnd, sens = {}) {
  const lock = new AutoLock(); let t = 0, n = null;
  while (!n) { n = lock.feed(syntheticFrame(0, 0, { person: p, rnd }), t); t += 33; }
  const est = new GazeEstimator(defaultModel(n), sens);
  const res = {};
  const run = (ms, o) => { let last; for (const e = t + ms; t < e; t += 33) last = est.update(syntheticFrame(o.gx || 0, o.gy || 0, { person: p, rnd, yaw: o.yaw ? o.yaw(t) : 0, pitch: o.pitch ? o.pitch(t) : 0 }), t).dir; return last; };
  let movedIdle = false;
  for (const e = t + 6000; t < e; t += 33) if (est.update(syntheticFrame(0, 0, { person: p, rnd, yaw: 12 * Math.sin(t / 800), pitch: 8 * Math.sin(t / 1100) }), t).dir !== 'center') movedIdle = true;
  res.idle = movedIdle;
  for (const [d, [gx, gy]] of Object.entries(DIRV)) { res[d] = run(1200, { gx: gx * 0.9, gy: gy * 0.9 }); run(800, {}); }
  return res;
}
console.log('spread  | left  right   up    down  | wrong dir | moves by itself');
for (const s of [1, 1.5, 2, 2.5]) {
  const rnd = makeRng(77); const N = 200; const c = { left: 0, right: 0, up: 0, down: 0, wrong: 0, idle: 0 };
  for (let i = 0; i < N; i++) {
    const r = trial(person(rnd, s), rnd);
    for (const d of Object.keys(DIRV)) { if (r[d] === d) c[d]++; else if (r[d] !== 'center') c.wrong++; }
    if (r.idle) c.idle++;
  }
  const p = (k) => `${((100 * c[k]) / N).toFixed(0).padStart(3)}%`;
  console.log(`x${s.toFixed(1)}    | ${p('left')}  ${p('right')}  ${p('up')}  ${p('down')} |   ${((100 * c.wrong) / (N * 4)).toFixed(1)}%    |   ${p('idle')}`);
}
