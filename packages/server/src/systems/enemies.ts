import { Direction, TILE_SIZE, TileType, WORLD_HEIGHT, WORLD_WIDTH } from "@battletank/shared";

import {
  DIRECTION_VECTORS,
  ENEMY_BRICK_FIRE_CHANCE,
  ENEMY_CHAOS_CHANCE,
  ENEMY_SIGHT_RANGE_TILES,
} from "../gameplay.js";
import { type GameState, type Tank, isInsideGrid, tileIndex } from "../schema/index.js";
import type { FlowField } from "../world/FlowField.js";
import { moveTank } from "./tanks.js";

/** The four cardinal facings, for iterating candidate directions. */
const DIRECTIONS: readonly Direction[] = [
  Direction.Up,
  Direction.Right,
  Direction.Down,
  Direction.Left,
];

/** What an enemy's forward ray ran into first. */
export type RaycastHit = "player" | "eagle" | "brick" | "steel" | "none";

/** Ray sampling granularity. A quarter tile never skips a 32px wall. */
const RAY_STEP = TILE_SIZE / 4;

/**
 * Casts a line straight ahead from a tank's muzzle.
 *
 * Water is not checked: shells fly over it, so it should not block line of
 * sight either. Steel stops the ray without being a reason to fire.
 */
export function castForward(
  state: GameState,
  tank: Tank,
  rangeTiles: number = ENEMY_SIGHT_RANGE_TILES,
): RaycastHit {
  const heading = DIRECTION_VECTORS[tank.direction];

  const originX = tank.x + tank.width / 2;
  const originY = tank.y + tank.height / 2;
  const maxDistance = rangeTiles * TILE_SIZE;

  // Start at the muzzle so a tank never detects itself.
  for (let distance = tank.width / 2; distance <= maxDistance; distance += RAY_STEP) {
    const x = originX + heading.x * distance;
    const y = originY + heading.y * distance;

    if (x < 0 || y < 0 || x >= WORLD_WIDTH || y >= WORLD_HEIGHT) return "none";

    for (let i = 0; i < state.tanks.length; i++) {
      const other = state.tanks.at(i);
      if (other.isEnemy) continue;

      if (
        x >= other.x &&
        x < other.x + other.width &&
        y >= other.y &&
        y < other.y + other.height
      ) {
        return "player";
      }
    }

    const tile = state.grid.at(tileIndex(Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE)));

    if (tile === TileType.EagleBase) return "eagle";
    if (tile === TileType.Brick) return "brick";
    if (tile === TileType.Steel) return "steel";
  }

  return "none";
}

/** Hooks the room provides so the AI can route, ask about, and take shots. */
export interface EnemyContext {
  /**
   * The field this tank should follow — the eagle route, or the hunter field
   * that converges on the nearest player. A null field leaves the tank holding.
   */
  fieldFor(tank: Tank): FlowField | null;
  /** True when this tank's cooldown has elapsed and it has no shell in flight. */
  canShoot(tank: Tank): boolean;
  /** Spawns the bullet and starts the cooldown. */
  shoot(tank: Tank): void;
  /** Injectable for deterministic tests; defaults to `Math.random`. */
  random?: () => number;
}

/**
 * Steers a single enemy one step along the flow field.
 *
 * Turns are only allowed on tile boundaries. A tank is a full tile wide, so one
 * caught mid-tile straddles two rows (or columns); turning there asks it to move
 * broadside through both, and if either is walled it jams — permanently, because
 * the field keeps requesting the same blocked direction and the tank never
 * re-aligns. Snapping turns to the grid keeps every tank travelling whole tiles.
 *
 * Where the field has no direction — a pocket sealed off by steel — the enemy
 * holds position rather than wandering.
 */
