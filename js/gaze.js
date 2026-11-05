// EYE MAZE v4 — gaze math (pure, no DOM; runs in the browser and in Node tests)
//
// Calibration-free pipeline:
//   face landmarks (+ blendshapes)
//     -> extractFeatures()   eye-in-head features (iris vs. eye corners/lids, invariant to head
//                            position, distance and roll) + head pose from the 3D landmarks
//     -> AutoLock            ~1 s of frames while the player looks at the "tracking" indicator in
//                            the centre: personal NEUTRAL (rest position of iris, lids, head)
//     -> defaultModel()      maps features to screen gaze with population-average gains (PRIORS)
//     -> GazeEstimator       screen gaze = eye-in-head + head rotation (head-pose compensation),
//                            spike filter, smoothing, slow neutral re-centring, dead zone,
//                            hysteresis, dwell, blink & reliability handling
// Optional quick calibration replaces the average gains with personal ones (personalModel()).
//
// Conventions: "image" coordinates are the raw (unmirrored) camera frame, x right, y down.
// The player faces the camera, so looking to the player's RIGHT (screen right) moves the iris
// toward IMAGE LEFT. Output x/y are screen directions: +x right, +y down, 1.0 ≈ screen edge.

export const LM = {
  // eye on the IMAGE-LEFT side (player's right eye): corners 33 (outer) / 133 (inner)
  A_C1: 33, A_C2: 133, A_UP: 159, A_LO: 145, A_IRIS: [468, 469, 470, 471, 472],
  // eye on the IMAGE-RIGHT side (player's left eye): corners 362 (inner) / 263 (outer)
  B_C1: 362, B_C2: 263, B_UP: 386, B_LO: 374, B_IRIS: [473, 474, 475, 476, 477],
  NOSE: 1, CHEEK_L: 234, CHEEK_R: 454, FOREHEAD: 10, CHIN: 152,
};

export const DIRS = ['center', 'left', 'right', 'up', 'down'];

/**
 * Population-average gains used when the player has not calibrated.
 * ih  0.0055 / degree : measured on real photos with the MediaPipe model (people looking at the
 *                       camera with the head turned 12° and 19° gave 0.0062 and 0.0056) and close to
 *                       eyeball geometry (≈10 mm rotation radius / ≈29 mm eye width ≈ 0.006 / °).
 * bh  0.035 / degree  : eyeLook blendshapes on the same photos (≈0.55 at 12°, ≈0.75 at 19°).
 * iv, lids, bv        : vertical is weaker and less certain (lids partly cover the iris). These are
 *                       conservative estimates — vertical sensitivity is adjustable in settings.
 * edgeDegX / edgeDegY : how far (in degrees) the eyes rotate to look at the screen edge from the
 *                       centre, for a ~14" laptop at ~60 cm. 1.0 in the output ≈ the screen edge.
 */
