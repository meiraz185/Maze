// Run with:  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMaze, solve, DV, edgeKey, circleRectOverlap, solveWithModeSwitching, dirBetween } from '../js/maze.js';
import { makeBall, stepBall, reachedGoal, resolveCollisions } from '../js/physics.js';
import { LEVELS, buildLevel, updatePhaseCharge } from '../js/levels.js';

const DIRS = Object.keys(DV);

// ---------------------------------------------------------------- maze generation / solvability
test('generated mazes are perfect: every cell reachable, edges = cells-1', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const m = generateMaze(9, 6, seed, 0.6);
    let open = 0;
    for (const e of m.edges.values()) if (e.kind === 'open') open++;
    assert.equal(open, 9 * 6 - 1, `seed ${seed}`);
    for (let y = 0; y < 6; y++) for (let x = 0; x < 9; x++) {
      assert.ok(solve(m, 'open', m.start, { x, y }), `cell ${x},${y} unreachable (seed ${seed})`);
    }
  }
});

test('outer boundary is always closed', () => {
  const m = generateMaze(7, 5, 3);
  for (let y = 0; y < 5; y++) {
    assert.equal(m.passable(0, y, 'left'), false);
    assert.equal(m.passable(6, y, 'right'), false);
  }
  for (let x = 0; x < 7; x++) {
    assert.equal(m.passable(x, 0, 'up'), false);
    assert.equal(m.passable(x, 4, 'down'), false);
  }
});

for (const def of LEVELS) {
  for (const portrait of [false, true]) {
    test(`level ${def.id} (${portrait ? 'portrait' : 'landscape'}) is solvable`, () => {
      const m = buildLevel(def, { portrait });
      assert.ok(solve(m, 'open'), 'solvable with all dynamic walls open');
      assert.notDeepEqual(m.goal, m.start);
      if (def.doors) {
        assert.equal(solve(m, 'closed'), null, 'doors must actually matter (on the solution path)');
        assert.ok(m.doors.filter((d) => d.onPath).length === def.doors.onPath);
      }
      if (def.phase) {
        assert.ok(solveWithModeSwitching(m, 'H'), 'solvable when switching modes');
        assert.equal(solve(m, 'H'), null, 'not solvable while staying in mode H');
        assert.equal(solve(m, 'V'), null, 'not solvable while staying in mode V');
      }
    });
  }
}

test('levels are deterministic', () => {
  for (const def of LEVELS) {
    const a = buildLevel(def), b = buildLevel(def);
    assert.equal(a.seedUsed, b.seedUsed);
    assert.deepEqual([...a.edges.entries()].map(([k, e]) => k + e.kind), [...b.edges.entries()].map(([k, e]) => k + e.kind));
  }
});

// ---------------------------------------------------------------- collision
function assertNoOverlap(ball, m, msg) {
  for (const R of m.staticRects()) {
    assert.ok(!circleRectOverlap(ball.x, ball.y, ball.r - 1e-6, R), `${msg}: ball overlaps wall at ${ball.x.toFixed(3)},${ball.y.toFixed(3)}`);
  }
}

test('ball never overlaps walls and never crosses a closed edge (random gaze, many mazes)', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const m = generateMaze(8, 5, seed, 0.5);
    const ball = makeBall(m.start);
    let rnd = seed * 9301;
    let dir = 'right';
    let cell = { x: Math.floor(ball.x), y: Math.floor(ball.y) };
    for (let i = 0; i < 4000; i++) {
      if (i % 23 === 0) { rnd = (rnd * 1103515245 + 12345) & 0x7fffffff; dir = ['center', ...DIRS][rnd % 5]; }
      const dt = [1 / 60, 1 / 30, 1 / 15][i % 3];
      stepBall(ball, dir, dt, m, { speed: 2.4 });
      assertNoOverlap(ball, m, `seed ${seed} step ${i}`);
      const nc = { x: Math.floor(ball.x), y: Math.floor(ball.y) };
      if (nc.x !== cell.x || nc.y !== cell.y) {
        const md = Math.abs(nc.x - cell.x) + Math.abs(nc.y - cell.y);
        assert.equal(md, 1, `jumped two cells at step ${i}`);
        assert.ok(m.passable(cell.x, cell.y, dirBetween(cell, nc), 'open'), `crossed closed edge ${cell.x},${cell.y}->${nc.x},${nc.y}`);
        cell = nc;
      }
      assert.ok(ball.x > 0 && ball.x < m.cols && ball.y > 0 && ball.y < m.rows, 'stays inside maze');
    }
  }
});

test('large time step does not tunnel through a wall', () => {
  const m = generateMaze(3, 1, 1); // a straight corridor 3 wide, closed at both ends
  const ball = makeBall({ x: 0, y: 0 });
  stepBall(ball, 'right', 2.0, m, { speed: 10 }); // 20 cells in one frame
  assert.ok(ball.x <= 3 - 0.04 - ball.r + 1e-6, `x=${ball.x}`);
  assertNoOverlap(ball, m, 'tunnel');
});

test('centre gaze stops the ball immediately', () => {
  const m = generateMaze(5, 5, 4);
  const ball = makeBall(m.start);
  const before = { x: ball.x, y: ball.y };
  stepBall(ball, 'center', 0.5, m);
  assert.deepEqual({ x: ball.x, y: ball.y }, before);
});

test('resolveCollisions handles a centre inside a wall', () => {
  const ball = { x: 1.0, y: 0.5, r: 0.2 };
  resolveCollisions(ball, [{ x: 0.96, y: 0, w: 0.08, h: 1 }]);
  assert.ok(Math.abs(ball.x - 1.0) >= 0.2 + 0.04 - 1e-9);
});

