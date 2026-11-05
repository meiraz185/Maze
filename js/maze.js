// EYE MAZE — maze model (pure, no DOM)
// Coordinates are in CELL units: cell (cx, cy) spans [cx, cx+1] x [cy, cy+1].
// Edges:  'v:X:Y' = vertical line at x = X, spanning row Y   (crossing it = horizontal move)
//         'h:X:Y' = horizontal line at y = Y, spanning col X (crossing it = vertical move)

export const DV = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
export const WALL_T = 0.08; // collision thickness of a wall, in cells

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function edgeKey(cx, cy, dir) {
  switch (dir) {
    case 'left': return `v:${cx}:${cy}`;
    case 'right': return `v:${cx + 1}:${cy}`;
    case 'up': return `h:${cx}:${cy}`;
    case 'down': return `h:${cx}:${cy + 1}`;
  }
  return null;
}

export class Maze {
  constructor(cols, rows) {
    this.cols = cols; this.rows = rows;
    this.edges = new Map();
    for (let y = 0; y < rows; y++) for (let x = 0; x <= cols; x++) this.edges.set(`v:${x}:${y}`, { kind: 'wall' });
    for (let y = 0; y <= rows; y++) for (let x = 0; x < cols; x++) this.edges.set(`h:${x}:${y}`, { kind: 'wall' });
    this.start = { x: 0, y: 0 };
    this.goal = { x: cols - 1, y: rows - 1 };
    this.doors = [];   // dynamic sliding walls (level 2)
    this.phases = [];  // gaze-reactive walls (level 3)
    this.mode = 'H';   // phase mode for level 3
    this._static = null;
  }
  inBounds(cx, cy) { return cx >= 0 && cy >= 0 && cx < this.cols && cy < this.rows; }
  edge(cx, cy, dir) { return this.edges.get(edgeKey(cx, cy, dir)); }

  /** can the ball cross from cell (cx,cy) in direction dir right now? */
  passable(cx, cy, dir, rule = 'live') {
    const [dx, dy] = DV[dir];
    if (!this.inBounds(cx, cy) || !this.inBounds(cx + dx, cy + dy)) return false;
    const e = this.edge(cx, cy, dir);
    if (!e) return false;
    return edgeOpen(e, rule, this.mode);
  }

  /** merged rectangles for permanent walls */
  staticRects() {
    if (this._static) return this._static;
    const rects = [], segs = [];
    const t = WALL_T;
    // vertical lines
    for (let x = 0; x <= this.cols; x++) {
      let y = 0;
      while (y < this.rows) {
        if (this.edges.get(`v:${x}:${y}`).kind !== 'wall') { y++; continue; }
        let y2 = y;
        while (y2 < this.rows && this.edges.get(`v:${x}:${y2}`).kind === 'wall') y2++;
        rects.push({ x: x - t / 2, y: y - t / 2, w: t, h: y2 - y + t });
        segs.push({ x1: x, y1: y, x2: x, y2 });
        y = y2;
      }
    }
    for (let y = 0; y <= this.rows; y++) {
      let x = 0;
      while (x < this.cols) {
        if (this.edges.get(`h:${x}:${y}`).kind !== 'wall') { x++; continue; }
        let x2 = x;
        while (x2 < this.cols && this.edges.get(`h:${x2}:${y}`).kind === 'wall') x2++;
        rects.push({ x: x - t / 2, y: y - t / 2, w: x2 - x + t, h: t });
        segs.push({ x1: x, y1: y, x2, y2: y });
        x = x2;
      }
    }
    this._static = rects;
    this._segs = segs;
    return rects;
  }
  staticSegments() { this.staticRects(); return this._segs; }

  /** all rectangles that currently block the ball */
  solidRects() {
    const out = this.staticRects().slice();
    for (const d of this.doors) { const r = doorRect(d, d.open); if (r) out.push(r); }
    for (const p of this.phases) if (p.solid > 0.5) out.push(edgeRect(p));
    return out;
  }

  /** advance moving / transforming walls; never closes onto the ball */
  update(timeS, dt, ball) {
    for (const d of this.doors) {
      const ph = (((timeS + d.offset) % d.period) + d.period) % d.period / d.period;
      const target = ph < d.openFrac ? 1 : 0;
      const step = dt / d.travel;
      let next = target > d.open ? Math.min(1, d.open + step) : Math.max(0, d.open - step);
      if (next < d.open && ball) {
        const r = doorRect(d, next);
        if (r && circleRectOverlap(ball.x, ball.y, ball.r + 0.02, r)) next = d.open; // polite: wait
      }
      d.blocked = next === d.open && target < d.open;
      d.open = next;
    }
    for (const p of this.phases) {
      const target = p.openIn === this.mode ? 0 : 1;
      const step = dt / 0.55;
      let next = target > p.solid ? Math.min(1, p.solid + step) : Math.max(0, p.solid - step);
      if (next > 0.5 && p.solid <= 0.5 && ball && circleRectOverlap(ball.x, ball.y, ball.r + 0.02, edgeRect(p))) next = 0.45;
      p.solid = next;
    }
  }
}

function edgeOpen(e, rule, mode) {
  if (e.kind === 'open') return true;
  if (e.kind === 'wall') return false;
  if (e.kind === 'door') {
    if (rule === 'open') return true;
    if (rule === 'closed') return false;
    return e.ref.open > 0.75;
  }
  if (e.kind === 'phase') {
    if (rule === 'H' || rule === 'V') return e.ref.openIn === rule;
    if (rule === 'open') return true;
    if (rule === 'closed') return false;
    return e.ref.solid <= 0.5;
  }
  return false;
}

