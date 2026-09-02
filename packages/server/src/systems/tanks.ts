import {
  PLAYER_TOP_BOUNDARY_Y,
  TILE_SIZE,
  TileType,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from "@battletank/shared";

import { DIRECTION_VECTORS } from "../gameplay.js";
import { type GameState, type Tank, isInsideGrid, tileIndex } from "../schema/index.js";

/**
 * True when placing `tank` at top `y` would push a *player* hull into the enemy
 * spawn lane (rows 0–1). Enemies are exempt — they enter along row 0 by design.
 *
 * A hard fence rather than a wall tile, so it applies only to player bodies and
 * leaves their shells, and every enemy, free to cross it.
 */
export function crossesPlayerBoundary(tank: Tank, y: number): boolean {
  return !tank.isEnemy && y < PLAYER_TOP_BOUNDARY_Y;
}

/**
 * Tiles a tank cannot drive through.
 *
 * Note this differs from the bullet rules in `systems/bullets.ts`: water stops
 * a tank but a shell flies straight over it.
 */
export function isSolidForTanks(tile: number): boolean {
  return (
    tile === TileType.Brick ||
    tile === TileType.Steel ||
    tile === TileType.Water ||
    tile === TileType.EagleBase ||
    tile === TileType.Radar ||
    tile === TileType.Factory
  );
}

/**
 * AABB test of a candidate position against the battlefield.
 *
 * @returns true when the box leaves the field or overlaps any solid tile.
 */
export function isBlocked(
  state: GameState,
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  if (x < 0 || y < 0 || x + width > WORLD_WIDTH || y + height > WORLD_HEIGHT) {
    return true;
  }

  const minTileX = Math.floor(x / TILE_SIZE);
  const maxTileX = Math.floor((x + width - 1) / TILE_SIZE);
  const minTileY = Math.floor(y / TILE_SIZE);
  const maxTileY = Math.floor((y + height - 1) / TILE_SIZE);

  for (let tileY = minTileY; tileY <= maxTileY; tileY++) {
    for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
      if (!isInsideGrid(tileX, tileY)) return true;

      if (isSolidForTanks(state.grid.at(tileIndex(tileX, tileY)))) {
        return true;
      }
    }
  }

  return false;
}