test('corner assist: a slightly early turn still enters the side corridor', () => {
  // find a cell with a wall to the right whose lower neighbour opens right
  const m = generateMaze(8, 5, 12);
  let found = null;
  for (let y = 0; y < 4 && !found; y++) for (let x = 0; x < 7 && !found; x++) {
    if (!m.passable(x, y, 'right') && m.passable(x, y, 'down') && m.passable(x, y + 1, 'right')) found = { x, y };
  }
  assert.ok(found, 'test layout exists');
  const ball = { x: found.x + 0.5, y: found.y + 0.85, r: 0.2 }; // 0.35 above the target lane
  for (let i = 0; i < 90; i++) stepBall(ball, 'right', 1 / 60, m);
  assert.ok(ball.x > found.x + 1, `ball entered the corridor (x=${ball.x.toFixed(2)})`);
  assert.equal(Math.floor(ball.y), found.y + 1);
});

// ---------------------------------------------------------------- level completion (autopilot through the real physics)
export function autopilot(m, { speed, maxSeconds = 120, dt = 1 / 30, modeSwitch = null } = {}) {
  const ball = makeBall(m.start);
  let t = 0;
  while (t < maxSeconds) {
    const cell = { x: Math.floor(ball.x), y: Math.floor(ball.y) };
    const path = solve(m, modeSwitch ? 'open' : 'open', cell, m.goal);
    let dir = 'center';
    if (path && path.length > 1) {
      const want = dirBetween(path[0], path[1]);
      // centre on the lane before turning (what a player does by briefly looking at centre)
      const lane = want === 'left' || want === 'right' ? ball.y - (cell.y + 0.5) : ball.x - (cell.x + 0.5);
      if (Math.abs(lane) > 0.15) dir = want === 'left' || want === 'right' ? (lane > 0 ? 'up' : 'down') : (lane > 0 ? 'left' : 'right');
      else dir = want;
    } else if (path) {
      dir = ball.x < m.goal.x + 0.5 - 0.05 ? 'right' : ball.x > m.goal.x + 0.55 ? 'left' : ball.y < m.goal.y + 0.5 ? 'down' : 'up';
    }
    if (modeSwitch) modeSwitch(dir, dt);
    m.update(t, dt, ball);
    stepBall(ball, dir, dt, m, { speed });
    t += dt;
    if (reachedGoal(ball, m.goal)) return { done: true, t };
  }
  return { done: false, t };
}

test('level 1 can be completed through the physics', () => {
  const m = buildLevel(LEVELS[0]);
  const r = autopilot(m, { speed: LEVELS[0].speed });
  assert.ok(r.done, 'reached the exit');
});

test('level 2 can be completed; doors never close onto the ball', () => {
  const m = buildLevel(LEVELS[1]);
  const r = autopilot(m, { speed: LEVELS[1].speed });
  assert.ok(r.done, `reached the exit (t=${r.t.toFixed(1)}s)`);
});

test('doors cycle and are polite', () => {
  const m = buildLevel(LEVELS[1]);
  const d = m.doors[0];
  const seen = new Set();
  for (let t = 0; t < 12; t += 1 / 30) { m.update(t, 1 / 30, null); seen.add(d.open === 1 ? 'open' : d.open === 0 ? 'closed' : 'moving'); }
  assert.deepEqual([...seen].sort(), ['closed', 'moving', 'open']);
  // park the ball in the doorway: door must never overlap it
  const ball = d.line === 'v' ? { x: d.X, y: d.Y + 0.5, r: 0.2 } : { x: d.X + 0.5, y: d.Y, r: 0.2 };
  d.open = 1;
  for (let t = 0; t < 12; t += 1 / 30) {
    m.update(t, 1 / 30, ball);
    for (const R of m.solidRects().slice(m.staticRects().length)) assert.ok(!circleRectOverlap(ball.x, ball.y, ball.r, R), 'door overlaps ball');
  }
});

test('level 3 can be completed by sustaining gaze (mode switching)', () => {
  const m = buildLevel(LEVELS[2]);
  const charge = { H: 0, V: 0 };
  let flips = 0;
  const r = autopilot(m, {
    speed: LEVELS[2].speed, maxSeconds: 180,
    modeSwitch: (dir, dt) => { if (updatePhaseCharge(m, charge, dir, dt)) flips++; },
  });
  assert.ok(flips >= 2, `maze transformed ${flips} times`);
  assert.ok(r.done, `reached the exit (t=${r.t.toFixed(1)}s)`);
});

test('phase charge: short glances do not transform the maze, sustained gaze does', () => {
  const m = buildLevel(LEVELS[2]);
  const ch = { H: 0, V: 0 };
  assert.equal(m.mode, 'H');
  for (let i = 0; i < 10; i++) {           // 0.5 s up, 0.5 s centre, repeated
    for (let t = 0; t < 0.5; t += 1 / 30) assert.equal(updatePhaseCharge(m, ch, 'up', 1 / 30), null);
    for (let t = 0; t < 0.5; t += 1 / 30) updatePhaseCharge(m, ch, 'center', 1 / 30);
  }
  assert.equal(m.mode, 'H');
  let flipped = null;
  for (let t = 0; t < 1.5 && !flipped; t += 1 / 30) flipped = updatePhaseCharge(m, ch, 'down', 1 / 30);
  assert.equal(flipped, 'V');
  assert.equal(m.mode, 'V');
});
