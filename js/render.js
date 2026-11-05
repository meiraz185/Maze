// EYE MAZE — canvas renderer
import { doorRect } from './maze.js';

const CYAN = [95, 242, 255];
const GREEN = [61, 255, 138];
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

export class Renderer {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.particles = [];
    this.ripples = [];
    this.stars = Array.from({ length: 90 }, () => ({ x: Math.random(), y: Math.random(), a: Math.random() * 0.25 + 0.03, p: Math.random() * 6.28 }));
    this.resize();
    addEventListener('resize', () => this.resize());
  }
  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.W = innerWidth; this.H = innerHeight;
    this.c.width = Math.round(this.W * dpr); this.c.height = Math.round(this.H * dpr);
    this.c.style.width = this.W + 'px'; this.c.style.height = this.H + 'px';
    if (this.maze) this.layout(this.maze);
  }
  layout(maze) {
    this.maze = maze;
    const mx = Math.max(24, this.W * 0.06), myTop = Math.max(64, this.H * 0.1), myBot = Math.max(40, this.H * 0.07);
    const cell = Math.floor(Math.min((this.W - 2 * mx) / maze.cols, (this.H - myTop - myBot) / maze.rows));
    this.cell = Math.max(cell, 18);
    this.ox = Math.round((this.W - this.cell * maze.cols) / 2);
    this.oy = Math.round(myTop + (this.H - myTop - myBot - this.cell * maze.rows) / 2);
  }
  toPx(x, y) { return [this.ox + x * this.cell, this.oy + y * this.cell]; }

  emit(x, y, n, color = CYAN, speed = 0.4, life = 0.9) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = Math.random() * speed;
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life, max: life, color, size: 0.5 + Math.random() });
    }
    if (this.particles.length > 700) this.particles.splice(0, this.particles.length - 700);
  }
  ripple(x, y, color = CYAN) { this.ripples.push({ x, y, t: 0, color }); }

  /** s = { maze, ball, dir, gaze:{x,y}, time, dt, moving, charge:{axis,amount}, dim } */
  draw(s) {
    const g = this.g, dpr = this.dpr, T = s.time;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // background
    g.fillStyle = '#04060a';
    g.fillRect(0, 0, this.W, this.H);
    const vg = g.createRadialGradient(this.W / 2, this.H / 2, 0, this.W / 2, this.H / 2, Math.max(this.W, this.H) * 0.7);
    vg.addColorStop(0, 'rgba(20,40,60,0.18)'); vg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = vg; g.fillRect(0, 0, this.W, this.H);
    for (const st of this.stars) {
      g.fillStyle = `rgba(200,230,255,${st.a * (0.6 + 0.4 * Math.sin(T * 0.7 + st.p))})`;
      g.fillRect(st.x * this.W, st.y * this.H, 1, 1);
    }
    if (!s.maze) return;
    const m = s.maze, cell = this.cell;

    // gaze cue: a soft glow on the edge of the screen you are looking toward
    if (s.dir && s.dir !== 'center') this._edgeGlow(s.dir, 0.12 + 0.04 * Math.sin(T * 4));

    // faint cell grid
    g.strokeStyle = 'rgba(255,255,255,0.025)'; g.lineWidth = 1;
    g.beginPath();
    for (let x = 1; x < m.cols; x++) { const [px] = this.toPx(x, 0); g.moveTo(px + 0.5, this.oy); g.lineTo(px + 0.5, this.oy + m.rows * cell); }
    for (let y = 1; y < m.rows; y++) { const [, py] = this.toPx(0, y); g.moveTo(this.ox, py + 0.5); g.lineTo(this.ox + m.cols * cell, py + 0.5); }
    g.stroke();

    // exit portal
    this._portal(m.goal, T);

    // walls
    const lw = Math.max(1.25, cell * 0.022);
    g.lineCap = 'round';
    g.save();
    g.shadowColor = 'rgba(255,255,255,0.55)'; g.shadowBlur = 6;
    g.strokeStyle = 'rgba(240,248,255,0.9)'; g.lineWidth = lw;
    g.beginPath();
    for (const sg of m.staticSegments()) {
      const [x1, y1] = this.toPx(sg.x1, sg.y1), [x2, y2] = this.toPx(sg.x2, sg.y2);
      g.moveTo(x1, y1); g.lineTo(x2, y2);
    }
    g.stroke();
    g.restore();

    // moving walls (level 2)
    for (const d of m.doors) this._door(d, lw, T);
    // gaze-reactive walls (level 3)
    for (const p of m.phases) this._phase(p, lw, T, m.mode);

    // ripples
    for (const r of this.ripples) {
      r.t += s.dt;
      const [px, py] = this.toPx(r.x, r.y);
      const k = r.t / 1.2;
      g.strokeStyle = rgba(r.color, 0.35 * (1 - k)); g.lineWidth = 1.5;
      g.beginPath(); g.arc(px, py, k * cell * 4, 0, Math.PI * 2); g.stroke();
    }
    this.ripples = this.ripples.filter((r) => r.t < 1.2);

    // particles
    g.save(); g.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      p.life -= s.dt; p.x += p.vx * s.dt; p.y += p.vy * s.dt; p.vx *= 0.96; p.vy *= 0.96;
      if (p.life <= 0) continue;
      const [px, py] = this.toPx(p.x, p.y);
      const a = (p.life / p.max) ** 1.5;
      g.fillStyle = rgba(p.color, 0.55 * a);
      g.beginPath(); g.arc(px, py, p.size * Math.max(1, cell * 0.018) * (0.5 + a), 0, Math.PI * 2); g.fill();
    }
    g.restore();
    this.particles = this.particles.filter((p) => p.life > 0);

    // ball
    if (s.ball) this._ball(s, T);

    if (s.dim) { g.fillStyle = `rgba(2,4,8,${s.dim})`; g.fillRect(0, 0, this.W, this.H); }
  }

  _edgeGlow(dir, a) {
    const g = this.g, W = this.W, H = this.H, d = Math.min(W, H) * 0.22;
    let grad;
    if (dir === 'left') grad = g.createLinearGradient(0, 0, d, 0);
    if (dir === 'right') grad = g.createLinearGradient(W, 0, W - d, 0);
    if (dir === 'up') grad = g.createLinearGradient(0, 0, 0, d);
    if (dir === 'down') grad = g.createLinearGradient(0, H, 0, H - d);
    grad.addColorStop(0, rgba(CYAN, a)); grad.addColorStop(1, rgba(CYAN, 0));
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
  }

  _portal(goal, T) {
    const g = this.g, cell = this.cell;
    const [px, py] = this.toPx(goal.x + 0.5, goal.y + 0.5);
    const R = cell * 0.3;
    g.save(); g.globalCompositeOperation = 'lighter';
    const gl = g.createRadialGradient(px, py, 0, px, py, R * 2.6);
    gl.addColorStop(0, rgba(GREEN, 0.35)); gl.addColorStop(0.4, rgba(GREEN, 0.12)); gl.addColorStop(1, rgba(GREEN, 0));
    g.fillStyle = gl; g.beginPath(); g.arc(px, py, R * 2.6, 0, Math.PI * 2); g.fill();
    g.lineWidth = Math.max(1.2, cell * 0.02);
    for (let i = 0; i < 3; i++) {
      const rr = R * (0.55 + i * 0.25) * (1 + 0.05 * Math.sin(T * 2 + i));
      const a0 = T * (0.8 + i * 0.5) * (i % 2 ? -1 : 1);
      g.strokeStyle = rgba(GREEN, 0.75 - i * 0.18);
      g.beginPath(); g.arc(px, py, rr, a0, a0 + Math.PI * 1.3); g.stroke();
    }
    g.fillStyle = rgba(GREEN, 0.9);
    g.beginPath(); g.arc(px, py, R * 0.18 * (1 + 0.2 * Math.sin(T * 5)), 0, Math.PI * 2); g.fill();
    g.restore();
    if (Math.random() < 0.3) this.emit(goal.x + 0.5 + (Math.random() - 0.5) * 0.3, goal.y + 0.5 + (Math.random() - 0.5) * 0.3, 1, GREEN, 0.15, 1.2);
  }

  _door(d, lw, T) {
    const g = this.g;
    const r = doorRect(d, d.open);
    const [ax, ay] = d.line === 'v' ? this.toPx(d.X, d.Y) : this.toPx(d.X, d.Y);
    const [bx, by] = d.line === 'v' ? this.toPx(d.X, d.Y + 1) : this.toPx(d.X + 1, d.Y);
    // ghost track
    g.save();
    g.strokeStyle = 'rgba(200,250,255,0.22)'; g.lineWidth = 1; g.setLineDash([3, 4]);
    g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
    g.restore();
    if (!r) return;
    const t = 0.04;
    let x1, y1, x2, y2;
    if (d.line === 'v') { [x1, y1] = this.toPx(d.X, r.y + t); [x2, y2] = this.toPx(d.X, r.y + r.h - t); }
    else { [x1, y1] = this.toPx(r.x + t, d.Y); [x2, y2] = this.toPx(r.x + r.w - t, d.Y); }
    g.save();
    g.shadowColor = 'rgba(255,255,255,0.8)'; g.shadowBlur = 8 + 4 * Math.sin(T * 3);
    g.strokeStyle = d.blocked ? 'rgba(150,240,255,1)' : 'rgba(215,250,255,0.98)';
    g.lineWidth = lw * 2.2; g.lineCap = 'round';
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    g.restore();
  }

  _phase(p, lw, T, mode) {
    const g = this.g, s = p.solid;
    const [x1, y1] = this.toPx(p.X, p.Y);
    const [x2, y2] = p.line === 'v' ? this.toPx(p.X, p.Y + 1) : this.toPx(p.X + 1, p.Y);
    g.save();
    g.lineCap = 'round';
    // a different "material": dotted, cool-tinted; dense when solid, a faint ghost when open
    g.setLineDash([Math.max(0.5, 2.5 * s), 3 + (1 - s) * 6]);
    g.lineDashOffset = -T * 10;
    g.shadowColor = 'rgba(170,200,255,0.8)'; g.shadowBlur = 8 * s;
    g.strokeStyle = `rgba(190,215,255,${0.18 + 0.8 * s})`;
    g.lineWidth = lw * (1.2 + 1.0 * s);
    // slight wobble while transforming
    const wob = s > 0.02 && s < 0.98 ? Math.sin(T * 30) * 1.5 : 0;
    g.beginPath(); g.moveTo(x1 + (p.line === 'h' ? 0 : wob), y1 + (p.line === 'h' ? wob : 0));
    g.lineTo(x2 + (p.line === 'h' ? 0 : wob), y2 + (p.line === 'h' ? wob : 0)); g.stroke();
    g.restore();
    if (s > 0.05 && s < 0.95 && Math.random() < 0.5) {
      const k = Math.random();
      const x = p.line === 'v' ? p.X : p.X + k, y = p.line === 'v' ? p.Y + k : p.Y;
      this.emit(x, y, 1, [210, 230, 255], 0.25, 0.6);
    }
  }

  _ball(s, T) {
    const g = this.g, cell = this.cell, b = s.ball;
    const [px, py] = this.toPx(b.x, b.y);
    const R = b.r * cell;
    if (s.moving) this.emit(b.x + (Math.random() - 0.5) * b.r * 0.8, b.y + (Math.random() - 0.5) * b.r * 0.8, 2, CYAN, 0.12, 0.9);
    g.save(); g.globalCompositeOperation = 'lighter';
    const pulse = 1 + 0.06 * Math.sin(T * 3.2);
    const gl = g.createRadialGradient(px, py, 0, px, py, R * 3.2 * pulse);
    gl.addColorStop(0, rgba(CYAN, 0.45)); gl.addColorStop(0.35, rgba(CYAN, 0.15)); gl.addColorStop(1, rgba(CYAN, 0));
    g.fillStyle = gl; g.beginPath(); g.arc(px, py, R * 3.2 * pulse, 0, Math.PI * 2); g.fill();
    const core = g.createRadialGradient(px - R * 0.25, py - R * 0.25, 0, px, py, R);
    core.addColorStop(0, 'rgba(240,255,255,1)'); core.addColorStop(0.5, rgba(CYAN, 0.95)); core.addColorStop(1, rgba(CYAN, 0.55));
    g.fillStyle = core; g.beginPath(); g.arc(px, py, R * 0.62, 0, Math.PI * 2); g.fill();
    g.restore();

    // direction chevron
    if (s.dir && s.dir !== 'center') {
      const v = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[s.dir];
      const d = R * 1.5 + R * 0.25 * Math.sin(T * 8);
      const cx = px + v[0] * d, cy = py + v[1] * d, w = R * 0.4;
      g.strokeStyle = rgba(CYAN, 0.8); g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(cx - v[0] * w + v[1] * w, cy - v[1] * w + v[0] * w);
      g.lineTo(cx, cy);
      g.lineTo(cx - v[0] * w - v[1] * w, cy - v[1] * w - v[0] * w);
      g.stroke();
    }
    // sustained-gaze charge ring (level 3)
    if (s.charge && s.charge.amount > 0.02) {
      g.strokeStyle = rgba([220, 235, 255], 0.75); g.lineWidth = 2;
      g.beginPath(); g.arc(px, py, R * 2.1, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, s.charge.amount)); g.stroke();
    }
  }
}
