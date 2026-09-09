import { Direction, TILE_SIZE, TileType, WORLD_HEIGHT, WORLD_WIDTH } from "@battletank/shared";

import {
  DIRECTION_VECTORS,
  ENEMY_BRICK_FIRE_CHANCE,
  ENEMY_CHAOS_CHANCE,
  ENEMY_PREDICTIVE_FIRE_CHANCE,
  ENEMY_PREDICT_TICKS,
  ENEMY_PREDICT_TOLERANCE,
  ENEMY_SIGHT_RANGE_TILES,
} from "../gameplay.js";
import { type GameState, type Tank, isInsideGrid, tileIndex } from "../schema/index.js";
import type { FlowField } from "../world/FlowField.js";
import { isBlocked, moveTank } from "./tanks.js";

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

/**
 * Whether the firing axis is clear of walls out to `distance`.
 *
 * Sampled at the same quarter-tile granularity as {@link castForward}, so a
 * 32px wall can never be stepped over.
 */
function axisClear(state: GameState, originX: number, originY: number, tank: Tank, distance: number): boolean {
  const heading = DIRECTION_VECTORS[tank.direction];

  for (let travelled = tank.width / 2; travelled < distance; travelled += RAY_STEP) {
    const x = originX + heading.x * travelled;
    const y = originY + heading.y * travelled;
    if (x < 0 || y < 0 || x >= WORLD_WIDTH || y >= WORLD_HEIGHT) return false;

    const tile = state.grid.at(tileIndex(Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE)));
    if (tile === TileType.Brick || tile === TileType.Steel) return false;
  }

  return true;
}

/**
 * Whether a player is about to cross this tank's line of fire.
 *
 * Projects each player forward along their current heading and asks whether
 * that predicted point sits on the tank's firing axis, within range and behind
 * no wall — so an enemy shoots at where the player is *going*, not only at
 * where they already are. Without this, moving is a near-perfect defence: the
 * shot only ever leaves once the player is centred, by which time they have
 * gone.
 */
export function predictsPlayerCrossing(
  state: GameState,
  tank: Tank,
  rangeTiles: number = ENEMY_SIGHT_RANGE_TILES,
): boolean {
  const heading = DIRECTION_VECTORS[tank.direction];
  const originX = tank.x + tank.width / 2;
  const originY = tank.y + tank.height / 2;
  const maxDistance = rangeTiles * TILE_SIZE;

  for (let i = 0; i < state.tanks.length; i++) {
    const player = state.tanks.at(i);
    if (player.isEnemy) continue;

    const lead = DIRECTION_VECTORS[player.direction];
    const px = player.x + player.width / 2 + lead.x * player.speed * ENEMY_PREDICT_TICKS;
    const py = player.y + player.height / 2 + lead.y * player.speed * ENEMY_PREDICT_TICKS;

    // Distance along the firing axis; behind the muzzle does not count.
    const along = (px - originX) * heading.x + (py - originY) * heading.y;
    if (along <= 0 || along > maxDistance) continue;

    // Distance off the axis.
    const perp = Math.abs((px - originX) * -heading.y + (py - originY) * heading.x);
    if (perp > ENEMY_PREDICT_TOLERANCE) continue;

    if (axisClear(state, originX, originY, tank, along)) return true;
  }

  return false;
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
  /**
   * How often this tank abandons its route for a random direction, 0 to 1.
   *
   * Defaults to {@link ENEMY_CHAOS_CHANCE}, which is what stops ordinary tanks
   * reading as tram cars. It is wrong for the units whose whole design is a
   * committed straight line: a rusher crosses a tile roughly every fifth of a
   * second, so a one-in-ten chance per boundary had it taking a random detour
   * every couple of seconds. From outside that looks exactly like a suicide
   * unit wandering off toward the edge of the map for no reason and then
   * remembering the player — which is what it was.
   */
  chaosFor?(tank: Tank): number;
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
/**
 * How far off the lattice a tank may drift and still be pulled back, in px.
 *
 * Sized to cover what the world can push a tank by in one tick: the separation
 * pass contributes up to 2px per relaxation pass over three passes, and the
 * traffic-jam jitter adds a few more on top.
 */
const CROSS_AXIS_SNAP_PX = TILE_SIZE / 3;

/**
 * Pulls a tank back onto the lattice across its direction of travel.
 *
 * Steering only ever turns a tank standing exactly on a tile boundary, and the
 * step function guarantees that along the axis a tank is *moving* on. The other
 * axis has no such guarantee: the separation pass and the anti-gridlock jitter
 * both shove tanks sideways by a few pixels, and once a hull is a pixel or two
 * off across its travel it can never satisfy the alignment test again.
 *
 * The symptom is unmistakable once you know it: a fast enemy — a rusher, most
 * visibly — stops being able to turn and simply drives in a straight line to
 * the far wall, sits there until the anti-stuck pass frees it, and only then
 * resumes hunting. It looks like the unit deciding to visit the edge of the map
 * for no reason. It is really a tank that has been unable to turn since the
 * moment something brushed past it.
 *
 * Only the cross axis is corrected. Snapping the travel axis as well would drag
 * a moving tank backward to the tile boundary it just left.
 */
function snapCrossAxis(state: GameState, tank: Tank): void {
  const heading = DIRECTION_VECTORS[tank.direction];
  const movingHorizontally = heading.x !== 0;
  const value = movingHorizontally ? tank.y : tank.x;

  const snapped = Math.round(value / TILE_SIZE) * TILE_SIZE;
  const drift = Math.abs(snapped - value);
  if (drift === 0 || drift > CROSS_AXIS_SNAP_PX) return;

  const nextX = movingHorizontally ? tank.x : snapped;
  const nextY = movingHorizontally ? snapped : tank.y;
  if (isBlocked(state, nextX, nextY, tank.width, tank.height)) return;

  tank.x = nextX;
  tank.y = nextY;
}

function steer(
  state: GameState,
  tank: Tank,
  flowField: FlowField,
  random: () => number,
  chaosChance: number,
): void {
  snapCrossAxis(state, tank);

  const alignedToGrid = tank.x % TILE_SIZE === 0 && tank.y % TILE_SIZE === 0;

  if (alignedToGrid) {
    const tileX = Math.floor((tank.x + tank.width / 2) / TILE_SIZE);
    const tileY = Math.floor((tank.y + tank.height / 2) / TILE_SIZE);

    // Stochastic noise: on a fresh decision, sometimes abandon the optimal
    // route for a random passable direction. Falls back to the field when no
    // chaotic option exists (walled in on every side but the route).
    let desired: Direction | null;
    if (random() < chaosChance) {
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
    if (field) steer(state, tank, field, random, ctx.chaosFor?.(tank) ?? ENEMY_CHAOS_CHANCE);

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
        // Nothing in the sights right now — but the player may be about to run
        // into them. Lead the shot rather than waiting to be walked past.
        if (
          random() < ENEMY_PREDICTIVE_FIRE_CHANCE &&
          predictsPlayerCrossing(state, tank)
        ) {
          ctx.shoot(tank);
        }
        break;
    }
  }
}
