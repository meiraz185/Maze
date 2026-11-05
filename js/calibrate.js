// EYE MAZE v4 — OPTIONAL quick calibration (opened from settings; never required)
import { Calibration, median } from './gaze.js';

export const TARGETS = [
  { id: 'center', fx: 0.5, fy: 0.5, gx: 0, gy: 0 },
  { id: 'left', fx: 0.06, fy: 0.5, gx: -1, gy: 0 },
  { id: 'right', fx: 0.94, fy: 0.5, gx: 1, gy: 0 },
  { id: 'up', fx: 0.5, fy: 0.08, gx: 0, gy: -1 },
  { id: 'down', fx: 0.5, fy: 0.92, gx: 0, gy: 1 },
];
const MOVE_MS = 500, SETTLE_MS = 450, COLLECT_MS = 1000, EXTEND_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class QuickCalibration {
  constructor(root, tracker) {
    this.root = root; this.tracker = tracker;
    this.dot = root.querySelector('.cal-dot');
    this.ring = root.querySelector('.cal-ring circle.fg');
    this.text = root.querySelector('.cal-text');
    this.step = root.querySelector('.cal-step');
    this.cal = null;
    this.collecting = null;
    this.cancelled = false;
  }
  feed(frame) {
    if (!this.collecting || !frame) return;
    const kept = this.cal.samples[this.collecting];
    if (kept.length >= 6 && frame.open < median(kept.slice(-30).map((f) => f.open)) * 0.6) return; // blink
    this.cal.add(this.collecting, frame);
  }
  _progress(p) {
    const C = 2 * Math.PI * 22;
    this.ring.style.strokeDasharray = `${C}`;
    this.ring.style.strokeDashoffset = `${C * (1 - Math.max(0, Math.min(1, p)))}`;
  }
  cancel() { this.cancelled = true; }
  /** ~10 s. resolves {ok, model, issues} or {cancelled:true} */
  async run() {
    this.cal = new Calibration();
    this.cancelled = false;
    this.root.hidden = false;
    let i = 0;
    for (const t of TARGETS) {
      i++;
      if (this.cancelled) break;
      this.step.textContent = `QUICK CALIBRATION  ${i} / ${TARGETS.length}`;
      this.text.textContent = i === 1 ? 'Follow the dot with your eyes.' : '';
      this.dot.style.left = `${t.fx * 100}%`;
      this.dot.style.top = `${t.fy * 100}%`;
      this._progress(0);
      this.dot.classList.add('moving');
      if (this.tracker.kind === 'synthetic') this.tracker.follow = () => ({ x: t.gx, y: t.gy });
      await sleep(MOVE_MS);
      this.dot.classList.remove('moving');
      await sleep(SETTLE_MS);
      this.collecting = t.id;
      const t0 = performance.now();
      while (!this.cancelled) {
        const el = performance.now() - t0, n = this.cal.count(t.id);
        this._progress(Math.min(el / COLLECT_MS, n / 20));
        if (el >= COLLECT_MS && n >= 12) break;
        if (el >= COLLECT_MS + EXTEND_MS) break;
        await sleep(40);
      }
      this.collecting = null;
      this.dot.classList.add('done');
      await sleep(120);
      this.dot.classList.remove('done');
    }
    if (this.tracker.kind === 'synthetic') this.tracker.follow = null;
    this.root.hidden = true;
    if (this.cancelled) return { cancelled: true };
    const res = this.cal.compute();
    res.counts = Object.fromEntries(Object.entries(this.cal.samples).map(([k, v]) => [k, v.length]));
    return res;
  }
}
