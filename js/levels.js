// EYE MAZE — level definitions (pure, no DOM)
import { generateMaze, solve, farthestCell, dirBetween, countTurns, edgeKey, mulberry32 } from './maze.js';

export const LEVELS = [
  {
    id: 1, name: 'FIRST SIGHT', hint: 'Look where you want to go. Look at the centre to stop.',
    cols: 6, rows: 4, seed: 11, straight: 0.7, speed: 1.55, maxTurns: 7,
  },
  {
    id: 2, name: 'TIDE GATES', hint: 'Some walls slide open and closed. Wait for the gap.',
    cols: 8, rows: 5, seed: 23, straight: 0.6, speed: 1.6, maxTurns: 12,
    doors: { onPath: 3, offPath: 3 },
  },
  {
    id: 3, name: 'GAZE FIELD', hint: 'Hold your gaze sideways or up/down to reshape the maze.',
    cols: 8, rows: 5, seed: 37, straight: 0.6, speed: 1.6, maxTurns: 12,
    phase: { onPath: 4, offPath: 4 },
  },
];

/**
 * Build a level deterministically. Tries seed, seed+1, ... until the level meets its constraints.
 * `portrait` swaps rows/cols so the maze fits tall screens.
 */
export function buildLevel(def, { portrait = false } = {}) {
  const cols = portrait ? def.rows : def.cols;
  const rows = portrait ? def.cols : def.rows;
  for (let attempt = 0; attempt < 200; attempt++) {
    const seed = def.seed + attempt * 101;
    const m = generateMaze(cols, rows, seed, def.straight);
    m.goal = farthestCell(m, m.start);
    const path = solve(m, 'open');
    if (!path || path.length < Math.ceil((cols * rows) * 0.35)) continue;
    if (countTurns(path) > def.maxTurns) continue;
    const rnd = mulberry32(seed ^ 0x9e37);
    if (def.doors && !addDoors(m, path, def.doors, rnd)) continue;
    if (def.phase && !addPhases(m, path, def.phase, rnd)) continue;
    m.seedUsed = seed;
    m.solution = path;
    return m;
  }
  throw new Error(`Could not build level ${def.id}`);
}

function pathEdges(m, path) {
  const out = [];
  for (let i = 0; i < path.length - 1; i++) {
    const d = dirBetween(path[i], path[i + 1]);
    out.push({ i, key: edgeKey(path[i].x, path[i].y, d), dir: d });
  }
  return out;
}

function edgeFromKey(key) {
  const [line, X, Y] = key.split(':');
  return { line, X: +X, Y: +Y };
}

function openEdgesNotOnPath(m, path) {
  const onPath = new Set(pathEdges(m, path).map((e) => e.key));
  const out = [];
  for (const [k, e] of m.edges) if (e.kind === 'open' && !onPath.has(k)) out.push(k);
  return out;
}

function pickSpread(list, n, rnd) {
  // evenly spaced along the list, small random jitter
  if (list.length < n) return null;
  const out = [];
  const stride = list.length / n;
  for (let j = 0; j < n; j++) {
    const lo = Math.floor(j * stride), hi = Math.max(lo, Math.floor((j + 1) * stride) - 1);
    out.push(list[lo + Math.floor(rnd() * (hi - lo + 1))]);
  }
  return out;
}

function addDoors(m, path, cfg, rnd) {
  const candidates = pathEdges(m, path).slice(1, -1); // not right at start or exit
  const chosen = pickSpread(candidates, cfg.onPath, rnd);
  if (!chosen) return false;
  const extra = pickSpread(shuffle(openEdgesNotOnPath(m, path), rnd), Math.min(cfg.offPath, 99), rnd) || [];
  const all = [...chosen.map((c) => c.key), ...extra];
  all.forEach((key, i) => {
    const e = edgeFromKey(key);
    const door = {
      ...e, key,
      from: rnd() < 0.5 ? 0 : 1,
      period: 3.4 + rnd() * 1.6,       // seconds per open/close cycle
      openFrac: 0.5 + rnd() * 0.12,    // fraction of the cycle that the gap is open
      offset: rnd() * 5,
      travel: 0.6,                     // seconds to slide fully open/closed
      open: 1,
      onPath: i < chosen.length,
    };
    m.edges.set(key, { kind: 'door', ref: door });
    m.doors.push(door);
  });
  return true;
}

function addPhases(m, path, cfg, rnd) {
  const pe = pathEdges(m, path).slice(1, -1);
  // need both orientations on the solution so neither mode alone solves it
  const horizMoves = pe.filter((e) => e.dir === 'left' || e.dir === 'right');
  const vertMoves = pe.filter((e) => e.dir === 'up' || e.dir === 'down');
  const half = Math.ceil(cfg.onPath / 2);
  const a = pickSpread(horizMoves, half, rnd), b = pickSpread(vertMoves, cfg.onPath - half, rnd);
  if (!a || !b) return false;
  const extra = pickSpread(shuffle(openEdgesNotOnPath(m, path), rnd), cfg.offPath, rnd) || [];
  const keys = [...a, ...b].map((e) => e.key).concat(extra);
  keys.forEach((key, i) => {
    const e = edgeFromKey(key);
    // a vertical line is crossed by a horizontal move -> opens in mode H (sustained left/right gaze)
    const p = { ...e, key, openIn: e.line === 'v' ? 'H' : 'V', solid: 0, onPath: i < a.length + b.length };
    m.edges.set(key, { kind: 'phase', ref: p });
    m.phases.push(p);
  });
  m.mode = 'H';
  for (const p of m.phases) p.solid = p.openIn === m.mode ? 0 : 1;
  return true;
}

function shuffle(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------------------------------------------------------------------------
// Level 3: sustained gaze reshapes the maze.
// Holding a left/right gaze for PHASE_HOLD_S switches to mode H (sideways gates open, vertical gates close);
// holding up/down switches to mode V. Short glances do nothing.
export const PHASE_HOLD_S = 1.2;
export function updatePhaseCharge(maze, charge, dir, dt) {
  const ax = dir === 'left' || dir === 'right' ? 'H' : dir === 'up' || dir === 'down' ? 'V' : null;
  for (const k of ['H', 'V']) charge[k] = k === ax && k !== maze.mode ? charge[k] + dt : Math.max(0, charge[k] - dt * 2);
  charge.axis = ax && ax !== maze.mode ? ax : (charge.H > charge.V ? (charge.H > 0 ? 'H' : null) : (charge.V > 0 ? 'V' : null));
  if (ax && ax !== maze.mode && charge[ax] >= PHASE_HOLD_S) {
    maze.mode = ax;
    charge.H = charge.V = 0; charge.axis = null;
    return ax;
  }
  return null;
}
