/**
 * Server-authoritative gameplay tuning.
 *
 * Speeds are expressed in pixels per simulation tick, so the simulation is
 * frame-rate independent by construction: one tick is always one step.
 */

import {
  Direction,
  ENEMY_SHOOT_COOLDOWN_MS,
  PLAYER_SHOOT_COOLDOWN_MS,
  TICK_MS,
  TICK_RATE,
  TILE_SIZE,
  type Vector2,
} from "@battletank/shared";

/** Tank hitbox, in pixels — a tank fills exactly one tile. */
export const TANK_SIZE = TILE_SIZE;

/** Bullet hitbox, in pixels. */
export const BULLET_SIZE = 8;

/** Tank movement speed, in pixels per tick. */
export const TANK_SPEED = 4;

/**
 * Bullet travel speed, in pixels per tick.
 *
 * MUST stay below {@link TILE_SIZE}: a bullet that advances a full tile in one
 * tick could pass straight through a wall without ever overlapping it, and the
 * collision pass below would never see the hit.
 */
export const BULLET_SPEED = 12;

/**
 * Player hit points. Damage is 1 per shell, so this is literally "four hits".
 *
 * Health is counted in hits rather than a 0-100 pool because the enemy tiers
 * are specified as 1, 2 and 3 HP.
 */
export const TANK_MAX_HEALTH = 4;

export const BULLET_DAMAGE = 1;

//
// Fire cooldowns are enforced in milliseconds of real match time, not ticks:
// setInterval(50) does not deliver 20Hz everywhere, so a tick-counted 400ms
// would actually be ~500ms on a platform that ticks at 16Hz. See
// BattleRoom.elapsedMs. The values themselves live in @battletank/shared so
// the client throttle cannot drift from the server rule.
//

/**
 * How long a single `move` message keeps a tank rolling, in ticks.
 *
 * The client re-sends while a key is held; when the messages stop arriving the
 * intent lapses and the tank halts. This keeps movement paced by the server’s
 * 20Hz tick rather than by how fast a client can emit packets.
 */
export const MOVE_INTENT_TTL_TICKS = 3;

/** Hard cap on players per room; matches the number of spawn points. */
export const MAX_PLAYERS = 10;

/** Unit vector for each facing, indexed by {@link Direction}. */
export const DIRECTION_VECTORS: Record<Direction, Vector2> = {
  [Direction.Up]: { x: 0, y: -1 },
  [Direction.Right]: { x: 1, y: 0 },
  [Direction.Down]: { x: 0, y: 1 },
  [Direction.Left]: { x: -1, y: 0 },
};

// ---------------------------------------------------------------- enemy waves

/** Enemies queued for the first minute of a match. */
export const ENEMY_WAVE_BASE = 50;

/** Extra enemies queued for each minute that passes: 50, 60, 70, ... */
export const ENEMY_WAVE_GROWTH = 10;

/** Length of a difficulty step, in milliseconds of real match time. */
export const DIFFICULTY_STEP_MS = 60_000;

/** How often the queue is drained (1 second at 20Hz). */
export const ENEMY_SPAWN_INTERVAL_TICKS = TICK_RATE;

/** Enemies released per drain. */
export const ENEMY_SPAWN_BATCH_MIN = 1;
export const ENEMY_SPAWN_BATCH_MAX = 2;

/**
 * Enemies alive at once, in the first minute.
 *
 * This is the real difficulty dial: queue depth sets how long a wave lasts,
 * concurrency sets how hard it hits.
 */
export const ENEMY_CONCURRENCY_BASE = 6;

/** Extra simultaneous enemies allowed for each minute that passes. */
export const ENEMY_CONCURRENCY_GROWTH = 2;

/** Ceiling, so a long match does not melt the tick budget. */
export const ENEMY_CONCURRENCY_MAX = 16;

/** How many enemies may be on the field during a given (1-based) minute. */
export function maxConcurrentEnemies(minute: number): number {
  const allowed = ENEMY_CONCURRENCY_BASE + ENEMY_CONCURRENCY_GROWTH * (minute - 1);
  return Math.min(ENEMY_CONCURRENCY_MAX, allowed);
}

/** What a freshly spawned enemy is trying to reach. */
export const EnemyObjective = {
  Eagle: "eagle",
  Player: "player",
} as const;
export type EnemyObjective = (typeof EnemyObjective)[keyof typeof EnemyObjective];

/** Share of enemies assigned to hunt the nearest player instead of the eagle. */
export const ENEMY_PLAYER_HUNTER_SHARE = 0.4;

/**
 * How often the hunter field is recomputed, in ticks.
 *
 * Players move constantly, so this field cannot be cached the way the eagle's
 * is. Half a second is frequent enough to track a tank that crosses a tile
 * every eight ticks, and costs one Dijkstra pass over 1980 cells.
 */
export const HUNTER_FIELD_REBUILD_TICKS = 10;

/** How far ahead an enemy looks when deciding whether to fire, in tiles. */
export const ENEMY_SIGHT_RANGE_TILES = 12;

/** Chance an enemy shoots a brick that is blocking its route. */
export const ENEMY_BRICK_FIRE_CHANCE = 0.25;

