// End-to-end browser test in TEST MODE (synthetic eyes, no camera) of the v4 hands-free flow:
// no calibration, automatic lock-on and start, natural head movement without pauses, small status
// indicator on tracking loss, settings, optional quick calibration kept across levels and restarts,
// all three levels, success screen and automatic replay.
//   CHROME=/path/to/chrome SHOTS=dir node tests/browser-game.mjs
import puppeteer from 'puppeteer-core';
import { serve } from './serve.mjs';

const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const SHOTS = process.env.SHOTS || null;
const PORT = 8123;

const server = await serve(PORT);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--window-size=1280,800'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const phase = () => ev(() => window.eyeMaze.phase);
const waitPhase = async (want, ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if ((await phase()) === want) return Date.now() - t0; await wait(50); }
  throw new Error(`timeout waiting for phase ${want} (now ${await phase()})`);
};
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
let passed = 0;
const ok = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); passed++; console.log('  ✓', msg); };
const ball = () => ev(() => ({ x: window.eyeMaze.ball.x, y: window.eyeMaze.ball.y }));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const statusText = () => ev(() => document.getElementById('status').hidden ? '' : document.getElementById('status-text').textContent);

/** one autopilot step: choose where to LOOK from the maze solution (drives synthetic gaze, never the ball) */
const steer = () => ev(() => {
  const a = window.eyeMaze;
  if (a.phase !== 'play') return { phase: a.phase, idx: a.levelIdx };
  const m = a.maze, b = a.ball, cell = { x: Math.floor(b.x), y: Math.floor(b.y) };
  const key = (c) => c.x + ',' + c.y, prev = new Map([[key(cell), null]]), q = [cell];
  const D = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
  while (q.length) {
    const c = q.shift();
    if (c.x === m.goal.x && c.y === m.goal.y) break;
    for (const d in D) if (m.passable(c.x, c.y, d, 'open')) { const n = { x: c.x + D[d][0], y: c.y + D[d][1] }; if (!prev.has(key(n))) { prev.set(key(n), c); q.push(n); } }
  }
  let c = m.goal;
  while (c && prev.get(key(c)) && key(prev.get(key(c))) !== key(cell)) c = prev.get(key(c));
  let want;
  if (!c || key(c) === key(cell)) want = b.x < m.goal.x + 0.5 ? 'right' : 'left';
  else want = c.x > cell.x ? 'right' : c.x < cell.x ? 'left' : c.y > cell.y ? 'down' : 'up';
  const horiz = want === 'left' || want === 'right';
  const lane = horiz ? b.y - (cell.y + 0.5) : b.x - (cell.x + 0.5);
  let look = want;
  if (Math.abs(lane) > 0.15) look = horiz ? (lane > 0 ? 'up' : 'down') : (lane > 0 ? 'left' : 'right');
  const G = { left: [-0.9, 0], right: [0.9, 0], up: [0, -0.9], down: [0, 0.9] }[look];
  a.setGaze(G[0], G[1]);
  return { phase: a.phase, idx: a.levelIdx };
});

