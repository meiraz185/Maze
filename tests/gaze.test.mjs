// Calibration-free gaze engine — automated tests with SIMULATED eye data (js/synthetic.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoLock, defaultModel, GazeEstimator, Calibration, OneEuro } from '../js/gaze.js';
import { syntheticFrame, makeRng, AVERAGE_PERSON, randomPerson } from '../js/synthetic.js';

const DIRV = { center: [0, 0], left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

/** automatic lock-on while the person looks at the centre; returns {est, t, lockMs} */
function autoStart(person = AVERAGE_PERSON, { seed = 1, opts = {}, lockGaze = [0, 0], head = {} } = {}) {
  const rnd = makeRng(seed);
  const lock = new AutoLock();
  let t = 0, neutral = null;
  while (!neutral && t < 10000) {
    neutral = lock.feed(syntheticFrame(lockGaze[0], lockGaze[1], { person, rnd, ...head }), t);
    t += 33;
  }
  assert.ok(neutral, 'auto lock-on happened');
  return { est: new GazeEstimator(defaultModel(neutral), opts), t, lockMs: t, rnd };
}

/** run for ms at 30 fps; gaze/head may be functions of time */
function run(est, ms, t0, { gx = 0, gy = 0, person = AVERAGE_PERSON, rnd = makeRng(7), yaw = 0, pitch = 0, roll = 0, noFace = false, blink = false, noise = 1 } = {}) {
  const dirs = [], states = [];
  let t = t0;
  for (; t < t0 + ms; t += 33) {
    const k = t - t0;
    const v = (q) => (typeof q === 'function' ? q(k) : q);
    const f = v(noFace) ? null : syntheticFrame(v(gx), v(gy), { person, rnd, yaw: v(yaw), pitch: v(pitch), roll: v(roll), blink: v(blink), noise });
    const o = est.update(f, t);
    dirs.push(o.dir); states.push(o.state);
  }
  return { dirs, states, t, last: dirs[dirs.length - 1], state: est.out.state };
}
const moved = (dirs) => dirs.some((d) => d !== 'center');

// ------------------------------------------------------------------ start-up without calibration
test('automatic lock-on: ~1 s of looking at the centre, no calibration targets', () => {
  const { lockMs } = autoStart();
  assert.ok(lockMs >= 1000 && lockMs <= 1600, `locked after ${lockMs} ms`);
});

test('lock-on waits while the eyes wander, then falls back after a few seconds', () => {
  const rnd = makeRng(3);
  const lock = new AutoLock();
  let t = 0, neutral = null;
  for (; t < 3000 && !neutral; t += 33) neutral = lock.feed(syntheticFrame(Math.sin(t / 150) * 0.9, 0, { rnd }), t);
  assert.equal(neutral, null, 'no lock while looking around');
  assert.ok(lock.unstable);
  for (; t < 9000 && !neutral; t += 33) neutral = lock.feed(syntheticFrame(Math.sin(t / 150) * 0.9, 0, { rnd }), t);
  assert.ok(neutral, 'fallback lock so the game never gets stuck');
});

test('lock-on ignores blink frames', () => {
  const rnd = makeRng(4);
  const lock = new AutoLock();
  let t = 0, neutral = null;
  for (; !neutral && t < 5000; t += 33) neutral = lock.feed(syntheticFrame(0, 0, { rnd, blink: (t / 33) % 9 === 0 && t > 200 }), t);
  assert.ok(neutral);
  assert.ok(neutral.open > 0.25, `neutral open ${neutral.open}`);
});

test('a lost face resets the lock-on', () => {
  const lock = new AutoLock();
  const rnd = makeRng(2);
  for (let t = 0; t < 600; t += 33) lock.feed(syntheticFrame(0, 0, { rnd }), t);
  assert.ok(lock.progress > 0.4);
  lock.feed(null, 633);
  assert.equal(lock.progress, 0);
});

// ------------------------------------------------------------------ directions with default thresholds
test('default model: all four directions and centre-stop (average person)', () => {
  const { est, t: t0 } = autoStart();
  let t = t0;
  for (const [d, [gx, gy]] of Object.entries(DIRV)) {
    const r = run(est, 800, t, { gx: gx * 0.85, gy: gy * 0.85 });
    t = r.t;
    assert.equal(r.last, d, `expected ${d}`);
  }
});

test('neutral dead zone: small gaze offsets do not move the ball', () => {
  const { est, t: t0 } = autoStart();
  let t = t0;
  for (const [gx, gy] of [[0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25], [0.2, 0.2]]) {
    const r = run(est, 1500, t, { gx, gy });
    t = r.t;
    assert.ok(!moved(r.dirs), `moved at ${gx},${gy}`);
  }
});

test('steady centre gaze with heavy noise never flickers into a direction (20 s)', () => {
  const { est, t } = autoStart();
  const r = run(est, 20000, t, { noise: 1.6, rnd: makeRng(99) });
  assert.ok(!moved(r.dirs), `flicker: ${r.dirs.filter((d) => d !== 'center').length} frames`);
});

test('hysteresis: weaker gaze keeps moving once started, but does not start from rest', () => {
  const { est, t: t0 } = autoStart();
  let r = run(est, 700, t0, { gx: 0.9 });
  assert.equal(r.last, 'right');
  r = run(est, 1500, r.t, { gx: 0.46 });
  assert.ok(r.dirs.slice(5).every((d) => d === 'right'), 'kept moving');
  const { est: est2, t: t2 } = autoStart();
  r = run(est2, 1500, t2, { gx: 0.46 });
  assert.ok(!moved(r.dirs), 'did not start');
});

test('diagonal gaze is ambiguous and does not start movement', () => {
  const { est, t } = autoStart();
  const r = run(est, 1500, t, { gx: 0.75, gy: 0.75, noise: 0.3 });
  assert.ok(!moved(r.dirs));
});

test('one-frame spikes are filtered (median + dwell)', () => {
  const { est, t: t0 } = autoStart();
  const rnd = makeRng(4);
  const dirs = [];
  for (let i = 0, t = t0; i < 90; i++, t += 33) {
    const spike = i % 20 === 10;
    dirs.push(est.update(syntheticFrame(spike ? 1.5 : 0, spike ? -1.5 : 0, { rnd }), t).dir);
  }
  assert.ok(!moved(dirs), dirs.join(','));
});

// ------------------------------------------------------------------ natural head movement
test('natural head turning and nodding while looking at the centre does not move the ball', () => {
  const { est, t } = autoStart();
  const r = run(est, 12000, t, { yaw: (k) => 14 * Math.sin(k / 900), pitch: (k) => 9 * Math.sin(k / 1300 + 1) });
  assert.ok(!moved(r.dirs), `moved ${r.dirs.filter((d) => d !== 'center').length} frames`);
  assert.ok(r.states.every((s) => s === 'ok' || s === 'headmove'), 'never reported unreliable');
});

test('head held turned 15° / tilted 10° and rolled 20°: no movement and no pause', () => {
  const { est, t: t0 } = autoStart();
  let t = t0;
  for (const h of [{ yaw: 15 }, { yaw: -15 }, { pitch: 10 }, { pitch: -10 }, { roll: 20 }]) {
    const r = run(est, 2500, t, h);
    t = r.t;
    assert.ok(!moved(r.dirs), `moved with ${JSON.stringify(h)}`);
    assert.ok(r.states.slice(-20).every((s) => s === 'ok'), `state ${r.state} with ${JSON.stringify(h)}`);
  }
});

test('strong head tilt (roll 35°): looking screen-right still means right, not diagonal', () => {
  const { est, t: t0 } = autoStart();
  let t = t0;
  for (const roll of [35, -35]) {
    for (const [d, [gx, gy]] of Object.entries(DIRV)) {
      if (d === 'center') continue;
      const r = run(est, 1000, t, { gx: gx * 0.9, gy: gy * 0.9, roll });
      t = r.t;
      assert.equal(r.last, d, `roll ${roll}: expected ${d}`);
      t = run(est, 600, t, { roll }).t;
    }
  }
  // control: without the roll correction the same tilt reads as a diagonal / wrong axis
  const raw = est.raw(syntheticFrame(0.9, 0, { roll: 45, noise: 0 }));
  assert.ok(Math.abs(raw.y) < 0.2 && raw.x > 0.7, `corrected: x ${raw.x.toFixed(2)} y ${raw.y.toFixed(2)}`);
});

test('control still works with the head turned (eyes steer relative to the face)', () => {
  const { est, t: t0 } = autoStart();
  let r = run(est, 900, t0, { gx: 0.85, yaw: 12 });
  assert.equal(r.last, 'right');
  r = run(est, 900, r.t, { gx: -0.85, yaw: 12 });
  assert.equal(r.last, 'left');
  r = run(est, 900, r.t, { gy: 0.9, pitch: -8 });
  assert.equal(r.last, 'down');
});

test('without head compensation the same head turn WOULD steer (control experiment)', () => {
  const { est, t } = autoStart();
  est.model.head.kx = 0;
  const r = run(est, 2000, t, { yaw: 13 });
  assert.ok(moved(r.dirs));
});

test('face turned far away: state "unreliable", ball stops safely, resumes when back', () => {
  const { est, t: t0 } = autoStart();
  let r = run(est, 700, t0, { gx: 0.9 });
  assert.equal(r.last, 'right');
  r = run(est, 600, r.t, { gx: 0.9, yaw: 45 });
  assert.equal(r.state, 'unreliable');
  assert.equal(r.last, 'center');
  r = run(est, 900, r.t, { gx: 0.9 });
  assert.equal(r.last, 'right', 'resumed automatically');
});

test('fast head motion: brief hold, no wrong direction', () => {
  const { est, t: t0 } = autoStart();
  const r = run(est, 1200, t0, { yaw: (k) => (k < 300 ? 0 : k < 450 ? (k - 300) * 0.13 : 19.5) });
  assert.ok(r.states.includes('headmove'));
  assert.ok(!moved(r.dirs), r.dirs.filter((d) => d !== 'center').join(','));
});

// ------------------------------------------------------------------ blinks / tracking loss
test('short blink keeps direction; long eye closure stops', () => {
  const { est, t: t0 } = autoStart();
  let r = run(est, 800, t0, { gy: -0.9 });
  assert.equal(r.last, 'up');
  r = run(est, 200, r.t, { gy: -0.9, blink: true });
  assert.equal(r.last, 'up', 'short blink');
  r = run(est, 900, r.t, { gy: -0.9, blink: true });
  assert.equal(r.last, 'center', 'long closure');
  r = run(est, 900, r.t, { gy: -0.9 });
  assert.equal(r.last, 'up', 'resumes');
});

test('looking down (lowered lids) is not mistaken for a blink', () => {
  const { est, t } = autoStart();
  const r = run(est, 1200, t, { gy: 1.0 });
  assert.equal(r.last, 'down');
  assert.equal(r.state, 'ok');
});

test('lost face stops the ball; recovery resumes without any setup', () => {
  const { est, t: t0 } = autoStart();
  let r = run(est, 700, t0, { gx: -0.9 });
  assert.equal(r.last, 'left');
  r = run(est, 700, r.t, { noFace: true });
  assert.equal(r.last, 'center');
  assert.equal(r.state, 'noface');
  r = run(est, 900, r.t, { gx: -0.9 });
  assert.equal(r.last, 'left');
});

// ------------------------------------------------------------------ neutral re-centring
test('intro re-centre fixes a neutral captured while looking off-centre', () => {
  const { est, t: t0 } = autoStart(AVERAGE_PERSON, { lockGaze: [0.35, 0.3] });
  let r = run(est, 1500, t0, {});            // looking at the true centre now reads as up-left
  est.beginRecenter();
  r = run(est, 1200, r.t, {});               // player looks at the countdown in the middle
  assert.ok(est.endRecenter(), 'applied');
  r = run(est, 2000, r.t, { gx: -0.3 });
  assert.ok(!moved(r.dirs), 'small offsets no longer move the ball');
  r = run(est, 900, r.t, { gx: 0.85 });
  assert.equal(r.last, 'right');
});

test('re-centre is rejected if the eyes were not steady', () => {
  const { est, t } = autoStart();
  est.beginRecenter();
  run(est, 1200, t, { gx: (k) => Math.sin(k / 80) * 0.9 });
  assert.equal(est.endRecenter(), false);
});

test('slow re-centring drifts toward the actual neutral while resting near the centre', () => {
  const { est, t: t0 } = autoStart(AVERAGE_PERSON, { lockGaze: [0.25, 0] });
  const before = run(est, 300, t0, {});
  const x0 = est.out.x;
  run(est, 15000, before.t, {});
  assert.ok(Math.abs(est.out.x) < Math.abs(x0) * 0.35, `x ${x0.toFixed(2)} → ${est.out.x.toFixed(2)}`);
});

test('holding a direction does NOT get absorbed by re-centring', () => {
  const { est, t } = autoStart();
  const r = run(est, 15000, t, { gx: 0.85 });
  assert.ok(r.dirs.slice(30).every((d) => d === 'right'));
});

// ------------------------------------------------------------------ settings
test('sensitivity setting rescues a person with weak eye signals', () => {
  const weak = { ...AVERAGE_PERSON, gh: AVERAGE_PERSON.gh * 0.55, gbh: AVERAGE_PERSON.gbh * 0.55 };
  let { est, t } = autoStart(weak);
  let r = run(est, 1500, t, { gx: 0.85, person: weak });
  assert.equal(r.last, 'center', 'default sensitivity: does not reach the threshold');
  est.setOpts({ sens: 1.6 });
  r = run(est, 1500, r.t, { gx: 0.85, person: weak });
  assert.equal(r.last, 'right', 'raised sensitivity works');
  r = run(est, 1500, r.t, { person: weak, noise: 1.3 });
  assert.equal(r.last, 'center', 'and still stops at the centre');
});

test('vertical boost setting only affects up/down', () => {
  const weakV = { ...AVERAGE_PERSON, gv: AVERAGE_PERSON.gv * 0.5, lidDown: AVERAGE_PERSON.lidDown * 0.5, lidUp: AVERAGE_PERSON.lidUp * 0.5, gbv: AVERAGE_PERSON.gbv * 0.5 };
  const { est, t } = autoStart(weakV);
  let r = run(est, 1500, t, { gy: -0.85, person: weakV });
  assert.equal(r.last, 'center');
  est.setOpts({ vsens: 1.9 });
  r = run(est, 1500, r.t, { gy: -0.85, person: weakV });
  assert.equal(r.last, 'up');
  const raw = est.raw(syntheticFrame(0.85, 0, { person: weakV, noise: 0 }));
  assert.ok(Math.abs(raw.x - 0.85) < 0.2, 'horizontal unaffected');
});

test('mirrored camera: swapped by default, fixed by the "swap left/right" setting', () => {
  const mirrored = { ...AVERAGE_PERSON, mirror: true };
  const { est, t } = autoStart(mirrored);
  let r = run(est, 900, t, { gx: 0.85, person: mirrored });
  assert.equal(r.last, 'left', 'without the setting, left/right are reversed');
  est.setOpts({ mirror: true });
  r = run(est, 900, r.t, { gx: 0.85, person: mirrored });
  assert.equal(r.last, 'right');
  r = run(est, 3000, r.t, { person: mirrored, yaw: (k) => 12 * Math.sin(k / 600) });
  assert.ok(!moved(r.dirs.slice(10)), 'head compensation flips with it');
});

// ------------------------------------------------------------------ optional quick calibration
function quickCal(person, seed = 1) {
  const rnd = makeRng(seed);
  const cal = new Calibration();
  for (const [t, [gx, gy]] of Object.entries(DIRV)) for (let i = 0; i < 30; i++) cal.add(t, syntheticFrame(gx, gy, { person, rnd }));
  return cal.compute();
}

test('quick calibration produces a personal model and rescues a weak person', () => {
  const weak = { ...AVERAGE_PERSON, gh: AVERAGE_PERSON.gh * 0.5, gbh: AVERAGE_PERSON.gbh * 0.5, gv: AVERAGE_PERSON.gv * 0.5, lidDown: AVERAGE_PERSON.lidDown * 0.5, lidUp: AVERAGE_PERSON.lidUp * 0.5, gbv: AVERAGE_PERSON.gbv * 0.5 };
  const res = quickCal(weak);
  assert.ok(res.ok, res.issues.join(' '));
  assert.equal(res.model.kind, 'personal');
  const est = new GazeEstimator(res.model);
  let t = 0;
  for (const [d, [gx, gy]] of Object.entries(DIRV)) {
    const r = run(est, 900, t, { gx: gx * 0.85, gy: gy * 0.85, person: weak });
    t = r.t;
    assert.equal(r.last, d, `expected ${d}`);
  }
  const r = run(est, 6000, t, { person: weak, yaw: (k) => 12 * Math.sin(k / 700) });
  assert.ok(!moved(r.dirs.slice(10)), 'head compensation still active in a personal model');
});

test('quick calibration detects a mirrored camera by itself', () => {
  const res = quickCal({ ...AVERAGE_PERSON, mirror: true });
  assert.ok(res.ok);
  assert.equal(res.model.mirror, true);
  const est = new GazeEstimator(res.model);
  const r = run(est, 900, 0, { gx: 0.85, person: { ...AVERAGE_PERSON, mirror: true } });
  assert.equal(r.last, 'right');
});

test('quick calibration refuses a signal with no eye movement', () => {
  const rnd = makeRng(1);
  const cal = new Calibration();
  for (const tg of Object.keys(DIRV)) for (let i = 0; i < 30; i++) cal.add(tg, syntheticFrame(0, 0, { rnd }));
  assert.equal(cal.compute().ok, false);
});

// ------------------------------------------------------------------ robustness across a simulated population
test('population of 300 simulated people with the calibration-free defaults', () => {
  const rnd = makeRng(2024);
  const N = 300;
  const hit = { left: 0, right: 0, up: 0, down: 0 };
  let falseCentre = 0, falseHead = 0, wrongDir = 0;
  for (let i = 0; i < N; i++) {
    const person = randomPerson(rnd);
    const { est, t: t0 } = autoStart(person, { seed: 100 + i });
    let t = t0;
    let r = run(est, 6000, t, { person, rnd, yaw: 0 });
    if (moved(r.dirs)) falseCentre++;
    t = r.t;
    r = run(est, 6000, t, { person, rnd, yaw: (k) => 12 * Math.sin(k / 800), pitch: (k) => 8 * Math.sin(k / 1100 + 2) });
    if (moved(r.dirs)) falseHead++;
    t = r.t;
    for (const d of ['left', 'right', 'up', 'down']) {
      const [gx, gy] = DIRV[d];
      r = run(est, 1200, t, { person, rnd, gx: gx * 0.9, gy: gy * 0.9 });
      if (r.last === d) hit[d]++;
      else if (r.last !== 'center') wrongDir++;
      r = run(est, 800, r.t, { person, rnd });
      t = r.t;
    }
  }
  const pct = (n) => `${((100 * n) / N).toFixed(1)}%`;
  console.log(`    looking 90% of the way to the edge → detected: left ${pct(hit.left)}, right ${pct(hit.right)}, up ${pct(hit.up)}, down ${pct(hit.down)}`);
  console.log(`    wrong direction: ${pct(wrongDir)} · moved while looking at the centre: ${pct(falseCentre)} · moved during natural head motion: ${pct(falseHead)}`);
  assert.ok(hit.left / N > 0.95 && hit.right / N > 0.95, 'horizontal works for almost everyone');
  assert.ok(hit.up / N > 0.75 && hit.down / N > 0.75, 'vertical works for most (weaker by design)');
  assert.ok(wrongDir === 0, 'never a wrong direction');
  assert.ok(falseCentre / N < 0.02 && falseHead / N < 0.05, 'rarely moves on its own');
});

test('One Euro filter converges to a step input', () => {
  const f = new OneEuro(1.2, 0.4);
  let v = 0;
  for (let t = 0; t < 1000; t += 33) v = f.filter(t < 100 ? 0 : 1, t);
  assert.ok(Math.abs(v - 1) < 0.02);
});
