// The REAL camera code path + REAL MediaPipe model, with Chrome's fake webcam playing a recorded video
// made from a real face photo (see make-recording.mjs). Checks the hands-free start and how the
// calibration-free tracking reacts to rest, iris shifts and in-plane head movement.
//   MODEL=... VIDEO=rec/recording.y4m SEGMENTS=rec/segments.json node tests/browser-camera.mjs
// This is NOT a live test with a person: real eye movement also moves lids and shading, and real head
// turns (yaw/pitch) cannot be produced from a single photo.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { serve } from './serve.mjs';

const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const SEG = JSON.parse(fs.readFileSync(process.env.SEGMENTS));
const PORT = 8125;
const server = await serve(PORT, { overrides: process.env.MODEL ? { '/models/face_landmarker.task': process.env.MODEL } : {} });
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${process.env.VIDEO}`, '--window-size=1280,800'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
let failed = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗', m); if (!c) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (fn, ...a) => page.evaluate(fn, ...a);
try {
  await page.goto(`http://localhost:${PORT}/`);
  await wait(800);
  const autoStarted = await ev(() => window.eyeMaze.phase !== 'start');
  if (autoStarted) console.log('    camera permission already granted → started without any click');
  else await page.click('#btn-start');
  const t0 = Date.now();
  while (Date.now() - t0 < 60000 && !(await ev(() => !!(window.eyeMaze.tracker)))) await wait(100);
  // log every tracked frame against the position in the recording
  await ev(() => {
    const a = window.eyeMaze, v = document.getElementById('cam');
    a.__log = [];
    a.tracker.onFrame(() => { const o = a.est && a.est.out; a.__log.push({ vt: v.currentTime, phase: a.phase, dir: o ? o.dir : null, state: o ? o.state : null, x: o ? o.x : 0, y: o ? o.y : 0 }); });
  });
  const info = await ev(() => ({ d: window.eyeMaze.tracker.delegate, src: window.eyeMaze.tracker.modelSource }));
  console.log(`    camera started; delegate ${info.d}, model ${info.src}`);
  let playAt = null;
  for (let i = 0; i < 400; i++) {
    const s = await ev(() => ({ phase: window.eyeMaze.phase, vt: document.getElementById('cam').currentTime, locks: window.eyeMaze.stats.locks, cals: window.eyeMaze.stats.calibrations }));
    if (s.phase === 'play' && playAt === null) { playAt = s.vt; ok(s.locks === 1 && s.cals === 0, `face found → locked → level 1 started by itself at ${s.vt.toFixed(1)} s of video (no calibration)`); }
    if (s.vt > SEG.duration - 0.5) break;
    await wait(200);
  }
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/camera-play.png` });
  const fps = await ev(() => window.eyeMaze.tracker.fps);
  const log = (await ev(() => window.eyeMaze.__log)).filter((r) => r.vt < SEG.duration && r.phase === 'play');
  console.log(`    ${log.length} tracked frames during play (~${fps.toFixed(1)} fps in this headless machine)`);
  ok(playAt !== null && playAt < SEG.segments[0].to, 'game was playing before the eye segments began');
  console.log(`    automatic re-centres (stuck guard): ${await ev(() => window.eyeMaze.stats.autoRecentres || 0)}, intro re-centres: ${await ev(() => window.eyeMaze.stats.recentres)}`);

  // per-segment report (skip the first 0.6 s of each segment: smoothing + dwell + low fps)
  const rows = [];
  for (const s of SEG.segments) {
    const fr = log.filter((r) => r.vt >= s.from + 0.6 && r.vt < s.to);
    if (!fr.length) continue;
    const match = fr.filter((r) => r.dir === s.expect).length / fr.length;
    const wrong = fr.filter((r) => r.dir !== s.expect && r.dir !== 'center').length;
    const mx = fr.reduce((a, r) => a + r.x, 0) / fr.length, my = fr.reduce((a, r) => a + r.y, 0) / fr.length;
    rows.push({ ...s, n: fr.length, match, wrong, mx, my, states: [...new Set(fr.map((r) => r.state))].join('/') });
  }
  console.log('    segment      expect   frames  as-expected  wrong   mean x   mean y   states');
  for (const r of rows) console.log(`    ${r.name.padEnd(11)}  ${r.expect.padEnd(7)}  ${String(r.n).padStart(5)}   ${(r.match * 100).toFixed(0).padStart(6)}%    ${String(r.wrong).padStart(4)}   ${r.mx.toFixed(2).padStart(6)}   ${r.my.toFixed(2).padStart(6)}   ${r.states}`);

  const still = rows.filter((r) => r.expect === 'center');
  const stillFrames = still.reduce((a, r) => a + r.n, 0), stillMoved = still.reduce((a, r) => a + Math.round(r.n * (1 - r.match)), 0);
  ok(stillMoved / Math.max(1, stillFrames) < 0.05, `rest + head shift/roll/distance changes: ball still in ${(100 * (1 - stillMoved / Math.max(1, stillFrames))).toFixed(0)}% of frames`);
  ok(rows.every((r) => r.wrong === 0), 'never moved in a wrong direction');
  const seg = (n) => rows.find((r) => r.name === n) || { mx: NaN, my: NaN };
  const rest = rows.filter((r) => r.name === 'rest');
  const restX = rest.reduce((a, r) => a + r.mx, 0) / rest.length, restY = rest.reduce((a, r) => a + r.my, 0) / rest.length;
  ok(seg('eyesRight').mx > restX + 0.1 && seg('eyesLeft').mx < restX - 0.1, `iris shifted toward screen-right/left → gaze x ${seg('eyesRight').mx.toFixed(2)} / ${seg('eyesLeft').mx.toFixed(2)} (rest ${restX.toFixed(2)})`);
  console.log(`    vertical (reported, not required): up y ${seg('eyesUp').my.toFixed(2)}, down y ${seg('eyesDown').my.toFixed(2)}, rest y ${restY.toFixed(2)}`);
  const lost = log.filter((r) => r.state === 'noface' || r.state === 'unreliable').length;
  ok(lost / Math.max(1, log.length) < 0.03, `tracking held on a well-lit face (${lost} of ${log.length} frames dropped — brief drop-outs are bridged)`);
  ok(errors.length === 0, 'no page errors ' + errors.join(' | '));
} finally {
  await browser.close();
  server.close();
}
process.exitCode = failed ? 1 : 0;
console.log(failed ? `${failed} failed` : 'CAMERA + RECORDING CHECKS PASSED');