function steer(state: GameState, tank: Tank, flowField: FlowField, random: () => number): void {
  const alignedToGrid = tank.x % TILE_SIZE === 0 && tank.y % TILE_SIZE === 0;

  if (alignedToGrid) {
    const tileX = Math.floor((tank.x + tank.width / 2) / TILE_SIZE);
    const tileY = Math.floor((tank.y + tank.height / 2) / TILE_SIZE);

    // Stochastic noise: on a fresh decision, sometimes abandon the optimal
    // route for a random passable direction. Falls back to the field when no
    // chaotic option exists (walled in on every side but the route).
    let desired: Direction | null;
    if (random() < ENEMY_CHAOS_CHANCE) {
      const options = passableDirections(state, tileX, tileY);
      desired =
        options.length > 0
          ? options[Math.floor(random() * options.length)]!
          : flowField.directionAt(tileX, tileY);
    } else {
      desired = flowField.directionAt(tileX, tileY);
    }

    if (desired === null) return;

    tank.direction = desired;
  }

  moveTank(state, tank);
}

/**
 * Orthogonal directions out of tile `(x, y)` a tank may set off down: those
 * whose neighbour is Empty or Brick. Steel, water, the eagle wall and the map
 * edge are excluded — brick stays in because the tank can shoot its way through.
 */
function passableDirections(state: GameState, x: number, y: number): Direction[] {
  const options: Direction[] = [];

  for (const direction of DIRECTIONS) {
    const step = DIRECTION_VECTORS[direction];
    const nx = x + step.x;
    const ny = y + step.y;
    if (!isInsideGrid(nx, ny)) continue;

    const tile = state.grid.at(tileIndex(nx, ny));
    if (tile === TileType.Empty || tile === TileType.Brick) options.push(direction);
  }

  return options;
}

/**
 * The tile directly ahead of a tank in its current facing, or `null` off-map.
 *
 * Read after steering to decide whether the tank is being routed straight into
 * a brick — its cue to open fire and blast a hole rather than stall against it.
 */
function tileAhead(state: GameState, tank: Tank): number | null {
  const tileX = Math.floor((tank.x + tank.width / 2) / TILE_SIZE);
  const tileY = Math.floor((tank.y + tank.height / 2) / TILE_SIZE);

  const step = DIRECTION_VECTORS[tank.direction];
  const nx = tileX + step.x;
  const ny = tileY + step.y;
  if (!isInsideGrid(nx, ny)) return null;

  return state.grid.at(tileIndex(nx, ny));
}

/**
 * Runs every enemy for one tick: follow the field, then decide whether to fire.
 *
 * Firing priority, all gated by the cooldown:
 *  1. Routed straight into a brick — blast it every chance, to punch a hole and
 *     keep moving rather than stalling against the wall.
 *  2. A player or the eagle in the line of sight — take the shot.
 *  3. A brick further down the line of sight — a one-in-four roll. This lives
 *     *after* the cooldown check so it is a real per-opportunity chance, not one
 *     per tick, which would fire the instant the cooldown expired almost always.
 */
export function updateEnemies(state: GameState, ctx: EnemyContext): void {
  const random = ctx.random ?? Math.random;

  for (let i = 0; i < state.tanks.length; i++) {
    const tank = state.tanks.at(i);
    if (!tank.isEnemy) continue;

    const field = ctx.fieldFor(tank);
    if (field) steer(state, tank, field, random);

    if (!ctx.canShoot(tank)) continue;

    // The route (or a chaotic detour) points this tank into a brick: force it to
    // fire and break through instead of grinding to a halt against the wall.
    if (tileAhead(state, tank) === TileType.Brick) {
      ctx.shoot(tank);
      continue;
    }

    switch (castForward(state, tank)) {
      case "player":
      case "eagle":
        ctx.shoot(tank);
        break;

      case "brick":
        // A brick further down the sight line: sometimes blast through it.
        if (random() < ENEMY_BRICK_FIRE_CHANCE) ctx.shoot(tank);
        break;

      default:
        break;
    }
  }
}
