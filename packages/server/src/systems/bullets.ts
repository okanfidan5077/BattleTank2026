import { TILE_SIZE, TileType, WORLD_HEIGHT, WORLD_WIDTH } from "@battletank/shared";

import { DIRECTION_VECTORS } from "../gameplay.js";
import { type Bullet, type GameState, type Tank, isInsideGrid, tileIndex } from "../schema/index.js";
import { boxesOverlap } from "./tanks.js";

/** True when the entity's AABB has left the battlefield. */
function isOutsideWorld(bullet: Bullet): boolean {
  return (
    bullet.x < 0 ||
    bullet.y < 0 ||
    bullet.x + bullet.width > WORLD_WIDTH ||
    bullet.y + bullet.height > WORLD_HEIGHT
  );
}

/**
 * Tests a bullet's AABB against every grid cell it overlaps, applying damage.
 *
 * Brick is destroyed on impact; steel and the eagle stop the bullet without
 * changing; empty tiles and water are flown over. A bullet spanning a tile
 * boundary can overlap two cells, and clears every brick among them — matching
 * the original game, where a shell takes out a two-tile-wide bite of wall.
 *
 * @returns true when the bullet was consumed and should be removed.
 */
function resolveTileCollision(
  state: GameState,
  bullet: Bullet,
  destroyed: { bricks: number; steel: number; eagle: boolean; steelHits: { x: number; y: number }[] },
): boolean {
  const minTileX = Math.floor(bullet.x / TILE_SIZE);
  const maxTileX = Math.floor((bullet.x + bullet.width - 1) / TILE_SIZE);
  const minTileY = Math.floor(bullet.y / TILE_SIZE);
  const maxTileY = Math.floor((bullet.y + bullet.height - 1) / TILE_SIZE);

  let consumed = false;
  let struckSteel = false;

  for (let y = minTileY; y <= maxTileY; y++) {
    for (let x = minTileX; x <= maxTileX; x++) {
      if (!isInsideGrid(x, y)) continue;

      const index = tileIndex(x, y);

      switch (state.grid.at(index)) {
        case TileType.Brick:
          state.grid[index] = TileType.Empty;
          destroyed.bricks++;
          consumed = true;
          break;

        case TileType.Steel:
          // Tier 4 shells cut straight through what is otherwise permanent.
          if (bullet.piercesSteel) {
            state.grid[index] = TileType.Empty;
            destroyed.steel++;
          }
          consumed = true;
          struckSteel = true;
          break;

        case TileType.EagleBase:
          // Any shell finishes the eagle — including one of your own.
          state.grid[index] = TileType.Empty;
          destroyed.eagle = true;
          consumed = true;
          break;

        default:
          // Empty and Water: bullets pass straight over.
          break;
      }
    }
  }

  // One spark per shell, at its centre — even when the AABB spanned two steel
  // cells at once.
  if (struckSteel) {
    destroyed.steelHits.push({ x: bullet.x + bullet.width / 2, y: bullet.y + bullet.height / 2 });
  }

  return consumed;
}

/**
 * Finds the first enemy-of-this-shell whose hull the bullet is inside.
 *
 * Sides are read from `bullet.isEnemy` against `tank.isEnemy`, so enemy shells
 * only ever hurt players and player shells only ever hurt enemies. There is no
 * friendly fire, which also means a tank can never be hit by its own shot as it
 * leaves the muzzle.
 */
function findTarget(state: GameState, bullet: Bullet): Tank | null {
  for (let i = 0; i < state.tanks.length; i++) {
    const tank = state.tanks.at(i);
    if (tank.isEnemy === bullet.isEnemy) continue;

    // Respawn grace: shells pass straight through.
    if (tank.isInvulnerable) continue;

    if (boxesOverlap(bullet.x, bullet.y, bullet.width, bullet.height, tank.x, tank.y, tank.width, tank.height)) {
      return tank;
    }
  }

  return null;
}