/** Standard AABB overlap test. Touching edges do not count as overlapping. */
export function boxesOverlap(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

/**
 * True when `tank` placed at `(x, y)` would overlap any *other* tank.
 *
 * Applies to every pairing — player/player, enemy/enemy, player/enemy — so no
 * two hulls can ever occupy the same ground.
 */
export function collidesWithTank(
  state: GameState,
  tank: Tank,
  x: number,
  y: number,
): boolean {
  for (let i = 0; i < state.tanks.length; i++) {
    const other = state.tanks.at(i);
    if (other === tank) continue;

    if (boxesOverlap(x, y, tank.width, tank.height, other.x, other.y, other.width, other.height)) {
      return true;
    }
  }

  return false;
}

/**
 * Advances a tank one step along its current facing, if the way is clear.
 *
 * Movement is all-or-nothing per tick rather than sliding up to the wall,
 * which is how the original game behaves on its tile grid.
 *
 * Tank-to-tank overlap is prevented here, by refusing the move, rather than
 * corrected afterwards by shoving hulls apart. A positional shove would knock
 * tanks off the tile grid, and enemy steering depends on tanks staying aligned
 * — an enemy stranded mid-tile jams against the first wall it meets.
 *
 * @returns true when the tank actually moved.
 */
/**
 * Advances one axis by `delta`, stopping exactly on the next tile boundary
 * rather than overshooting it.
 *
 * Enemy steering may only turn a tank that is aligned to the grid, so a tank
 * whose speed does not divide `TILE_SIZE` would sail past every boundary and
 * never be allowed to turn again. Clamping makes any speed safe, which is what
 * lets the slower enemy tiers exist at all.
 */
function stepAxis(position: number, delta: number): number {
  if (delta === 0) return position;

  const next = position + delta;
  const tile = Math.floor(position / TILE_SIZE);

  if (delta > 0) {
    const boundary = (tile + 1) * TILE_SIZE;
    return next > boundary ? boundary : next;
  }

  const boundary = position % TILE_SIZE === 0 ? position - TILE_SIZE : tile * TILE_SIZE;
  return next < boundary ? boundary : next;
}

export function moveTank(state: GameState, tank: Tank, fenceTop = true): boolean {
  const heading = DIRECTION_VECTORS[tank.direction];

  const nextX = stepAxis(tank.x, heading.x * tank.speed);
  const nextY = stepAxis(tank.y, heading.y * tank.speed);

  // Players are fenced out of the top enemy-spawn rows; enemies are not. The
  // campaign disables this anti-camp fence entirely by passing fenceTop=false.
  if (fenceTop && crossesPlayerBoundary(tank, nextY)) {
    return false;
  }

  if (isBlocked(state, nextX, nextY, tank.width, tank.height)) {
    return false;
  }

  if (collidesWithTank(state, tank, nextX, nextY)) {
    return false;
  }

  tank.x = nextX;
  tank.y = nextY;
  return true;
}

/** Relaxation passes per tick. */
const SEPARATION_PASSES = 3;

/** Maximum pixels a tank may be pushed per axis per pass (soft resolution). */
const MAX_PUSH_PX = 2.0;

/** Random nudge magnitude for enemy-enemy traffic jam breaking. */
const ENEMY_JITTER_PX = 0.4;

/** Below this, an accumulated push is treated as no push at all. */
const PUSH_EPSILON = 1e-6;

/** Symmetry-breaking noise: nudges an exactly-balanced push off dead centre. */
function separationJitter(): number {
  return Math.random() * 0.1 - 0.05;
}

/**
 * Sums each tank's separation push against every tank it currently overlaps.
 *
 * An accumulation model: all pushes are computed from the same snapshot before
 * anything moves, so a tank wedged between two others feels both and does not
 * ping-pong the way a sequential pair-by-pair resolver does. Each pair pushes
 * along its axis of least penetration; a jitter term breaks the tie when two
 * tanks are perfectly aligned (penetration direction otherwise zero).
 */
function accumulateSeparation(state: GameState): { x: number; y: number }[] {
  const count = state.tanks.length;
  const push = Array.from({ length: count }, () => ({ x: 0, y: 0 }));

  for (let i = 0; i < count; i++) {
    const a = state.tanks.at(i);

    for (let j = i + 1; j < count; j++) {
      const b = state.tanks.at(j);

      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (overlapX <= 0 || overlapY <= 0) continue;

      const alongX = overlapX + separationJitter() < overlapY;
      if (alongX) {
        const dir = Math.sign(a.x - b.x + separationJitter()) || 1;
        const mag = Math.min(overlapX, MAX_PUSH_PX);
        push[i]!.x += dir * mag;
        push[j]!.x -= dir * mag;
      } else {
        const dir = Math.sign(a.y - b.y + separationJitter()) || 1;
        const mag = Math.min(overlapY, MAX_PUSH_PX);
        push[i]!.y += dir * mag;
        push[j]!.y -= dir * mag;
      }
    }
  }

  return push;
}

/**
 * Pulls overlapping tanks apart gradually — a safety net for overlaps that
 * movement blocking cannot prevent.
 *
 * Uses soft resolution: each pass pushes tanks by at most {@link MAX_PUSH_PX}
 * per axis, so deep overlaps slide apart over several ticks instead of
 * teleporting one full tile. Enemy-enemy overlaps receive a small random nudge
 * to help them organically slide past each other and break traffic jams.
 *
 * @returns how many tanks were moved across all passes.
 */
export function separateTanks(state: GameState, fenceTop = true): number {
  const count = state.tanks.length;
  let moved = 0;

  for (let pass = 0; pass < SEPARATION_PASSES; pass++) {
    const push = accumulateSeparation(state);

    let movedThisPass = 0;
    for (let i = 0; i < count; i++) {
      const tank = state.tanks.at(i);
      const vector = push[i]!;

      let dx = vector.x;
      let dy = vector.y;

      if (Math.abs(dx) < PUSH_EPSILON && Math.abs(dy) < PUSH_EPSILON) continue;

      // Clamp so tanks slide apart smoothly instead of teleporting.
      dx = Math.sign(dx) * Math.min(Math.abs(dx), MAX_PUSH_PX);
      dy = Math.sign(dy) * Math.min(Math.abs(dy), MAX_PUSH_PX);

      // Random jitter helps enemy clusters break apart organically.
      if (tank.isEnemy) {
        dx += (Math.random() - 0.5) * ENEMY_JITTER_PX;
        dy += (Math.random() - 0.5) * ENEMY_JITTER_PX;
      }

      const newX = tank.x + dx;
      const newY = tank.y + dy;

      if (fenceTop && crossesPlayerBoundary(tank, newY)) continue;
      if (isBlocked(state, newX, newY, tank.width, tank.height)) continue;
      if (collidesWithTank(state, tank, newX, newY)) continue;

      tank.x = newX;
      tank.y = newY;
      movedThisPass++;
    }

    moved += movedThisPass;
    if (movedThisPass === 0) break;
  }

  if (fenceTop) {
    for (let i = 0; i < count; i++) {
      const tank = state.tanks.at(i);
      if (crossesPlayerBoundary(tank, tank.y)) {
        tank.y = PLAYER_TOP_BOUNDARY_Y;
      }
    }
  }

  return moved;
}
