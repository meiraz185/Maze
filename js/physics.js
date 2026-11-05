// EYE MAZE — ball movement and collision (pure, no DOM)
import { DV } from './maze.js';

export const BALL_R = 0.2;

export function makeBall(cell) {
  return { x: cell.x + 0.5, y: cell.y + 0.5, r: BALL_R, vx: 0, vy: 0 };
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** push a circle out of every overlapping axis-aligned rectangle */
export function resolveCollisions(ball, rects) {
  let hit = false;
  for (let pass = 0; pass < 3; pass++) {
    let any = false;
    for (const R of rects) {
      const qx = clamp(ball.x, R.x, R.x + R.w), qy = clamp(ball.y, R.y, R.y + R.h);
      const dx = ball.x - qx, dy = ball.y - qy;
      const d2 = dx * dx + dy * dy;
      if (d2 >= ball.r * ball.r - 1e-12) continue;
      any = hit = true;
      if (d2 > 1e-12) {
        const d = Math.sqrt(d2), k = (ball.r - d) / d;
        ball.x += dx * k; ball.y += dy * k;
      } else {
        // centre inside the rectangle: leave along the shallowest side
        const pen = [
          [ball.x - R.x + ball.r, -1, 0], [R.x + R.w - ball.x + ball.r, 1, 0],
          [ball.y - R.y + ball.r, 0, -1], [R.y + R.h - ball.y + ball.r, 0, 1],
        ].sort((a, b) => a[0] - b[0])[0];
        ball.x += pen[1] * pen[0]; ball.y += pen[2] * pen[0];
      }
    }
    if (!any) break;
  }
  return hit;
}

/**
 * Move the ball for dt seconds toward `dir` ('center' = stop).
 * Lane assist keeps the ball on the corridor centre line; corner assist lets a
 * slightly-early or slightly-late turn still enter a side corridor.
 */
export function stepBall(ball, dir, dt, maze, opt = {}) {
  const speed = opt.speed ?? 1.6;
  const assist = opt.assist ?? 0.12; // min lane offset (cells) before corner assist slides to the neighbour lane
  if (!DV[dir]) { ball.vx = ball.vy = 0; return { moved: 0, blocked: false }; }
  const [dx, dy] = DV[dir];
  const horiz = dx !== 0;
  const rects = maze.solidRects();
  const total = speed * dt;
  const n = Math.max(1, Math.ceil(total / (ball.r * 0.4)));
  const step = total / n;
  const x0 = ball.x, y0 = ball.y;
  let blocked = false, sliding = false;

  for (let i = 0; i < n; i++) {
    const cx = Math.floor(ball.x), cy = Math.floor(ball.y);
    const lane = horiz ? cy + 0.5 : cx + 0.5;
    const perp = horiz ? ball.y : ball.x;
    const off = perp - lane;
    let target = lane, rate = 0.6;

    const ahead = maze.passable(cx, cy, dir);
    if (!ahead) {
      // where would the ball hit the boundary of its cell in this direction?
      const edgeDist = horiz ? (dx > 0 ? cx + 1 - ball.x : ball.x - cx) : (dy > 0 ? cy + 1 - ball.y : ball.y - cy);
      if (edgeDist < ball.r + 0.08 && Math.abs(off) >= assist) {
        // corner assist: neighbour lane on the side we are offset toward
        const side = off > 0 ? (horiz ? 'down' : 'right') : (horiz ? 'up' : 'left');
        const [sx, sy] = DV[side];
        if (maze.passable(cx, cy, side) && maze.passable(cx + sx, cy + sy, dir)) {
          target = lane + (off > 0 ? 1 : -1); rate = 1.0; sliding = true;
        }
      }
    }
    const pd = clamp(target - perp, -rate * step, rate * step);
    if (horiz) { ball.x += dx * step; ball.y += pd; } else { ball.y += dy * step; ball.x += pd; }
    if (resolveCollisions(ball, rects)) blocked = true;
  }
  ball.vx = (ball.x - x0) / dt; ball.vy = (ball.y - y0) / dt;
  const moved = Math.hypot(ball.x - x0, ball.y - y0);
  return { moved, blocked: blocked && moved < total * 0.5, sliding };
}

export function reachedGoal(ball, goal) {
  return Math.hypot(ball.x - (goal.x + 0.5), ball.y - (goal.y + 0.5)) < 0.32;
}