/** What one tick of bullet movement changed. */
export interface BulletOutcome {
  /** Brick tiles cleared. */
  bricksDestroyed: number;
  /** Steel tiles cut open by tier 4 shells. */
  steelDestroyed: number;
  /** Tanks whose health reached zero, already removed from the state. */
  destroyedTanks: Tank[];
  /** Opposing shells that annihilated each other in mid-air. */
  bulletsIntercepted: number;
  /** The eagle was hit this tick — the match is lost. */
  eagleDestroyed: boolean;
  /** Impact points, in world units, where shells struck steel this tick. */
  steelHits: { x: number; y: number }[];
}

/**
 * Cancels out opposing shells that have collided in flight.
 *
 * Runs after every bullet has moved but before anything resolves against tanks
 * or terrain, so an interception always beats a hit: two shells that meet
 * destroy each other and neither deals damage.
 *
 * @param doomed - filled with the indices of every intercepted shell.
 */
function resolveInterceptions(state: GameState, doomed: Set<number>): number {
  let pairs = 0;

  // Interception is judged on hitboxes grown by `padding` on every side, so two
  // shells cancel out even when they slip past with a few pixels between them.
  // This padding is deliberately local to bullet-vs-bullet checks — tank and
  // terrain collisions still use each shell's true AABB.
  const padding = 6;

  for (let i = 0; i < state.bullets.length; i++) {
    if (doomed.has(i)) continue;
    const a = state.bullets.at(i);

    for (let j = i + 1; j < state.bullets.length; j++) {
      if (doomed.has(j)) continue;
      const b = state.bullets.at(j);

      // Only opposing shells interact; two of the same side pass through.
      if (a.isEnemy === b.isEnemy) continue;

      if (
        boxesOverlap(
          a.x - padding,
          a.y - padding,
          a.width + padding * 2,
          a.height + padding * 2,
          b.x - padding,
          b.y - padding,
          b.width + padding * 2,
          b.height + padding * 2,
        )
      ) {
        doomed.add(i);
        doomed.add(j);
        pairs++;
        break;
      }
    }
  }

  return pairs;
}

/**
 * Advances every bullet by one tick and resolves what it ran into.
 *
 * Movement is applied to all shells first, so interception can be judged on the
 * positions they actually share this tick rather than on whichever happened to
 * be processed first. Only then does each survivor resolve against tanks (before
 * terrain, so a tank flush to a wall still takes the hit).
 */
export function updateBullets(state: GameState): BulletOutcome {
  const destroyed = { bricks: 0, steel: 0, eagle: false, steelHits: [] as { x: number; y: number }[] };
  const destroyedTanks: Tank[] = [];

  // 1. Move everything.
  for (let i = 0; i < state.bullets.length; i++) {
    const bullet = state.bullets.at(i);
    const heading = DIRECTION_VECTORS[bullet.direction];

    bullet.x += heading.x * bullet.speed;
    bullet.y += heading.y * bullet.speed;
  }

  // 2. Shells that met in mid-air cancel out, dealing no damage.
  const doomed = new Set<number>();
  const bulletsIntercepted = resolveInterceptions(state, doomed);

  // 3. Everything still flying resolves against the world.
  for (let i = state.bullets.length - 1; i >= 0; i--) {
    if (doomed.has(i)) {
      state.bullets.splice(i, 1);
      continue;
    }

    const bullet = state.bullets.at(i);

    if (isOutsideWorld(bullet)) {
      state.bullets.splice(i, 1);
      continue;
    }

    const target = findTarget(state, bullet);
    if (target) {
      target.currentHealth = Math.max(0, target.currentHealth - bullet.damage);

      if (target.currentHealth === 0) {
        const index = state.tanks.indexOf(target);
        if (index >= 0) state.tanks.splice(index, 1);
        destroyedTanks.push(target);
      }

      state.bullets.splice(i, 1);
      continue;
    }

    if (resolveTileCollision(state, bullet, destroyed)) {
      state.bullets.splice(i, 1);
    }
  }

  return {
    bricksDestroyed: destroyed.bricks,
    steelDestroyed: destroyed.steel,
    destroyedTanks,
    bulletsIntercepted,
    eagleDestroyed: destroyed.eagle,
    steelHits: destroyed.steelHits,
  };
}