export const PRIORS = {
  edgeDegX: 15, edgeDegY: 10,
  ih: 0.0055, bh: 0.035,
  iv: 0.0035, lidDown: 0.018, lidUp: 0.010, bv: 0.02,
  weightsX: { ih: 0.65, bh: 0.35 },
  weightsY: { iv: 0.4, open: 0.35, bv: 0.25 },
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
export function median(arr) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const mad = (arr, m = median(arr)) => median(arr.map((v) => Math.abs(v - m)));
const std = (arr) => { const m = mean(arr); return Math.sqrt(mean(arr.map((v) => (v - m) ** 2))); };

function eyeFeatures(P, c1, c2, up, lo, irisIdx) {
  const A = P[c1], B = P[c2];
  const ux0 = B.x - A.x, uy0 = B.y - A.y;
  const w = Math.hypot(ux0, uy0) || 1e-6;
  const ux = ux0 / w, uy = uy0 / w; // along the eye (image left -> right)
  const nx = -uy, ny = ux;          // perpendicular (image down)
  let ix = 0, iy = 0;
  for (const i of irisIdx) { ix += P[i].x; iy += P[i].y; }
  ix /= irisIdx.length; iy /= irisIdx.length;
  const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
  const h = ((ix - A.x) * ux + (iy - A.y) * uy) / w;   // 0..1, ~0.5 when centred
  const v = ((ix - mx) * nx + (iy - my) * ny) / w;     // + = iris lower in the eye
  const open = ((P[lo].x - P[up].x) * nx + (P[lo].y - P[up].y) * ny) / w; // lid aperture
  return { h, v, open, w };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1e-9; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Head pose from the 3D landmarks, expressed in the head's own frame so it is independent of roll
 * (the eye features are measured along each eye's own axis, so they are roll-free too).
 * yaw  > 0: face points toward IMAGE RIGHT;  pitch > 0: face points toward IMAGE DOWN (degrees).
 */
export function headPose3D(lm, aspect) {
  const P = (i) => [lm[i].x * aspect, lm[i].y, (lm[i].z || 0) * aspect];
  const ex = norm(sub(P(LM.CHEEK_R), P(LM.CHEEK_L)));
  let ey = sub(P(LM.CHIN), P(LM.FOREHEAD));
  ey = norm(sub(ey, ex.map((v) => v * dot(ey, ex))));
  const ez = cross(ex, ey);             // points away from the camera for a frontal face
  const fwd = ez.map((v) => -v);        // face forward (toward the camera)
  const cam = [0, 0, -1];               // direction from the face to the camera
  const yaw = Math.atan2(-dot(cam, ex), dot(cam, fwd)) * 180 / Math.PI;
  const pitch = Math.atan2(-dot(cam, ey), dot(cam, fwd)) * 180 / Math.PI;
  const roll = Math.atan2(ex[1], ex[0]) * 180 / Math.PI;
  return { yaw, pitch, roll };
}

/**
 * Turn one Face Landmarker result into a feature frame.
 * @param landmarks  array of {x,y,z} in normalised image coords
 * @param aspect     video width / height
 * @param blend      optional blendshape categories [{categoryName, score}]
 */
export function extractFeatures(landmarks, aspect = 4 / 3, blend = null) {
  if (!landmarks || landmarks.length < 478) return null;
  const P = landmarks.map((p) => ({ x: p.x * aspect, y: p.y }));
  const a = eyeFeatures(P, LM.A_C1, LM.A_C2, LM.A_UP, LM.A_LO, LM.A_IRIS);
  const b = eyeFeatures(P, LM.B_C1, LM.B_C2, LM.B_UP, LM.B_LO, LM.B_IRIS);
  const head = headPose3D(landmarks, aspect);
  const l = P[LM.CHEEK_L], r = P[LM.CHEEK_R];
  const f = {
    ih: (a.h + b.h) / 2,
    iv: (a.v + b.v) / 2,
    open: (a.open + b.open) / 2,
    eyeDiff: a.h - b.h,                 // the two eyes should move together
    eyeW: (a.w + b.w) / 2,              // eye width (fraction of image height): distance proxy
    yaw: head.yaw, pitch: head.pitch, roll: head.roll,
    faceSize: Math.hypot(r.x - l.x, r.y - l.y),
  };
  if (blend && blend.length) {
    const s = {};
    for (const c of blend) s[c.categoryName] = c.score;
    if (s.eyeLookOutLeft !== undefined) {
      // measured on the real model: Out(Left)+In(Right) rise as the irises move toward IMAGE RIGHT
      f.bh = ((s.eyeLookOutLeft + s.eyeLookInRight) - (s.eyeLookInLeft + s.eyeLookOutRight)) / 2;
      f.bv = ((s.eyeLookDownLeft + s.eyeLookDownRight) - (s.eyeLookUpLeft + s.eyeLookUpRight)) / 2;
      f.blink = ((s.eyeBlinkLeft || 0) + (s.eyeBlinkRight || 0)) / 2;
    }
  }
  return f;
}

// ---------------------------------------------------------------------------
// Neutral (rest) position, captured automatically — no calibration targets
// ---------------------------------------------------------------------------
export class AutoLock {
  constructor({ minFrames = 14, minMs = 1000, maxMs = 6000 } = {}) {
    Object.assign(this, { minFrames, minMs, maxMs });
    this.reset();
  }
  reset() { this.frames = []; this.t0 = null; this.progress = 0; this.unstable = false; }
  /** feed a frame; returns a neutral baseline object when locked, else null */
  feed(f, tMs) {
    if (!f) { this.reset(); return null; }
    if (this.t0 === null) this.t0 = tMs;
    // skip blinks (eyelids much more closed than what has been seen)
    if (this.frames.length >= 4) {
      const mo = median(this.frames.map((x) => x.open));
      if (f.open < mo * 0.65) return null;
    }
    this.frames.push({ ...f, t: tMs });
    // keep only the last ~1.2 s
    this.frames = this.frames.filter((x) => tMs - x.t <= 1200);
    const el = tMs - this.t0;
    const n = this.frames.length;
    const stable = n >= 5 && std(this.frames.map((x) => x.ih)) < 0.02 && std(this.frames.map((x) => x.iv)) < 0.02 &&
      std(this.frames.map((x) => x.yaw)) < 4;
    this.unstable = n >= 5 && !stable;
    this.progress = clamp(Math.min(el / this.minMs, n / this.minFrames), 0, stable ? 1 : 0.85);
    if ((el >= this.minMs && n >= this.minFrames && stable) || (el >= this.maxMs && n >= 5)) {
      return neutralFrom(this.frames);
    }
    return null;
  }
}

export function neutralFrom(frames) {
  const m = (k) => { const v = frames.map((x) => x[k]).filter(Number.isFinite); return v.length ? median(v) : undefined; };
  return { ih: m('ih'), iv: m('iv'), open: m('open'), bh: m('bh'), bv: m('bv'), yaw: m('yaw'), pitch: m('pitch'), roll: m('roll'), eyeDiff: m('eyeDiff'), eyeW: m('eyeW'), n: frames.length };
}

// ---------------------------------------------------------------------------
// Models: both produce { axes:{x,y}, head:{yaw0,pitch0,kx,ky}, blinkOpen, eyeDiff0, kind, quality }
// axes.* = { feats:[{key, c, dPos, dNeg, weight}], total } evaluated by projectAxis().
// ---------------------------------------------------------------------------

/** calibration-free model from the automatically captured neutral + population gains */
export function defaultModel(neutral, { mirror = false } = {}) {
  const P = PRIORS, sx = mirror ? 1 : -1; // unmirrored: looking screen-right DEcreases ih
  const EX = P.edgeDegX, EY = P.edgeDegY;
  const feats = (list) => { const fs = list.filter((f) => Number.isFinite(f.c)); return { feats: fs, total: fs.reduce((s, f) => s + f.weight, 0) }; };
  const open0 = neutral.open || 0.3;
  const x = feats([
    { key: 'ih', c: neutral.ih, dPos: sx * P.ih * EX, dNeg: sx * P.ih * EX, weight: P.weightsX.ih },
    { key: 'bh', c: neutral.bh, dPos: sx * P.bh * EX, dNeg: sx * P.bh * EX, weight: P.weightsX.bh },
  ]);
  const y = feats([
    { key: 'iv', c: neutral.iv, dPos: P.iv * EY, dNeg: P.iv * EY, weight: P.weightsY.iv },
    { key: 'open', c: open0, dPos: -open0 * P.lidDown * EY, dNeg: -open0 * P.lidUp * EY, weight: P.weightsY.open },
    { key: 'bv', c: neutral.bv, dPos: P.bv * EY, dNeg: P.bv * EY, weight: P.weightsY.bv },
  ]);
  return {
    kind: 'auto', mirror, axes: { x, y },
    head: headTerms(neutral, mirror),
    blinkOpen: open0 * 0.5, eyeDiff0: neutral.eyeDiff || 0, eyeW0: neutral.eyeW || 0,
    quality: { x: 0.6, y: 0.45, overall: 0.45 },
  };
}

/**
 * Head-pose compensation: screen gaze = eye-in-head + head rotation.
 * The eye axes report eye-in-head rotation, so turning the head 10° while still looking at the same
 * point (the eyes counter-rotate 10°) shifts the eye reading by 10°/edgeDeg — kx/ky cancel that.
 */
function headTerms(neutral, mirror, roll0 = 0) {
  return {
    yaw0: neutral.yaw || 0, pitch0: neutral.pitch || 0, roll0,
    kx: (mirror ? -1 : 1) / PRIORS.edgeDegX,
    ky: -1 / PRIORS.edgeDegY,
  };
}

/** Map a feature frame onto one axis: -1 at the neg end (left/up), 0 neutral, +1 pos end (right/down). */
export function projectAxis(axis, f) {
  if (!axis || !axis.total) return 0;
  let s = 0, w = 0;
  for (const ft of axis.feats) {
    if (!ft.weight) continue;
    const v = f[ft.key];
    if (!Number.isFinite(v)) continue;
    const d = v - ft.c;
    const span = (d >= 0) === (ft.dPos >= 0) ? Math.abs(ft.dPos) : Math.abs(ft.dNeg);
    const val = (d * Math.sign(ft.dPos)) / (span || 1e-6);
    s += clamp(val, -2.5, 2.5) * ft.weight;
    w += ft.weight;
  }
  return w ? s / w : 0;
}

// ---------------------------------------------------------------------------
// Optional quick calibration (personal gains)
// ---------------------------------------------------------------------------
export class Calibration {
  constructor() { this.samples = { center: [], left: [], right: [], up: [], down: [] }; }
  add(target, frame) { if (frame && this.samples[target]) this.samples[target].push(frame); }
  count(target) { return this.samples[target].length; }

  /** Returns { ok, model, quality, issues } — model is a personal model when ok */
  compute() {
    const issues = [];
    const S = this.samples;
    for (const t of DIRS) if (S[t].length < 8) issues.push(`Not enough samples for "${t}" (${S[t].length}).`);
    if (issues.length) return { ok: false, model: null, quality: 0, issues };
    const stat = (t, k) => {
      const vals = S[t].map((s) => s[k]).filter((v) => Number.isFinite(v));
      return vals.length >= 5 ? { med: median(vals), mad: mad(vals) } : null;
    };
    const AXES = { x: { neg: 'left', pos: 'right', features: ['ih', 'bh'] }, y: { neg: 'up', pos: 'down', features: ['iv', 'bv', 'open'] } };
    const axes = {};
    for (const [name, ax] of Object.entries(AXES)) {
      const feats = [];
      for (const k of ax.features) {
        const c = stat('center', k), n = stat(ax.neg, k), p = stat(ax.pos, k);
        if (!c || !n || !p) continue;
        const noise = Math.max(1.4826 * mean([c.mad, n.mad, p.mad]), 1e-4);
        const dPos = p.med - c.med, dNeg = c.med - n.med;
        const monotonic = Math.sign(dPos) === Math.sign(dNeg) && dPos !== 0;
        const sep = Math.min(Math.abs(dPos), Math.abs(dNeg)) / noise;
        const weight = monotonic && sep >= 1.5 ? Math.min(sep, 12) : 0;
        feats.push({ key: k, c: c.med, dPos, dNeg, noise, sep, weight });
      }
      axes[name] = { feats, total: feats.reduce((s, f) => s + f.weight, 0) };
      if (axes[name].total < 2) issues.push(`Weak ${name === 'x' ? 'left/right' : 'up/down'} signal — try larger eye movements, more light, or move closer.`);
    }
    const neutral = neutralFrom(S.center);
    // mirrored video if the iris moves toward IMAGE RIGHT when the player looks screen-right
    const ihF = axes.x.feats.find((f) => f.key === 'ih');
    const mirror = !!(ihF && ihF.weight && ihF.dPos > 0);
    const q = (tot) => clamp((tot - 1) / 7, 0, 1);
    const quality = { x: q(axes.x.total), y: q(axes.y.total) };
    quality.overall = Math.min(quality.x, quality.y);
    const opens = ['center', 'down', 'up', 'left', 'right'].map((t) => stat(t, 'open')).filter(Boolean).map((s) => s.med);
    const model = {
      kind: 'personal', mirror, axes, head: headTerms(neutral, mirror, neutral.roll || 0),
      blinkOpen: Math.min(...opens) * 0.55, eyeDiff0: neutral.eyeDiff || 0, eyeW0: neutral.eyeW || 0, quality,
    };
    const ok = axes.x.total >= 2 && axes.y.total >= 2;
    return { ok, model, quality: quality.overall, issues, neutral };
  }
}

// ---------------------------------------------------------------------------
// One Euro filter (Casiez et al.) — low lag when moving, low jitter when still
// ---------------------------------------------------------------------------
export class OneEuro {
  constructor(minCutoff = 1.2, beta = 0.4, dCutoff = 1.0) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    this.reset();
  }
  reset() { this.x = null; this.dx = 0; this.t = null; }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(v, tMs) {
    if (this.x === null) { this.x = v; this.t = tMs; return v; }
    const dt = Math.max((tMs - this.t) / 1000, 1e-3);
    this.t = tMs;
    const dv = (v - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dv - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
}

export const DEFAULT_OPTS = {
  enter: 0.55,          // |gaze| needed to start moving (1.0 ≈ screen edge)
  exit: 0.36,           // |gaze| below this stops movement (neutral dead zone)
  dominance: 1.25,      // the winning axis must be this much stronger than the other
  dwellMs: 150,         // a new direction must persist this long before it is accepted
  centerDwellMs: 90,    // returning to centre is accepted faster (stopping feels responsive)
  smoothing: 1.2,       // One Euro min cutoff (Hz); lower = smoother but laggier
  sens: 1,              // overall sensitivity multiplier (settings)
  vsens: 1,             // extra vertical sensitivity multiplier (settings)
  mirror: false,        // swap left/right (for cameras that deliver a mirrored image)
  recenterTau: 8,       // seconds: slow re-centring of the neutral while the gaze rests near centre
  maxOffset: 0.6,
  headSpeedLimit: 90,   // deg/s — fast head motion: hold still briefly instead of guessing
  headSpeedHoldMs: 220,
  reliableYaw: 38,      // beyond these absolute head angles the eye landmarks are not trustworthy
  reliablePitch: 30,
  minEyeW: 0.022,       // eye width (fraction of image height) below which the face is too far away
  blinkHoldMs: 350,     // keep the last direction through a short blink, then stop
  lostMs: 300,          // face missing longer than this -> stop
};

export class GazeEstimator {
  constructor(model, opts = {}) {
    this.opts = { ...DEFAULT_OPTS, ...opts };
    this.fx = new OneEuro(this.opts.smoothing, 0.4);
    this.fy = new OneEuro(this.opts.smoothing, 0.4);
    this.setModel(model);
    this.dir = 'center';
    this.candidate = 'center';
    this.candidateSince = 0;
    this.lastFaceT = -1e9;
    this.blinkSince = null;
    this.headHoldUntil = 0;
    this.jitter = 0;
    this.off = { x: 0, y: 0 };
    this.hist = [];        // last 3 raw samples for the spike (median) filter
    this.headHist = [];
    this.lastT = null;
    this.last = { x: 0, y: 0 };
    this.collect = null;   // re-centre sample collector
    this.out = this._out('noface', 0, 0, 0, 0, 0);
  }
  setModel(model) {
    this.model = model;
    this.off = { x: 0, y: 0 };
    this.hist = [];
  }
  setOpts(o) {
    Object.assign(this.opts, o);
    this.fx.minCutoff = this.fy.minCutoff = this.opts.smoothing;
  }
  _out(state, x, y, rawX, rawY, confidence, extra = {}) {
    return { dir: this.dir, state, x, y, rawX, rawY, confidence, candidate: this.candidate, off: { ...(this.off || { x: 0, y: 0 }) }, ...extra };
  }

  /** raw screen gaze (before offsets / smoothing) from a frame — exported for tests */
  raw(f) {
    const m = this.model, o = this.opts;
    const dYaw = f.yaw - m.head.yaw0, dPitch = f.pitch - m.head.pitch0;
    // gaze relative to the FACE (eye-in-head + head rotation, both in the head's own frame)
    const hx = projectAxis(m.axes.x, f) - m.head.kx * dYaw;
    const hy = projectAxis(m.axes.y, f) - m.head.ky * dPitch;
    // rotate the face-relative direction by the head's roll so "right" stays screen-right when the head tilts
    const roll = ((Number.isFinite(f.roll) ? f.roll : 0) - (m.head.roll0 || 0)) * Math.PI / 180;
    const s = m.mirror ? -1 : 1, c = Math.cos(roll), sn = Math.sin(roll);
    const EX = PRIORS.edgeDegX, EY = PRIORS.edgeDegY;
    let x = (hx * EX * c + s * hy * EY * sn) / EX;
    let y = (-s * hx * EX * sn + hy * EY * c) / EY;
    // the swap setting flips an automatic model; a personal model already learned the camera's orientation
    if (m.kind === 'auto' && o.mirror !== m.mirror) x = -x;
    return { x: x * o.sens, y: y * o.sens * o.vsens, dYaw, dPitch, roll: roll * 180 / Math.PI };
  }

  /** start collecting raw gaze to re-centre (e.g. while a countdown is shown in the middle) */
  beginRecenter() { this.collect = []; }
  /** apply the collected re-centre if it was steady; returns true if applied */
  endRecenter({ maxShift = 0.75 } = {}) {
    const c = this.collect; this.collect = null;
    if (!c || c.length < 5) return false;
    const xs = c.map((s) => s.x), ys = c.map((s) => s.y);
    if (std(xs) > 0.2 || std(ys) > 0.2) return false;
    const mx = median(xs), my = median(ys);
    if (Math.abs(mx - this.off.x) > maxShift || Math.abs(my - this.off.y) > maxShift) return false;
    this.off = { x: clamp(mx, -this.opts.maxOffset, this.opts.maxOffset), y: clamp(my, -this.opts.maxOffset, this.opts.maxOffset) };
    this.fx.reset(); this.fy.reset(); this.hist = [];
    return true;
  }

  /** feed one frame (or null when no face); returns the current decision */
  update(f, tMs) {
    const o = this.opts, m = this.model;
    const dt = this.lastT === null ? 0.033 : clamp((tMs - this.lastT) / 1000, 0.001, 0.5);
    this.lastT = tMs;
    if (!f || !m) {
      if (tMs - this.lastFaceT > o.lostMs) this._commit('center', tMs, true);
      return (this.out = this._out('noface', this.last.x, this.last.y, 0, 0, 0, { reason: 'face not found' }));
    }
    this.lastFaceT = tMs;

    // ---- reliability: can the eyes be read well enough to steer? (not a posture rule)
    const tooTurned = Math.abs(f.yaw) > o.reliableYaw || Math.abs(f.pitch) > o.reliablePitch;
    const tooFar = Number.isFinite(f.eyeW) && f.eyeW < o.minEyeW;
    const eyesDisagree = Number.isFinite(f.eyeDiff) && Math.abs(f.eyeDiff - (m.eyeDiff0 || 0)) > 0.14;
    if (tooTurned || tooFar) {
      this._commit('center', tMs, true);
      this.hist = [];
      return (this.out = this._out('unreliable', this.last.x, this.last.y, 0, 0, 0.1, { reason: tooFar ? 'too far from the camera' : 'face turned away' }));
    }

    // ---- fast head motion: hold still briefly rather than guess
    this.headHist = this.headHist.filter((h) => tMs - h.t <= 160);
    this.headHist.push({ yaw: f.yaw, pitch: f.pitch, t: tMs });
    const old = this.headHist[0];
    if (tMs - old.t >= 80) {
      const speed = Math.hypot(f.yaw - old.yaw, f.pitch - old.pitch) / ((tMs - old.t) / 1000);
      if (speed > o.headSpeedLimit) this.headHoldUntil = tMs + o.headSpeedHoldMs;
    }

    // ---- blinks: eyes closed -> features unreliable
    const blinking = f.open < m.blinkOpen || (f.blink !== undefined && f.blink > 0.6 && f.open < m.blinkOpen * 1.5);
    if (blinking) {
      if (this.blinkSince === null) this.blinkSince = tMs;
      if (tMs - this.blinkSince > o.blinkHoldMs) this._commit('center', tMs, true);
      return (this.out = this._out('blink', this.last.x, this.last.y, 0, 0, 0.3));
    }
    this.blinkSince = null;
    if (eyesDisagree) {
      // one-eye glitch (reflection, partial occlusion): treat like a blink
      return (this.out = this._out('glitch', this.last.x, this.last.y, 0, 0, 0.3, { reason: 'eyes unclear' }));
    }

    // ---- gaze: eye-in-head + head rotation, minus the slowly adapting neutral offset
    const r = this.raw(f);
    if (this.collect) this.collect.push({ x: r.x, y: r.y });
    this.hist.push({ x: r.x - this.off.x, y: r.y - this.off.y });
    if (this.hist.length > 3) this.hist.shift();
    const rawX = median(this.hist.map((h) => h.x)), rawY = median(this.hist.map((h) => h.y)); // 1-frame spike filter
    const x = this.fx.filter(rawX, tMs), y = this.fy.filter(rawY, tMs);
    this.jitter = 0.9 * this.jitter + 0.1 * Math.hypot(rawX - x, rawY - y);
    this.last = { x, y };

    // larger head rotations widen the dead zone (compensation is less certain there)
    const headK = 1 + Math.max(0, Math.abs(r.dYaw) - 12) / 20 + Math.max(0, Math.abs(r.dPitch) - 10) / 15;
    const stability = clamp(1 - this.jitter / 0.6, 0, 1);
    const headF = clamp(1.3 - (headK - 1), 0.2, 1);
    const calQ = 0.45 + 0.55 * (m.quality ? m.quality.overall : 0.5);
    const confidence = clamp(stability * headF * calQ, 0, 1);
    const extra = { dYaw: r.dYaw, dPitch: r.dPitch, headK };

    if (tMs < this.headHoldUntil) {
      this._commit('center', tMs, true);
      return (this.out = this._out('headmove', x, y, rawX, rawY, confidence, extra));
    }

    const next = this._decide(x, y, headK);
    this._commit(next, tMs, false);

    // slow re-centring: while the player rests near the centre, drift toward their actual neutral
    if (this.dir === 'center' && Math.abs(x) < o.exit * 0.8 && Math.abs(y) < o.exit * 0.8 && o.recenterTau > 0) {
      const k = dt / o.recenterTau;
      this.off.x = clamp(this.off.x + rawX * k, -o.maxOffset, o.maxOffset);
      this.off.y = clamp(this.off.y + rawY * k, -o.maxOffset, o.maxOffset);
    }
    return (this.out = this._out('ok', x, y, rawX, rawY, confidence, extra));
  }
  _decide(x, y, headK = 1) {
    const o = this.opts, ax = Math.abs(x), ay = Math.abs(y);
    const enter = o.enter * headK, exit = o.exit * headK;
    const cur = this.dir;
    if (cur !== 'center') {  // hysteresis: keep going while still above the exit threshold
      const v = cur === 'left' ? -x : cur === 'right' ? x : cur === 'up' ? -y : y;
      const other = cur === 'left' || cur === 'right' ? ay : ax;
      if (v > exit && v * o.dominance >= other) return cur;
    }
    if (ax < exit && ay < exit) return 'center';                       // neutral dead zone
    if (ax >= enter && ax >= ay * o.dominance) return x < 0 ? 'left' : 'right';
    if (ay >= enter && ay >= ax * o.dominance) return y < 0 ? 'up' : 'down';
    return 'center'; // ambiguous (diagonal) or not far enough: stay still
  }
  _commit(next, tMs, immediate) {
    if (immediate) { this.candidate = next; this.dir = next; this.candidateSince = tMs; return; }
    if (next !== this.candidate) { this.candidate = next; this.candidateSince = tMs; }
    const need = next === 'center' ? this.opts.centerDwellMs : this.opts.dwellMs;
    if (next !== this.dir && tMs - this.candidateSince >= need) this.dir = next;
  }
}
