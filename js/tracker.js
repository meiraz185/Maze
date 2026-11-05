// EYE MAZE — webcam + MediaPipe Face Landmarker. Everything runs locally in the browser:
// frames go from the <video> element straight into the on-device model; nothing is recorded or uploaded.
import { extractFeatures } from './gaze.js';
import { syntheticFrame, AVERAGE_PERSON } from './synthetic.js';

const MODEL_LOCAL = new URL('../models/face_landmarker.task', import.meta.url).href;
const MODEL_REMOTE = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const WASM_LOCAL = new URL('../vendor/mediapipe/wasm', import.meta.url).href;

export class CameraTracker {
  constructor(video) {
    this.video = video;
    this.kind = 'camera';
    this.listeners = [];
    this.running = false;
    this.lastVideoTime = -1;
    this.fps = 0;
    this.last = null; // last raw result (for the debug preview)
    this.delegate = null;
    this.modelSource = null;
  }
  onFrame(fn) { this.listeners.push(fn); }

  async start(status = () => {}) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw Object.assign(new Error('This browser cannot access a camera here. Use Chrome, Edge, Firefox or Safari over https:// or http://localhost.'), { code: 'nocamapi' });
    }
    status('Requesting camera…');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 60 } },
    });
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    await new Promise((r) => (this.video.videoWidth ? r() : this.video.addEventListener('loadedmetadata', r, { once: true })));

    status('Loading face tracking model…');
    const vision = await import('../vendor/mediapipe/vision_bundle.mjs');
    const fileset = await vision.FilesetResolver.forVisionTasks(WASM_LOCAL);
    const modelPath = await pickModel();
    this.modelSource = modelPath === MODEL_LOCAL ? 'local' : 'google';
    const make = (delegate) => vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: modelPath, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try { this.landmarker = await make('GPU'); this.delegate = 'GPU'; }
    catch (e) { console.warn('GPU delegate failed, using CPU', e); this.landmarker = await make('CPU'); this.delegate = 'CPU'; }
    status('Tracking ready');
    this.running = true;
    this._loop();
  }

  _loop() {
    if (!this.running) return;
    const v = this.video;
    const now = performance.now();
    if (v.readyState >= 2 && v.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = v.currentTime;
      let result = null;
      try { result = this.landmarker.detectForVideo(v, now); } catch (e) { console.warn(e); }
      const lm = result && result.faceLandmarks && result.faceLandmarks[0];
      const frame = lm ? extractFeatures(
        lm, v.videoWidth / v.videoHeight,
        result.faceBlendshapes && result.faceBlendshapes[0] ? result.faceBlendshapes[0].categories : null,
      ) : null;
      this.last = { landmarks: lm || null, frame };
      if (this._prevT) this.fps = 0.9 * this.fps + 0.1 * (1000 / Math.max(1, now - this._prevT));
      this._prevT = now;
      for (const fn of this.listeners) fn(frame, now);
    }
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => this._loop());
    else requestAnimationFrame(() => this._loop());
  }

  stop() {
    this.running = false;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.landmarker) this.landmarker.close();
  }
}

async function pickModel() {
  // prefer a copy in /models (offline use); otherwise Google's official hosted model file
  try {
    const r = await fetch(MODEL_LOCAL, { method: 'HEAD', cache: 'no-store' });
    if (r.ok && Number(r.headers.get('content-length') || 1) > 100000) return MODEL_LOCAL;
  } catch (e) { /* no local copy */ }
  return MODEL_REMOTE;
}

/**
 * Keyboard / scripted stand-in for the camera. For testing the game and the pipeline only.
 * Arrow keys (or window.eyeMaze.setGaze) set a "true gaze"; frames come from a synthetic eye model.
 */
export class SyntheticTracker {
  constructor() {
    this.kind = 'synthetic';
    this.listeners = [];
    this.gaze = { x: 0, y: 0 };
    this.head = { yaw: 0, pitch: 0 };
    this.person = { ...AVERAGE_PERSON };
    this.blink = false;
    this.face = true;
    this.follow = null; // during calibration: () => {x,y} of the target, so tests can run unattended
    this.fps = 30;
    this.last = null;
    this.delegate = 'synthetic';
    this.modelSource = 'none';
    this.keys = new Set();
  }
  onFrame(fn) { this.listeners.push(fn); }
  async start(status = () => {}) {
    status('Test mode: synthetic eyes (arrow keys)');
    const onKey = (e) => {
      const map = { ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1 };
      if (!map[e.key]) return;
      e.preventDefault();
      if (e.type === 'keydown') this.keys.add(e.key); else this.keys.delete(e.key);
      this.follow = null;
    };
    addEventListener('keydown', onKey); addEventListener('keyup', onKey);
    this.timer = setInterval(() => this._tick(), 33);
  }
  _tick() {
    let g = this.gaze;
    if (this.follow) g = this.follow();
    else if (this.keys.size) {
      const k = this.keys;
      g = { x: (k.has('ArrowRight') ? 0.9 : 0) - (k.has('ArrowLeft') ? 0.9 : 0), y: (k.has('ArrowDown') ? 0.9 : 0) - (k.has('ArrowUp') ? 0.9 : 0) };
    }
    const frame = this.face ? syntheticFrame(g.x, g.y, { person: this.person, blink: this.blink, yaw: g.yaw ?? this.head.yaw, pitch: g.pitch ?? this.head.pitch }) : null;
    this.last = { landmarks: null, frame };
    const now = performance.now();
    for (const fn of this.listeners) fn(frame, now);
  }
  stop() { clearInterval(this.timer); }
}
