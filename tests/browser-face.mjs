// Real MediaPipe model on still face photos (no webcam): checks landmark indices and feature behaviour.
//   MODEL=/path/face_landmarker.task FACES=/dir/with/jpgs node tests/browser-face.mjs
// This does NOT verify live gaze tracking with a real camera — it checks the image → features step.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { serve } from './serve.mjs';
import { defaultModel, GazeEstimator, projectAxis } from '../js/gaze.js';

const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const MODEL = process.env.MODEL;
const FACES = process.env.FACES;
if (!MODEL || !FACES) { console.error('set MODEL and FACES'); process.exit(2); }
const PORT = 8124;
const overrides = { '/models/face_landmarker.task': MODEL };
for (const f of fs.readdirSync(FACES)) overrides[`/faces/${f}`] = path.join(FACES, f);
const server = await serve(PORT, { overrides });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('pageerror', e));
let failed = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗', m); if (!c) failed++; };

try {
  await page.goto(`http://127.0.0.1:${PORT}/tests/face-harness.html`);
  await page.evaluate(() => window.ready);
  for (const face of fs.readdirSync(FACES).filter((f) => f.endsWith('.jpg'))) {
    console.log(`\n${face}`);
    const url = `/faces/${face}`;
    const A = (u) => page.evaluate((u) => window.analyse(u), u);
    const V = async (spec, lm) => A(await page.evaluate((u, s, l) => window.variant(u, s, l), url, spec, lm || null));
    const base = await A(url);
    ok(base.found && base.n === 478, `face found with 478 landmarks (iris refinement)`);
    if (!base.found) continue;
    const f = base.f;
    console.log(`    ih ${f.ih.toFixed(3)}  iv ${f.iv.toFixed(3)}  open ${f.open.toFixed(3)}  bh ${f.bh?.toFixed(3)}  bv ${f.bv?.toFixed(3)}  head yaw ${f.yaw.toFixed(1)}° pitch ${f.pitch.toFixed(1)}° roll ${f.roll.toFixed(1)}°`);
    ok(f.ih > 0.3 && f.ih < 0.7, 'iris sits inside the eye horizontally');
    ok(Math.abs(f.iv) < 0.15, 'iris near the eye centre line vertically');
    ok(f.open > 0.08 && f.open < 0.6, 'eye openness plausible');
    const noseX = base.lm[1][0] - (base.lm[234][0] + base.lm[454][0]) / 2;
    ok(Math.sign(noseX) === Math.sign(f.yaw), `head yaw sign matches the nose position (${f.yaw.toFixed(1)}°)`);
    // head-pose compensation on a real photo: the person looks at the camera with the head turned.
    // Neutral assumed = a frontal face looking at the camera (iris centred, head 0°). Not exact per person.
    {
      const m = defaultModel({ ih: 0.5, bh: 0, iv: f.iv, bv: f.bv, open: f.open, yaw: 0, pitch: f.pitch });
      const eyeOnly = projectAxis(m.axes.x, f), comp = new GazeEstimator(m).raw(f).x;
      ok(Math.abs(comp) < Math.abs(eyeOnly) * 0.6, `head turned ${f.yaw.toFixed(0)}° while looking at the camera: gaze x ${eyeOnly.toFixed(2)} without vs ${comp.toFixed(2)} with head compensation`);
    }

    // invariance to head translation / distance / roll (the image moves, the eyes do not)
    for (const [name, spec] of [['shift', { tx: 50, ty: -30 }], ['closer', { scale: 1.2 }], ['further', { scale: 0.8 }], ['roll 10°', { rot: 10 }]]) {
      // (head yaw/pitch must not change with in-plane movement either)
      const r = await V(spec);
      if (!r.found) { ok(false, `${name}: face lost`); continue; }
      const dh = r.f.ih - f.ih, dv = r.f.iv - f.iv;
      ok(Math.abs(dh) < 0.025 && Math.abs(dv) < 0.025, `${name}: features stable (Δih ${dh.toFixed(3)}, Δiv ${dv.toFixed(3)})`);
      ok(Math.abs(r.f.yaw - f.yaw) < 4 && Math.abs(r.f.pitch - f.pitch) < 4, `${name}: head yaw/pitch stable (Δ ${(r.f.yaw - f.yaw).toFixed(1)}°, ${(r.f.pitch - f.pitch).toFixed(1)}°)`);
    }
    // mirror: horizontal ratio flips around 0.5
    const mir = await V({ mirror: true });
    ok(mir.found && Math.abs(mir.f.ih - (1 - f.ih)) < 0.04, `mirror: ih ${mir.f.ih.toFixed(3)} ≈ 1 − ${f.ih.toFixed(3)}`);
    ok(mir.found && Math.sign(mir.f.yaw) === -Math.sign(f.yaw), `mirror: yaw flips sign (${f.yaw.toFixed(1)}° → ${mir.f.yaw.toFixed(1)}°)`);

    // simulated iris movement (pixel warp inside the eye opening)
    const series = {};
    for (const d of [-0.6, -0.3, 0.3, 0.6]) {
      const r = await V({ irisDx: d }, base.lm);
      series[d] = r.found ? r.f.ih : NaN;
    }
    console.log(`    ih vs iris shift:  −0.6R ${series[-0.6].toFixed(3)}  −0.3R ${series[-0.3].toFixed(3)}  0 ${f.ih.toFixed(3)}  +0.3R ${series[0.3].toFixed(3)}  +0.6R ${series[0.6].toFixed(3)}`);
    ok(series[-0.6] < series[-0.3] && series[-0.3] < f.ih && f.ih < series[0.3] && series[0.3] < series[0.6], 'ih follows iris position monotonically');
    const up = await V({ irisDy: -0.35 }, base.lm), dn = await V({ irisDy: 0.35 }, base.lm);
    console.log(`    iv vs iris shift:  up ${up.f.iv.toFixed(3)}  0 ${f.iv.toFixed(3)}  down ${dn.f.iv.toFixed(3)}`);
    ok(up.f.iv < f.iv && f.iv < dn.f.iv, 'iv follows vertical iris position');
  }
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nFACE PIPELINE CHECKS PASSED');
process.exitCode = failed ? 1 : 0;
