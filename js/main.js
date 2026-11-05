// EYE MAZE v4 — app flow
//   start → camera → automatic lock-on (no calibration) → level intro → play → next level … → success → replay
// Optional, from the settings icon: sensitivity, smoothing, speed, swap left/right, re-centre, quick calibration.
import { LEVELS, buildLevel, updatePhaseCharge, PHASE_HOLD_S } from './levels.js';
import { makeBall, stepBall, reachedGoal } from './physics.js';
import { Renderer } from './render.js';
import { CameraTracker, SyntheticTracker } from './tracker.js';
import { QuickCalibration } from './calibrate.js';
import { GazeEstimator, DEFAULT_OPTS, AutoLock, defaultModel } from './gaze.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const TEST = params.has('test');
const PLAYLIST = LEVELS;
const INTRO_S = 2.6;        // level intro countdown
const RECENTER_FROM = 1.3;  // during the intro, re-centre on the last part (the player looks at the ring)
const REPLAY_S = 8;         // success screen → automatic new run

const DEFAULT_SETTINGS = { sens: 1, vsens: 1, smooth: DEFAULT_OPTS.smoothing, speed: 1, mirror: false, debug: false };
const store = {
  get(k) { try { return JSON.parse(sessionStorage.getItem('eyemaze.' + k)); } catch (e) { return null; } },
  set(k, v) { try { sessionStorage.setItem('eyemaze.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
};

const app = {
  phase: 'start',
  tracker: null, est: null, lock: new AutoLock(), neutral: null,
  personal: store.get('personal'),                 // optional quick-calibration model (session)
  settings: { ...DEFAULT_SETTINGS, ...(store.get('settings') || {}), ...(params.has('debug') ? { debug: true } : {}) },
  levelIdx: 0, maze: null, ball: null, levelTime: 0, times: [],
  charge: { H: 0, V: 0, axis: null }, moving: false,
  phaseT: 0, paused: false, lostT: 0, stats: { calibrations: 0, locks: 0, recentres: 0 },
};
window.eyeMaze = app; // handy in the console; used by the automated browser tests

const renderer = new Renderer($('stage'));
const video = $('cam');

// ---------------------------------------------------------------- screens
const SCREENS = ['screen-start', 'screen-permission', 'screen-center', 'screen-success'];
function show(id) { for (const s of SCREENS) $(s).hidden = s !== id; }
function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
function setPhase(p) { app.phase = p; app.phaseT = 0; }

// ---------------------------------------------------------------- start
if (TEST) {
  $('btn-start').textContent = 'Start test mode';
  $('link-test').textContent = 'Back to camera mode';
  $('link-test').href = location.pathname;
  const w = $('proto-warn'); w.hidden = false;
  w.textContent = 'TEST MODE — no camera. Synthetic eyes; use the arrow keys to "look". This checks the game, not real eye tracking.';
}
if (!window.isSecureContext && location.protocol !== 'file:') {
  const w = $('proto-warn'); w.hidden = false;
  w.textContent = 'Camera access needs https:// (GitHub Pages) or http://localhost.';
}
$('btn-start').addEventListener('click', startTracking);
$('btn-retry').addEventListener('click', startTracking);
$('btn-succ-again').addEventListener('click', () => replay());
addEventListener('keydown', (e) => {
  if (e.key === 'd' || e.key === 'D') setSetting('debug', !app.settings.debug);
  if (e.key === 'Escape' && !$('settings').hidden) closeSettings();
});

// Returning visitors who already allowed the camera start straight away (no click needed).
if (!TEST && navigator.permissions && navigator.permissions.query) {
  navigator.permissions.query({ name: 'camera' }).then((p) => { if (p.state === 'granted' && app.phase === 'start') startTracking(); }).catch(() => {});
}

async function startTracking() {
  if (app.tracker || app.phase === 'starting') return;
  setPhase('starting');
  show('screen-permission');
  $('perm-actions').hidden = true;
  $('perm-title').textContent = TEST ? 'Test mode' : 'Camera access';
  $('perm-msg').innerHTML = TEST ? 'Starting synthetic eyes…' : 'Your browser will ask to use the camera. Choose <b>Allow</b>.';
  const tracker = TEST ? new SyntheticTracker() : new CameraTracker(video);
  tracker.onFrame(onFrame);
  try {
    await tracker.start((s) => { $('perm-msg').textContent = s; });
    app.tracker = tracker;
    app.quickcal = new QuickCalibration($('calib'), tracker);
    $('dbg-src').textContent = TEST ? 'synthetic' : `${tracker.delegate} · model ${tracker.modelSource}`;
    beginLock();
  } catch (err) {
    console.error(err);
    try { tracker.stop(); } catch (e) { /* ignore */ }
    setPhase('start');
    $('perm-title').textContent = 'Could not start';
    $('perm-msg').innerHTML = explainError(err);
    $('perm-actions').hidden = false;
  }
}

function explainError(err) {
  const n = err && err.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'Camera permission was blocked. Click the camera icon in the address bar, allow access for this page, then try again.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No camera was found. Connect a webcam and try again.';
  if (n === 'NotReadableError') return 'The camera is busy — close other apps or tabs using it (video calls…) and try again.';
  if (err && err.code === 'nocamapi') return err.message;
  return `The face tracking model could not load (${(err && err.message) || err}). It is downloaded the first time — check your internet connection and try again.`;
}

// ---------------------------------------------------------------- frames
function onFrame(frame, t) {
  if (app.phase === 'calibrating') app.quickcal.feed(frame);
  if (app.phase === 'lock') {
    const neutral = app.lock.feed(frame, t);
    if (neutral) onLocked(neutral);
  }
  if (app.est) app.est.update(frame, t);
}

// ---------------------------------------------------------------- automatic lock-on (no calibration)
function beginLock() {
  app.lock.reset();
  setPhase('lock');
  if (!app.maze) loadLevel(app.levelIdx);
  $('hud').hidden = false;
  $('ready-title').textContent = 'EYE MAZE';
  $('ready-name').textContent = '';
  $('ready-hint').textContent = '';
  $('ready-num').textContent = '';
  $('ready-ring').classList.remove('done');
  $('ready-sub').textContent = 'Looking for your face…';
  show('screen-center');
}

function onLocked(neutral) {
  app.neutral = neutral;
  app.stats.locks++;
  const model = app.personal ? app.personal : defaultModel(neutral);
  if (!app.est) app.est = new GazeEstimator(model, estOpts());
  else app.est.setModel(model);
  setPhase('locked');
  $('ready-ring').classList.add('done');
  $('ready-sub').textContent = 'Tracking ready';
  setTimeout(() => { if (app.phase === 'locked') enterIntro(); }, 650);
}

function estOpts() {
  const s = app.settings;
  return { sens: s.sens, vsens: s.vsens, smoothing: s.smooth, mirror: s.mirror };
}

// ---------------------------------------------------------------- levels
function loadLevel(i) {
  app.levelIdx = i;
  const def = PLAYLIST[i];
  app.def = def;
  app.maze = buildLevel(def, { portrait: innerHeight > innerWidth * 1.1 });
  app.maze.levelId = i;
  app.ball = makeBall(app.maze.start);
  app.levelTime = 0;
  app.charge = { H: 0, V: 0, axis: null };
  renderer.layout(app.maze);
  $('hud-level').textContent = `LEVEL ${i + 1}/${PLAYLIST.length}`;
  $('hud-name').textContent = def.name;
  $('hud-hint').textContent = def.hint;
  $('hud-hint').style.opacity = 1;
  $('hud-mode').hidden = !app.maze.phases.length;
}

function enterIntro() {
  if (!app.maze || app.maze.levelId !== app.levelIdx) loadLevel(app.levelIdx);
  setPhase('intro');
  app.recentering = false;
  const def = PLAYLIST[app.levelIdx];
  $('ready-title').textContent = `LEVEL ${app.levelIdx + 1}`;
  $('ready-name').textContent = def.name;
  $('ready-hint').textContent = def.hint;
  $('ready-ring').classList.remove('done');
  $('hud').hidden = false;
  show('screen-center');
  if (app.tracker.kind === 'synthetic') app.tracker.follow = null;
}

function startPlay() {
  setPhase('play');
  show(null);
  setTimeout(() => ($('hud-hint').style.opacity = 0), 7000);
}

function levelComplete() {
  setPhase('transition');
  app.times[app.levelIdx] = app.levelTime;
  renderer.emit(app.ball.x, app.ball.y, 90, [61, 255, 138], 1.6, 1.4);
  renderer.ripple(app.ball.x, app.ball.y, [61, 255, 138]);
  toast(`${app.def.name} — ${fmt(app.levelTime)}`, 1800);
}

function showSuccess() {
  setPhase('success');
  $('hud').hidden = true;
  const total = app.times.reduce((s, t) => s + (t || 0), 0);
  $('succ-times').innerHTML = PLAYLIST.map((d, i) => `<li>${d.name} <b>${fmt(app.times[i] || 0)}</b></li>`).join('') +
    `<li>TOTAL <b>${fmt(total)}</b></li>`;
  show('screen-success');
}

function replay() {
  app.levelIdx = 0; app.times = []; app.maze = null;
  enterIntro(); // same tracking, same settings: no calibration, no camera prompt
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${Math.floor((s % 1) * 10)}`;

// ---------------------------------------------------------------- settings (optional)
const SLIDERS = [['sl-sens', 'sens', 2], ['sl-vsens', 'vsens', 2], ['sl-smooth', 'smooth', 1], ['sl-speed', 'speed', 2]];
function syncSettingsUI() {
  for (const [id, key, dp] of SLIDERS) { $(id).value = app.settings[key]; $(id + '-v').textContent = (+app.settings[key]).toFixed(dp); }
  $('cb-mirror').checked = !!app.settings.mirror;
  $('cb-debug').checked = !!app.settings.debug;
  const personal = !!app.personal;
  $('set-mode').textContent = personal
    ? `Tracking: personal calibration (quality ${(app.personal.quality.overall * 100).toFixed(0)}%)`
    : 'Tracking: automatic (no calibration)';
  $('btn-auto').hidden = !personal;
  $('debug').hidden = !app.settings.debug;
}
function setSetting(key, value) {
  app.settings[key] = value;
  store.set('settings', app.settings);
  if (app.est) app.est.setOpts(estOpts());
  syncSettingsUI();
}
for (const [id, key] of SLIDERS) $(id).addEventListener('input', () => setSetting(key, +$(id).value));
$('cb-mirror').addEventListener('change', () => setSetting('mirror', $('cb-mirror').checked));
$('cb-debug').addEventListener('change', () => setSetting('debug', $('cb-debug').checked));
$('btn-settings').addEventListener('click', () => ($('settings').hidden ? openSettings() : closeSettings()));
$('btn-settings-close').addEventListener('click', closeSettings);
$('btn-reset').addEventListener('click', () => { app.settings = { ...DEFAULT_SETTINGS, debug: app.settings.debug }; store.set('settings', app.settings); if (app.est) app.est.setOpts(estOpts()); syncSettingsUI(); });
$('btn-recenter').addEventListener('click', () => { closeSettings(); startRecenter(); });
$('btn-quickcal').addEventListener('click', () => { closeSettings(); quickCalibrate(); });
$('btn-auto').addEventListener('click', () => {
  app.personal = null; store.set('personal', null);
  if (app.est && app.neutral) app.est.setModel(defaultModel(app.neutral));
  syncSettingsUI(); toast('Automatic tracking');
});
function openSettings() { syncSettingsUI(); $('settings').hidden = false; app.paused = true; }
function closeSettings() { $('settings').hidden = true; app.paused = false; }
syncSettingsUI();

/** re-centre: the player looks at the ring in the middle for about a second */
function startRecenter(hint = 'Look at the ring.') {
  if (!app.est) return;
  app.resumePhase = app.phase === 'recenter' ? app.resumePhase : app.phase;
  setPhase('recenter');
  $('ready-title').textContent = 'RE-CENTRE';
  $('ready-name').textContent = '';
  $('ready-hint').textContent = hint;
  $('ready-num').textContent = '';
  $('ready-ring').classList.remove('done');
  $('ready-sub').textContent = '';
  show('screen-center');
  if (app.tracker.kind === 'synthetic') app.tracker.follow = () => ({ x: 0, y: 0 });
}

async function quickCalibrate() {
  if (!app.tracker) return;
  const resume = ['play', 'intro'].includes(app.phase) ? 'intro' : app.phase;
  setPhase('calibrating');
  show(null);
  $('hud').hidden = true;
  const res = await app.quickcal.run();
  app.stats.calibrations++;
  $('hud').hidden = false;
  if (res.ok) {
    app.personal = res.model;
    store.set('personal', res.model);
    app.neutral = res.neutral || app.neutral;
    if (!app.est) app.est = new GazeEstimator(res.model, estOpts()); else app.est.setModel(res.model);
    toast(`Calibrated for you (quality ${(res.quality * 100).toFixed(0)}%) — kept for this session`, 3200);
  } else if (!res.cancelled) {
    toast('Calibration was unclear — still using automatic tracking', 3600);
    console.info('[EYE MAZE] calibration issues', res.issues);
  }
  syncSettingsUI();
  if (resume === 'intro' || resume === 'play') enterIntro();
  else if (resume === 'success') showSuccess();
  else beginLock();
}

// ---------------------------------------------------------------- status indicator (small, never blocking)
const STATUS_TEXT = { noface: 'looking for your face', unreliable: '', blink: '', headmove: '', glitch: '' };
function updateStatus(o, dt) {
  const el = $('status'), active = ['play', 'intro', 'recenter', 'transition'].includes(app.phase);
  el.hidden = !active || !o;
  if (el.hidden) return;
  const bad = o.state === 'noface' || o.state === 'unreliable';
  app.badT = bad ? (app.badT || 0) + dt : 0;
  const showText = bad && app.badT > 0.5;     // ignore brief drop-outs entirely
  el.className = showText ? 'warn' : o.state === 'ok' ? 'ok' : 'mid';
  $('status-text').textContent = showText ? (o.state === 'noface' ? STATUS_TEXT.noface : o.reason || 'tracking unclear') : '';
}

// ---------------------------------------------------------------- main loop
let lastT = performance.now(), dbgT = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  const o = app.est ? app.est.out : null;
  const tracking = o && o.state === 'ok';
  let dir = 'center';
  if (!app.paused) app.phaseT += dt;

  if (app.phase === 'lock') {
    const last = app.tracker && app.tracker.last;
    const face = last && last.frame;
    ring($('ready-fg'), app.lock.progress);
    $('ready-sub').textContent = !face
      ? (app.phaseT > 6 ? 'Looking for your face… make sure it is lit and in view of the camera' : 'Looking for your face…')
      : app.lock.unstable ? 'Look at the ring…' : 'Look at the ring';
  }

  if (app.phase === 'intro' && !app.paused) {
    const faceOk = o && o.state !== 'noface';
    if (!faceOk) { app.phaseT = Math.min(app.phaseT, 0.5); $('ready-sub').textContent = 'Looking for your face…'; }
    else $('ready-sub').textContent = 'starting';
    const p = app.phaseT / INTRO_S;
    ring($('ready-fg'), p);
    $('ready-num').textContent = faceOk ? String(Math.max(1, Math.ceil(INTRO_S - app.phaseT))) : '';
    // the player is looking at the countdown: refresh the neutral (only applied if steady)
    if (app.phaseT >= INTRO_S - RECENTER_FROM && !app.recentering) { app.recentering = true; app.est.beginRecenter(); }
    if (app.phaseT >= INTRO_S) {
      if (app.est.endRecenter()) app.stats.recentres++;
      startPlay();
    }
  }

  if (app.phase === 'recenter' && !app.paused) {
    ring($('ready-fg'), app.phaseT / 1.4);
    if (app.phaseT > 0.35 && !app.est.collect) app.est.beginRecenter();
    if (app.phaseT >= 1.4) {
      const ok = app.est.endRecenter({ maxShift: 2 });
      if (ok) app.stats.recentres++;
      toast(ok ? 'Re-centred' : 'Could not re-centre — hold your eyes on the ring and try again');
      if (app.tracker.kind === 'synthetic') app.tracker.follow = null;
      const back = app.resumePhase;
      if (back === 'play') { setPhase('play'); show(null); } else enterIntro();
    }
  }

  if (app.phase === 'play') {
    // only the absence of a readable face pauses the clock — never head posture
    app.lostT = o && o.state === 'noface' ? app.lostT + dt : 0;
    const frozen = app.paused || app.lostT > 0.6;
    if (tracking && !app.paused) dir = o.dir;
    if (!frozen) {
      app.levelTime += dt;
      app.maze.update(app.levelTime, dt, app.ball);
      if (app.maze.phases.length) {
        const flipped = updatePhaseCharge(app.maze, app.charge, dir, dt);
        if (flipped) { renderer.ripple(app.ball.x, app.ball.y, [220, 235, 255]); toast(flipped === 'H' ? 'the maze turns sideways' : 'the maze turns vertical', 1400); }
      }
      const speed = PLAYLIST[app.levelIdx].speed * app.settings.speed;
      const r = stepBall(app.ball, dir, dt, app.maze, { speed });
      app.moving = r.moved > 0.002;
      // stuck guard: pushing into a PERMANENT wall for a few seconds usually means the neutral gaze is off
      // (e.g. the player looked away while tracking locked on). Gates and gaze-walls are excluded — waiting
      // at those is part of levels 2 and 3.
      const cell = { x: Math.floor(app.ball.x), y: Math.floor(app.ball.y) };
      const permanent = dir !== 'center' && !app.maze.passable(cell.x, cell.y, dir, 'open');
      app.stuckT = r.blocked && permanent ? (app.stuckT || 0) + dt : Math.max(0, (app.stuckT || 0) - dt * 2);
      if (app.stuckT > 3) { app.stuckT = 0; app.stats.autoRecentres = (app.stats.autoRecentres || 0) + 1; startRecenter('Drifting? Look at the ring for a moment.'); }
      if (reachedGoal(app.ball, app.maze.goal)) levelComplete();
    } else app.moving = false;
    $('hud-time').textContent = fmt(app.levelTime);
    if (app.maze.phases.length) $('hud-mode').textContent = app.maze.mode === 'H' ? '↔ sideways' : '↕ vertical';
  }

  if (app.phase === 'transition' && app.phaseT >= 1.8) {
    if (app.levelIdx + 1 < PLAYLIST.length) { app.levelIdx++; enterIntro(); } else showSuccess();
  }

  if (app.phase === 'success' && !app.paused) {
    ring($('succ-fg'), app.phaseT / REPLAY_S);
    $('succ-sub').textContent = `A new run starts in ${Math.max(0, Math.ceil(REPLAY_S - app.phaseT))} s — or`;
    if (app.phaseT >= REPLAY_S) replay();
  }

  updateStatus(o, dt);

  const showMaze = ['lock', 'locked', 'intro', 'play', 'transition', 'success', 'recenter'].includes(app.phase);
  renderer.draw({
    maze: showMaze ? app.maze : null, ball: showMaze ? app.ball : null,
    dir: app.phase === 'play' ? dir : 'center', time: now / 1000, dt, moving: app.phase === 'play' && app.moving,
    charge: app.charge.axis ? { amount: app.charge[app.charge.axis] / PHASE_HOLD_S } : null,
    dim: ['lock', 'locked', 'intro', 'recenter'].includes(app.phase) ? 0.62 : app.phase === 'success' ? 0.5 : app.paused ? 0.4 : 0,
  });
  if (app.settings.debug && now - dbgT > 66) { dbgT = now; updateDebug(); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function ring(el, p) { el.style.strokeDashoffset = `${138.2 * (1 - Math.max(0, Math.min(1, p)))}`; }

// ---------------------------------------------------------------- debug panel
const EYE_IDX = [33, 133, 159, 145, 362, 263, 386, 374, 468, 473];
const dbgG = $('dbg-preview').getContext('2d');
function drawPreview(g, w, h) {
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  if (!app.tracker || app.tracker.kind !== 'camera' || !video.videoWidth) {
    g.fillStyle = 'rgba(232,242,255,0.4)'; g.font = '11px monospace'; g.textAlign = 'center';
    g.fillText(app.tracker && app.tracker.kind === 'synthetic' ? 'synthetic eyes' : 'no video', w / 2, h / 2);
    return;
  }
  g.save(); g.translate(w, 0); g.scale(-1, 1); // shown mirrored, like a mirror
  g.drawImage(video, 0, 0, w, h);
  const lm = app.tracker.last && app.tracker.last.landmarks;
  if (lm) for (const i of EYE_IDX) {
    g.fillStyle = i >= 468 ? '#5ff2ff' : 'rgba(255,255,255,0.8)';
    g.beginPath(); g.arc(lm[i].x * w, lm[i].y * h, i >= 468 ? 2.2 : 1.4, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}
function updateDebug() {
  drawPreview(dbgG, 200, 150);
  const o = app.est && app.est.out;
  if (!o) { $('dbg-state').textContent = app.phase; return; }
  $('dbg-dir').textContent = o.dir;
  $('dbg-state').textContent = `${o.state}${o.reason ? ' (' + o.reason + ')' : ''} · ${app.phase}`;
  $('dbg-conf').style.width = `${(o.confidence * 100).toFixed(0)}%`;
  $('dbg-confv').textContent = o.confidence.toFixed(2);
  const bar = (el, v) => { const c = Math.max(-1.5, Math.min(1.5, v)) / 1.5 * 50; el.style.left = c >= 0 ? '50%' : `${50 + c}%`; el.style.width = `${Math.abs(c)}%`; };
  bar($('dbg-x'), o.x); bar($('dbg-y'), o.y);
  $('dbg-xv').textContent = o.x.toFixed(2); $('dbg-yv').textContent = o.y.toFixed(2);
  const th = app.est.opts.enter * (o.headK || 1) / 1.5 * 50;
  for (const id of ['dbg-thx', 'dbg-thy']) { $(id).style.left = `${50 - th}%`; $(id).style.width = `${th * 2}%`; }
  const last = app.tracker && app.tracker.last && app.tracker.last.frame;
  $('dbg-head').textContent = last ? `yaw ${last.yaw.toFixed(0)}° pitch ${last.pitch.toFixed(0)}° roll ${last.roll.toFixed(0)}°` : '—';
  $('dbg-off').textContent = `x ${o.off.x.toFixed(2)} y ${o.off.y.toFixed(2)}`;
  const m = app.est.model;
  $('dbg-q').textContent = m ? `${m.kind}${m.mirror ? ' · mirrored' : ''}${app.settings.mirror ? ' · swapped' : ''}` : '—';
  $('dbg-fps').textContent = app.tracker ? app.tracker.fps.toFixed(0) : '—';
}

// ---------------------------------------------------------------- test hooks (test mode drives synthetic eyes only)
const synth = () => app.tracker && app.tracker.kind === 'synthetic' ? app.tracker : null;
app.setGaze = (x, y) => { const t = synth(); if (t) { t.follow = null; t.gaze = { x, y }; } };
app.setFace = (v) => { const t = synth(); if (t) t.face = v; };
app.setHead = (yaw, pitch) => { const t = synth(); if (t) t.head = { yaw, pitch }; };
app.setBlink = (v) => { const t = synth(); if (t) t.blink = v; };
app.setPerson = (p) => { const t = synth(); if (t) Object.assign(t.person, p); };
app.jumpToLevel = (i) => { if (!TEST) return; app.levelIdx = i; app.maze = null; enterIntro(); };
app.openSettings = openSettings; app.closeSettings = closeSettings; app.quickCalibrate = quickCalibrate; app.startRecenter = startRecenter;