/**
 * Cost of routing a flow field through a brick, relative to open ground (1).
 *
 * Finite on purpose: the eagle is walled in by brick, so an impassable brick
 * would leave it unreachable and the field empty. Set to `Infinity` for strict
 * "brick is a wall" pathing.
 */
export const FLOW_FIELD_BRICK_COST = 8;

/** Lives a player starts a match with. */
export const PLAYER_STARTING_LIVES = 3;

/** Delay before a destroyed player returns to the field, in milliseconds. */
export const PLAYER_RESPAWN_DELAY_MS = 5000;

/**
 * How long a dropped seat is held open for a reconnect, in seconds.
 *
 * This is the anti-refresh window: long enough to cover a page reload and a
 * slow reconnect, short enough that a rage-quitter does not block a seat.
 */
export const RECONNECT_WINDOW_SECONDS = 30;

/** Grace period on returning, during which shells pass harmlessly through. */
export const PLAYER_INVULNERABILITY_MS = 3000;

// ---------------------------------------------------------------- enemy tiers

/** One kind of enemy tank. */
export interface EnemyTier {
  readonly name: string;
  /** Share of spawns, as a fraction. Must sum to 1. */
  readonly share: number;
  readonly health: number;
  /** Pixels per tick. Any value is safe — movement clamps to tile boundaries. */
  readonly speed: number;
}

/**
 * Spawn table, in the order it is sampled.
 *
 * Health doubles as the client's tier signal: it tints an enemy by `maxHealth`,
 * so there is no separate tier field on the wire.
 */
export const ENEMY_TIERS: readonly EnemyTier[] = [
  { name: "normal", share: 0.7, health: 1, speed: 4 },
  { name: "armored", share: 0.2, health: 2, speed: 3 },
  { name: "heavy", share: 0.1, health: 3, speed: 2 },
];

// ---------------------------------------------------------------------- boons

/** Chance a destroyed enemy leaves a power-up behind. */
export const BOON_DROP_CHANCE = 0.1;


/** How long a stopwatch holds the enemies still. */
export const STOPWATCH_FREEZE_TICKS = TICK_RATE * 8;

/** How long a shovel keeps the eagle's bunker in steel. */
export const SHOVEL_DURATION_TICKS = TICK_RATE * 15;

/**
 * Samples the tier table: 70% normal, 20% armored, 10% heavy.
 *
 * @param random - injectable for deterministic tests.
 */
export function rollEnemyTier(random: () => number = Math.random): EnemyTier {
  let roll = random();

  for (const tier of ENEMY_TIERS) {
    if (roll < tier.share) return tier;
    roll -= tier.share;
  }

  return ENEMY_TIERS[0]!;
}

/**
 * Assigns a fresh enemy's objective: 60% march on the eagle, 40% hunt a player.
 *
 * @param random - injectable for deterministic tests.
 */
export function rollEnemyObjective(random: () => number = Math.random): EnemyObjective {
  return random() < ENEMY_PLAYER_HUNTER_SHARE ? EnemyObjective.Player : EnemyObjective.Eagle;
}

// -------------------------------------------------------------- player tiers

/** Combat profile a player's tank fights with at a given star tier. */
export interface TierProfile {
  /** Minimum gap between volleys, in milliseconds. */
  readonly cooldownMs: number;
  /** Shell speed, in pixels per tick. */
  readonly bulletSpeed: number;
  /** Shells fired side by side per volley. */
  readonly volley: number;
  /** Whether those shells cut through steel. */
  readonly piercesSteel: boolean;
}

export const MAX_PLAYER_TIER = 4;

/**
 * Star progression. Upgrades are cumulative: tier 4 keeps the faster shells and
 * the shorter cooldown it earned at tier 2, and the twin barrels from tier 3.
 *
 * Every speed here must stay below {@link TILE_SIZE} — a shell that covers a
 * whole tile in one tick can jump clean over a wall. 12 x 1.3 = 15.6, well clear.
 */
export const PLAYER_TIERS: readonly TierProfile[] = [
  { cooldownMs: PLAYER_SHOOT_COOLDOWN_MS, bulletSpeed: BULLET_SPEED, volley: 1, piercesSteel: false },
  { cooldownMs: 300, bulletSpeed: BULLET_SPEED * 1.3, volley: 1, piercesSteel: false },
  { cooldownMs: 300, bulletSpeed: BULLET_SPEED * 1.3, volley: 2, piercesSteel: false },
  { cooldownMs: 300, bulletSpeed: BULLET_SPEED * 1.3, volley: 2, piercesSteel: true },
];

/** Profile for a 1-based tier, clamped into range. */
export function tierProfile(tier: number): TierProfile {
  const index = Math.min(MAX_PLAYER_TIER, Math.max(1, Math.floor(tier))) - 1;
  return PLAYER_TIERS[index]!;
}

/** What enemies fight with; they do not upgrade. */
export const ENEMY_PROFILE: TierProfile = {
  cooldownMs: ENEMY_SHOOT_COOLDOWN_MS,
  bulletSpeed: BULLET_SPEED,
  volley: 1,
  piercesSteel: false,
};

/** Perpendicular offsets for a volley, in pixels, centred on the muzzle. */
export function volleyOffsets(volley: number): readonly number[] {
  return volley <= 1 ? [0] : [-8, 8];
}