export function edgeRect(e) {
  const t = WALL_T;
  return e.line === 'v'
    ? { x: e.X - t / 2, y: e.Y - t / 2, w: t, h: 1 + t }
    : { x: e.X - t / 2, y: e.Y - t / 2, w: 1 + t, h: t };
}

/** door occupies (1-open) of its edge, sliding in from one end */
export function doorRect(d, open) {
  const L = 1 - open;
  if (L <= 0.001) return null;
  const t = WALL_T;
  if (d.line === 'v') {
    const y0 = d.from === 0 ? d.Y : d.Y + 1 - L;
    return { x: d.X - t / 2, y: y0 - t / 2, w: t, h: L + t };
  }
  const x0 = d.from === 0 ? d.X : d.X + 1 - L;
  return { x: x0 - t / 2, y: d.Y - t / 2, w: L + t, h: t };
}

export function circleRectOverlap(cx, cy, r, R) {
  const qx = Math.max(R.x, Math.min(cx, R.x + R.w));
  const qy = Math.max(R.y, Math.min(cy, R.y + R.h));
  const dx = cx - qx, dy = cy - qy;
  return dx * dx + dy * dy < r * r;
}

// ---------------------------------------------------------------------------
// generation
// ---------------------------------------------------------------------------
/** recursive backtracker; `straight` (0..1) biases toward long corridors (easier with the eyes) */
export function generateMaze(cols, rows, seed, straight = 0.5) {
  const rnd = mulberry32(seed);
  const m = new Maze(cols, rows);
  const seen = new Set([`0,0`]);
  const stack = [{ x: 0, y: 0, last: null }];
  while (stack.length) {
    const cur = stack[stack.length - 1];
    const opts = Object.keys(DV).filter((d) => {
      const [dx, dy] = DV[d];
      const nx = cur.x + dx, ny = cur.y + dy;
      return m.inBounds(nx, ny) && !seen.has(`${nx},${ny}`);
    });
    if (!opts.length) { stack.pop(); continue; }
    let d = opts[Math.floor(rnd() * opts.length)];
    if (cur.last && opts.includes(cur.last) && rnd() < straight) d = cur.last;
    const [dx, dy] = DV[d];
    m.edges.get(edgeKey(cur.x, cur.y, d)).kind = 'open';
    const nx = cur.x + dx, ny = cur.y + dy;
    seen.add(`${nx},${ny}`);
    stack.push({ x: nx, y: ny, last: d });
  }
  return m;
}

/** BFS. rule: 'live' | 'open' | 'closed' | 'H' | 'V'. Returns array of cells or null. */
export function solve(m, rule = 'open', from = m.start, to = m.goal) {
  const key = (c) => `${c.x},${c.y}`;
  const prev = new Map([[key(from), null]]);
  const q = [from];
  while (q.length) {
    const c = q.shift();
    if (c.x === to.x && c.y === to.y) {
      const path = [];
      for (let k = key(c), cell = c; cell; ) {
        path.unshift(cell);
        const p = prev.get(k);
        cell = p; k = p ? key(p) : null;
      }
      return path;
    }
    for (const d of Object.keys(DV)) {
      if (!m.passable(c.x, c.y, d, rule)) continue;
      const n = { x: c.x + DV[d][0], y: c.y + DV[d][1] };
      if (!prev.has(key(n))) { prev.set(key(n), c); q.push(n); }
    }
  }
  return null;
}

/** BFS over (cell, phase-mode) — the player may switch mode anywhere by sustaining gaze. */
export function solveWithModeSwitching(m, startMode = 'H') {
  const key = (x, y, md) => `${x},${y},${md}`;
  const seen = new Set([key(m.start.x, m.start.y, startMode)]);
  const q = [{ x: m.start.x, y: m.start.y, md: startMode, n: 0 }];
  while (q.length) {
    const s = q.shift();
    if (s.x === m.goal.x && s.y === m.goal.y) return { steps: s.n };
    const other = s.md === 'H' ? 'V' : 'H';
    if (!seen.has(key(s.x, s.y, other))) { seen.add(key(s.x, s.y, other)); q.push({ ...s, md: other, n: s.n + 1 }); }
    for (const d of Object.keys(DV)) {
      if (!m.passable(s.x, s.y, d, s.md)) continue;
      const nx = s.x + DV[d][0], ny = s.y + DV[d][1];
      if (!seen.has(key(nx, ny, s.md))) { seen.add(key(nx, ny, s.md)); q.push({ x: nx, y: ny, md: s.md, n: s.n + 1 }); }
    }
  }
  return null;
}

export function farthestCell(m, from = m.start) {
  const dist = new Map([[`${from.x},${from.y}`, 0]]);
  const q = [from];
  let best = from, bestD = 0;
  while (q.length) {
    const c = q.shift();
    const dc = dist.get(`${c.x},${c.y}`);
    if (dc > bestD) { bestD = dc; best = c; }
    for (const d of Object.keys(DV)) {
      if (!m.passable(c.x, c.y, d, 'open')) continue;
      const n = { x: c.x + DV[d][0], y: c.y + DV[d][1] };
      const k = `${n.x},${n.y}`;
      if (!dist.has(k)) { dist.set(k, dc + 1); q.push(n); }
    }
  }
  return best;
}

export function dirBetween(a, b) {
  if (b.x > a.x) return 'right';
  if (b.x < a.x) return 'left';
  if (b.y > a.y) return 'down';
  return 'up';
}

/** count of 90° turns on a path (a measure of difficulty for eye control) */
export function countTurns(path) {
  let t = 0;
  for (let i = 2; i < path.length; i++) if (dirBetween(path[i - 2], path[i - 1]) !== dirBetween(path[i - 1], path[i])) t++;
  return t;
}
