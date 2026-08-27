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
    tile === TileType.EagleBase
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

export function moveTank(state: GameState, tank: Tank): boolean {
  const heading = DIRECTION_VECTORS[tank.direction];

  const nextX = stepAxis(tank.x, heading.x * tank.speed);
  const nextY = stepAxis(tank.y, heading.y * tank.speed);

  // Players are fenced out of the top enemy-spawn rows; enemies are not.
  if (crossesPlayerBoundary(tank, nextY)) {
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

/** Relaxation passes per tick, so a shoved cluster fully disperses in one tick. */
const SEPARATION_PASSES = 3;

/** The eight neighbouring tile offsets a stuck tank may be nudged into. */
const NEIGHBOUR_OFFSETS: readonly (readonly [number, number])[] = [
  [TILE_SIZE, 0],
  [-TILE_SIZE, 0],
  [0, TILE_SIZE],
  [0, -TILE_SIZE],
  [TILE_SIZE, TILE_SIZE],
  [TILE_SIZE, -TILE_SIZE],
  [-TILE_SIZE, TILE_SIZE],
  [-TILE_SIZE, -TILE_SIZE],
];

/** Below this, an accumulated push is treated as no push at all. */
const PUSH_EPSILON = 1e-6;

/** Symmetry-breaking noise: nudges an exactly-balanced push off dead centre. */
function separationJitter(): number {
  return Math.random() * 0.1 - 0.05;
}

/** Nearest tile-grid multiple, keeping tanks aligned for enemy steering. */
function snapToTile(value: number): number {
  return Math.round(value / TILE_SIZE) * TILE_SIZE;
}

/** True when `tank` may sit at `(x, y)`: in bounds, clear of walls and tanks. */
function canOccupy(state: GameState, tank: Tank, x: number, y: number): boolean {
  // The anti-camping fence is checked here too, so no shove can push a player
  // into the top rows.
  if (crossesPlayerBoundary(tank, y)) return false;
  if (isBlocked(state, x, y, tank.width, tank.height)) return false;
  if (collidesWithTank(state, tank, x, y)) return false;
  return true;
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

      // Resolve along whichever axis needs the smaller nudge. When the two are
      // equal — the fully-coincident case — the jitter tiebreak sends different
      // pairs different ways, so a stack spreads in 2D rather than piling along
      // a single row it cannot fit into.
      const alongX = overlapX + separationJitter() < overlapY;
      if (alongX) {
        const dir = Math.sign(a.x - b.x + separationJitter()) || 1;
        push[i]!.x += dir * overlapX;
        push[j]!.x -= dir * overlapX;
      } else {
        const dir = Math.sign(a.y - b.y + separationJitter()) || 1;
        push[i]!.y += dir * overlapY;
        push[j]!.y -= dir * overlapY;
      }
    }
  }

  return push;
}

/**
 * Pulls overlapping tanks apart — a safety net for overlaps that movement
 * blocking cannot prevent (two tanks spawned on the same ground, a cluster
 * that formed some other way).
 *
 * Runs the accumulate-then-apply pass a few times per tick (relaxation), so a
 * tank shoved out of one collision and into another still ends the tick clear.
 * Each tank steps one tile along its net push direction — kept on the grid so
 * enemy steering can still turn it — into space that is actually free; a step
 * that would hit a wall, another tank, or the player fence is skipped and left
 * for a later pass. Positions are only ever grid-aligned, never fractional, so
 * the jitter breaks symmetry without stranding anyone off the lattice.
 *
 * @returns how many tanks were moved across all passes.
 */
export function separateTanks(state: GameState): number {
  const count = state.tanks.length;
  let moved = 0;

  for (let pass = 0; pass < SEPARATION_PASSES; pass++) {
    const push = accumulateSeparation(state);

    let movedThisPass = 0;
    for (let i = 0; i < count; i++) {
      const tank = state.tanks.at(i);
      const vector = push[i]!;

      const magX = Math.abs(vector.x);
      const magY = Math.abs(vector.y);
      if (magX < PUSH_EPSILON && magY < PUSH_EPSILON) continue;

      const baseX = snapToTile(tank.x);
      const baseY = snapToTile(tank.y);

      // Every surrounding cell, ordered by how well it matches the push
      // direction, then re-aligning in place as a last resort. Any free cell
      // thins the pile; including the diagonals means a tank whose four
      // orthogonal neighbours are taken can still slip out of a dense cluster
      // rather than being walled in by the first tanks that escaped.
      const candidates = NEIGHBOUR_OFFSETS.map(
        ([dx, dy]) => [baseX + dx, baseY + dy, dx * vector.x + dy * vector.y] as const,
      ).sort((p, q) => q[2] - p[2]);

      let placed = false;
      for (const [targetX, targetY] of candidates) {
        if (!canOccupy(state, tank, targetX, targetY)) continue;
        tank.x = targetX;
        tank.y = targetY;
        movedThisPass++;
        placed = true;
        break;
      }

      // Nowhere better to go: at least re-align onto the grid if that is free,
      // so a mid-tile tank stays turnable.
      if (!placed && (baseX !== tank.x || baseY !== tank.y) && canOccupy(state, tank, baseX, baseY)) {
        tank.x = baseX;
        tank.y = baseY;
        movedThisPass++;
      }
    }

    moved += movedThisPass;
    if (movedThisPass === 0) break; // settled — nothing left to disperse
  }

  // Item 4: whatever the passes did, no player may end up above the fence. This
  // is the strict last word, applied after all jitter and shoves.
  for (let i = 0; i < count; i++) {
    const tank = state.tanks.at(i);
    if (crossesPlayerBoundary(tank, tank.y)) {
      tank.y = PLAYER_TOP_BOUNDARY_Y;
    }
  }

  return moved;
}