try {
  // ------------------------------------------------ start: one click, then nothing
  await page.goto(`http://127.0.0.1:${PORT}/?test`, { waitUntil: 'load' });
  await shot('01-start');
  await page.click('#btn-start');
  await waitPhase('lock', 5000);
  await wait(500);
  await shot('02-lock');
  const tPlay = await waitPhase('play', 15000);
  ok(true, `face found → tracking locked → level 1 started automatically (${(tPlay / 1000).toFixed(1)} s after the click, no calibration)`);
  ok(await ev(() => window.eyeMaze.stats.calibrations === 0 && document.getElementById('calib').hidden), 'no calibration screen was shown');
  ok(await ev(() => window.eyeMaze.est.model.kind === 'auto'), 'tracking runs on the calibration-free model');
  await shot('03-play');

  // ------------------------------------------------ neutral gaze + natural head movement
  const b0 = await ball();
  await ev(() => window.eyeMaze.setHead(14, 0)); await wait(1200);
  await ev(() => window.eyeMaze.setHead(-12, 8)); await wait(1200);
  await ev(() => window.eyeMaze.setHead(0, -9)); await wait(1200);
  await ev(() => window.eyeMaze.setHead(0, 0)); await wait(600);
  ok(dist(b0, await ball()) < 0.01, 'looking at the centre while turning/tilting the head: ball stays still');
  ok(!(await statusText()), 'no head-movement message or pause');
  ok(await ev(() => !document.getElementById('pause')), 'the blocking "HEAD MOVED" overlay no longer exists');

  // ------------------------------------------------ steering (+ with head turned)
  await ev(() => window.eyeMaze.setGaze(0.9, 0)); await wait(900);
  const dirR = await ev(() => window.eyeMaze.est.out.dir);
  await ev(() => window.eyeMaze.setGaze(0, 0)); await wait(700);
  ok(dirR === 'right', `looking right → ball rolls right`);
  ok(await ev(() => window.eyeMaze.est.out.dir) === 'center', 'looking back at the centre → stops');
  await ev(() => { window.eyeMaze.setHead(12, 0); window.eyeMaze.setGaze(0, 0.9); }); await wait(1100);
  ok(await ev(() => window.eyeMaze.est.out.dir) === 'down', 'looking down with the head turned 12° → down');
  await ev(() => { window.eyeMaze.setHead(0, 0); window.eyeMaze.setGaze(0, 0); }); await wait(800);

  // ------------------------------------------------ blink + tracking loss
  await ev(() => window.eyeMaze.setBlink(true)); await wait(200); await ev(() => window.eyeMaze.setBlink(false)); await wait(400);
  ok(!(await statusText()), 'short blink: nothing shown');
  const tm0 = await ev(() => window.eyeMaze.levelTime);
  await ev(() => window.eyeMaze.setFace(false)); await wait(1500);
  const lostText = await statusText();
  ok(/looking for your face/.test(lostText), `face lost → small status "${lostText}" (game not blocked)`);
  await shot('04-face-lost');
  const tm1 = await ev(() => window.eyeMaze.levelTime);
  ok(tm1 - tm0 < 1.0, `level clock holds while the face is missing (+${(tm1 - tm0).toFixed(2)} s)`);
  await ev(() => window.eyeMaze.setFace(true)); await wait(900);
  ok(!(await statusText()) && (await ev(() => window.eyeMaze.est.out.state)) === 'ok', 'face back → resumes automatically');
  await ev(() => window.eyeMaze.setHead(45, 0)); await wait(1300);
  ok(/turned/.test(await statusText()), 'face turned far away → small "face turned away" status, ball stopped');
  await ev(() => window.eyeMaze.setHead(0, 0)); await wait(900);

  // ------------------------------------------------ settings (optional)
  await page.click('#btn-settings'); await wait(300);
  await shot('05-settings');
  ok(await ev(() => window.eyeMaze.paused), 'settings open → game paused');
  const bS = await ball();
  await ev(() => window.eyeMaze.setGaze(0.9, 0)); await wait(900);
  ok(dist(bS, await ball()) < 0.01, 'ball does not move while settings are open');
  await ev(() => window.eyeMaze.setGaze(0, 0));
  await ev(() => { const s = document.getElementById('sl-sens'); s.value = '1.4'; s.dispatchEvent(new Event('input')); const v = document.getElementById('sl-vsens'); v.value = '1.3'; v.dispatchEvent(new Event('input')); });
  ok(await ev(() => window.eyeMaze.est.opts.sens === 1.4 && window.eyeMaze.est.opts.vsens === 1.3), 'sensitivity sliders apply immediately');

  // ------------------------------------------------ optional quick calibration
  await page.click('#btn-quickcal');
  await waitPhase('calibrating', 3000);
  await wait(800); await shot('06-quickcal');
  await waitPhase('intro', 20000);
  ok(await ev(() => window.eyeMaze.est.model.kind === 'personal' && window.eyeMaze.stats.calibrations === 1), 'optional quick calibration → personal model');
  await waitPhase('play', 6000);
  ok(true, 'after calibrating, the level continues automatically');

  // ------------------------------------------------ play all three levels by "looking"
  let done = 0, playShot = -1;
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const st = await steer();
    if (st.phase === 'play' && playShot !== st.idx) { await wait(1500); await shot(`07-play-L${st.idx + 1}`); playShot = st.idx; }
    if (st.phase === 'transition' && done === st.idx) { done++; console.log(`  ✓ level ${st.idx + 1} completed → automatic transition`); await ev(() => window.eyeMaze.setGaze(0, 0)); }
    if (st.phase === 'intro') await ev(() => window.eyeMaze.setGaze(0, 0));
    if (st.phase === 'success') break;
    await wait(60);
  }
  ok(done === 3, 'all three levels completed');
  await wait(700); await shot('08-success');
  ok(await ev(() => window.eyeMaze.est.model.kind === 'personal' && window.eyeMaze.est.opts.sens === 1.4), 'calibration + settings kept through all level transitions');
  ok(await ev(() => window.eyeMaze.stats.locks === 1), 'tracking was set up once (no re-lock between levels)');
  const times = await ev(() => window.eyeMaze.times);
  ok(times.length === 3 && times.every((t) => t > 0), `success screen with times ${times.map((t) => t.toFixed(1) + 's').join(', ')}`);

  // ------------------------------------------------ hands-free replay
  const tr = await waitPhase('intro', 12000);
  ok(true, `success → new run started automatically after ${(tr / 1000).toFixed(1)} s`);
  await waitPhase('play', 6000);
  ok(await ev(() => window.eyeMaze.levelIdx === 0 && window.eyeMaze.est.model.kind === 'personal' && window.eyeMaze.stats.calibrations === 1), 'replay: level 1, same calibration, nothing repeated');

  // ------------------------------------------------ back to automatic + re-centre
  await ev(() => window.eyeMaze.openSettings()); await page.click('#btn-auto'); await page.click('#btn-recenter');
  await waitPhase('play', 6000);
  ok(await ev(() => window.eyeMaze.est.model.kind === 'auto' && window.eyeMaze.stats.recentres >= 1), '"Back to automatic" and "Re-centre" work');

  // ------------------------------------------------ stuck guard: a wrong neutral is noticed and fixed by itself
  await ev(() => { window.eyeMaze.setGaze(0, 0); window.eyeMaze.setPerson({ ih0: 0.59 }); }); // as if locked while looking aside
  let fixed = false;
  for (let i = 0; i < 120 && !fixed; i++) { await wait(100); fixed = await ev(() => (window.eyeMaze.stats.autoRecentres || 0) >= 1); }
  ok(fixed, 'drifting into a wall for 3 s → automatic re-centre (no menu, no calibration)');
  await shot('10-auto-recentre');
  await waitPhase('play', 6000);
  const bA = await ball(); await wait(2000);
  ok(dist(bA, await ball()) < 0.01, 'after the automatic re-centre the ball rests when looking at the centre');
  await ev(() => { window.eyeMaze.setPerson({ ih0: 0.5 }); window.eyeMaze.startRecenter(); });
  await waitPhase('play', 6000);

  // ------------------------------------------------ portrait / small screen layout
  await page.setViewport({ width: 390, height: 844 });
  await ev(() => { window.eyeMaze.setGaze(0, 0); window.eyeMaze.jumpToLevel(1); });
  await waitPhase('play', 8000); await wait(500);
  await shot('09-portrait');
  const fits = await ev(() => { const r = document.getElementById('stage').getBoundingClientRect(); return document.documentElement.scrollWidth <= innerWidth && r.width <= innerWidth; });
  ok(fits, 'portrait phone layout: no horizontal overflow');

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  console.log(`BROWSER GAME TEST PASSED (${passed} checks)`);
} catch (e) {
  console.error(e.message);
  await shot('zz-failure');
  console.error('errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
