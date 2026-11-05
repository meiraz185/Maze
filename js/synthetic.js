// EYE MAZE v4 — synthetic eyes, used ONLY by the automated tests and the keyboard test mode.
// Produces feature frames with the same conventions as real Face Landmarker output (signs verified
// on real photos). Each synthetic "person" has their own gains, rest position, noise and screen
// distance, so the calibration-free defaults are tested against variation they were not tuned on.
// It is a model, not a person: it proves nothing about accuracy with a real camera.
import { PRIORS } from './gaze.js';

export function makeRng(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
export function gauss(rnd) {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** the "average person" the defaults assume */
export const AVERAGE_PERSON = {
  gh: PRIORS.ih, gbh: PRIORS.bh, gv: PRIORS.iv, lidDown: PRIORS.lidDown, lidUp: PRIORS.lidUp, gbv: PRIORS.bv,
  ih0: 0.5, iv0: -0.09, open0: 0.33, bh0: 0, bv0: -0.2,
  edgeX: PRIORS.edgeDegX, edgeY: PRIORS.edgeDegY, // their actual screen size / distance
  noise: 1, mirror: false, eyeW: 0.075,
};

/** a random person: gains vary ±35% (vertical ±45%), different rest positions, distances and noise */
export function randomPerson(rnd) {
  const f = (spread) => Math.exp(gauss(rnd) * spread);
  return {
    ...AVERAGE_PERSON,
    gh: PRIORS.ih * f(0.18), gbh: PRIORS.bh * f(0.25),
    gv: PRIORS.iv * f(0.25), lidDown: PRIORS.lidDown * f(0.25), lidUp: PRIORS.lidUp * f(0.25), gbv: PRIORS.bv * f(0.3),
    ih0: 0.5 + gauss(rnd) * 0.02, iv0: -0.09 + gauss(rnd) * 0.02, open0: 0.33 * f(0.15),
    bh0: gauss(rnd) * 0.05, bv0: -0.2 + gauss(rnd) * 0.08,
    edgeX: PRIORS.edgeDegX * f(0.15), edgeY: PRIORS.edgeDegY * f(0.15),
    noise: f(0.3),
  };
}

/**
 * gx, gy: true gaze in screen terms (-1 = left/top edge, +1 = right/bottom edge)
 * yaw, pitch: head rotation (degrees, image convention: + = face toward image right / down).
 * The eyes counter-rotate so the gaze stays on the same screen point (vestibulo-ocular reflex).
 */
export function syntheticFrame(gx, gy, { person = AVERAGE_PERSON, yaw = 0, pitch = 0, roll = 0, noise = 1, rnd = Math.random, blink = false } = {}) {
  const p = person;
  const n = (s) => gauss(rnd) * s * noise * p.noise;
  const sx = p.mirror ? -1 : 1;
  // gaze direction in image terms: screen-right = image-left (camera faces the player)
  const gazeImgX = -gx * p.edgeX * sx, gazeImgY = gy * p.edgeY;
  const yawI = yaw * sx;
  // head roll: the eye's own axes are rotated by `roll` in the image, so a screen-referenced gaze
  // appears rotated by -roll in the face frame. (yaw/pitch are given in the head frame.)
  const rr = (roll * sx * Math.PI) / 180, c = Math.cos(rr), sn = Math.sin(rr);
  const gfx = gazeImgX * c + gazeImgY * sn, gfy = -gazeImgX * sn + gazeImgY * c;
  const ex = gfx - yawI, ey = gfy - pitch;                  // eye-in-head rotation (deg)
  const sat = (v, k) => Math.tanh(v / k) * k;               // blendshapes saturate
  const open = blink ? 0.04 : p.open0 * (1 - p.lidDown * Math.max(0, ey) + p.lidUp * Math.max(0, -ey)) + n(0.006);
  return {
    ih: p.ih0 + p.gh * ex + n(0.006),
    iv: p.iv0 + p.gv * ey + n(0.004),
    open,
    bh: p.bh0 + sat(p.gbh * ex, 0.9) + n(0.04),
    bv: p.bv0 + sat(p.gbv * ey, 0.7) + n(0.04),
    blink: blink ? 0.9 : 0.05,
    eyeDiff: n(0.008),
    eyeW: p.eyeW,
    yaw: yawI + n(0.6), pitch: pitch + n(0.6), roll: roll * sx + n(0.5),
    faceSize: 0.5,
  };
}
