// Builds a "recorded input" webcam video from a real face photo, using the real MediaPipe model to
// place a pixel warp of the irises (a crude stand-in for eye movement: lids/shading do not move).
//   MODEL=... FACE=face.jpg OUT=dir node tests/make-recording.mjs      (needs ffmpeg)
// Writes OUT/recording.y4m and OUT/segments.json
import puppeteer from 'puppeteer-core';
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
import { serve } from './serve.mjs';

const { MODEL, FACE, OUT } = process.env;
const IRIS = +(process.env.IRIS || 0.9);
fs.mkdirSync(OUT, { recursive: true });
const server = await serve(8131, { overrides: { '/models/face_landmarker.task': MODEL, '/faces/face.jpg': FACE } });
const b = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const p = await b.newPage();
await p.goto('http://127.0.0.1:8131/tests/face-harness.html'); await p.evaluate(() => window.ready);
const base = await p.evaluate(() => window.analyse('/faces/face.jpg'));
const variants = {
  rest: {}, eyesRight: { irisDx: -IRIS }, eyesLeft: { irisDx: IRIS }, eyesUp: { irisDy: -IRIS * 0.6 }, eyesDown: { irisDy: IRIS * 0.6 },
  shiftL: { tx: -45, ty: 10 }, shiftR: { tx: 40, ty: -15 }, rollL: { rot: -9 }, rollR: { rot: 9 }, closer: { scale: 1.12 }, further: { scale: 0.88 },
};
for (const [name, spec] of Object.entries(variants)) {
  const url = await p.evaluate((s, l) => window.variant('/faces/face.jpg', s, l), spec, spec.irisDx || spec.irisDy ? base.lm : null);
  fs.writeFileSync(path.join(OUT, `${name}.jpg`), Buffer.from(url.split(',')[1], 'base64'));
}
await b.close(); server.close();

// timeline (seconds). "expect" is what a person doing this would want the ball to do.
const segments = [
  ['rest', 40, 'center'], ['eyesRight', 5, 'right'], ['rest', 4, 'center'], ['eyesLeft', 5, 'left'], ['rest', 4, 'center'],
  ['eyesUp', 5, 'up'], ['rest', 4, 'center'], ['eyesDown', 5, 'down'], ['rest', 4, 'center'],
  ...['shiftL', 'rollR', 'closer', 'shiftR', 'rollL', 'further', 'shiftL', 'rollR', 'rest', 'closer', 'rollL', 'shiftR'].map((v) => [v, 0.7, 'center']),
  ['rest', 4, 'center'],
];
let list = '', t = 0;
const meta = [];
for (const [name, dur, expect] of segments) { list += `file '${name}.jpg'\nduration ${dur}\n`; meta.push({ name, from: t, to: t + dur, expect }); t += dur; }
list += `file 'rest.jpg'\n`;
fs.writeFileSync(path.join(OUT, 'list.txt'), list);
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(OUT, 'list.txt'), '-vf', 'fps=15,format=yuv420p', path.join(OUT, 'recording.y4m')]);
fs.writeFileSync(path.join(OUT, 'segments.json'), JSON.stringify({ duration: t, segments: meta }, null, 1));
console.log(`recording ${t.toFixed(1)} s → ${OUT}`);
