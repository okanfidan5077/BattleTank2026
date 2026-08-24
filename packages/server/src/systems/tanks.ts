import { TILE_SIZE, TileType, WORLD_HEIGHT, WORLD_WIDTH } from "@battletank/shared";

import { DIRECTION_VECTORS } from "../gameplay.js";
import { type GameState, type Tank, isInsideGrid, tileIndex } from "../schema/index.js";

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

/**
 * Safety net for overlaps that movement blocking cannot prevent — two tanks
 * spawned on the same ground, say.
 *
 * Pushes the pair apart along the axis of least penetration, but only into
 * space that is actually free; a shove that would bury a tank in a wall or in
 * a third tank is abandoned rather than forced.
 *
 * @returns how many overlapping pairs were separated.
 */
export function separateTanks(state: GameState): number {
  let separated = 0;

  for (let i = 0; i < state.tanks.length; i++) {
    for (let j = i + 1; j < state.tanks.length; j++) {
      const a = state.tanks.at(i);
      const b = state.tanks.at(j);

      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (overlapX <= 0 || overlapY <= 0) continue;

      // Least penetration: shift along whichever axis needs the smaller nudge.
      const alongX = overlapX <= overlapY;
      const push = alongX ? overlapX : overlapY;
      const sign = alongX ? Math.sign(b.x - a.x) || 1 : Math.sign(b.y - a.y) || 1;

      // Snap the result back onto the tile grid. Pushing by the raw overlap
      // leaves a tank at a fractional offset, and enemy steering may only turn
      // a grid-aligned tank — one nudged off the lattice can never turn again
      // and jams for good the moment something blocks it.
      const snap = (value: number, away: number) => {
        const target = value + away;
        return Math.round(target / TILE_SIZE) * TILE_SIZE;
      };

      const candidates = [
        {
          tank: b,
          x: alongX ? snap(b.x, push * sign) : snap(b.x, 0),
          y: alongX ? snap(b.y, 0) : snap(b.y, push * sign),
        },
        {
          tank: a,
          x: alongX ? snap(a.x, -push * sign) : snap(a.x, 0),
          y: alongX ? snap(a.y, 0) : snap(a.y, -push * sign),
        },
      ];

      for (const move of candidates) {
        if (isBlocked(state, move.x, move.y, move.tank.width, move.tank.height)) continue;
        if (collidesWithTank(state, move.tank, move.x, move.y)) continue;

        move.tank.x = move.x;
        move.tank.y = move.y;
        separated++;
        break;
      }
    }
  }

  return separated;
}
