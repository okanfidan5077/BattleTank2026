import { Room, type Client } from "colyseus";

import {
  CAMPAIGN_LEVELS,
  CampaignMessage,
  CampaignPhase,
  CampaignWinCondition,
  ClientMessage,
  Direction,
  GRID_HEIGHT,
  GRID_LENGTH,
  GRID_WIDTH,
  BLAST_BRICK_RADIUS_TILES,
  BLAST_COOLDOWN_MS,
  BLAST_RADIUS_TILES,
  BLAST_UNLOCK_LEVEL,
  BOMB_DEFUSAL_DURATION_SECONDS,
  DECOY_COOLDOWN_MS,
  DECOY_DURATION_MS,
  DECOY_UNLOCK_LEVEL,
  MOVE_DIRECTION_TO_FACING,
  NULLIFIER_RADIUS_TILES,
  RAM_COOLDOWN_MS,
  RAM_DURATION_MS,
  RAM_SPEED_FACTOR,
  RAM_UNLOCK_LEVEL,
  SHIELD_COOLDOWN_MS,
  SHIELD_DURATION_MS,
  SHIELD_UNLOCK_LEVEL,
  TELEPORT_MAX_CHARGES,
  TELEPORT_RECHARGE_MS,
  TELEPORT_TILES,
  TELEPORT_UNLOCK_LEVEL,
  surviveSecondsForLevel,
  ZONE_CONTROL_DURATION_SECONDS,
  ServerMessage,
  TICK_MS,
  TILE_SIZE,
  TileType,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  defaultPlayerColor,
  defaultPlayerName,
  isMoveMessage,
  sanitizeDeviceId,
  sanitizePlayerColor,
  sanitizePlayerName,
  type BlastChangedMessage,
  type BossBounceMessage,
  type DecoyChangedMessage,
  type GrappleHitMessage,
  type JoinOptions,
  type RamChangedMessage,
  type MineDetonatedMessage,
  type MortarWarningMessage,
  type ShieldChangedMessage,
  type SteelHitMessage,
  type TeleportChangedMessage,
  type TankDestroyedMessage,
} from "@battletank/shared";

import {
  BULLET_DAMAGE,
  BULLET_SIZE,
  DIRECTION_VECTORS,
  ENEMY_PROFILE,
  HUNTER_FIELD_REBUILD_TICKS,
  MOVE_INTENT_TTL_TICKS,
  PLAYER_INVULNERABILITY_MS,
  PLAYER_RESPAWN_DELAY_MS,
  TANK_MAX_HEALTH,
  TANK_SIZE,
  TANK_SPEED,
  rollEnemyTier,
  tierProfile,
  volleyOffsets,
  type TierProfile,
} from "../gameplay.js";
import { Bullet, CampaignState, Player, Tank, isInsideGrid, tileIndex } from "../schema/index.js";
import { updateBullets } from "../systems/bullets.js";
import { updateEnemies } from "../systems/enemies.js";
import {
  boxesOverlap,
  collidesWithTank,
  isBlocked,
  isSolidForTanks,
  moveTank,
  separateTanks,
} from "../systems/tanks.js";
import { FlowField } from "../world/FlowField.js";

/**
 * Interior enemy spawn tiles for the campaign.
 *
 * Level maps are walled with a steel border, so enemies can no longer enter
 * along row 0 as they do in the battle arena — these sit just inside the top of
 * the field, spread across it and clear of the corner radar towers.
 */
const ENEMY_SPAWNS: readonly { x: number; y: number }[] = [
  { x: 6, y: 2 },
  { x: 30, y: 2 },
  { x: 53, y: 2 },
  { x: 6, y: 16 },
  { x: 53, y: 16 },
];

/** Where the player's tank materialises: centre-bottom, inside the wall. */
const PLAYER_SPAWN = { x: 30, y: 31 };

/** Most standard (non-boss) enemies allowed on the field at once. */
const MAX_ENEMIES = 10;

/**
 * Small physical nudge (px) applied to an enemy that is trying to move but is
 * wedged against other hulls, to break traffic-jam deadlocks — the tiny overlap
 * it introduces gives {@link separateTanks} something to disperse.
 */
const TRAFFIC_JITTER = 3;

/**
 * Enemy release cadence. The gap shrinks 500ms per level from a 4s base down to
 * a 1.5s floor, so later levels apply steadily heavier pressure.
 */
const SPAWN_INTERVAL_BASE_MS = 3400;
const SPAWN_INTERVAL_MIN_MS = 1500;
const SPAWN_INTERVAL_PER_LEVEL_MS = 500;

/** How long the player must hold a `zone_control` level's zone, in ms. */
const ZONE_MS = ZONE_CONTROL_DURATION_SECONDS * 1000;

/** How long the player has to defuse every bomb on a `defuse_bombs` level. */
const BOMB_MS = BOMB_DEFUSAL_DURATION_SECONDS * 1000;

/** Kamikaze spawn chance on the Level 4 zone hold and among the Level 5 adds. */
const KAMIKAZE_CHANCE_ZONE = 0.35;
const KAMIKAZE_CHANCE_BOSS = 0.35;

/**
 * Kamikaze speed as a multiple of the player's base speed ({@link TANK_SPEED}),
 * so they are always faster than the player and force them to keep moving.
 */
const KAMIKAZE_SPEED_MIN = 2.0;
const KAMIKAZE_SPEED_MAX = 2.5;

/** The enemy `variant` string for the fast contact-detonating rushers. */
const KAMIKAZE = "kamikaze";

/** Slack, in px, for judging a kamikaze "in contact" with the player. */
const KAMIKAZE_CONTACT_PADDING = 6;

/** The Level 5 boss hitbox, three tiles square — massive. */
const SWEEPER_SIZE = TILE_SIZE * 3;

/** The boss's ballistic speed on each axis, in pixels per second. */
const SWEEPER_SPEED = 120;

/** The boss's hit points. */
const SWEEPER_HP = 25;

/** Chance a wall bounce turns into a homing lunge straight at the player. */
const SWEEPER_HOMING_CHANCE = 0.33;

/** The enemy `variant` string for the Level 6 trench-laying miniboss. */
const CONSTRUCTOR = "constructor";

/** Chance a Level 6 spawn is a Constructor rather than a standard tank. */
const CONSTRUCTOR_CHANCE = 0.35;

/** A Constructor's hit points — tankier than the rank and file. */
const CONSTRUCTOR_HP = 1;

/** A Constructor's speed as a fraction of the player's base speed (25% slower). */
const CONSTRUCTOR_SPEED_FACTOR = 0.75;

/** The enemy `variant` string for the Level 8 mine-laying miniboss. */
const TRAPPER = "trapper";

/** Chance a Level 8 spawn is a Trapper rather than a standard tank. */
const TRAPPER_CHANCE = 0.35;

/** A Trapper's speed as a multiple of the player's base speed (50% faster). */
const TRAPPER_SPEED_FACTOR = 1.5;

/** How often a Trapper drops a mine, in milliseconds. */
const TRAPPER_MINE_INTERVAL_MS = 3000;

/** Chance per grid-aligned step that a wandering Trapper picks a new heading. */
const TRAPPER_TURN_CHANCE = 0.15;

/** The `variant` string for the Level 9 escort carrier (a friendly, isEnemy=false). */
const CONVOY = "convoy";

/** The carrier's upward speed, in pixels per second (it only ever climbs). */
const CONVOY_VY = -40;

/** Slack, in px, for judging an enemy "in contact" with the carrier. */
const CONVOY_CONTACT_PADDING = 6;

/**
 * The carrier's hit points. Player shells pass through it harmlessly (it is a
 * friendly, so they never target it); enemy shells and enemy hull contact chip
 * it down, and the escort only fails once it reaches zero.
 */
const CONVOY_HP = 10;

/** Minimum gap between contact-damage ticks on the carrier, in ms. */
const CONVOY_CONTACT_INTERVAL_MS = 500;

/** The `variant` string for the Level 10 mobile artillery boss. */
const ARTILLERY = "artillery";

/** The artillery boss's hit points. */
const ARTILLERY_HP = 15;

/** The artillery boss hitbox, one and a half tiles square. */
const ARTILLERY_SIZE = Math.round(TILE_SIZE * 1.5);

/**
 * The artillery boss's flee speed, in pixels per second — half the player's,
 * whose {@link TANK_SPEED} px/tick works out to `TANK_SPEED * TICK_RATE` px/s.
 * It skulks away from the player to keep cover between them.
 */
const ARTILLERY_SPEED = TANK_SPEED * (1000 / TICK_MS) * 0.5;

/** The (1-based) level whose boss is the Artillery rather than the Sweeper. */
const ARTILLERY_BOSS_LEVEL = 10;

/** How often the artillery launches a mortar strike, in ms. */
const MORTAR_INTERVAL_MS = 3600;

/** How long a mortar is telegraphed before it detonates, in ms. */
const MORTAR_DETONATION_MS = 2000;

/** The `variant` string for the Level 11 shield miniboss. */
const AEGIS = "aegis";

/** The (1-based) level that fields Aegis shield units. */
const AEGIS_LEVEL = 11;

/** Chance a Level 11 spawn is an Aegis shield unit. */
const AEGIS_CHANCE = 0.35;

/** Radius, in px, of the Aegis protective aura. */
const AEGIS_RADIUS = 3 * TILE_SIZE;

/** The `variant` string for the Level 12 jammer miniboss. */
const JAMMER = "jammer";

/** The (1-based) level that fields Jammer units. */
const JAMMER_LEVEL = 12;

/** Chance a Level 12 spawn is a Jammer. */
const JAMMER_CHANCE = 0.35;

/** Player fire-cooldown multiplier while any Jammer is on the field. */
const JAMMER_COOLDOWN_MULTIPLIER = 2;

/** The `variant` string for the Level 13 disguised-loot miniboss. */
const MIMIC = "mimic";

/** The (1-based) level that fields Mimics. */
const MIMIC_LEVEL = 13;

/** Chance a Level 13 spawn is a disguised Mimic rather than a standard tank. */
const MIMIC_CHANCE = 0.45;

/**
 * A revealed Mimic's speed as a multiple of the player's base speed.
 *
 * Twice the player: a sprung Mimic is a genuine chase that has to be dealt with
 * now, rather than something you can simply reverse away from. This is the whole
 * point of the ambush — at 1.5x it was outrun trivially and the trap never bit.
 */
const MIMIC_SPEED_FACTOR = 2.0;

/**
 * A still-disguised Mimic's speed as a fraction of the player's base speed — a
 * slow, menacing creep straight toward the player rather than sitting inert.
 *
 * Fast enough to actually close ground while it is being ignored: at 0.15 it
 * barely moved, so a Mimic the player never walked into was no threat at all.
 */
const MIMIC_CREEP_FACTOR = 0.45;

/**
 * A Mimic's hit points — enough to survive the shot that springs it and still
 * reach the player, so shooting a suspicious "drop" is not a free kill.
 */
const MIMIC_HP = 3;

/** How close (px) the player must get before a disguised Mimic springs. */
const MIMIC_REVEAL_DISTANCE = 3 * TILE_SIZE;

/** How long a freshly sprung Mimic keeps its ambush burst of speed, in ms. */
const MIMIC_LUNGE_MS = 2000;

/** Speed multiple during that burst — a short, frightening pounce. */
const MIMIC_LUNGE_FACTOR = 2.6;

/** The `variant` string for the Level 14 Juggernaut siege boss. */
const JUGGERNAUT = "juggernaut";

/** The (1-based) level that fields the Juggernaut. */
const JUGGERNAUT_LEVEL = 14;

/** The Juggernaut's hit points. */
const JUGGERNAUT_HP = 25;

/** The Juggernaut hitbox, two tiles square — massive. */
const JUGGERNAUT_SIZE = TILE_SIZE * 2;

/**
 * The Juggernaut's chase speed, in pixels per second — half the player's, whose
 * {@link TANK_SPEED} pixels-per-tick works out to `TANK_SPEED * TICK_RATE` px/s.
 */
const JUGGERNAUT_SPEED = TANK_SPEED * (1000 / TICK_MS) * 0.625;

/** The `variant` string for the Level 16 cloaking Ghost miniboss. */
const GHOST = "ghost";

/** The (1-based) level that fields Ghost units. */
const GHOST_LEVEL = 16;

/** Chance a Level 16 spawn is a Ghost. */
const GHOST_CHANCE = 0.30;

/** How long (ms) a Ghost stays visible after it fires a shot. */
const GHOST_UNCLOAK_MS = 2000;

/** The (1-based) level for the Warden boss (formerly the Miniboss Gauntlet). */
const WARDEN_LEVEL = 15;

/** The `variant` string for the Level 15 Warden siege boss. */
const WARDEN = "warden";

/** The Warden's hit points. */
const WARDEN_HP = 60;

/** The Warden hitbox, two tiles square. */
const WARDEN_SIZE = TILE_SIZE * 2;

/** The Warden's chase speed — 40% of the player's base px/s. */
const WARDEN_SPEED = TANK_SPEED * (1000 / TICK_MS) * 0.5;

/** Super-Aegis shield radius — 6 tiles. */
const WARDEN_SHIELD_RADIUS = 6 * TILE_SIZE;

/** How often the Warden drops a carpet of mines, in ms. */
const WARDEN_MINE_INTERVAL_MS = 4000;

// ------------------------------------------------------------------- sapper
//
// Every other enemy either charges the player or wanders; none of them punish
// the player for holding a good position. The Sapper is the answer: it refuses
// to close, keeps a standoff band, and lobs arcing shells that ignore walls
// entirely — so cover stops being safety and the player has to advance into it.

/**
 * A horizontally centred spawn x, snapped to the tile grid.
 *
 * `WORLD_WIDTH / 2 - size / 2` lands half a tile off for any hull an odd number
 * of tiles across, and enemy steering only ever turns a tank that is aligned to
 * the grid. A misaligned boss therefore can never change direction: it drives
 * until it meets something and is stuck there for the rest of the level. Every
 * boss spawn goes through this.
 */
function centredSpawnX(size: number): number {
  return Math.round((WORLD_WIDTH / 2 - size / 2) / TILE_SIZE) * TILE_SIZE;
}

/** The vertical counterpart of {@link centredSpawnX}. */
function centredSpawnY(size: number): number {
  return Math.round((WORLD_HEIGHT / 2 - size / 2) / TILE_SIZE) * TILE_SIZE;
}

/** The `variant` string for the standoff siege unit. */
const SAPPER = "sapper";

/** A Sapper's hit points — fragile once the player actually reaches it. */
const SAPPER_HP = 2;

/**
 * A Sapper's speed as a fraction of the player's base speed.
 *
 * Deliberately below 1: the player must always be able to run one down. A
 * kiting enemy that cannot be caught is a stalemate, not a threat.
 */
const SAPPER_SPEED_FACTOR = 0.7;

/** Closer than this (px), a Sapper backs away. */
const SAPPER_STANDOFF_MIN = 6 * TILE_SIZE;

/** Farther than this (px), a Sapper closes in to get the player in range. */
const SAPPER_STANDOFF_MAX = 12 * TILE_SIZE;

/** Chance per grid-aligned step that a holding Sapper shuffles sideways. */
const SAPPER_STRAFE_CHANCE = 0.25;

/** Gap between a Sapper's lobs, in ms. */
const SAPPER_LOB_INTERVAL_MS = 3200;

/** How long a lobbed shell is telegraphed before it lands, in ms. */
const SAPPER_LOB_FLIGHT_MS = 2000;

/** Blast radius of a lobbed shell, in px — a single tile, not a mortar. */
const SAPPER_LOB_RADIUS = TILE_SIZE;

/** Random scatter applied to a lob's aim point, in px. */
const SAPPER_LOB_SCATTER = 1.2 * TILE_SIZE;

/** Damage a lob deals to the player — chip damage, not a one-shot kill. */
const SAPPER_LOB_DAMAGE = 1;

/** The (1-based) level that introduces Sappers. */
const SAPPER_LEVEL = 11;

/** Chance a spawn on {@link SAPPER_LEVEL} is a Sapper. */
const SAPPER_CHANCE = 0.35;

/**
 * The full miniboss variant pool used on the Warden level's add spawns.
 * Each spawn picks one at random.
 */
const GAUNTLET_POOL: readonly string[] = [
  KAMIKAZE, CONSTRUCTOR, TRAPPER, AEGIS, JAMMER, MIMIC, SAPPER,
];

// ------------------------------------------------------------------ lurcher
//
// The first enemy that takes the player's spacing away from them. Everything
// else is avoided by positioning; this one reaches out and moves the player,
// which is the natural counter to a kit built around shields, blinks and kiting.

/** The `variant` string for the grappling Lurcher. */
const LURCHER = "lurcher";

/** The (1-based) level that introduces Lurchers. */
const LURCHER_LEVEL = 19;

/** Chance a spawn on {@link LURCHER_LEVEL} is a Lurcher. */
const LURCHER_CHANCE = 0.35;

/** A Lurcher's hit points. */
const LURCHER_HP = 2;

/** A Lurcher's speed as a fraction of the player's base speed. */
const LURCHER_SPEED_FACTOR = 0.75;

/** How far a grapple reaches, in tiles. */
const LURCHER_RANGE_TILES = 8;

/** Gap between grapple attempts, in ms. */
const LURCHER_INTERVAL_MS = 4200;

/** How far a connecting grapple drags the player, in tiles. */
const LURCHER_PULL_TILES = 2;

/** How long a grapple keeps the player's blink drive locked, in ms. */
const LURCHER_LOCK_MS = 1500;

// ---------------------------------------------------------------- nullifier
//
// The answer to a player who leans on their abilities. It does not out-shoot
// anyone — it simply switches the kit off inside its bubble, and has to be
// killed the hard way.

/** The `variant` string for the ability-suppressing Nullifier. */
const NULLIFIER = "nullifier";

/** The (1-based) level that introduces Nullifiers. */
const NULLIFIER_LEVEL = 17;

/** Chance a spawn on {@link NULLIFIER_LEVEL} is a Nullifier. */
const NULLIFIER_CHANCE = 0.3;

/** A Nullifier's hit points. */
const NULLIFIER_HP = 2;

/** A Nullifier's speed as a fraction of the player's base speed. */
const NULLIFIER_SPEED_FACTOR = 0.8;

// ------------------------------------------------------------------- effigy
//
// The campaign's last word: a copy of the player, at the player's own size,
// carrying the player's own three abilities. Nothing about it is bigger or
// tougher than what the player has been given — it simply uses it all well.

/** The `variant` string for the Effigy, the mirror boss. */
const EFFIGY = "effigy";

/** The (1-based) level that fields the Effigy — the campaign's true last. */
const EFFIGY_LEVEL = 22;

/** The Effigy's hit points. */
const EFFIGY_HP = 20;

/** How long the Effigy's own shield holds, in ms. */
const EFFIGY_SHIELD_MS = 2200;

/** Gap between the Effigy's shield raises, in ms. */
const EFFIGY_SHIELD_COOLDOWN_MS = 9000;

/** Gap between the Effigy's blinks, in ms. */
const EFFIGY_BLINK_COOLDOWN_MS = 6000;

/** How far the Effigy blinks, in tiles. */
const EFFIGY_BLINK_TILES = 5;

/** Gap between the Effigy's blasts, in ms. */
const EFFIGY_BLAST_COOLDOWN_MS = 11_000;

/** How close the player must be for the Effigy to blast, in tiles. */
const EFFIGY_BLAST_TRIGGER_TILES = 3;

/** The Effigy's blast radius, in tiles — the player's own. */
const EFFIGY_BLAST_RADIUS_TILES = 3;

/** Gap between the Effigy's shells, in ms. */
const EFFIGY_SHOOT_INTERVAL_MS = 900;

// ------------------------------------------------------------------ bastion
//
// A boss that cannot be beaten by out-shooting it. Its frontal plating turns
// every shell, and it keeps rotating to face the player — so the fight is a
// geometry problem, not a damage race, and the blink drive is the answer to it.

/** The `variant` string for the Level 12 Bastion boss. */
const BASTION = "bastion";

/** The (1-based) level that fields the Bastion. */
const BASTION_LEVEL = 12;

/** The Bastion's hit points. Low, because landing a hit at all is the work. */
const BASTION_HP = 12;

/** The Bastion's hitbox, two tiles square. */
const BASTION_SIZE = TILE_SIZE * 2;

/** The Bastion's advance speed, in px/s — slow enough to be circled. */
const BASTION_SPEED = TANK_SPEED * (1000 / TICK_MS) * 0.35;

/**
 * How long the Bastion takes to swing 90 degrees, in ms.
 *
 * This is the whole encounter's tuning knob: it sets how long a window the
 * player has behind the plating after getting there.
 */
const BASTION_TURN_INTERVAL_MS = 900;

/** Gap between the Bastion's forward shells, in ms. */
const BASTION_SHOOT_INTERVAL_MS = 1700;

// -------------------------------------------------------------------- hydra
//
// The only boss that is more than one thing. It halves on death rather than
// dying, so the fight widens instead of lengthening: total health is roughly
// conserved across the tiers, but by the end the player is holding off seven
// bodies at once and cannot afford to have backed themselves into a corner.

/** The `variant` string for the Level 18 Hydra boss and its fragments. */
const HYDRA = "hydra";

/** The (1-based) level that fields the Hydra. */
const HYDRA_LEVEL = 18;

/** How many children each surviving tier splits into. */
const HYDRA_SPLIT_COUNT = 2;

/**
 * The Hydra's tiers, largest first. A unit splits into {@link HYDRA_SPLIT_COUNT}
 * of the next entry; the last tier is terminal and simply dies.
 */
const HYDRA_TIERS: readonly { size: number; health: number; speed: number }[] = [
  { size: TILE_SIZE * 3, health: 16, speed: TANK_SPEED * 0.5 },
  { size: TILE_SIZE * 2, health: 6, speed: TANK_SPEED * 0.85 },
  { size: TILE_SIZE, health: 2, speed: TANK_SPEED * 1.35 },
];

/** How far apart split children are nudged, in px, so they do not stack. */
const HYDRA_SPLIT_SPREAD = TILE_SIZE;

// ---------------------------------------------------------------- architect
//
// The boss that is not the thing you shoot. It is immune while its pylons
// stand, and spends the fight closing the arena in from the edges — so the
// player's real opponent is the shrinking floor, and the pylons are the timer.

/** The `variant` string for the Level 20 Architect boss. */
const ARCHITECT = "architect";

/** The (1-based) level that fields the Architect. */
const ARCHITECT_LEVEL = 20;

/** The Architect's hit points, once its pylons are down and it is exposed. */
const ARCHITECT_HP = 14;

/** The Architect's hitbox, three tiles square. */
const ARCHITECT_SIZE = TILE_SIZE * 3;

/**
 * Base gap between arena contractions, in ms, with every pylon still standing.
 *
 * Each pylon the player levels adds {@link ARCHITECT_RING_SLOWDOWN_MS} to this,
 * so clearing them visibly buys back room to fight in.
 */
const ARCHITECT_RING_BASE_MS = 6000;

/**
 * Gap between the Architect's suppressing mortar lobs, in ms.
 *
 * It is not meant to out-damage the player — the pylons are the fight — but a
 * boss that never does anything at all reads as broken rather than as sinister,
 * so it keeps steady pressure on while it works.
 */
const ARCHITECT_LOB_INTERVAL_MS = 3400;

/** How long the Architect telegraphs an incoming contraction, in ms. */
const ARCHITECT_RING_WARNING_MS = 1500;

/** Extra ms added to the contraction interval per pylon destroyed. */
const ARCHITECT_RING_SLOWDOWN_MS = 4000;

/**
 * How many rings may close before the arena stops contracting.
 *
 * Capped so the walls can never reach the pylons at ring 6. If steel could bury
 * a pylon, the contraction would clear the Architect's own seal for the player
 * and the whole encounter could be won by standing still and waiting.
 */
const ARCHITECT_MAX_RINGS = 5;

/** The `variant` string for the Level 20 Logic Core final boss. */
const CORE = "core";

/** The (1-based) level that fields the Logic Core — the campaign's last. */
const CORE_LEVEL = 21;

/** The Core's hit points — a large pool for the final boss. */
const CORE_HP = 40;

/** The Core's hitbox, three tiles square. */
const CORE_SIZE = TILE_SIZE * 3;

/** How often the Core fires a radial bullet wave, in ms. */
const CORE_SHOOT_INTERVAL_MS = 2900;

/**
 * Number of bullets per radial wave (2 per cardinal direction = 8).
 *
 * Three per direction left almost no gap to thread between waves; with the whole
 * miniboss pool on the field at once the level stopped being readable.
 */
const CORE_BULLETS_PER_DIRECTION = 2;

/**
 * The full miniboss variant pool used on the final boss level. Every miniboss
 * type in the game appears with equal probability alongside the Core.
 */
const CORE_POOL: readonly string[] = [
  KAMIKAZE, CONSTRUCTOR, TRAPPER, AEGIS, JAMMER, MIMIC, GHOST, SAPPER,
];

/** HP thresholds for Core phase transitions. */
const CORE_PHASE2_HP = 35;
const CORE_PHASE3_HP = 15;

/** Core Phase 2: shotgun fire interval, in ms. */
const CORE_PHASE2_SHOOT_MS = 1900;

/** Core Phase 2/3 chase speeds — fractions of the player's base px/s. */
const CORE_PHASE2_SPEED = TANK_SPEED * (1000 / TICK_MS) * 0.4;
const CORE_PHASE3_SPEED = TANK_SPEED * (1000 / TICK_MS) * 0.7;

/** Core Phase 3: spiral fire rate — one bullet every 320ms. */
const CORE_SPIRAL_INTERVAL_MS = 320;

/** How often the Logic Core launches a mortar barrage, in ms. */
const CORE_MORTAR_INTERVAL_MS = 5500;

/** The enemy `variant` string for the Level 5 boss. */
const SWEEPER = "sweeper";

/**
 * The single-player campaign room.
 *
 * Runs the same authoritative physics loop and systems as {@link BattleRoom} —
 * shells, tanks, flow-field pathing — but sequenced by the replicated
 * {@link CampaignState.phase} rather than a lobby/match cycle, and with the enemy
 * flow field converging on the player instead of an eagle.
 */
export class CampaignRoom extends Room<CampaignState> {
  override maxClients = 1;

  /** Simulation tick counter; drives movement intents and field rebuilds. */
  private tick = 0;

  /** Real elapsed time within the current level, in milliseconds. */
  private elapsedMs = 0;

  /** Session id of the lone player, or null before anyone joins. */
  private playerId: string | null = null;

  /** ownerId -> tick at which that tank's movement intent lapses. */
  private readonly moveIntents = new Map<string, number>();

  /** ownerId -> elapsedMs at that tank's last shot. */
  private readonly lastShotAtMs = new Map<string, number>();

  /** sessionId -> elapsedMs at which respawn invulnerability lapses. */
  private readonly invulnerableUntilMs = new Map<string, number>();

  /** elapsedMs at which the destroyed player returns, or null. */
  private respawnAtMs: number | null = null;

  /** elapsedMs of the last enemy release. */
  private lastEnemySpawnMs = 0;

  /** Milliseconds the player has held the uplink zone (zone_control levels). */
  private zoneProgressMs = 0;

  /** Milliseconds left to defuse every bomb (defuse_bombs levels). */
  private bombTimerMs = BOMB_MS;

  /** ownerId of the active boss, or null. Its velocity lives alongside. */
  private bossId: string | null = null;
  private bossVx = 0;
  private bossVy = 0;

  /** ownerId -> last grid cell a Constructor occupied, for its trench trail. */
  private readonly constructorCells = new Map<string, { gx: number; gy: number }>();

  /** ownerId -> ms since a Trapper last dropped a mine. */
  private readonly trapperMineTimers = new Map<string, number>();

  /** ownerId of the escort carrier, or null. */
  private convoyId: string | null = null;

  /** ms remaining before the carrier can take another tick of contact damage. */
  private convoyContactCooldownMs = 0;

  /** ms accumulated toward the next artillery mortar launch. */
  private mortarCooldownMs = 0;

  /** Mortars in flight: their impact centre and ms until detonation. */
  private mortarStrikes: Array<{ x: number; y: number; timerMs: number }> = [];

  /** ownerId -> ms remaining until a Ghost re-cloaks. */
  private readonly ghostUncloakTimers = new Map<string, number>();

  /** ownerId -> ms remaining on a sprung Mimic's ambush lunge. */
  private readonly mimicLungeTimers = new Map<string, number>();

  /** ownerId -> ms accumulated toward a Sapper's next lob. */
  private readonly sapperLobTimers = new Map<string, number>();

  /** Lobbed Sapper shells in flight: impact centre and ms until they land. */
  private sapperLobs: Array<{ x: number; y: number; timerMs: number }> = [];

  /**
   * Sappers that chose to hold station this tick.
   *
   * The anti-stuck pass consults this so it does not mistake a unit that is
   * deliberately standing its ground for one that is wedged, and shove it out
   * of the standoff band it is trying to keep.
   */
  private readonly sapperHolding = new Set<string>();

  /** ms accumulated toward the Bastion's next 90-degree swing. */
  private bastionTurnMs = 0;

  /** ms accumulated toward the Bastion's next forward shell. */
  private bastionShootMs = 0;

  /** ms accumulated toward the Architect's next arena contraction. */
  private architectRingMs = 0;

  /** How many rings the Architect has already closed in from the edge. */
  private architectRings = 0;

  /** ms accumulated toward the Architect's next suppressing lob. */
  private architectLobMs = 0;

  /** True once the incoming contraction has been telegraphed. */
  private architectWarned = false;

  /** ms until the close-in blast can be fired again; 0 when ready. */
  private blastCooldownMs = 0;

  /** ms remaining on the ram surge; 0 when not ramming. */
  private ramActiveMs = 0;

  /** ms until the ram can be fired again; 0 when ready. */
  private ramCooldownMs = 0;

  /** The facing the ram was launched along; it cannot be steered mid-surge. */
  private ramDirection: Direction = Direction.Up;

  /** The standing decoy beacon, if one is out. */
  private decoy: { x: number; y: number; remainingMs: number } | null = null;

  /** ms until another decoy beacon can be dropped; 0 when ready. */
  private decoyCooldownMs = 0;

  /** ownerId -> ms accumulated toward a Lurcher's next grapple. */
  private readonly lurcherTimers = new Map<string, number>();

  /** ms remaining on a grapple's blink lock; 0 when the drive is free. */
  private blinkLockMs = 0;

  /** ms remaining on the Effigy's own shield. */
  private effigyShieldMs = 0;

  /** Cooldown timers for the Effigy's three borrowed abilities. */
  private effigyShieldCdMs = 0;
  private effigyBlinkCdMs = 0;
  private effigyBlastCdMs = 0;
  private effigyShootMs = 0;

  /** Blink charges the player currently has banked. */
  private teleportCharges = TELEPORT_MAX_CHARGES;

  /** ms until the next blink charge returns; 0 when the bank is full. */
  private teleportRechargeMs = 0;

  /** ms remaining on the player's raised shield; 0 when it is down. */
  private shieldActiveMs = 0;

  /** ms remaining before the shield can be raised again; 0 when ready. */
  private shieldCooldownMs = 0;

  /** ms accumulated toward the next Core radial bullet wave. */
  private coreShootTimerMs = 0;

  /** The Core's current spiral angle (Phase 3), in radians. */
  private coreSpiralAngle = 0;

  /** ms accumulated toward the next Warden carpet mine drop. */
  private wardenMineTimerMs = 0;

  /** Anti-stuck: per-enemy timers tracking positional stalls and forced escapes. */
  private readonly stuckTimers = new Map<string, { prevX: number; prevY: number; stuckMs: number }>();

  /** ms accumulated toward the next Logic Core mortar launch. */
  private coreMortarTimerMs = 0;

  /** Mines placed by Trappers, each with an expiration timestamp (elapsedMs). */
  private activeMines: Array<{ x: number; y: number; expiresAtMs: number }> = [];

  private enemySequence = 0;

  /** Routes every enemy toward the player's current position. */
  private readonly hunterField = new FlowField();

  override onCreate(): void {
    this.setState(new CampaignState());

    // The player leaves the intro briefing: build the level and go live.
    this.onMessage(CampaignMessage.StartLevel, () => {
      if (this.state.phase !== CampaignPhase.Intro) return;
      this.beginLevel();
      this.state.phase = CampaignPhase.Playing;
      console.log(`[room ${this.roomId}] level ${this.state.currentLevel} started`);
    });

    // The player clears the outro: advance, or finish the campaign if this was
    // the last level.
    this.onMessage(CampaignMessage.NextLevel, () => {
      if (this.state.phase !== CampaignPhase.Outro) return;
      const next = this.state.currentLevel + 1;

      if (next > CAMPAIGN_LEVELS.length) {
        this.state.phase = CampaignPhase.CampaignComplete;
        console.log(`[room ${this.roomId}] campaign complete`);
        return;
      }

      // Reactive Armor upgrade: grant +2 lives on reaching level 16.
      if (next === 16) {
        this.state.lives += 2;
        const player = this.playerId ? this.state.players.get(this.playerId) : undefined;
        if (player) player.lives = this.state.lives;
      }

      this.state.currentLevel = next;
      this.state.phase = CampaignPhase.Intro;
      console.log(`[room ${this.roomId}] advancing to level ${this.state.currentLevel}`);
    });

    this.onMessage(CampaignMessage.CheatWin, () => {
      if (this.state.phase !== CampaignPhase.Playing) return;
      this.winLevel();
    });

    this.onMessage(CampaignMessage.ActivateShield, () => {
      if (this.state.phase !== CampaignPhase.Playing) return;
      this.raiseShield();
    });

    this.onMessage(CampaignMessage.Teleport, () => {
      if (this.state.phase !== CampaignPhase.Playing) return;
      this.teleportPlayer();
    });

    this.onMessage(CampaignMessage.Blast, () => {
      if (this.state.phase !== CampaignPhase.Playing) return;
      this.fireBlast();
    });

    this.onMessage(CampaignMessage.Ram, () => {
      if (this.state.phase !== CampaignPhase.Playing) return;
      this.startRam();
    });

    this.onMessage(CampaignMessage.Decoy, () => {
      if (this.state.phase !== CampaignPhase.Playing) return;
      this.dropDecoy();
    });

    this.onMessage(ClientMessage.Move, (client, payload: unknown) => {
      if (this.state.phase !== CampaignPhase.Playing) return;
      if (!isMoveMessage(payload)) return;
      this.requestMove(client.sessionId, MOVE_DIRECTION_TO_FACING[payload.dir]);
    });

    this.onMessage(ClientMessage.Shoot, (client) => {
      if (this.state.phase !== CampaignPhase.Playing) return;
      this.playerShoot(client.sessionId);
    });

    this.setSimulationInterval((deltaMs) => this.update(deltaMs), TICK_MS);

    console.log(
      `[room ${this.roomId}] campaign created — level ${this.state.currentLevel}, ${this.state.lives} lives`,
    );
  }

  override onJoin(client: Client, options?: JoinOptions): void {
    // Join options are attacker-controlled: normalise before they reach state.
    const name = sanitizePlayerName(options?.name, defaultPlayerName(client.sessionId));
    const color = sanitizePlayerColor(options?.color, defaultPlayerColor(client.sessionId));
    client.userData = { deviceId: sanitizeDeviceId(options?.deviceId) };

    this.playerId = client.sessionId;
    this.state.players.set(
      client.sessionId,
      new Player({ sessionId: client.sessionId, name, color, lives: this.state.lives, tier: 1 }),
    );

    console.log(`[room ${this.roomId}] ${name} joined the campaign`);
  }

  override onLeave(client: Client): void {
    this.removeOwned(client.sessionId);
    this.state.players.delete(client.sessionId);
    this.moveIntents.delete(client.sessionId);
    this.lastShotAtMs.delete(client.sessionId);
    this.invulnerableUntilMs.delete(client.sessionId);
    if (this.playerId === client.sessionId) this.playerId = null;
  }

  // --------------------------------------------------------------- level setup

  /**
   * Prepares a fresh level: clears the field, loads the level's map into the
   * physical grid, resets per-run bookkeeping and drops the player onto their
   * spawn pad. Called when the intro briefing is dismissed.
   */
  private beginLevel(): void {
    this.state.tanks.splice(0);
    this.state.bullets.splice(0);
    this.state.boons.splice(0);

    const level = CAMPAIGN_LEVELS[this.state.currentLevel - 1];
    for (let i = 0; i < GRID_LENGTH; i++) {
      this.state.grid[i] = level?.mapGrid[i] ?? TileType.Empty;
    }

    this.tick = 0;
    this.elapsedMs = 0;
    this.lastEnemySpawnMs = 0;
    this.zoneProgressMs = 0;
    this.bombTimerMs = BOMB_MS;
    this.respawnAtMs = null;
    this.bossId = null;
    this.moveIntents.clear();
    this.lastShotAtMs.clear();
    this.invulnerableUntilMs.clear();
    this.constructorCells.clear();
    this.trapperMineTimers.clear();
    this.ghostUncloakTimers.clear();
    this.convoyId = null;
    this.convoyContactCooldownMs = 0;
    this.mortarCooldownMs = 0;
    this.mortarStrikes = [];
    this.coreShootTimerMs = 0;
    this.coreSpiralAngle = 0;
    this.wardenMineTimerMs = 0;
    this.activeMines = [];
    this.stuckTimers.clear();
    this.mimicLungeTimers.clear();
    this.sapperLobTimers.clear();
    this.sapperLobs = [];
    this.lurcherTimers.clear();
    this.coreMortarTimerMs = 0;
    this.resetShield();
    this.resetTeleport();
    this.resetBlast();
    this.resetRam();
    this.resetDecoy();
    this.blinkLockMs = 0;

    this.spawnPlayer();
    if (this.currentWinCondition() === CampaignWinCondition.AssassinateBoss) {
      if (this.state.currentLevel === CORE_LEVEL) this.spawnCore();
      else if (this.state.currentLevel === ARTILLERY_BOSS_LEVEL) this.spawnArtillery();
      else if (this.state.currentLevel === WARDEN_LEVEL) this.spawnWarden();
      else if (this.state.currentLevel === BASTION_LEVEL) this.spawnBastion();
      else if (this.state.currentLevel === HYDRA_LEVEL) this.spawnHydra();
      else if (this.state.currentLevel === ARCHITECT_LEVEL) this.spawnArchitect();
      else if (this.state.currentLevel === EFFIGY_LEVEL) this.spawnEffigy();
      else this.spawnSweeper();
    }
    if (this.currentWinCondition() === CampaignWinCondition.Escort) {
      this.spawnConvoy();
    }
    // The Level 14 Juggernaut is a boss on a non-assassinate (defuse) level, so
    // it is spawned by level number rather than by win condition.
    if (this.state.currentLevel === JUGGERNAUT_LEVEL) {
      this.spawnJuggernaut();
    }
    this.hunterField.rebuildToward(this.state.grid, this.playerTargets());
    this.refreshObjective();
  }

  /**
   * Spawns the escort carrier at bottom centre.
   *
   * A friendly unit (`isEnemy=false`), so player shells pass through it and enemy
   * shells damage it, but it is not steered or counted like an enemy. It has
   * {@link CONVOY_HP} hit points now — enemy fire and hull contact whittle it
   * down, and the escort only fails once it is destroyed.
   */
  private spawnConvoy(): void {
    const id = `convoy-${this.enemySequence++}`;
    this.convoyId = id;
    this.convoyContactCooldownMs = 0;

    this.state.tanks.push(
      new Tank({
        x: 30 * TILE_SIZE,
        y: 31 * TILE_SIZE,
        width: TANK_SIZE,
        height: TANK_SIZE,
        ownerId: id,
        maxHealth: CONVOY_HP,
        speed: 0,
        direction: Direction.Up,
        isEnemy: false,
        variant: CONVOY,
      }),
    );
  }

  /** Spawns the Level 5 boss at top centre, moving ballistically down-right. */
  private spawnSweeper(): void {
    const id = `boss-${this.enemySequence++}`;
    this.bossId = id;
    this.bossVx = SWEEPER_SPEED;
    this.bossVy = SWEEPER_SPEED;

    this.state.tanks.push(
      new Tank({
        x: centredSpawnX(SWEEPER_SIZE),
        y: 2 * TILE_SIZE,
        width: SWEEPER_SIZE,
        height: SWEEPER_SIZE,
        ownerId: id,
        maxHealth: SWEEPER_HP,
        speed: 0,
        direction: Direction.Up,
        isEnemy: true,
        variant: SWEEPER,
        isBoss: true,
      }),
    );
  }

  /**
   * Spawns the Level 10 artillery boss in its top gallery. It never fires
   * bullets — its mortars are the weapon — but it now skulks around, fleeing the
   * player via {@link moveArtillery} to keep cover between them.
   */
  private spawnArtillery(): void {
    const id = `boss-${this.enemySequence++}`;
    this.bossId = id;

    this.state.tanks.push(
      new Tank({
        x: centredSpawnX(ARTILLERY_SIZE),
        y: 2 * TILE_SIZE,
        width: ARTILLERY_SIZE,
        height: ARTILLERY_SIZE,
        ownerId: id,
        maxHealth: ARTILLERY_HP,
        speed: 0,
        direction: Direction.Down,
        isEnemy: true,
        variant: ARTILLERY,
        isBoss: true,
      }),
    );
  }

  /**
   * Spawns the Level 14 Juggernaut in its top-centre chamber.
   *
   * A massive boss that homes straight at the player and ploughs through the
   * brick maze, but never fires — its hull is the weapon. It shares the boss
   * hooks (bossId, contact-kill) with the Sweeper, but steers itself via
   * {@link moveJuggernaut} instead of the ballistic Sweeper path.
   */
  private spawnJuggernaut(): void {
    const id = `boss-${this.enemySequence++}`;
    this.bossId = id;

    this.state.tanks.push(
      new Tank({
        x: centredSpawnX(JUGGERNAUT_SIZE),
        y: 2 * TILE_SIZE,
        width: JUGGERNAUT_SIZE,
        height: JUGGERNAUT_SIZE,
        ownerId: id,
        maxHealth: JUGGERNAUT_HP,
        speed: 0,
        direction: Direction.Down,
        isEnemy: true,
        variant: JUGGERNAUT,
        isBoss: true,
      }),
    );
  }

  /** Spawns the Level 15 Warden at top centre. */
  /**
   * Spawns the Level 12 Bastion at centre-north.
   *
   * Only its rear takes damage (see {@link isBastionArmoured}), so it is placed
   * with room on every side for the player to work around it.
   */
  private spawnBastion(): void {
    const id = `boss-${this.enemySequence++}`;
    this.bossId = id;
    this.bastionTurnMs = 0;
    this.bastionShootMs = 0;

    this.state.tanks.push(
      new Tank({
        x: centredSpawnX(BASTION_SIZE),
        y: 6 * TILE_SIZE,
        width: BASTION_SIZE,
        height: BASTION_SIZE,
        ownerId: id,
        maxHealth: BASTION_HP,
        speed: 0,
        direction: Direction.Down,
        isEnemy: true,
        variant: BASTION,
        isBoss: true,
      }),
    );
  }

  /** Spawns the Level 18 Hydra at its largest tier, centre-north. */
  private spawnHydra(): void {
    const tier = HYDRA_TIERS[0]!;
    const id = `boss-${this.enemySequence++}`;
    this.bossId = id;

    this.state.tanks.push(
      new Tank({
        x: centredSpawnX(tier.size),
        y: 5 * TILE_SIZE,
        width: tier.size,
        height: tier.size,
        ownerId: id,
        maxHealth: tier.health,
        speed: tier.speed,
        direction: Direction.Down,
        isEnemy: true,
        variant: HYDRA,
        isBoss: true,
      }),
    );
  }

  /**
   * Splits a felled Hydra into the next tier down.
   *
   * Children keep `isBoss`, so the level's win check — which asks whether any
   * boss body is still standing — only resolves once the last fragment is gone.
   * The smallest tier has no successor and simply dies.
   */
  private splitHydra(parent: Tank): void {
    const tierIndex = HYDRA_TIERS.findIndex((tier) => tier.size === parent.width);
    const next = tierIndex >= 0 ? HYDRA_TIERS[tierIndex + 1] : undefined;
    if (!next) return;

    const cx = parent.x + parent.width / 2;
    const cy = parent.y + parent.height / 2;

    for (let i = 0; i < HYDRA_SPLIT_COUNT; i++) {
      // Fan the children out to either side so they do not spawn stacked.
      const offset = (i - (HYDRA_SPLIT_COUNT - 1) / 2) * HYDRA_SPLIT_SPREAD * 2;
      let x = cx + offset - next.size / 2;
      let y = cy - next.size / 2;

      // Keep them on the field and out of walls; fall back to the parent's
      // centre when the offset would have put a child somewhere illegal.
      x = Math.max(0, Math.min(WORLD_WIDTH - next.size, x));
      y = Math.max(0, Math.min(WORLD_HEIGHT - next.size, y));
      if (isBlocked(this.state, x, y, next.size, next.size)) {
        x = Math.max(0, Math.min(WORLD_WIDTH - next.size, cx - next.size / 2));
        y = Math.max(0, Math.min(WORLD_HEIGHT - next.size, cy - next.size / 2));
      }

      const id = `boss-${this.enemySequence++}`;
      this.state.tanks.push(
        new Tank({
          x,
          y,
          width: next.size,
          height: next.size,
          ownerId: id,
          maxHealth: next.health,
          speed: next.speed,
          direction: parent.direction,
          isEnemy: true,
          variant: HYDRA,
          isBoss: true,
        }),
      );

      // Keep the bossId slot pointing at something alive, for the HP readout.
      if (i === 0) this.bossId = id;
    }
  }

  /** Spawns the Level 20 Architect dead centre, surrounded by its pylons. */
  private spawnArchitect(): void {
    const id = `boss-${this.enemySequence++}`;
    this.bossId = id;
    this.architectRingMs = 0;
    this.architectRings = 0;
    this.architectLobMs = 0;
    this.architectWarned = false;

    this.state.tanks.push(
      new Tank({
        x: centredSpawnX(ARCHITECT_SIZE),
        y: centredSpawnY(ARCHITECT_SIZE),
        width: ARCHITECT_SIZE,
        height: ARCHITECT_SIZE,
        ownerId: id,
        maxHealth: ARCHITECT_HP,
        speed: 0,
        direction: Direction.Down,
        isEnemy: true,
        variant: ARCHITECT,
        isBoss: true,
      }),
    );
  }

  private spawnWarden(): void {
    const id = `boss-${this.enemySequence++}`;
    this.bossId = id;

    this.state.tanks.push(
      new Tank({
        x: centredSpawnX(WARDEN_SIZE),
        y: 2 * TILE_SIZE,
        width: WARDEN_SIZE,
        height: WARDEN_SIZE,
        ownerId: id,
        maxHealth: WARDEN_HP,
        speed: 0,
        direction: Direction.Down,
        isEnemy: true,
        variant: WARDEN,
        isBoss: true,
      }),
    );
  }

  /**
   * Spawns the Level 20 Logic Core at top centre.
   *
   * The final boss: a massive stationary unit that fires radial bullet waves
   * via {@link fireCoreWave} and never moves. It uses the bossId slot so the
   * `assassinate_boss` win condition resolves when it dies.
   */
  private spawnCore(): void {
    const id = `boss-${this.enemySequence++}`;
    this.bossId = id;

    this.state.tanks.push(
      new Tank({
        x: 30 * TILE_SIZE - CORE_SIZE / 2,
        y: 10 * TILE_SIZE - CORE_SIZE / 2,
        width: CORE_SIZE,
        height: CORE_SIZE,
        ownerId: id,
        maxHealth: CORE_HP,
        speed: 0,
        direction: Direction.Down,
        isEnemy: true,
        variant: CORE,
        isBoss: true,
      }),
    );
  }

  /**
   * Finds a safe spawn position starting from the default and spiralling outward.
   * Avoids tiles occupied by enemies, mines, bricks, and steel.
   */
  private getSafeSpawnPosition(startX: number, startY: number): { x: number; y: number } {
    const startGx = Math.floor(startX / TILE_SIZE);
    const startGy = Math.floor(startY / TILE_SIZE);

    const isSafe = (gx: number, gy: number): boolean => {
      if (!isInsideGrid(gx, gy)) return false;
      const tile = this.state.grid.at(tileIndex(gx, gy));
      if (tile === TileType.Brick || tile === TileType.Steel || tile === TileType.Mine) return false;
      const px = gx * TILE_SIZE;
      const py = gy * TILE_SIZE;
      if (isBlocked(this.state, px, py, TANK_SIZE, TANK_SIZE)) return false;
      for (let i = 0; i < this.state.tanks.length; i++) {
        const tank = this.state.tanks.at(i);
        if (!tank.isEnemy) continue;
        if (boxesOverlap(px, py, TANK_SIZE, TANK_SIZE, tank.x, tank.y, tank.width, tank.height)) return false;
      }
      return true;
    };

    if (isSafe(startGx, startGy)) return { x: startX, y: startY };

    for (let radius = 1; radius <= 10; radius++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
          const gx = startGx + dx;
          const gy = startGy + dy;
          if (isSafe(gx, gy)) return { x: gx * TILE_SIZE, y: gy * TILE_SIZE };
        }
      }
    }

    return { x: startX, y: startY };
  }

  /** Puts the player's tank on its spawn pad, invulnerable for a moment. */
  private spawnPlayer(): boolean {
    if (!this.playerId) return false;

    // On the escort level the carrier takes the centre pad, so the player spawns
    // beside it rather than on top of it.
    const spawnCol =
      this.currentWinCondition() === CampaignWinCondition.Escort ? PLAYER_SPAWN.x + 4 : PLAYER_SPAWN.x;
    const defaultX = spawnCol * TILE_SIZE;
    const defaultY = PLAYER_SPAWN.y * TILE_SIZE;

    const { x, y } = this.getSafeSpawnPosition(defaultX, defaultY);

    if (isBlocked(this.state, x, y, TANK_SIZE, TANK_SIZE)) return false;

    const speed = this.state.currentLevel > 5 ? TANK_SPEED * 1.15 : TANK_SPEED;

    this.state.tanks.push(
      new Tank({
        x,
        y,
        width: TANK_SIZE,
        height: TANK_SIZE,
        ownerId: this.playerId,
        maxHealth: TANK_MAX_HEALTH,
        speed,
        direction: Direction.Up,
        isEnemy: false,
        isInvulnerable: true,
      }),
    );

    const invulnMs = this.state.currentLevel > 15
      ? PLAYER_INVULNERABILITY_MS * 2
      : PLAYER_INVULNERABILITY_MS;
    this.invulnerableUntilMs.set(this.playerId, this.elapsedMs + invulnMs);
    const player = this.state.players.get(this.playerId);
    if (player) player.respawnInSeconds = 0;
    return true;
  }

  // ---------------------------------------------------------------- simulation

  /** One simulation step. Nothing ticks outside the `playing` phase. */
  private update(deltaMs: number): void {
    if (this.state.phase !== CampaignPhase.Playing) return;

    this.tick++;
    this.elapsedMs += deltaMs;

    this.releaseEnemies();
    this.respawnPlayer();
    this.expireInvulnerability();
    this.moveTanks();
    this.refreshHunterField();

    // A disguised Mimic springs when the player closes in or once it is shot.
    this.revealMimics();
    this.tickMimicLunge(deltaMs);
    this.tickShield(deltaMs);
    this.tickTeleport(deltaMs);
    this.tickBlast(deltaMs);
    this.tickDecoy(deltaMs);
    this.tickRam(deltaMs);
    if (this.state.phase !== CampaignPhase.Playing) return;

    // Lurchers reel the player in; the Effigy plays the player's own kit back.
    this.tickLurchers(deltaMs);
    this.updateEffigy(deltaMs);
    if (this.state.phase !== CampaignPhase.Playing) return;

    // Snapshot the flow-field movers before steering, so a deadlock (an enemy
    // that wanted to move but was wedged against other hulls) can be detected
    // and nudged loose afterwards.
    const moverPositions = new Map<string, { x: number; y: number }>();
    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      if (this.usesHunterField(tank)) moverPositions.set(tank.ownerId, { x: tank.x, y: tank.y });
    }

    updateEnemies(this.state, {
      // Bosses, Trappers and Jammers ignore flow-field steering (bosses move on
      // their own; Trappers and Jammers wander). Everyone else — Aegis units and
      // Mimics (disguised ones creep, revealed ones hunt) included — routes
      // toward the player.
      fieldFor: (tank) => {
        if (!this.usesHunterField(tank) || !this.hunterField.isPopulated) return null;
        return this.hunterField;
      },
      // Rushers, every boss, Trappers, Jammers and disguised Mimics never fire.
      canShoot: (tank) =>
        tank.variant !== KAMIKAZE &&
        tank.variant !== SWEEPER &&
        tank.variant !== ARTILLERY &&
        tank.variant !== JUGGERNAUT &&
        tank.variant !== CORE &&
        tank.variant !== WARDEN &&
        tank.variant !== TRAPPER &&
        tank.variant !== JAMMER &&
        tank.variant !== SAPPER &&
        // The Bastion shells on its own cadence; the Architect never fires;
        // the Effigy runs its own fire control alongside its borrowed kit.
        tank.variant !== BASTION &&
        tank.variant !== ARCHITECT &&
        tank.variant !== EFFIGY &&
        !(tank.variant === MIMIC && tank.isDisguised) &&
        this.readyToShoot(tank, ENEMY_PROFILE.cooldownMs),
      shoot: (tank) => {
        this.fire(tank);
        if (tank.variant === GHOST && tank.isCloaked) {
          tank.isCloaked = false;
          this.ghostUncloakTimers.set(tank.ownerId, GHOST_UNCLOAK_MS);
        }
      },
    });

    // Free any enemy that steered into a traffic-jam deadlock this tick.
    this.jitterStuckMovers(moverPositions);

    // Anti-stuck: detect enemies that haven't moved and force them in a random
    // direction to break out of clusters.
    this.tickAntiStuck(deltaMs);

    // Ghost re-cloak: count down every exposed Ghost's timer.
    this.tickGhostCloaks(deltaMs);

    // Constructors wall off the ground behind them as they roll.
    this.layTrenches();

    // Trappers and Jammers wander erratically; Trappers also seed mines.
    this.moveWanderers(deltaMs);

    // Sappers hold their standoff band and shell the player over the walls.
    this.moveSappers();
    this.tickSapperLobs(deltaMs);
    if (this.state.phase !== CampaignPhase.Playing) return;

    // The boss barrels around under its own momentum, crushing cover.
    this.moveSweeper(deltaMs);

    // The Juggernaut homes straight at the player, ploughing through the maze.
    this.moveJuggernaut(deltaMs);

    // The artillery boss skulks away from the player, hiding behind cover.
    this.moveArtillery(deltaMs);

    // The Warden homes toward the player and drops carpet mines.
    this.moveWarden(deltaMs);

    // The escort carrier climbs north on its own, halting at any wall.
    this.moveConvoy(deltaMs);

    // The artillery boss telegraphs and lands mortar strikes.
    this.updateArtillery(deltaMs);

    // The Bastion swings its plating toward the player and shells straight ahead.
    this.moveBastion(deltaMs);

    // The Architect walls the arena in while its pylons still stand.
    this.tickArchitect(deltaMs);
    if (this.state.phase !== CampaignPhase.Playing) return;

    // The Logic Core fires and moves through its phases.
    this.updateCore(deltaMs);
    this.moveCore(deltaMs);

    // A kamikaze reaching the player, the boss running it over, a mine, or a
    // mortar landing on the player is lethal.
    this.resolveKamikaze();
    this.resolveSweeperContact();
    this.resolveMines();
    this.expireMines();
    // Enemy hulls in contact chip the carrier down; a destroyed carrier fails.
    if (this.resolveConvoyContact(deltaMs)) return;
    if (this.state.phase !== CampaignPhase.Playing) return;

    const outcome = updateBullets(this.state, {
      // Everything that turns a shell aside without taking damage: the player's
      // deflector, an Aegis aura, the Bastion's frontal plating, and the
      // Architect while its pylons still stand.
      shieldsTarget: (target, bullet) =>
        this.isShieldUp(target) ||
        this.ramDeflects(target, bullet) ||
        this.isAegisShielded(target) ||
        this.isBastionArmoured(target, bullet) ||
        this.isArchitectSealed(target) ||
        this.isEffigyShielded(target),
    });

    // A destroyed wall/structure opens new routes — re-path the hunters.
    if (
      outcome.bricksDestroyed +
        outcome.steelDestroyed +
        outcome.radarsDestroyed +
        outcome.factoriesDestroyed >
      0
    ) {
      this.hunterField.rebuildToward(this.state.grid, this.playerTargets());
    }

    for (const spark of outcome.steelHits) {
      this.broadcast(ServerMessage.SteelHit, { x: spark.x, y: spark.y } satisfies SteelHitMessage);
    }

    let convoyShotDown = false;
    for (const { tank } of outcome.destroyedTanks) {
      if (tank.variant === CONVOY) {
        // An enemy shell finished the carrier — announce the wreck, fail below.
        convoyShotDown = true;
        this.broadcast(ServerMessage.TankDestroyed, {
          x: tank.x + tank.width / 2,
          y: tank.y + tank.height / 2,
          isEnemy: false,
          heavy: false,
        } satisfies TankDestroyedMessage);
      } else {
        this.onTankDestroyed(tank);
      }
    }
    if (convoyShotDown) {
      this.loseConvoy();
      return;
    }

    // A player death this tick may have ended the run — stop here if so.
    if (this.state.phase !== CampaignPhase.Playing) return;

    // Zone control accrues only while the player holds the uplink zone.
    if (this.currentWinCondition() === CampaignWinCondition.ZoneControl && this.playerInZone()) {
      this.zoneProgressMs += deltaMs;
    }

    // Bomb defusal: run down the timer, defuse on contact, and detonate at zero.
    if (this.currentWinCondition() === CampaignWinCondition.DefuseBombs) {
      this.bombTimerMs -= deltaMs;
      this.defuseBombsUnderPlayer();
      if (this.bombTimerMs <= 0) {
        this.detonateBombs();
        // A game over ends the tick; a survivable blast reset the level below.
        if (this.state.phase !== CampaignPhase.Playing) return;
      }
    }

    // Intel retrieval: collect any package the player is standing on.
    if (this.currentWinCondition() === CampaignWinCondition.RetrieveIntel) {
      this.collectIntelUnderPlayer();
    }

    this.refreshObjective();
    if (this.checkWin(outcome)) return;

    // The boss and the escort carrier both hold free-floating positions the
    // grid-snapping separation pass would jerk around, so skip it whenever
    // either is on the field — including the Level 14 Juggernaut, which is a
    // boss on a non-assassinate (defuse) level.
    const win = this.currentWinCondition();
    if (
      win !== CampaignWinCondition.AssassinateBoss &&
      win !== CampaignWinCondition.Escort &&
      !this.hasBoss()
    ) {
      separateTanks(this.state, false); // no anti-camp fence in the campaign
    }
  }

  // ------------------------------------------------------------------ objectives

  /** The win condition of the level currently being played. */
  private currentWinCondition(): string | undefined {
    return CAMPAIGN_LEVELS[this.state.currentLevel - 1]?.winCondition;
  }

  /** Recomputes the replicated objective label and value for the HUD. */
  private refreshObjective(): void {
    switch (this.currentWinCondition()) {
      case CampaignWinCondition.DestroyRadars: {
        const remaining = this.countRadar();
        this.setObjective(`RADARS LEFT: ${remaining}`, remaining);
        break;
      }
      case CampaignWinCondition.ReachExtraction:
        this.setObjective("REACH EXTRACTION POINT", 0);
        break;
      case CampaignWinCondition.SurviveTime: {
        const seconds = this.secondsToSurvive();
        this.setObjective(`SURVIVE: ${seconds}s`, seconds);
        break;
      }
      case CampaignWinCondition.ZoneControl: {
        const seconds = this.secondsToHoldZone();
        this.setObjective(`HOLD ZONE: ${seconds}s`, seconds);
        break;
      }
      case CampaignWinCondition.AssassinateBoss: {
        const hp = this.bossHealth();
        // While the Architect is sealed its HP bar is meaningless — the pylons
        // are the actual objective, so the readout names them instead.
        if (this.state.currentLevel === ARCHITECT_LEVEL) {
          const pylons = this.architectPylons();
          if (pylons > 0) {
            this.setObjective(`PYLONS LEFT: ${pylons}`, pylons);
            break;
          }
        }
        this.setObjective(`BOSS HP: ${hp}`, hp);
        break;
      }
      case CampaignWinCondition.DestroyFactories: {
        const remaining = this.countFactory();
        this.setObjective(`FACTORIES LEFT: ${remaining}`, remaining);
        break;
      }
      case CampaignWinCondition.DefuseBombs: {
        const bombs = this.countBomb();
        const seconds = Math.max(0, Math.ceil(this.bombTimerMs / 1000));
        this.setObjective(`BOMBS LEFT: ${bombs} - TIME: ${seconds}s`, seconds);
        break;
      }
      case CampaignWinCondition.RetrieveIntel: {
        const remaining = this.countIntel();
        this.setObjective(`INTEL LEFT: ${remaining}`, remaining);
        break;
      }
      case CampaignWinCondition.Escort:
        this.setObjective("ESCORT THE CARRIER NORTH", 0);
        break;
    }
  }

  /** The boss's remaining hit points, or 0 once it is gone. */
  private bossHealth(): number {
    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      if (tank.isBoss) return tank.currentHealth;
    }
    return 0;
  }

  /** Tests the level's win condition; wins and returns true when it is met. */
  private checkWin(outcome: { radarsDestroyed: number; factoriesDestroyed: number }): boolean {
    switch (this.currentWinCondition()) {
      case CampaignWinCondition.DestroyRadars:
        if (outcome.radarsDestroyed > 0 && !this.gridHasRadar()) return this.winLevel();
        break;
      case CampaignWinCondition.DestroyFactories:
        if (outcome.factoriesDestroyed > 0 && this.countFactory() === 0) return this.winLevel();
        break;
      case CampaignWinCondition.DefuseBombs:
        // Bombs are defused by touch in the update loop; win once none remain.
        if (!this.gridHasBomb()) return this.winLevel();
        break;
      case CampaignWinCondition.RetrieveIntel:
        // Intel is collected by touch in the update loop; win once none remain.
        if (!this.gridHasIntel()) return this.winLevel();
        break;
      case CampaignWinCondition.Escort:
        // The carrier drives itself north; win once it reaches the pad.
        if (this.convoyOnExtraction()) return this.winLevel();
        break;
      case CampaignWinCondition.ReachExtraction:
        if (this.playerOnExtraction()) return this.winLevel();
        break;
      case CampaignWinCondition.SurviveTime:
        if (this.elapsedMs >= this.surviveMs()) return this.winLevel();
        break;
      case CampaignWinCondition.ZoneControl:
        if (this.zoneProgressMs >= ZONE_MS) return this.winLevel();
        break;
      case CampaignWinCondition.AssassinateBoss:
        // The boss spawns at level start, so "no boss left" only becomes true
        // once the player's shells have finally brought it down.
        if (!this.hasBoss()) return this.winLevel();
        break;
    }
    return false;
  }

  /** How long the current survival level lasts, in ms (Level 3 runs longer). */
  private surviveMs(): number {
    return surviveSecondsForLevel(this.state.currentLevel) * 1000;
  }

  /** Whole seconds left on the survival timer, floored at zero. */
  private secondsToSurvive(): number {
    return Math.max(0, Math.ceil((this.surviveMs() - this.elapsedMs) / 1000));
  }

  /** Whole seconds of uplink hold still needed, floored at zero. */
  private secondsToHoldZone(): number {
    return Math.max(0, Math.ceil((ZONE_MS - this.zoneProgressMs) / 1000));
  }

  /** True when the player's hull overlaps any extraction pad tile. */
  private playerOnExtraction(): boolean {
    return this.playerOverlapsTile(TileType.ExtractionZone);
  }

  /** True when the player's hull overlaps any uplink zone tile. */
  private playerInZone(): boolean {
    return this.playerOverlapsTile(TileType.UplinkZone);
  }

  /** True when the player's hull overlaps any tile of the given type. */
  private playerOverlapsTile(tileType: TileType): boolean {
    const tank = this.playerId ? this.findTank(this.playerId) : undefined;
    if (!tank) return false;

    const minTX = Math.floor(tank.x / TILE_SIZE);
    const maxTX = Math.floor((tank.x + tank.width - 1) / TILE_SIZE);
    const minTY = Math.floor(tank.y / TILE_SIZE);
    const maxTY = Math.floor((tank.y + tank.height - 1) / TILE_SIZE);

    for (let ty = minTY; ty <= maxTY; ty++) {
      for (let tx = minTX; tx <= maxTX; tx++) {
        if (!isInsideGrid(tx, ty)) continue;
        if (this.state.grid.at(tileIndex(tx, ty)) === tileType) return true;
      }
    }
    return false;
  }

  private countRadar(): number {
    let count = 0;
    for (let i = 0; i < GRID_LENGTH; i++) {
      if (this.state.grid.at(i) === TileType.Radar) count++;
    }
    return count;
  }

  private countFactory(): number {
    let count = 0;
    for (let i = 0; i < GRID_LENGTH; i++) {
      if (this.state.grid.at(i) === TileType.Factory) count++;
    }
    return count;
  }

  private countBomb(): number {
    let count = 0;
    for (let i = 0; i < GRID_LENGTH; i++) {
      if (this.state.grid.at(i) === TileType.Bomb) count++;
    }
    return count;
  }

  private gridHasBomb(): boolean {
    for (let i = 0; i < GRID_LENGTH; i++) {
      if (this.state.grid.at(i) === TileType.Bomb) return true;
    }
    return false;
  }

  /** Defuses (clears) any bomb tile the player's hull is currently touching. */
  private defuseBombsUnderPlayer(): void {
    const tank = this.playerId ? this.findTank(this.playerId) : undefined;
    if (!tank) return;

    const minTX = Math.floor(tank.x / TILE_SIZE);
    const maxTX = Math.floor((tank.x + tank.width - 1) / TILE_SIZE);
    const minTY = Math.floor(tank.y / TILE_SIZE);
    const maxTY = Math.floor((tank.y + tank.height - 1) / TILE_SIZE);

    for (let ty = minTY; ty <= maxTY; ty++) {
      for (let tx = minTX; tx <= maxTX; tx++) {
        if (!isInsideGrid(tx, ty)) continue;
        const index = tileIndex(tx, ty);
        if (this.state.grid.at(index) === TileType.Bomb) this.state.grid[index] = TileType.Empty;
      }
    }
  }

  /**
   * The bomb timer hit zero — the blast costs a life. With lives to spare the
   * level is rebuilt (bombs and timer restored, enemies cleared, player
   * respawned); otherwise it is game over.
   */
  private detonateBombs(): void {
    this.state.lives = Math.max(0, this.state.lives - 1);
    const player = this.playerId ? this.state.players.get(this.playerId) : undefined;
    if (player) player.lives = this.state.lives;

    if (this.state.lives <= 0) {
      this.state.phase = CampaignPhase.GameOver;
      console.log(`[room ${this.roomId}] bombs detonated — game over`);
      return;
    }

    console.log(`[room ${this.roomId}] bombs detonated — ${this.state.lives} lives left, retrying`);
    this.beginLevel(); // restores the bombs and timer, clears enemies, respawns
  }

  // ------------------------------------------------------------------- intel

  private countIntel(): number {
    let count = 0;
    for (let i = 0; i < GRID_LENGTH; i++) {
      if (this.state.grid.at(i) === TileType.Intel) count++;
    }
    return count;
  }

  private gridHasIntel(): boolean {
    for (let i = 0; i < GRID_LENGTH; i++) {
      if (this.state.grid.at(i) === TileType.Intel) return true;
    }
    return false;
  }

  /** Collects (clears) any intel tile the player's hull is currently touching. */
  private collectIntelUnderPlayer(): void {
    const tank = this.playerId ? this.findTank(this.playerId) : undefined;
    if (!tank) return;

    const minTX = Math.floor(tank.x / TILE_SIZE);
    const maxTX = Math.floor((tank.x + tank.width - 1) / TILE_SIZE);
    const minTY = Math.floor(tank.y / TILE_SIZE);
    const maxTY = Math.floor((tank.y + tank.height - 1) / TILE_SIZE);

    for (let ty = minTY; ty <= maxTY; ty++) {
      for (let tx = minTX; tx <= maxTX; tx++) {
        if (!isInsideGrid(tx, ty)) continue;
        const index = tileIndex(tx, ty);
        if (this.state.grid.at(index) === TileType.Intel) this.state.grid[index] = TileType.Empty;
      }
    }
  }

  // ------------------------------------------------------------- trappers & mines

  /**
   * Wanders every Trapper and drops mines on a timer.
   *
   * Trappers steer themselves — a random new heading now and then, and always
   * when they hit something — rather than homing on the player, and seed a mine
   * on the empty ground beneath them every few seconds.
   */
  private moveWanderers(deltaMs: number): void {
    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      // Jammers hold station: they are emplaced suppression, not a chase. A
      // wandering one drifted out of relevance and was rarely worth hunting.
      if (tank.variant !== TRAPPER) continue;

      this.wanderStep(tank);
      this.layMine(tank, deltaMs);
    }
  }

  /** One erratic step: turn randomly now and then, and always when blocked. */
  private wanderStep(tank: Tank): void {
    const aligned = tank.x % TILE_SIZE === 0 && tank.y % TILE_SIZE === 0;
    if (aligned && Math.random() < TRAPPER_TURN_CHANCE) {
      tank.direction = this.randomPassableDir(tank) ?? tank.direction;
    }

    // fenceTop=false: the campaign has no top-row fence.
    const moved = moveTank(this.state, tank, false);
    if (moved) return;

    // Blocked. Re-roll regardless of grid alignment: the separation pass can
    // shove a tank off the tile grid, and an off-grid tank that only turned
    // when aligned would stay frozen against the wall forever — it can never
    // move to re-align. Pick from passable neighbours so it cannot re-roll
    // straight back into the wall it is already pinned against.
    tank.direction = this.randomPassableDir(tank, tank.direction) ?? tank.direction;

    // Re-snap to the grid so ordinary tile-aligned steering can resume.
    if (!aligned) {
      const snapX = Math.round(tank.x / TILE_SIZE) * TILE_SIZE;
      const snapY = Math.round(tank.y / TILE_SIZE) * TILE_SIZE;
      if (!isBlocked(this.state, snapX, snapY, tank.width, tank.height)) {
        tank.x = snapX;
        tank.y = snapY;
      }
    }
  }

  // ----------------------------------------------------------------- lurchers

  /**
   * Runs every Lurcher's grapple.
   *
   * A grapple needs a clear straight line — it is stopped by anything a shell
   * would be stopped by — so cover genuinely protects the player, and the
   * counter-play is to break the line rather than to out-range it.
   */
  private tickLurchers(deltaMs: number): void {
    if (this.blinkLockMs > 0) this.blinkLockMs = Math.max(0, this.blinkLockMs - deltaMs);

    const player = this.playerId ? this.findTank(this.playerId) : undefined;
    if (!player) return;

    const px = player.x + player.width / 2;
    const py = player.y + player.height / 2;
    const range = LURCHER_RANGE_TILES * TILE_SIZE;

    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      if (tank.variant !== LURCHER) continue;

      const timer = (this.lurcherTimers.get(tank.ownerId) ?? Math.random() * LURCHER_INTERVAL_MS) + deltaMs;
      if (timer < LURCHER_INTERVAL_MS) {
        this.lurcherTimers.set(tank.ownerId, timer);
        continue;
      }

      const cx = tank.x + tank.width / 2;
      const cy = tank.y + tank.height / 2;
      const dx = px - cx;
      const dy = py - cy;
      const dist = Math.hypot(dx, dy);
      if (dist > range || dist < 1) continue;

      // Only fires along a clear line; walls and steel eat the grapple.
      if (!this.hasClearLine(cx, cy, px, py)) continue;

      this.lurcherTimers.set(tank.ownerId, 0);

      // Drag the player toward the Lurcher, stopping at anything solid so the
      // yank can never pull them into a wall.
      const ux = dx / dist;
      const uy = dy / dist;
      let toX = player.x;
      let toY = player.y;

      const stepPx = TILE_SIZE / 2;
      const total = LURCHER_PULL_TILES * TILE_SIZE;
      for (let travelled = stepPx; travelled <= total; travelled += stepPx) {
        const candX = player.x - ux * travelled;
        const candY = player.y - uy * travelled;
        if (isBlocked(this.state, candX, candY, player.width, player.height)) break;
        toX = candX;
        toY = candY;
      }

      player.x = toX;
      player.y = toY;
      this.blinkLockMs = LURCHER_LOCK_MS;

      this.broadcast(ServerMessage.GrappleHit, {
        fromX: cx,
        fromY: cy,
        toX: toX + player.width / 2,
        toY: toY + player.height / 2,
      } satisfies GrappleHitMessage);
    }
  }

  /**
   * Whether a straight line between two world points is unobstructed.
   *
   * Sampled at quarter-tile steps, matching the enemy sight raycast, so a
   * 32px wall can never be stepped over.
   */
  private hasClearLine(x0: number, y0: number, x1: number, y1: number): boolean {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return true;

    const stepPx = TILE_SIZE / 4;
    for (let travelled = stepPx; travelled < dist; travelled += stepPx) {
      const x = x0 + (dx / dist) * travelled;
      const y = y0 + (dy / dist) * travelled;
      const tx = Math.floor(x / TILE_SIZE);
      const ty = Math.floor(y / TILE_SIZE);
      if (!isInsideGrid(tx, ty)) return false;

      const tile = this.state.grid.at(tileIndex(tx, ty));
      if (tile === TileType.Brick || tile === TileType.Steel || tile === TileType.EagleBase) {
        return false;
      }
    }

    return true;
  }

  // ------------------------------------------------------------------- effigy

  /** Spawns the Effigy: player-sized, player-speed, carrying the player's kit. */
  private spawnEffigy(): void {
    const id = `boss-${this.enemySequence++}`;
    this.bossId = id;
    this.effigyShieldMs = 0;
    this.effigyShieldCdMs = 0;
    this.effigyBlinkCdMs = 0;
    this.effigyBlastCdMs = 0;
    this.effigyShootMs = 0;

    this.state.tanks.push(
      new Tank({
        x: centredSpawnX(TANK_SIZE),
        y: 4 * TILE_SIZE,
        width: TANK_SIZE,
        height: TANK_SIZE,
        ownerId: id,
        maxHealth: EFFIGY_HP,
        speed: TANK_SPEED,
        direction: Direction.Down,
        isEnemy: true,
        variant: EFFIGY,
        isBoss: true,
      }),
    );
  }

  /**
   * Runs the Effigy's borrowed kit: shield, blink and blast, on their own
   * cooldowns, used the way a competent player would use them.
   *
   * It shields when hurt, blinks away when the player crowds it, and blasts
   * when they crowd it anyway. Movement is the ordinary hunter field, because
   * the point of the fight is the abilities, not exotic pathing.
   */
  private updateEffigy(deltaMs: number): void {
    if (!this.bossId) return;
    const boss = this.findTank(this.bossId);
    if (!boss || boss.variant !== EFFIGY) return;

    const player = this.playerId ? this.findTank(this.playerId) : undefined;

    // Its shield runs on the same shape of timer the player's does.
    if (this.effigyShieldMs > 0) {
      this.effigyShieldMs = Math.max(0, this.effigyShieldMs - deltaMs);
      if (this.effigyShieldMs === 0) {
        boss.isShielded = false;
        this.effigyShieldCdMs = EFFIGY_SHIELD_COOLDOWN_MS;
      }
    } else if (this.effigyShieldCdMs > 0) {
      this.effigyShieldCdMs = Math.max(0, this.effigyShieldCdMs - deltaMs);
    }

    if (this.effigyBlinkCdMs > 0) this.effigyBlinkCdMs = Math.max(0, this.effigyBlinkCdMs - deltaMs);
    if (this.effigyBlastCdMs > 0) this.effigyBlastCdMs = Math.max(0, this.effigyBlastCdMs - deltaMs);

    if (!player) return;

    const dx = player.x + player.width / 2 - (boss.x + boss.width / 2);
    const dy = player.y + player.height / 2 - (boss.y + boss.height / 2);
    const dist = Math.hypot(dx, dy);

    // Shields once it has actually been hurt — not on sight.
    if (
      this.effigyShieldMs === 0 &&
      this.effigyShieldCdMs === 0 &&
      boss.currentHealth < boss.maxHealth
    ) {
      this.effigyShieldMs = EFFIGY_SHIELD_MS;
      boss.isShielded = true;
    }

    // Blasts when the player is inside knife range.
    if (this.effigyBlastCdMs === 0 && dist <= EFFIGY_BLAST_TRIGGER_TILES * TILE_SIZE) {
      this.effigyBlastCdMs = EFFIGY_BLAST_COOLDOWN_MS;
      this.effigyBlast(boss);
      return;
    }

    // Blinks away when crowded, to reopen the range it wants to shoot from.
    if (this.effigyBlinkCdMs === 0 && dist <= EFFIGY_BLAST_TRIGGER_TILES * TILE_SIZE * 1.6) {
      this.effigyBlinkCdMs = EFFIGY_BLINK_COOLDOWN_MS;
      this.effigyBlink(boss, dx, dy);
    }

    // And shoots, briskly, the rest of the time.
    this.effigyShootMs += deltaMs;
    if (this.effigyShootMs >= EFFIGY_SHOOT_INTERVAL_MS) {
      this.effigyShootMs -= EFFIGY_SHOOT_INTERVAL_MS;
      if (this.hasClearLine(
        boss.x + boss.width / 2,
        boss.y + boss.height / 2,
        player.x + player.width / 2,
        player.y + player.height / 2,
      )) {
        this.fire(boss);
      }
    }
  }

  /** The Effigy's blink: straight away from the player, traced like the player's. */
  private effigyBlink(boss: Tank, dx: number, dy: number): void {
    // Away from the player, along whichever axis opens the most distance.
    const away =
      Math.abs(dx) >= Math.abs(dy)
        ? dx >= 0
          ? Direction.Left
          : Direction.Right
        : dy >= 0
          ? Direction.Up
          : Direction.Down;

    const heading = DIRECTION_VECTORS[away];
    let destX = boss.x;
    let destY = boss.y;

    for (let step = 1; step <= EFFIGY_BLINK_TILES; step++) {
      const candX = boss.x + heading.x * TILE_SIZE * step;
      const candY = boss.y + heading.y * TILE_SIZE * step;
      if (isBlocked(this.state, candX, candY, boss.width, boss.height)) break;
      if (collidesWithTank(this.state, boss, candX, candY)) break;
      destX = candX;
      destY = candY;
    }

    if (destX === boss.x && destY === boss.y) return;

    const fromX = boss.x;
    const fromY = boss.y;
    boss.x = destX;
    boss.y = destY;
    boss.direction = away;

    // Reuses the player's own blink effect, which is exactly the point.
    this.broadcast(ServerMessage.TeleportChanged, {
      charges: 0,
      rechargeMs: 0,
      fromX,
      fromY,
      toX: destX,
      toY: destY,
    } satisfies TeleportChangedMessage);
  }

  /** The Effigy's blast: the player's own, pointed the other way. */
  private effigyBlast(boss: Tank): void {
    const cx = boss.x + boss.width / 2;
    const cy = boss.y + boss.height / 2;
    const radius = EFFIGY_BLAST_RADIUS_TILES * TILE_SIZE;

    this.broadcast(ServerMessage.BlastChanged, {
      cooldownMs: 0,
      x: cx,
      y: cy,
      radius,
    } satisfies BlastChangedMessage);

    const player = this.playerId ? this.findTank(this.playerId) : undefined;
    if (!player || player.isInvulnerable || this.isShieldUp(player)) return;

    const dx = player.x + player.width / 2 - cx;
    const dy = player.y + player.height / 2 - cy;
    if (Math.hypot(dx, dy) > radius) return;

    player.currentHealth = Math.max(0, player.currentHealth - 1);
    if (player.currentHealth === 0) this.killPlayer();
  }

  // ------------------------------------------------------------------ sappers

  /**
   * Whether a tank could step one tile in `dir` without meeting solid ground.
   *
   * Terrain only — brick counts as passable because the unit can shoot through
   * it, matching how the flow field costs walls.
   */
  private canStep(tank: Tank, dir: Direction): boolean {
    const tx = Math.floor((tank.x + tank.width / 2) / TILE_SIZE);
    const ty = Math.floor((tank.y + tank.height / 2) / TILE_SIZE);
    const step = DIRECTION_VECTORS[dir];
    const nx = tx + step.x;
    const ny = ty + step.y;
    if (!isInsideGrid(nx, ny)) return false;
    const tile = this.state.grid.at(tileIndex(nx, ny));
    return tile === TileType.Empty || tile === TileType.Brick;
  }

  /**
   * The passable cardinal that best follows the vector `(dx, dy)`.
   *
   * Tries the dominant axis first, then the other, then gives up and picks any
   * passable direction — so a Sapper backed into a corner still shuffles free
   * instead of grinding against the wall.
   */
  private stepDirection(dx: number, dy: number, tank: Tank): Direction | null {
    const horizontal = dx >= 0 ? Direction.Right : Direction.Left;
    const vertical = dy >= 0 ? Direction.Down : Direction.Up;
    const order =
      Math.abs(dx) >= Math.abs(dy) ? [horizontal, vertical] : [vertical, horizontal];

    for (const dir of order) if (this.canStep(tank, dir)) return dir;
    return this.randomPassableDir(tank);
  }

  /**
   * Kites every Sapper: back off when crowded, close when the player drifts out
   * of range, and otherwise hold the standoff band and shuffle in place.
   *
   * Grid-aligned like every other mover — turns are only taken on tile
   * boundaries, which keeps the unit on the lattice the steering and anti-stuck
   * passes both depend on.
   */
  private moveSappers(): void {
    this.sapperHolding.clear();

    const player = this.playerId ? this.findTank(this.playerId) : undefined;
    if (!player) return;

    const px = player.x + player.width / 2;
    const py = player.y + player.height / 2;

    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      if (tank.variant !== SAPPER) continue;

      const dx = px - (tank.x + tank.width / 2);
      const dy = py - (tank.y + tank.height / 2);
      const dist = Math.hypot(dx, dy);

      const aligned = tank.x % TILE_SIZE === 0 && tank.y % TILE_SIZE === 0;
      if (aligned) {
        if (dist < SAPPER_STANDOFF_MIN) {
          // Too close — give ground, away from the player.
          const away = this.stepDirection(-dx, -dy, tank);
          if (away !== null) tank.direction = away;
        } else if (dist > SAPPER_STANDOFF_MAX) {
          // Out of range — walk it back into the band.
          const toward = this.stepDirection(dx, dy, tank);
          if (toward !== null) tank.direction = toward;
        } else if (Math.random() < SAPPER_STRAFE_CHANCE) {
          // In the band: drift a little so it is not a stationary target.
          const strafe = this.randomPassableDir(tank);
          if (strafe !== null) tank.direction = strafe;
        } else {
          // Holding station — stay put and keep shelling. Flagged so the
          // anti-stuck pass leaves it where it means to be.
          this.sapperHolding.add(tank.ownerId);
          continue;
        }
      }

      moveTank(this.state, tank, false);
    }
  }

  /**
   * Runs every Sapper's lob cadence and lands the shells already in the air.
   *
   * Shells in flight keep falling after their Sapper dies, so a telegraphed
   * strike always resolves — the same rule the artillery boss plays by.
   */
  private tickSapperLobs(deltaMs: number): void {
    const player = this.playerId ? this.findTank(this.playerId) : undefined;

    if (player) {
      for (let i = 0; i < this.state.tanks.length; i++) {
        const tank = this.state.tanks.at(i);
        if (tank.variant !== SAPPER) continue;

        // A fresh Sapper starts partway through its cycle, so a group that
        // spawned together does not fire in one synchronised salvo.
        const timer =
          (this.sapperLobTimers.get(tank.ownerId) ?? Math.random() * SAPPER_LOB_INTERVAL_MS) +
          deltaMs;

        if (timer < SAPPER_LOB_INTERVAL_MS) {
          this.sapperLobTimers.set(tank.ownerId, timer);
          continue;
        }

        this.sapperLobTimers.set(tank.ownerId, 0);
        this.launchSapperLob(tank, player);
      }
    }

    for (let i = this.sapperLobs.length - 1; i >= 0; i--) {
      const lob = this.sapperLobs[i]!;
      lob.timerMs -= deltaMs;
      if (lob.timerMs > 0) continue;

      this.sapperLobs.splice(i, 1);
      this.detonateSapperLob(lob.x, lob.y);
      if (this.state.phase !== CampaignPhase.Playing) return;
    }
  }

  /** Arcs one shell at the player's position, led slightly and scattered. */
  private launchSapperLob(tank: Tank, player: Tank): void {
    // Only lead a player who is actually moving; leading a stationary target
    // would just miss them every time.
    const intent = this.moveIntents.get(player.ownerId);
    const isMoving = intent !== undefined && this.tick < intent;
    const heading = DIRECTION_VECTORS[player.direction];
    const lead = isMoving
      ? player.speed * (1000 / TICK_MS) * (SAPPER_LOB_FLIGHT_MS / 1000) * 0.6
      : 0;

    const x =
      player.x + player.width / 2 + heading.x * lead + (Math.random() * 2 - 1) * SAPPER_LOB_SCATTER;
    const y =
      player.y + player.height / 2 + heading.y * lead + (Math.random() * 2 - 1) * SAPPER_LOB_SCATTER;

    this.sapperLobs.push({ x, y, timerMs: SAPPER_LOB_FLIGHT_MS });

    // Reuses the artillery telegraph, at a tighter radius so the two threats
    // stay visually distinct.
    this.broadcast(ServerMessage.MortarWarning, {
      x,
      y,
      delay: SAPPER_LOB_FLIGHT_MS,
      radius: SAPPER_LOB_RADIUS,
    } satisfies MortarWarningMessage);
  }

  /**
   * Lands a lobbed shell: chips the player and digs out the brick they were
   * hiding behind.
   *
   * Brick only — steel and the campaign objective tiles survive, so a Sapper can
   * strip cover but never demolish the level's own goals.
   */
  private detonateSapperLob(worldX: number, worldY: number): void {
    const cx = Math.floor(worldX / TILE_SIZE);
    const cy = Math.floor(worldY / TILE_SIZE);

    if (isInsideGrid(cx, cy)) {
      const index = tileIndex(cx, cy);
      if (this.state.grid.at(index) === TileType.Brick) this.state.grid[index] = TileType.Empty;
    }

    const player = this.playerId ? this.findTank(this.playerId) : undefined;
    if (!player || player.isInvulnerable || this.isShieldUp(player)) return;

    const bx = worldX - SAPPER_LOB_RADIUS;
    const by = worldY - SAPPER_LOB_RADIUS;
    const size = SAPPER_LOB_RADIUS * 2;

    if (boxesOverlap(bx, by, size, size, player.x, player.y, player.width, player.height)) {
      player.currentHealth = Math.max(0, player.currentHealth - SAPPER_LOB_DAMAGE);
      if (player.currentHealth === 0) this.killPlayer();
    }
  }

  /** Drops a mine on the empty cell beneath a Trapper every few seconds. */
  private layMine(tank: Tank, deltaMs: number): void {
    const timer = (this.trapperMineTimers.get(tank.ownerId) ?? 0) + deltaMs;
    if (timer < TRAPPER_MINE_INTERVAL_MS) {
      this.trapperMineTimers.set(tank.ownerId, timer);
      return;
    }

    this.trapperMineTimers.set(tank.ownerId, 0);
    const gx = Math.floor((tank.x + tank.width / 2) / TILE_SIZE);
    const gy = Math.floor((tank.y + tank.height / 2) / TILE_SIZE);
    if (isInsideGrid(gx, gy)) {
      const index = tileIndex(gx, gy);
      if (this.state.grid.at(index) === TileType.Empty) {
        this.state.grid[index] = TileType.Mine;
        this.activeMines.push({ x: gx, y: gy, expiresAtMs: this.elapsedMs + 20_000 });
      }
    }
  }

  /** Detonates a mine under the player: clears the tile and kills the player. */
  private resolveMines(): void {
    const tank = this.playerId ? this.findTank(this.playerId) : undefined;
    if (!tank || tank.isInvulnerable) return;

    // A raised shield does not make the player intangible — the mine still goes
    // off, it is still spent, and the blast is simply soaked. Skipping the whole
    // pass instead would leave live charges armed under the player's tracks, to
    // catch them the moment the shield lapsed.
    const absorbed = this.isShieldUp(tank);

    const minTX = Math.floor(tank.x / TILE_SIZE);
    const maxTX = Math.floor((tank.x + tank.width - 1) / TILE_SIZE);
    const minTY = Math.floor(tank.y / TILE_SIZE);
    const maxTY = Math.floor((tank.y + tank.height - 1) / TILE_SIZE);

    for (let ty = minTY; ty <= maxTY; ty++) {
      for (let tx = minTX; tx <= maxTX; tx++) {
        if (!isInsideGrid(tx, ty)) continue;
        const index = tileIndex(tx, ty);
        if (this.state.grid.at(index) !== TileType.Mine) continue;

        this.state.grid[index] = TileType.Empty;
        this.forgetMine(tx, ty);

        this.broadcast(ServerMessage.MineDetonated, {
          x: tx * TILE_SIZE + TILE_SIZE / 2,
          y: ty * TILE_SIZE + TILE_SIZE / 2,
          absorbed,
        } satisfies MineDetonatedMessage);

        if (!absorbed) this.killPlayer();
        return;
      }
    }
  }

  /** Drops a detonated mine from the expiry list so it is not tracked twice. */
  private forgetMine(tx: number, ty: number): void {
    const at = this.activeMines.findIndex((mine) => mine.x === tx && mine.y === ty);
    if (at >= 0) this.activeMines.splice(at, 1);
  }

  /** Removes mines whose 20-second lifetime has elapsed. */
  private expireMines(): void {
    for (let i = this.activeMines.length - 1; i >= 0; i--) {
      const mine = this.activeMines[i]!;
      if (this.elapsedMs < mine.expiresAtMs) continue;
      this.activeMines.splice(i, 1);
      if (!isInsideGrid(mine.x, mine.y)) continue;
      const index = tileIndex(mine.x, mine.y);
      if (this.state.grid.at(index) === TileType.Mine) {
        this.state.grid[index] = TileType.Empty;
      }
    }
  }

  // ------------------------------------------------------------------ escort

  /**
   * Drives the carrier straight north until it hits a wall.
   *
   * Collides only against solid tiles (not tanks), so it climbs open ground and
   * stalls at any brick/steel until the player clears the way.
   */
  private moveConvoy(deltaMs: number): void {
    if (!this.convoyId) return;
    const convoy = this.findTank(this.convoyId);
    if (!convoy) {
      this.convoyId = null;
      return;
    }

    const nextY = convoy.y + CONVOY_VY * (deltaMs / 1000);
    if (!isBlocked(this.state, convoy.x, nextY, convoy.width, convoy.height)) {
      convoy.y = nextY;
    }
  }

  /** True when the carrier's hull has reached the extraction pad. */
  private convoyOnExtraction(): boolean {
    if (!this.convoyId) return false;
    const convoy = this.findTank(this.convoyId);
    if (!convoy) return false;

    const minTX = Math.floor(convoy.x / TILE_SIZE);
    const maxTX = Math.floor((convoy.x + convoy.width - 1) / TILE_SIZE);
    const minTY = Math.floor(convoy.y / TILE_SIZE);
    const maxTY = Math.floor((convoy.y + convoy.height - 1) / TILE_SIZE);

    for (let ty = minTY; ty <= maxTY; ty++) {
      for (let tx = minTX; tx <= maxTX; tx++) {
        if (!isInsideGrid(tx, ty)) continue;
        if (this.state.grid.at(tileIndex(tx, ty)) === TileType.ExtractionZone) return true;
      }
    }
    return false;
  }

  /**
   * Chips the carrier down while an enemy hull is in contact with it.
   *
   * Contact deals 1 damage on a cooldown (rather than instant death), so a
   * rammer whittles the carrier's {@link CONVOY_HP} away over a few seconds. The
   * escort only fails — costing a life — once the carrier's health hits zero.
   * Returns true when the carrier was destroyed this tick.
   */
  private resolveConvoyContact(deltaMs: number): boolean {
    if (!this.convoyId) return false;
    const convoy = this.findTank(this.convoyId);
    if (!convoy) return false;

    this.convoyContactCooldownMs = Math.max(0, this.convoyContactCooldownMs - deltaMs);

    const pad = CONVOY_CONTACT_PADDING;
    let inContact = false;
    for (let i = 0; i < this.state.tanks.length; i++) {
      const enemy = this.state.tanks.at(i);
      if (!enemy.isEnemy) continue;

      if (
        boxesOverlap(
          enemy.x - pad,
          enemy.y - pad,
          enemy.width + pad * 2,
          enemy.height + pad * 2,
          convoy.x,
          convoy.y,
          convoy.width,
          convoy.height,
        )
      ) {
        inContact = true;
        break;
      }
    }

    if (!inContact || this.convoyContactCooldownMs > 0) return false;
    this.convoyContactCooldownMs = CONVOY_CONTACT_INTERVAL_MS;

    convoy.currentHealth = Math.max(0, convoy.currentHealth - 1);
    if (convoy.currentHealth > 0) return false;

    // The carrier is wrecked — remove it, announce the loss, and fail the escort.
    const index = this.state.tanks.indexOf(convoy);
    if (index >= 0) this.state.tanks.splice(index, 1);
    this.broadcast(ServerMessage.TankDestroyed, {
      x: convoy.x + convoy.width / 2,
      y: convoy.y + convoy.height / 2,
      isEnemy: false,
      heavy: false,
    } satisfies TankDestroyedMessage);
    this.loseConvoy();
    return true;
  }

  /**
   * The carrier was destroyed — the escort fails. It costs a life and rebuilds
   * the level (just like a bomb detonation); with no lives left it is game over.
   */
  private loseConvoy(): void {
    this.convoyId = null;
    this.state.lives = Math.max(0, this.state.lives - 1);
    const player = this.playerId ? this.state.players.get(this.playerId) : undefined;
    if (player) player.lives = this.state.lives;

    if (this.state.lives <= 0) {
      this.state.phase = CampaignPhase.GameOver;
      console.log(`[room ${this.roomId}] carrier destroyed — game over`);
      return;
    }

    console.log(`[room ${this.roomId}] carrier destroyed — ${this.state.lives} lives left, retrying`);
    this.beginLevel();
  }

  /** Writes the objective fields, skipping the patch when nothing changed. */
  private setObjective(text: string, value: number): void {
    if (this.state.objectiveText !== text) this.state.objectiveText = text;
    if (this.state.objectiveValue !== value) this.state.objectiveValue = value;
  }

  /** Clears the field and hands the player their outro. Returns true. */
  private winLevel(): boolean {
    for (let i = this.state.tanks.length - 1; i >= 0; i--) {
      if (this.state.tanks.at(i).isEnemy) this.state.tanks.splice(i, 1);
    }
    this.state.bullets.splice(0);
    this.state.phase = CampaignPhase.Outro;
    console.log(`[room ${this.roomId}] level ${this.state.currentLevel} cleared`);
    return true;
  }

  private gridHasRadar(): boolean {
    for (let i = 0; i < GRID_LENGTH; i++) {
      if (this.state.grid.at(i) === TileType.Radar) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ kamikaze

  /**
   * Detonates any kamikaze rusher that has reached the player.
   *
   * Tank movement refuses to overlap another hull, so a rusher comes to rest
   * flush against the player rather than on top of it — the contact test grows
   * its box by a few pixels to catch that touch. On a hit the rusher and the
   * player both explode, the player loses a life, and the blast chews a 3x3 hole
   * in the destructible cover around the impact. Skipped while the player is in
   * respawn grace, matching how shells pass through an invulnerable tank.
   */
  private resolveKamikaze(): void {
    const player = this.playerId ? this.findTank(this.playerId) : undefined;
    if (!player || player.isInvulnerable || this.isShieldUp(player)) return;

    const pad = KAMIKAZE_CONTACT_PADDING;

    for (let i = this.state.tanks.length - 1; i >= 0; i--) {
      const enemy = this.state.tanks.at(i);
      if (!enemy.isEnemy || enemy.variant !== KAMIKAZE) continue;

      const inContact = boxesOverlap(
        enemy.x - pad,
        enemy.y - pad,
        enemy.width + pad * 2,
        enemy.height + pad * 2,
        player.x,
        player.y,
        player.width,
        player.height,
      );
      if (!inContact) continue;

      const epicenterX = enemy.x + enemy.width / 2;
      const epicenterY = enemy.y + enemy.height / 2;

      // The rusher is consumed in the blast.
      this.state.tanks.splice(i, 1);
      this.onTankDestroyed(enemy);

      // Level the destructible cover in a 3x3 around the impact.
      this.blastTiles(epicenterX, epicenterY);

      // And take the player with it — one life, then respawn or game over.
      const playerIndex = this.state.tanks.indexOf(player);
      if (playerIndex >= 0) this.state.tanks.splice(playerIndex, 1);
      this.onTankDestroyed(player);

      return; // the player is gone; no further contact to resolve this tick
    }
  }

  /** Clears Brick and Radar tiles in the 3x3 block around a world point. */
  private blastTiles(worldX: number, worldY: number): void {
    const cx = Math.floor(worldX / TILE_SIZE);
    const cy = Math.floor(worldY / TILE_SIZE);

    let changed = false;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const tx = cx + dx;
        const ty = cy + dy;
        if (!isInsideGrid(tx, ty)) continue;

        const index = tileIndex(tx, ty);
        const tile = this.state.grid.at(index);
        if (tile === TileType.Brick || tile === TileType.Radar) {
          this.state.grid[index] = TileType.Empty;
          changed = true;
        }
      }
    }

    // Opening up cover changes the routes — re-path the hunters.
    if (changed) this.hunterField.rebuildToward(this.state.grid, this.playerTargets());
  }

  // -------------------------------------------------------------- sweeper boss

  /**
   * Drives the boss one step under its own momentum.
   *
   * No pathing — it simply advances by its velocity and rebounds off steel or
   * the map edge, one axis at a time, crushing any brick or radar it rolls over.
   */
  private moveSweeper(deltaMs: number): void {
    if (!this.bossId) return;
    const boss = this.findTank(this.bossId);
    if (!boss) {
      this.bossId = null;
      return;
    }
    // Only the ballistic Sweeper moves this way; the Juggernaut and the static
    // Artillery share the boss slot but steer (or hold) on their own.
    if (boss.variant !== SWEEPER) return;

    const dt = deltaMs / 1000;
    let bounced = false;

    const nextX = boss.x + this.bossVx * dt;
    if (this.sweeperHitsWall(nextX, boss.y, boss.width, boss.height)) {
      this.bossVx = -this.bossVx;
      bounced = true;
    } else {
      boss.x = nextX;
    }

    const nextY = boss.y + this.bossVy * dt;
    if (this.sweeperHitsWall(boss.x, nextY, boss.width, boss.height)) {
      this.bossVy = -this.bossVy;
      bounced = true;
    } else {
      boss.y = nextY;
    }

    if (bounced) {
      // The plain reversal above already points it back into open space; a third
      // of the time, override that with a lunge straight at the player instead.
      this.maybeHomingBounce(boss, dt);
      this.onSweeperBounce(boss);
    }

    this.crushTiles(boss.x, boss.y, boss.width, boss.height);
    this.crushEnemies(boss);
  }

  /**
   * On a bounce, a 1-in-3 chance to redirect the boss straight at the player.
   *
   * Guarded so it can't grind against the wall it just hit: the homing vector is
   * only taken if a step along it lands in open space — otherwise the boss keeps
   * the safe reversed velocity computed by the caller.
   */
  private maybeHomingBounce(boss: Tank, dt: number): void {
    if (Math.random() >= SWEEPER_HOMING_CHANCE) return;

    const player = this.playerId ? this.findTank(this.playerId) : undefined;
    if (!player) return;

    const bossCx = boss.x + boss.width / 2;
    const bossCy = boss.y + boss.height / 2;
    const playerCx = player.x + player.width / 2;
    const playerCy = player.y + player.height / 2;

    const angle = Math.atan2(playerCy - bossCy, playerCx - bossCx);
    const homingVx = Math.cos(angle) * SWEEPER_SPEED;
    const homingVy = Math.sin(angle) * SWEEPER_SPEED;

    // Only home if the new heading leads away from the wall (into open space).
    if (!this.sweeperHitsWall(boss.x + homingVx * dt, boss.y + homingVy * dt, boss.width, boss.height)) {
      this.bossVx = homingVx;
      this.bossVy = homingVy;
    }
  }

  /** The boss crushes any lesser enemy its hull overlaps — no friendly fire. */
  private crushEnemies(boss: Tank): void {
    for (let i = this.state.tanks.length - 1; i >= 0; i--) {
      const other = this.state.tanks.at(i);
      if (!other.isEnemy || other.isBoss) continue;

      if (
        boxesOverlap(
          boss.x,
          boss.y,
          boss.width,
          boss.height,
          other.x,
          other.y,
          other.width,
          other.height,
        )
      ) {
        this.state.tanks.splice(i, 1);
        this.onTankDestroyed(other);
      }
    }
  }

  /** True when the box leaves the field or overlaps a steel tile (a wall). */
  private sweeperHitsWall(x: number, y: number, w: number, h: number): boolean {
    if (x < 0 || y < 0 || x + w > WORLD_WIDTH || y + h > WORLD_HEIGHT) return true;

    const minTX = Math.floor(x / TILE_SIZE);
    const maxTX = Math.floor((x + w - 1) / TILE_SIZE);
    const minTY = Math.floor(y / TILE_SIZE);
    const maxTY = Math.floor((y + h - 1) / TILE_SIZE);

    for (let ty = minTY; ty <= maxTY; ty++) {
      for (let tx = minTX; tx <= maxTX; tx++) {
        if (!isInsideGrid(tx, ty)) return true;
        if (this.state.grid.at(tileIndex(tx, ty)) === TileType.Steel) return true;
      }
    }
    return false;
  }

  /** Instantly clears every Brick and Radar tile under the given box. */
  private crushTiles(x: number, y: number, w: number, h: number): void {
    const minTX = Math.floor(x / TILE_SIZE);
    const maxTX = Math.floor((x + w - 1) / TILE_SIZE);
    const minTY = Math.floor(y / TILE_SIZE);
    const maxTY = Math.floor((y + h - 1) / TILE_SIZE);

    for (let ty = minTY; ty <= maxTY; ty++) {
      for (let tx = minTX; tx <= maxTX; tx++) {
        if (!isInsideGrid(tx, ty)) continue;
        const index = tileIndex(tx, ty);
        const tile = this.state.grid.at(index);
        if (tile === TileType.Brick || tile === TileType.Radar) this.state.grid[index] = TileType.Empty;
      }
    }
  }

  // ------------------------------------------------------------- juggernaut boss

  /**
   * Drives the Juggernaut one step straight at the player.
   *
   * No pathfinding: it takes the direct angle to the player and advances along
   * it, one axis at a time, blocked only by steel and the map edge (via
   * {@link sweeperHitsWall}) — brick, factories and radars are not walls to it
   * but scenery it crushes. Every block it levels re-opens the maze, so the
   * hunter field is repathed and a jolt is thrown through the camera.
   */
  private moveJuggernaut(deltaMs: number): void {
    if (!this.bossId) return;
    const boss = this.findTank(this.bossId);
    if (!boss) {
      this.bossId = null;
      return;
    }
    if (boss.variant !== JUGGERNAUT) return;

    const player = this.playerId ? this.findTank(this.playerId) : undefined;
    if (player) {
      const bossCx = boss.x + boss.width / 2;
      const bossCy = boss.y + boss.height / 2;
      const playerCx = player.x + player.width / 2;
      const playerCy = player.y + player.height / 2;

      const angle = Math.atan2(playerCy - bossCy, playerCx - bossCx);
      const dt = deltaMs / 1000;
      const vx = Math.cos(angle) * JUGGERNAUT_SPEED;
      const vy = Math.sin(angle) * JUGGERNAUT_SPEED;

      const nextX = boss.x + vx * dt;
      if (!this.sweeperHitsWall(nextX, boss.y, boss.width, boss.height)) boss.x = nextX;

      const nextY = boss.y + vy * dt;
      if (!this.sweeperHitsWall(boss.x, nextY, boss.width, boss.height)) boss.y = nextY;
    }

    if (this.crushJuggernautTiles(boss.x, boss.y, boss.width, boss.height)) {
      // A levelled wall opens new routes — re-path the hunters, and give the
      // camera a very subtle rumble (crushes are frequent, so it must not jolt).
      this.hunterField.rebuildToward(this.state.grid, this.playerTargets());
      this.onSweeperBounce(boss, true);
    }
    this.crushEnemies(boss);
  }

  /**
   * Levels every Brick, Factory and Radar tile under the given box.
   *
   * Like {@link crushTiles}, but also takes out factories — the Juggernaut's
   * spec — and reports whether anything was destroyed, so the caller can repath
   * and shake only when the maze actually changed.
   */
  private crushJuggernautTiles(x: number, y: number, w: number, h: number): boolean {
    const minTX = Math.floor(x / TILE_SIZE);
    const maxTX = Math.floor((x + w - 1) / TILE_SIZE);
    const minTY = Math.floor(y / TILE_SIZE);
    const maxTY = Math.floor((y + h - 1) / TILE_SIZE);

    let changed = false;
    for (let ty = minTY; ty <= maxTY; ty++) {
      for (let tx = minTX; tx <= maxTX; tx++) {
        if (!isInsideGrid(tx, ty)) continue;
        const index = tileIndex(tx, ty);
        const tile = this.state.grid.at(index);
        if (tile === TileType.Brick || tile === TileType.Factory || tile === TileType.Radar) {
          this.state.grid[index] = TileType.Empty;
          changed = true;
        }
      }
    }
    return changed;
  }

  // ---------------------------------------------------------------- warden boss

  /** Moves the Warden toward the player at 40% speed and drops carpet mines. */
  private moveWarden(deltaMs: number): void {
    if (!this.bossId) return;
    const boss = this.findTank(this.bossId);
    if (!boss || boss.variant !== WARDEN) return;

    const player = this.playerId ? this.findTank(this.playerId) : undefined;
    if (player) {
      const bossCx = boss.x + boss.width / 2;
      const bossCy = boss.y + boss.height / 2;
      const playerCx = player.x + player.width / 2;
      const playerCy = player.y + player.height / 2;

      const angle = Math.atan2(playerCy - bossCy, playerCx - bossCx);
      const dt = deltaMs / 1000;
      const vx = Math.cos(angle) * WARDEN_SPEED;
      const vy = Math.sin(angle) * WARDEN_SPEED;

      const nextX = boss.x + vx * dt;
      if (!this.sweeperHitsWall(nextX, boss.y, boss.width, boss.height)) boss.x = nextX;

      const nextY = boss.y + vy * dt;
      if (!this.sweeperHitsWall(boss.x, nextY, boss.width, boss.height)) boss.y = nextY;
    }

    if (this.crushJuggernautTiles(boss.x, boss.y, boss.width, boss.height)) {
      this.hunterField.rebuildToward(this.state.grid, this.playerTargets());
      this.onSweeperBounce(boss, true);
    }
    this.crushEnemies(boss);

    this.wardenMineTimerMs += deltaMs;
    if (this.wardenMineTimerMs >= WARDEN_MINE_INTERVAL_MS) {
      this.wardenMineTimerMs -= WARDEN_MINE_INTERVAL_MS;
      this.layWardenMines(boss);
    }
  }

  /** Drops 3 mines in a spread around the Warden's current position. */
  private layWardenMines(boss: Tank): void {
    const cx = Math.floor((boss.x + boss.width / 2) / TILE_SIZE);
    const cy = Math.floor((boss.y + boss.height / 2) / TILE_SIZE);

    const offsets = [
      { dx: 0, dy: 1 },
      { dx: -1, dy: 1 },
      { dx: 1, dy: 1 },
    ];

    for (const { dx, dy } of offsets) {
      const gx = cx + dx;
      const gy = cy + dy;
      if (!isInsideGrid(gx, gy)) continue;
      const index = tileIndex(gx, gy);
      if (this.state.grid.at(index) === TileType.Empty) {
        this.state.grid[index] = TileType.Mine;
        this.activeMines.push({ x: gx, y: gy, expiresAtMs: this.elapsedMs + 20_000 });
      }
    }
  }

  // ------------------------------------------------------------- artillery boss

  /**
   * Drives the artillery boss one slow step directly away from the player.
   *
   * It flees along the exact reverse of the angle to the player, one axis at a
   * time, blocked by any solid tile ({@link isBlocked}) and the map edge — so it
   * naturally tucks itself behind the steel cover in its gallery rather than
   * pathfinding. It keeps lobbing mortars from wherever it ends up.
   */
  private moveArtillery(deltaMs: number): void {
    if (!this.bossId) return;
    const boss = this.findTank(this.bossId);
    if (!boss || boss.variant !== ARTILLERY) return;

    const player = this.playerId ? this.findTank(this.playerId) : undefined;
    if (!player) return;

    const bossCx = boss.x + boss.width / 2;
    const bossCy = boss.y + boss.height / 2;
    const playerCx = player.x + player.width / 2;
    const playerCy = player.y + player.height / 2;

    // Reverse of the angle to the player: head straight away from them.
    const angle = Math.atan2(bossCy - playerCy, bossCx - playerCx);
    const dt = deltaMs / 1000;
    const vx = Math.cos(angle) * ARTILLERY_SPEED;
    const vy = Math.sin(angle) * ARTILLERY_SPEED;

    const nextX = boss.x + vx * dt;
    if (!isBlocked(this.state, nextX, boss.y, boss.width, boss.height)) boss.x = nextX;

    const nextY = boss.y + vy * dt;
    if (!isBlocked(this.state, boss.x, nextY, boss.width, boss.height)) boss.y = nextY;
  }

  // -------------------------------------------------------------- bastion boss

  /**
   * True when a shell is striking the Bastion's armoured plating.
   *
   * Only a shot into its back lands. A bullet travelling the same way the
   * Bastion faces must have come from behind it, so that — and only that — is a
   * hit; shells from the front or either flank spark off. Deliberately a hard
   * rule rather than a fuzzy arc, so the player can read the fight from the
   * hull's facing alone and know exactly where they need to be.
   */
  private isBastionArmoured(target: Tank, bullet: Bullet): boolean {
    if (target.variant !== BASTION) return false;
    return bullet.direction !== target.direction;
  }

  /** Swings the Bastion toward the player and walks it slowly forward. */
  private moveBastion(deltaMs: number): void {
    if (!this.bossId) return;
    const boss = this.findTank(this.bossId);
    if (!boss || boss.variant !== BASTION) return;

    const player = this.playerId ? this.findTank(this.playerId) : undefined;
    if (!player) return;

    // Rotate one quarter-turn at a time, on a timer — the delay between swings
    // is the window the player has to get behind it and shoot.
    this.bastionTurnMs += deltaMs;
    if (this.bastionTurnMs >= BASTION_TURN_INTERVAL_MS) {
      this.bastionTurnMs -= BASTION_TURN_INTERVAL_MS;

      const dx = player.x + player.width / 2 - (boss.x + boss.width / 2);
      const dy = player.y + player.height / 2 - (boss.y + boss.height / 2);
      const desired =
        Math.abs(dx) >= Math.abs(dy)
          ? dx >= 0
            ? Direction.Right
            : Direction.Left
          : dy >= 0
            ? Direction.Down
            : Direction.Up;

      // Cardinals run clockwise (Up, Right, Down, Left), so stepping by one
      // toward the shorter side turns the hull the natural way round.
      const diff = (desired - boss.direction + 4) % 4;
      if (diff === 3) boss.direction = ((boss.direction + 3) % 4) as Direction;
      else if (diff !== 0) boss.direction = ((boss.direction + 1) % 4) as Direction;
    }

    // Grind forward along the facing. Blocked simply means it stops; it is the
    // plating, not the position, that makes this fight.
    const heading = DIRECTION_VECTORS[boss.direction];
    const dt = deltaMs / 1000;
    const nextX = boss.x + heading.x * BASTION_SPEED * dt;
    if (!isBlocked(this.state, nextX, boss.y, boss.width, boss.height)) boss.x = nextX;

    const nextY = boss.y + heading.y * BASTION_SPEED * dt;
    if (!isBlocked(this.state, boss.x, nextY, boss.width, boss.height)) boss.y = nextY;

    // A heavy shell straight ahead, so standing in front is doubly wrong.
    this.bastionShootMs += deltaMs;
    if (this.bastionShootMs >= BASTION_SHOOT_INTERVAL_MS) {
      this.bastionShootMs -= BASTION_SHOOT_INTERVAL_MS;
      this.fire(boss);
    }
  }

  // ------------------------------------------------------------ architect boss

  /** Pylons still standing — the Radar tiles scattered around the arena. */
  private architectPylons(): number {
    return this.countRadar();
  }

  /**
   * True while the Architect is sealed behind its pylons.
   *
   * Shells are consumed but deal nothing, so the player learns quickly that the
   * pylons, not the hull, are the fight.
   */
  private isArchitectSealed(target: Tank): boolean {
    return target.variant === ARCHITECT && this.architectPylons() > 0;
  }

  /**
   * Contracts the arena on a timer while the pylons still stand.
   *
   * Each contraction turns the next ring in from the border to steel, crushing
   * whatever is standing on it. Levelling pylons stretches the interval, and
   * clearing the last one stops the walls entirely — which is what turns the
   * encounter from a losing race into a winnable one.
   */
  private tickArchitect(deltaMs: number): void {
    if (!this.bossId) return;
    const boss = this.findTank(this.bossId);
    if (!boss || boss.variant !== ARCHITECT) return;

    // Steady suppressing fire, so the boss is visibly alive while it builds.
    // It keeps lobbing after the pylons fall — that is when it is exposed and
    // has nothing left to do but fight.
    this.architectLobMs += deltaMs;
    if (this.architectLobMs >= ARCHITECT_LOB_INTERVAL_MS) {
      this.architectLobMs -= ARCHITECT_LOB_INTERVAL_MS;
      const player = this.playerId ? this.findTank(this.playerId) : undefined;
      if (player) this.launchSapperLob(boss, player);
    }

    const pylons = this.architectPylons();
    if (pylons === 0) return;
    if (this.architectRings >= ARCHITECT_MAX_RINGS) return;

    const destroyed = Math.max(0, 4 - pylons);
    const interval = ARCHITECT_RING_BASE_MS + destroyed * ARCHITECT_RING_SLOWDOWN_MS;

    this.architectRingMs += deltaMs;

    // Warn before the walls move. The contraction happens at the map edge,
    // usually well away from where the player is looking, so announcing it is
    // what makes the mechanic readable at all.
    if (!this.architectWarned && this.architectRingMs >= interval - ARCHITECT_RING_WARNING_MS) {
      this.architectWarned = true;
      this.broadcast(ServerMessage.BossBounce, {
        x: WORLD_WIDTH / 2,
        y: WORLD_HEIGHT / 2,
        subtle: true,
      } satisfies BossBounceMessage);
    }

    if (this.architectRingMs < interval) return;
    this.architectRingMs -= interval;
    this.architectWarned = false;

    this.architectRings++;
    this.closeArchitectRing(this.architectRings);
  }

  /**
   * Turns one ring in from the map border to steel.
   *
   * Anything standing on the ring as it closes is crushed — the player included.
   *
   * Pylons are the one thing the walls will not take: burying one would count as
   * the player having destroyed it and unseal the boss for free.
   * {@link ARCHITECT_MAX_RINGS} already stops the contraction short of them, and
   * this check keeps that true if the arena is ever re-laid.
   */
  private closeArchitectRing(ring: number): void {
    const minX = ring;
    const maxX = GRID_WIDTH - 1 - ring;
    const minY = ring;
    const maxY = GRID_HEIGHT - 1 - ring;
    if (minX >= maxX || minY >= maxY) return;

    const cells: Array<[number, number]> = [];
    for (let x = minX; x <= maxX; x++) {
      cells.push([x, minY], [x, maxY]);
    }
    for (let y = minY + 1; y < maxY; y++) {
      cells.push([minX, y], [maxX, y]);
    }

    for (const [x, y] of cells) {
      if (!isInsideGrid(x, y)) continue;
      const index = tileIndex(x, y);
      if (this.state.grid.at(index) === TileType.Radar) continue;
      this.state.grid[index] = TileType.Steel;
    }

    // Crush whatever the new wall closed on. Enemies go first so the player's
    // death, if it happens, is the last thing resolved this tick.
    const bx = minX * TILE_SIZE;
    const by = minY * TILE_SIZE;
    const bw = (maxX - minX + 1) * TILE_SIZE;
    const bh = (maxY - minY + 1) * TILE_SIZE;

    for (let i = this.state.tanks.length - 1; i >= 0; i--) {
      const tank = this.state.tanks.at(i);
      if (!tank.isEnemy || tank.isBoss) continue;
      // Only bodies actually overlapping the new steel are caught.
      if (isBlocked(this.state, tank.x, tank.y, tank.width, tank.height)) {
        this.state.tanks.splice(i, 1);
        this.onTankDestroyed(tank);
      }
    }

    this.broadcast(ServerMessage.BossBounce, {
      x: bx + bw / 2,
      y: by + bh / 2,
      subtle: false,
    } satisfies BossBounceMessage);

    const player = this.playerId ? this.findTank(this.playerId) : undefined;
    if (!player || player.isInvulnerable) return;
    // The closing wall kills through a shield, like a boss hull does.
    if (isBlocked(this.state, player.x, player.y, player.width, player.height)) {
      this.killPlayer();
    }
  }

  // ----------------------------------------------------------- logic core boss

  /** Returns the Core's current phase based on HP. */
  private corePhase(boss: Tank): 1 | 2 | 3 {
    if (boss.currentHealth > CORE_PHASE2_HP) return 1;
    if (boss.currentHealth > CORE_PHASE3_HP) return 2;
    return 3;
  }

  /** Ticks the Core's fire system — dispatches by phase, plus mortar barrages. */
  private updateCore(deltaMs: number): void {
    if (!this.bossId) return;
    const boss = this.findTank(this.bossId);
    if (!boss || boss.variant !== CORE) return;

    const phase = this.corePhase(boss);

    if (phase === 1) {
      this.coreShootTimerMs += deltaMs;
      if (this.coreShootTimerMs >= CORE_SHOOT_INTERVAL_MS) {
        this.coreShootTimerMs -= CORE_SHOOT_INTERVAL_MS;
        this.fireCoreRadialWave(boss);
      }
    } else if (phase === 2) {
      this.coreShootTimerMs += deltaMs;
      if (this.coreShootTimerMs >= CORE_PHASE2_SHOOT_MS) {
        this.coreShootTimerMs -= CORE_PHASE2_SHOOT_MS;
        this.fireCoreShotgun(boss);
      }
    } else {
      this.coreShootTimerMs += deltaMs;
      if (this.coreShootTimerMs >= CORE_SPIRAL_INTERVAL_MS) {
        this.coreShootTimerMs -= CORE_SPIRAL_INTERVAL_MS;
        this.fireCoreSpiral(boss);
      }
    }

    this.coreMortarTimerMs += deltaMs;
    if (this.coreMortarTimerMs >= CORE_MORTAR_INTERVAL_MS) {
      this.coreMortarTimerMs -= CORE_MORTAR_INTERVAL_MS;
      this.launchMortar();
    }
  }

  /** Phase 2/3: moves the Core toward the player, crushing bricks. */
  private moveCore(deltaMs: number): void {
    if (!this.bossId) return;
    const boss = this.findTank(this.bossId);
    if (!boss || boss.variant !== CORE) return;

    const phase = this.corePhase(boss);
    if (phase === 1) return;

    const player = this.playerId ? this.findTank(this.playerId) : undefined;
    if (!player) return;

    const speed = phase === 2 ? CORE_PHASE2_SPEED : CORE_PHASE3_SPEED;
    const bossCx = boss.x + boss.width / 2;
    const bossCy = boss.y + boss.height / 2;
    const playerCx = player.x + player.width / 2;
    const playerCy = player.y + player.height / 2;

    const angle = Math.atan2(playerCy - bossCy, playerCx - bossCx);
    const dt = deltaMs / 1000;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;

    const nextX = boss.x + vx * dt;
    if (!this.sweeperHitsWall(nextX, boss.y, boss.width, boss.height)) boss.x = nextX;

    const nextY = boss.y + vy * dt;
    if (!this.sweeperHitsWall(boss.x, nextY, boss.width, boss.height)) boss.y = nextY;

    if (this.crushJuggernautTiles(boss.x, boss.y, boss.width, boss.height)) {
      this.hunterField.rebuildToward(this.state.grid, this.playerTargets());
      this.onSweeperBounce(boss, true);
    }
    this.crushEnemies(boss);
  }

  /** Phase 1: standard 360-degree radial wave. */
  private fireCoreRadialWave(boss: Tank): void {
    const cx = boss.x + boss.width / 2;
    const cy = boss.y + boss.height / 2;
    const halfBullet = BULLET_SIZE / 2;
    const spread = TILE_SIZE;

    const directions: Array<{ dir: Direction; hx: number; hy: number; px: number; py: number }> = [
      { dir: Direction.Up, hx: 0, hy: -1, px: 1, py: 0 },
      { dir: Direction.Down, hx: 0, hy: 1, px: 1, py: 0 },
      { dir: Direction.Left, hx: -1, hy: 0, px: 0, py: 1 },
      { dir: Direction.Right, hx: 1, hy: 0, px: 0, py: 1 },
    ];

    for (const { dir, hx, hy, px, py } of directions) {
      for (let offset = -(CORE_BULLETS_PER_DIRECTION - 1) / 2; offset <= (CORE_BULLETS_PER_DIRECTION - 1) / 2; offset++) {
        const spawnX = cx - halfBullet + hx * (boss.width / 2) + px * offset * spread;
        const spawnY = cy - halfBullet + hy * (boss.height / 2) + py * offset * spread;

        this.state.bullets.push(
          new Bullet({
            x: spawnX,
            y: spawnY,
            width: BULLET_SIZE,
            height: BULLET_SIZE,
            ownerId: boss.ownerId,
            damage: BULLET_DAMAGE,
            direction: dir,
            speed: ENEMY_PROFILE.bulletSpeed,
            isEnemy: true,
            piercesSteel: false,
          }),
        );
      }
    }
  }

  /** Phase 2: 3-shot shotgun aimed at the player. */
  private fireCoreShotgun(boss: Tank): void {
    const player = this.playerId ? this.findTank(this.playerId) : undefined;
    if (!player) return;

    const cx = boss.x + boss.width / 2;
    const cy = boss.y + boss.height / 2;
    const px = player.x + player.width / 2;
    const py = player.y + player.height / 2;
    const baseAngle = Math.atan2(py - cy, px - cx);
    const spreadAngle = Math.PI / 12;

    for (let i = -1; i <= 1; i++) {
      const angle = baseAngle + i * spreadAngle;
      const bx = cx + Math.cos(angle) * (boss.width / 2) - BULLET_SIZE / 2;
      const by = cy + Math.sin(angle) * (boss.height / 2) - BULLET_SIZE / 2;

      this.state.bullets.push(
        new Bullet({
          x: bx,
          y: by,
          width: BULLET_SIZE,
          height: BULLET_SIZE,
          ownerId: boss.ownerId,
          damage: BULLET_DAMAGE,
          direction: this.angleToDirection(angle),
          speed: ENEMY_PROFILE.bulletSpeed * 1.2,
          isEnemy: true,
          piercesSteel: false,
        }),
      );
    }
  }

  /** Phase 3: continuous spiral — one bullet per call, angle increments 15°. */
  private fireCoreSpiral(boss: Tank): void {
    const cx = boss.x + boss.width / 2;
    const cy = boss.y + boss.height / 2;
    const angle = this.coreSpiralAngle;
    this.coreSpiralAngle += (15 * Math.PI) / 180;

    const bx = cx + Math.cos(angle) * (boss.width / 2) - BULLET_SIZE / 2;
    const by = cy + Math.sin(angle) * (boss.height / 2) - BULLET_SIZE / 2;

    this.state.bullets.push(
      new Bullet({
        x: bx,
        y: by,
        width: BULLET_SIZE,
        height: BULLET_SIZE,
        ownerId: boss.ownerId,
        damage: BULLET_DAMAGE,
        direction: this.angleToDirection(angle),
        speed: ENEMY_PROFILE.bulletSpeed,
        isEnemy: true,
        piercesSteel: false,
      }),
    );
  }

  /** Maps a continuous angle to the nearest cardinal Direction for bullet travel. */
  private angleToDirection(angle: number): Direction {
    const deg = ((angle * 180) / Math.PI + 360) % 360;
    if (deg >= 315 || deg < 45) return Direction.Right;
    if (deg >= 45 && deg < 135) return Direction.Down;
    if (deg >= 135 && deg < 225) return Direction.Left;
    return Direction.Up;
  }

  // -------------------------------------------------------------------- mimics

  /**
   * Springs any disguised Mimic the player has closed on or shot.
   *
   * A disguised Mimic only creeps toward the player (a slow {@link
   * MIMIC_CREEP_FACTOR} of base speed) and never fires. It reveals when the
   * player's hull gets within {@link MIMIC_REVEAL_DISTANCE}, or the instant it
   * takes damage — detected here as its health having dropped below full (the
   * shot that hurt it landed inside {@link updateBullets} last tick). Revealing
   * mutates the existing enemy in place — its `isDisguised` flag and speed — so
   * a shot springs the Mimic rather than ever spawning a second tank. On reveal
   * it jumps to hunting speed and begins firing like a tank.
   */
  private revealMimics(): void {
    const player = this.playerId ? this.findTank(this.playerId) : undefined;

    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      if (tank.variant !== MIMIC || !tank.isDisguised) continue;

      let reveal = tank.currentHealth < tank.maxHealth;
      if (!reveal && player) {
        const dx = player.x + player.width / 2 - (tank.x + tank.width / 2);
        const dy = player.y + player.height / 2 - (tank.y + tank.height / 2);
        if (Math.hypot(dx, dy) < MIMIC_REVEAL_DISTANCE) reveal = true;
      }

      if (reveal) {
        tank.isDisguised = false;
        // Springs with a short lunge, then settles to its normal hunting speed.
        tank.speed = TANK_SPEED * MIMIC_LUNGE_FACTOR;
        this.mimicLungeTimers.set(tank.ownerId, MIMIC_LUNGE_MS);
      }
    }
  }

  // -------------------------------------------------------------- suppression

  /**
   * True while a live Nullifier is close enough to switch the player's kit off.
   *
   * Every ability activation runs through this. It is checked at the moment of
   * the press rather than continuously, so a shield already up is not stripped
   * mid-fight — walking into a bubble does not kill you, it just means you
   * cannot reach for anything new until the Nullifier is dealt with.
   */
  private abilitiesSuppressed(): boolean {
    const player = this.playerId ? this.findTank(this.playerId) : undefined;
    if (!player) return false;

    const px = player.x + player.width / 2;
    const py = player.y + player.height / 2;
    const radius = NULLIFIER_RADIUS_TILES * TILE_SIZE;

    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      if (tank.variant !== NULLIFIER) continue;

      const dx = tank.x + tank.width / 2 - px;
      const dy = tank.y + tank.height / 2 - py;
      if (Math.hypot(dx, dy) <= radius) return true;
    }

    return false;
  }

  // --------------------------------------------------------------------- ram

  /** True once the campaign has reached the level that grants the ram. */
  private ramUnlocked(): boolean {
    return this.state.currentLevel >= RAM_UNLOCK_LEVEL;
  }

  /**
   * True when a charging player is shrugging a shell off the front of the hull.
   *
   * A surge commits the player to a straight line with no way to break off, so
   * without this the ability would routinely feed them into a shell they had no
   * option to avoid. Only rounds meeting the front are turned — the flanks and
   * the back stay open, so charging past a gun line is still a real risk.
   */
  private ramDeflects(target: Tank, bullet: Bullet): boolean {
    if (target.isEnemy || this.ramActiveMs <= 0) return false;
    // The shell is coming head-on when it travels opposite the charge.
    return bullet.direction === ((this.ramDirection + 2) % 4);
  }

  /** Launches the ram surge along the player's current facing. */
  private startRam(): void {
    if (!this.ramUnlocked()) return;
    if (this.ramActiveMs > 0 || this.ramCooldownMs > 0) return;
    if (this.abilitiesSuppressed()) return;

    const player = this.playerId ? this.findTank(this.playerId) : undefined;
    if (!player) return;

    this.ramActiveMs = RAM_DURATION_MS;
    this.ramDirection = player.direction;

    this.broadcast(ServerMessage.RamChanged, {
      active: true,
      cooldownMs: 0,
    } satisfies RamChangedMessage);
  }

  /**
   * Drives the ram surge: fast movement along the locked facing, crushing what
   * it runs into.
   *
   * The exceptions are the point of the ability. A boss hull and a live
   * kamikaze both kill the player instead of dying — so the ram is a tool for
   * cutting through ordinary ranks, never an "I win" button aimed at the thing
   * that actually matters. A raised shield is the one thing that turns a
   * kamikaze, which gives the two abilities a real combo.
   */
  private tickRam(deltaMs: number): void {
    if (this.ramActiveMs <= 0) {
      if (this.ramCooldownMs > 0) {
        this.ramCooldownMs = Math.max(0, this.ramCooldownMs - deltaMs);
        if (this.ramCooldownMs === 0) {
          this.broadcast(ServerMessage.RamChanged, {
            active: false,
            cooldownMs: 0,
          } satisfies RamChangedMessage);
        }
      }
      return;
    }

    const player = this.playerId ? this.findTank(this.playerId) : undefined;
    if (!player) {
      this.endRam();
      return;
    }

    this.ramActiveMs = Math.max(0, this.ramActiveMs - deltaMs);

    // Advance along the locked heading. A wall simply ends the surge.
    player.direction = this.ramDirection;
    const heading = DIRECTION_VECTORS[this.ramDirection];
    const step = TANK_SPEED * RAM_SPEED_FACTOR;
    const nextX = player.x + heading.x * step;
    const nextY = player.y + heading.y * step;

    if (isBlocked(this.state, nextX, nextY, player.width, player.height)) {
      // Brick gives way to a charging hull; steel and the objective tiles do
      // not, and stop the surge dead.
      if (!this.ramThroughBrick(player, nextX, nextY)) {
        this.endRam();
        return;
      }
    }

    player.x = nextX;
    player.y = nextY;

    // Resolve whatever the hull is now inside.
    for (let i = this.state.tanks.length - 1; i >= 0; i--) {
      const tank = this.state.tanks.at(i);
      if (!tank.isEnemy) continue;
      if (!boxesOverlap(player.x, player.y, player.width, player.height, tank.x, tank.y, tank.width, tank.height)) {
        continue;
      }

      // A boss shrugs the charge off and runs the player down.
      if (tank.isBoss) {
        this.endRam();
        if (!player.isInvulnerable) this.killPlayer();
        return;
      }

      // A rusher detonates — unless the deflector is up, which turns it.
      if (tank.variant === KAMIKAZE) {
        if (this.isShieldUp(player)) {
          this.state.tanks.splice(i, 1);
          this.onTankDestroyed(tank);
          continue;
        }
        this.endRam();
        if (!player.isInvulnerable) this.killPlayer();
        return;
      }

      this.state.tanks.splice(i, 1);
      this.onTankDestroyed(tank);
    }

    if (this.ramActiveMs === 0) this.endRam();
  }

  /**
   * Smashes brick out of a charging hull's way.
   *
   * Every tile the hull would occupy is examined: brick is cleared, and if
   * anything harder is in there — steel, water, the eagle, a campaign objective
   * — the charge is refused and the surge ends. So the ram opens walls without
   * ever becoming a way through the things walls are made of.
   *
   * @returns true when the path is now clear and the move may proceed.
   */
  private ramThroughBrick(player: Tank, x: number, y: number): boolean {
    const minTX = Math.floor(x / TILE_SIZE);
    const maxTX = Math.floor((x + player.width - 1) / TILE_SIZE);
    const minTY = Math.floor(y / TILE_SIZE);
    const maxTY = Math.floor((y + player.height - 1) / TILE_SIZE);

    const brick: number[] = [];
    for (let ty = minTY; ty <= maxTY; ty++) {
      for (let tx = minTX; tx <= maxTX; tx++) {
        // Off the map: nothing to smash, the surge simply stops.
        if (!isInsideGrid(tx, ty)) return false;

        const index = tileIndex(tx, ty);
        const tile = this.state.grid.at(index);
        if (tile === TileType.Brick) brick.push(index);
        else if (isSolidForTanks(tile)) return false;
      }
    }

    if (brick.length === 0) return false;
    for (const index of brick) this.state.grid[index] = TileType.Empty;

    // Opening a wall changes the routes the hunters were following.
    this.hunterField.rebuildToward(this.state.grid, this.playerTargets());
    return true;
  }

  /** Ends the surge and starts its cooldown. */
  private endRam(): void {
    if (this.ramActiveMs === 0 && this.ramCooldownMs > 0) return;
    this.ramActiveMs = 0;
    this.ramCooldownMs = RAM_COOLDOWN_MS;

    this.broadcast(ServerMessage.RamChanged, {
      active: false,
      cooldownMs: RAM_COOLDOWN_MS,
    } satisfies RamChangedMessage);
  }

  /** Clears the ram state — used on death and on level change. */
  private resetRam(): void {
    this.ramActiveMs = 0;
    this.ramCooldownMs = 0;
    this.broadcast(ServerMessage.RamChanged, {
      active: false,
      cooldownMs: 0,
    } satisfies RamChangedMessage);
  }

  // ------------------------------------------------------------------- decoy

  /** True once the campaign has reached the level that grants the decoy. */
  private decoyUnlocked(): boolean {
    return this.state.currentLevel >= DECOY_UNLOCK_LEVEL;
  }

  /**
   * Drops a beacon at the player's feet.
   *
   * The whole effect is in {@link playerTargets}: while a beacon stands, the
   * hunter field is rebuilt toward it instead of the player, and every
   * field-following enemy on the map turns and walks to it.
   */
  private dropDecoy(): void {
    if (!this.decoyUnlocked()) return;
    if (this.decoyCooldownMs > 0 || this.decoy) return;
    if (this.abilitiesSuppressed()) return;

    const player = this.playerId ? this.findTank(this.playerId) : undefined;
    if (!player) return;

    this.decoy = {
      x: player.x + player.width / 2,
      y: player.y + player.height / 2,
      remainingMs: DECOY_DURATION_MS,
    };

    this.hunterField.rebuildToward(this.state.grid, this.playerTargets());

    this.broadcast(ServerMessage.DecoyChanged, {
      cooldownMs: 0,
      x: this.decoy.x,
      y: this.decoy.y,
      durationMs: DECOY_DURATION_MS,
    } satisfies DecoyChangedMessage);
  }

  /** Expires a standing beacon and runs the decoy cooldown. */
  private tickDecoy(deltaMs: number): void {
    if (this.decoy) {
      this.decoy.remainingMs -= deltaMs;
      if (this.decoy.remainingMs <= 0) {
        this.decoy = null;
        this.decoyCooldownMs = DECOY_COOLDOWN_MS;
        // Attention snaps back to the player the moment it goes out.
        this.hunterField.rebuildToward(this.state.grid, this.playerTargets());
        this.broadcast(ServerMessage.DecoyChanged, {
          cooldownMs: DECOY_COOLDOWN_MS,
        } satisfies DecoyChangedMessage);
      }
      return;
    }

    if (this.decoyCooldownMs > 0) {
      this.decoyCooldownMs = Math.max(0, this.decoyCooldownMs - deltaMs);
      if (this.decoyCooldownMs === 0) {
        this.broadcast(ServerMessage.DecoyChanged, {
          cooldownMs: 0,
        } satisfies DecoyChangedMessage);
      }
    }
  }

  /** Clears the decoy state — used on death and on level change. */
  private resetDecoy(): void {
    this.decoy = null;
    this.decoyCooldownMs = 0;
    this.broadcast(ServerMessage.DecoyChanged, {
      cooldownMs: 0,
    } satisfies DecoyChangedMessage);
  }

  // ------------------------------------------------------------------- blast

  /** True once the campaign has reached the level that grants the blast. */
  private blastUnlocked(): boolean {
    return this.state.currentLevel >= BLAST_UNLOCK_LEVEL;
  }

  /**
   * Detonates a ring around the player, clearing everything soft inside it.
   *
   * What it takes: every ordinary enemy, and brick and mines. What it leaves:
   * steel, the campaign objective tiles, and — deliberately — bosses.
   *
   * Bosses are exempt because each of them is a puzzle about *how* to do damage
   * rather than a health bar: the Bastion is only open from behind, the
   * Architect is sealed until its pylons fall, the Hydra has to be split apart.
   * A button that ignored all three would delete those fights. The blast is the
   * answer to being swarmed, not the answer to a boss.
   */
  private fireBlast(): void {
    if (!this.blastUnlocked()) return;
    if (this.blastCooldownMs > 0) return;
    if (this.abilitiesSuppressed()) return;

    const player = this.playerId ? this.findTank(this.playerId) : undefined;
    if (!player) return;

    const cx = player.x + player.width / 2;
    const cy = player.y + player.height / 2;
    const radius = BLAST_RADIUS_TILES * TILE_SIZE;

    // Ordinary enemies inside the ring are destroyed outright.
    for (let i = this.state.tanks.length - 1; i >= 0; i--) {
      const tank = this.state.tanks.at(i);
      if (!tank.isEnemy || tank.isBoss) continue;

      const dx = tank.x + tank.width / 2 - cx;
      const dy = tank.y + tank.height / 2 - cy;
      if (Math.hypot(dx, dy) > radius) continue;

      this.state.tanks.splice(i, 1);
      this.onTankDestroyed(tank);
    }

    // Terrain is worked over the whole kill radius, but the two tile kinds are
    // treated differently: mines are a threat and clear with everything else,
    // while brick is structure and only breaks close in. Steel and every
    // objective tile ride it out, so no level's puzzle can be blasted open.
    const brickRadius = BLAST_BRICK_RADIUS_TILES * TILE_SIZE;
    const minTX = Math.max(0, Math.floor((cx - radius) / TILE_SIZE));
    const maxTX = Math.min(GRID_WIDTH - 1, Math.floor((cx + radius) / TILE_SIZE));
    const minTY = Math.max(0, Math.floor((cy - radius) / TILE_SIZE));
    const maxTY = Math.min(GRID_HEIGHT - 1, Math.floor((cy + radius) / TILE_SIZE));

    let clearedBrick = false;
    for (let ty = minTY; ty <= maxTY; ty++) {
      for (let tx = minTX; tx <= maxTX; tx++) {
        if (!isInsideGrid(tx, ty)) continue;

        const tileCx = tx * TILE_SIZE + TILE_SIZE / 2;
        const tileCy = ty * TILE_SIZE + TILE_SIZE / 2;
        const distance = Math.hypot(tileCx - cx, tileCy - cy);
        if (distance > radius) continue;

        const index = tileIndex(tx, ty);
        const tile = this.state.grid.at(index);
        if (tile === TileType.Brick) {
          if (distance > brickRadius) continue;
          this.state.grid[index] = TileType.Empty;
          clearedBrick = true;
        } else if (tile === TileType.Mine) {
          this.state.grid[index] = TileType.Empty;
          this.forgetMine(tx, ty);
        }
      }
    }

    // Blowing walls open changes the routes the hunters were following.
    if (clearedBrick) {
      this.hunterField.rebuildToward(this.state.grid, this.playerTargets());
    }

    this.blastCooldownMs = BLAST_COOLDOWN_MS;

    this.broadcast(ServerMessage.BlastChanged, {
      cooldownMs: BLAST_COOLDOWN_MS,
      x: cx,
      y: cy,
      radius,
      brickRadius,
    } satisfies BlastChangedMessage);
  }

  /** Counts the blast cooldown down and announces when it is ready again. */
  private tickBlast(deltaMs: number): void {
    if (this.blastCooldownMs <= 0) return;

    this.blastCooldownMs = Math.max(0, this.blastCooldownMs - deltaMs);
    if (this.blastCooldownMs > 0) return;

    this.broadcast(ServerMessage.BlastChanged, {
      cooldownMs: 0,
    } satisfies BlastChangedMessage);
  }

  /** Clears the blast cooldown — used on death and on level change. */
  private resetBlast(): void {
    this.blastCooldownMs = 0;
    this.broadcast(ServerMessage.BlastChanged, {
      cooldownMs: 0,
    } satisfies BlastChangedMessage);
  }

  // ---------------------------------------------------------------- teleport

  /** True once the campaign has reached the level that grants the blink drive. */
  private teleportUnlocked(): boolean {
    return this.state.currentLevel >= TELEPORT_UNLOCK_LEVEL;
  }

  /**
   * Blinks the player up to {@link TELEPORT_TILES} tiles along their facing.
   *
   * The jump is traced a tile at a time rather than dropped straight at the far
   * end, so it can never put the player through a wall or inside another hull:
   * the first tile that is solid, or occupied by a tank, ends the trace and the
   * player lands on the last clear tile before it. A blink with nowhere to go
   * costs nothing — the charge is only spent on a jump that actually moves.
   */
  private teleportPlayer(): void {
    if (!this.teleportUnlocked()) return;
    if (this.teleportCharges <= 0) return;
    if (this.abilitiesSuppressed()) return;
    // A Lurcher's grapple clamps the drive shut for a moment after it lands.
    if (this.blinkLockMs > 0) return;

    const player = this.playerId ? this.findTank(this.playerId) : undefined;
    if (!player) return;

    const heading = DIRECTION_VECTORS[player.direction];
    const fromX = player.x;
    const fromY = player.y;

    let destX = fromX;
    let destY = fromY;

    for (let step = 1; step <= TELEPORT_TILES; step++) {
      const candX = fromX + heading.x * TILE_SIZE * step;
      const candY = fromY + heading.y * TILE_SIZE * step;

      // Terrain (and the map edge) stops the jump short.
      if (isBlocked(this.state, candX, candY, player.width, player.height)) break;

      // So does a tank standing on the landing tile: land on the one before it.
      if (collidesWithTank(this.state, player, candX, candY)) break;

      destX = candX;
      destY = candY;
    }

    // Facing a wall with nowhere to land: refuse rather than burn the charge.
    if (destX === fromX && destY === fromY) return;

    player.x = destX;
    player.y = destY;

    this.teleportCharges--;
    if (this.teleportRechargeMs <= 0) this.teleportRechargeMs = TELEPORT_RECHARGE_MS;

    this.broadcast(ServerMessage.TeleportChanged, {
      charges: this.teleportCharges,
      rechargeMs: this.teleportRechargeMs,
      fromX,
      fromY,
      toX: destX,
      toY: destY,
    } satisfies TeleportChangedMessage);
  }

  /** Refills one blink charge at a time while the bank is below its cap. */
  private tickTeleport(deltaMs: number): void {
    if (this.teleportCharges >= TELEPORT_MAX_CHARGES) {
      this.teleportRechargeMs = 0;
      return;
    }

    if (this.teleportRechargeMs <= 0) this.teleportRechargeMs = TELEPORT_RECHARGE_MS;

    this.teleportRechargeMs -= deltaMs;
    if (this.teleportRechargeMs > 0) return;

    this.teleportCharges = Math.min(TELEPORT_MAX_CHARGES, this.teleportCharges + 1);
    this.teleportRechargeMs =
      this.teleportCharges < TELEPORT_MAX_CHARGES ? TELEPORT_RECHARGE_MS : 0;

    this.broadcast(ServerMessage.TeleportChanged, {
      charges: this.teleportCharges,
      rechargeMs: this.teleportRechargeMs,
    } satisfies TeleportChangedMessage);
  }

  /** Returns the blink bank to full — used on death and on level change. */
  private resetTeleport(): void {
    this.teleportCharges = TELEPORT_MAX_CHARGES;
    this.teleportRechargeMs = 0;

    this.broadcast(ServerMessage.TeleportChanged, {
      charges: this.teleportCharges,
      rechargeMs: 0,
    } satisfies TeleportChangedMessage);
  }

  // ------------------------------------------------------------------ shield

  /** True once the campaign has reached the level that grants the shield. */
  private shieldUnlocked(): boolean {
    return this.state.currentLevel >= SHIELD_UNLOCK_LEVEL;
  }

  /**
   * Raises the deflector shield, if it is unlocked, down, and off cooldown.
   *
   * The cooldown starts when the shield *drops*, not when it is raised, so the
   * gap between protection is always the full {@link SHIELD_COOLDOWN_MS}.
   */
  private raiseShield(): void {
    if (!this.shieldUnlocked()) return;
    if (this.shieldActiveMs > 0 || this.shieldCooldownMs > 0) return;
    if (this.abilitiesSuppressed()) return;

    const player = this.playerId ? this.findTank(this.playerId) : undefined;
    if (!player) return;

    this.shieldActiveMs = SHIELD_DURATION_MS;
    player.isShielded = true;

    this.broadcast(ServerMessage.ShieldChanged, {
      active: true,
      durationMs: SHIELD_DURATION_MS,
    } satisfies ShieldChangedMessage);
  }

  /** Counts the shield down, drops it when it expires, then runs the cooldown. */
  private tickShield(deltaMs: number): void {
    if (this.shieldActiveMs > 0) {
      this.shieldActiveMs = Math.max(0, this.shieldActiveMs - deltaMs);
      if (this.shieldActiveMs === 0) {
        const player = this.playerId ? this.findTank(this.playerId) : undefined;
        if (player) player.isShielded = false;
        this.shieldCooldownMs = SHIELD_COOLDOWN_MS;

        this.broadcast(ServerMessage.ShieldChanged, {
          active: false,
          cooldownMs: SHIELD_COOLDOWN_MS,
        } satisfies ShieldChangedMessage);
      }
      return;
    }

    if (this.shieldCooldownMs > 0) {
      this.shieldCooldownMs = Math.max(0, this.shieldCooldownMs - deltaMs);
      if (this.shieldCooldownMs === 0) {
        this.broadcast(ServerMessage.ShieldChanged, {
          active: false,
          ready: true,
        } satisfies ShieldChangedMessage);
      }
    }
  }

  /**
   * True while the player is behind a raised shield.
   *
   * Every damage path consults this *except* boss contact — a boss hull still
   * runs a shielded player down, which is what keeps the bosses frightening.
   */
  private isShieldUp(tank: Tank): boolean {
    return !tank.isEnemy && tank.isShielded;
  }

  /**
   * The Effigy's copy of the deflector.
   *
   * Kept separate from {@link isShieldUp}, which is deliberately player-only —
   * the Effigy is an enemy, so it would otherwise never benefit from the flag
   * its own routine sets.
   */
  private isEffigyShielded(target: Tank): boolean {
    return target.variant === EFFIGY && target.isShielded;
  }

  /** Drops the shield and clears its timers — used on death and level change. */
  private resetShield(): void {
    this.shieldActiveMs = 0;
    this.shieldCooldownMs = 0;
    const player = this.playerId ? this.findTank(this.playerId) : undefined;
    if (player) player.isShielded = false;
  }

  /** Decays each sprung Mimic's lunge back to its steady hunting speed. */
  private tickMimicLunge(deltaMs: number): void {
    for (const [ownerId, remaining] of this.mimicLungeTimers) {
      const left = remaining - deltaMs;
      if (left > 0) {
        this.mimicLungeTimers.set(ownerId, left);
        continue;
      }

      this.mimicLungeTimers.delete(ownerId);
      const tank = this.findTank(ownerId);
      if (tank && tank.variant === MIMIC && !tank.isDisguised) {
        tank.speed = TANK_SPEED * MIMIC_SPEED_FACTOR;
      }
    }
  }

  // ------------------------------------------------------------------- ghosts

  /**
   * Counts down every uncloaked Ghost's timer and re-cloaks it when it expires.
   *
   * A Ghost starts cloaked, uncloaks when it fires (set in the `shoot` callback),
   * and re-cloaks once its {@link GHOST_UNCLOAK_MS} window has elapsed.
   */
  private tickGhostCloaks(deltaMs: number): void {
    for (const [ownerId, remaining] of this.ghostUncloakTimers) {
      const left = remaining - deltaMs;
      if (left <= 0) {
        this.ghostUncloakTimers.delete(ownerId);
        const tank = this.findTank(ownerId);
        if (tank && tank.variant === GHOST) tank.isCloaked = true;
      } else {
        this.ghostUncloakTimers.set(ownerId, left);
      }
    }
  }

  /**
   * Announces a boss jolt so the client can shake the camera. `subtle` marks the
   * Juggernaut's frequent block-crushes, which get a far gentler shake than the
   * Sweeper's wall rebounds.
   */
  private onSweeperBounce(boss: Tank, subtle = false): void {
    this.broadcast(ServerMessage.BossBounce, {
      x: boss.x + boss.width / 2,
      y: boss.y + boss.height / 2,
      subtle,
    } satisfies BossBounceMessage);
  }

  /**
   * Runs the player over if the boss's hull overlaps theirs.
   *
   * Note this path deliberately ignores the deflector shield: a boss body-check
   * kills through it. The shield answers shells, mines and blasts, so the player
   * still has to respect the boss itself rather than parking inside it.
   */
  private resolveSweeperContact(): void {
    if (!this.bossId) return;
    const boss = this.findTank(this.bossId);
    if (!boss) return;

    const player = this.playerId ? this.findTank(this.playerId) : undefined;
    if (!player || player.isInvulnerable) return;

    if (
      boxesOverlap(
        boss.x,
        boss.y,
        boss.width,
        boss.height,
        player.x,
        player.y,
        player.width,
        player.height,
      )
    ) {
      this.killPlayer();
    }
  }

  /** True while a boss unit is still on the field. */
  private hasBoss(): boolean {
    for (let i = 0; i < this.state.tanks.length; i++) {
      if (this.state.tanks.at(i).isBoss) return true;
    }
    return false;
  }

  /** Removes the player's tank and runs the death/respawn/game-over path. */
  private killPlayer(): void {
    const player = this.playerId ? this.findTank(this.playerId) : undefined;
    if (!player) return;

    // Both abilities die with the tank; the respawn comes back with them ready.
    this.resetShield();
    this.resetTeleport();
    this.resetBlast();
    this.resetRam();
    this.resetDecoy();
    this.blinkLockMs = 0;

    const index = this.state.tanks.indexOf(player);
    if (index >= 0) this.state.tanks.splice(index, 1);
    this.onTankDestroyed(player);
  }

  // ---------------------------------------------------------------- artillery

  /**
   * Runs the artillery boss's mortar cadence.
   *
   * While the boss lives it launches a strike at the player every few seconds
   * and lands each one a set delay later. Strikes already in flight keep falling
   * even after the boss dies, so a telegraphed shell still lands.
   */
  private updateArtillery(deltaMs: number): void {
    const boss = this.bossId ? this.findTank(this.bossId) : undefined;

    if (boss && boss.variant === ARTILLERY) {
      this.mortarCooldownMs += deltaMs;
      if (this.mortarCooldownMs >= MORTAR_INTERVAL_MS) {
        this.mortarCooldownMs -= MORTAR_INTERVAL_MS;
        this.launchMortar();
      }
    }

    for (let i = this.mortarStrikes.length - 1; i >= 0; i--) {
      const strike = this.mortarStrikes[i]!;
      strike.timerMs -= deltaMs;
      if (strike.timerMs <= 0) {
        this.mortarStrikes.splice(i, 1);
        this.detonateMortar(strike.x, strike.y);
        if (this.state.phase !== CampaignPhase.Playing) return;
      }
    }
  }

  /**
   * Launches a mortar barrage at the player.
   *
   * Each shell independently decides its aim: 50% chance to lead the player's
   * predicted position 1.5s ahead, 50% chance to target their exact current
   * coordinate — so the barrage is harder to dodge by simply stopping or turning.
   * One, two or three shells with equal probability — the barrage size is meant
   * to be unpredictable, so the player cannot learn a single dodge that always
   * works. Each shell is spread randomly within ±2 tiles of the chosen centre.
   */
  private launchMortar(): void {
    const player = this.playerId ? this.findTank(this.playerId) : undefined;
    if (!player) return;

    const intent = this.moveIntents.get(player.ownerId);
    const isMoving = intent !== undefined && this.tick < intent;
    const heading = DIRECTION_VECTORS[player.direction];

    const leadTime = 1.5;
    const playerSpeed = player.speed * (1000 / TICK_MS);

    const shellCount = 1 + Math.floor(Math.random() * 3);
    const spreadRange = 2 * TILE_SIZE;

    for (let i = 0; i < shellCount; i++) {
      const predictive = Math.random() > 0.5;
      const baseX = player.x + player.width / 2 + (predictive && isMoving ? heading.x * playerSpeed * leadTime : 0);
      const baseY = player.y + player.height / 2 + (predictive && isMoving ? heading.y * playerSpeed * leadTime : 0);

      const x = baseX + (Math.random() * 2 - 1) * spreadRange;
      const y = baseY + (Math.random() * 2 - 1) * spreadRange;
      this.mortarStrikes.push({ x, y, timerMs: MORTAR_DETONATION_MS });

      this.broadcast(ServerMessage.MortarWarning, {
        x,
        y,
        delay: MORTAR_DETONATION_MS,
      } satisfies MortarWarningMessage);
    }
  }

  /**
   * Lands a mortar: levels destructible tiles in a 3x3, and destroys the player
   * and any lesser enemies caught in the blast.
   */
  private detonateMortar(worldX: number, worldY: number): void {
    const cx = Math.floor(worldX / TILE_SIZE);
    const cy = Math.floor(worldY / TILE_SIZE);

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const tx = cx + dx;
        const ty = cy + dy;
        if (!isInsideGrid(tx, ty)) continue;
        const index = tileIndex(tx, ty);
        const tile = this.state.grid.at(index);
        if (tile === TileType.Brick || tile === TileType.Factory || tile === TileType.Radar) {
          this.state.grid[index] = TileType.Empty;
        }
      }
    }

    // The blast AABB: the 3x3 tile block centred on the impact tile.
    const bx = (cx - 1) * TILE_SIZE;
    const by = (cy - 1) * TILE_SIZE;
    const bw = 3 * TILE_SIZE;
    const bh = 3 * TILE_SIZE;

    // Lesser enemies in the blast are wiped out (never the boss itself).
    for (let i = this.state.tanks.length - 1; i >= 0; i--) {
      const tank = this.state.tanks.at(i);
      if (!tank.isEnemy || tank.isBoss) continue;
      if (boxesOverlap(bx, by, bw, bh, tank.x, tank.y, tank.width, tank.height)) {
        this.state.tanks.splice(i, 1);
        this.onTankDestroyed(tank);
      }
    }

    // A player caught in the blast is killed (unless still in respawn grace).
    const player = this.playerId ? this.findTank(this.playerId) : undefined;
    if (
      player &&
      !player.isInvulnerable &&
      !this.isShieldUp(player) &&
      boxesOverlap(bx, by, bw, bh, player.x, player.y, player.width, player.height)
    ) {
      this.killPlayer();
    }
  }

  /** Handles a tank reaching zero health (already removed from the state). */
  private onTankDestroyed(tank: Tank): void {
    this.broadcast(ServerMessage.TankDestroyed, {
      x: tank.x + tank.width / 2,
      y: tank.y + tank.height / 2,
      isEnemy: tank.isEnemy,
      heavy: tank.isEnemy && tank.maxHealth === 3,
    } satisfies TankDestroyedMessage);

    // A Hydra does not die so much as halve. Run this before the win check
    // sees an empty field, so the level only resolves on the last fragment.
    if (tank.variant === HYDRA) this.splitHydra(tank);

    this.lastShotAtMs.delete(tank.ownerId);
    this.moveIntents.delete(tank.ownerId);
    this.constructorCells.delete(tank.ownerId);
    this.trapperMineTimers.delete(tank.ownerId);
    this.ghostUncloakTimers.delete(tank.ownerId);
    this.stuckTimers.delete(tank.ownerId);
    this.mimicLungeTimers.delete(tank.ownerId);
    this.sapperLobTimers.delete(tank.ownerId);
    this.lurcherTimers.delete(tank.ownerId);
    if (tank.isBoss) this.bossId = null;

    // Enemies just vanish; only the player's death costs a life.
    if (tank.isEnemy) return;

    this.invulnerableUntilMs.delete(tank.ownerId);
    this.state.lives = Math.max(0, this.state.lives - 1);

    const player = this.state.players.get(tank.ownerId);
    if (player) player.lives = this.state.lives;

    if (this.state.lives <= 0) {
      this.state.phase = CampaignPhase.GameOver;
      console.log(`[room ${this.roomId}] out of lives — game over`);
      return;
    }

    this.respawnAtMs = this.elapsedMs + PLAYER_RESPAWN_DELAY_MS;
    if (player) player.respawnInSeconds = Math.ceil(PLAYER_RESPAWN_DELAY_MS / 1000);
  }

  /** Returns the player to the field once the delay is up and the pad is free. */
  private respawnPlayer(): void {
    if (this.respawnAtMs === null) return;

    if (this.elapsedMs < this.respawnAtMs) {
      const player = this.playerId ? this.state.players.get(this.playerId) : undefined;
      if (player) player.respawnInSeconds = Math.ceil((this.respawnAtMs - this.elapsedMs) / 1000);
      return;
    }

    if (this.spawnPlayer()) this.respawnAtMs = null;
  }

  /** Drops the respawn shield once the grace period is up. */
  private expireInvulnerability(): void {
    for (const [sessionId, until] of this.invulnerableUntilMs) {
      if (this.elapsedMs < until) continue;
      const tank = this.findTank(sessionId);
      if (tank) tank.isInvulnerable = false;
      this.invulnerableUntilMs.delete(sessionId);
    }
  }

  /** Advances the player tank while its movement intent is still live. */
  private moveTanks(): void {
    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      const expiresAtTick = this.moveIntents.get(tank.ownerId);
      if (expiresAtTick === undefined) continue;

      if (this.tick >= expiresAtTick) {
        this.moveIntents.delete(tank.ownerId);
        continue;
      }

      // fenceTop=false: the campaign has no anti-camp top-row fence.
      moveTank(this.state, tank, false);
    }
  }

  // ------------------------------------------------------------------- enemies

  /**
   * Releases one standard enemy on a level-scaled interval, up to the cap.
   *
   * Runs on every level, the boss level included — there the adds fight
   * alongside the Sweeper, which is exempt from the cap (see
   * {@link countStandardEnemies}).
   */
  private releaseEnemies(): void {
    let interval = Math.max(
      SPAWN_INTERVAL_MIN_MS,
      SPAWN_INTERVAL_BASE_MS - this.state.currentLevel * SPAWN_INTERVAL_PER_LEVEL_MS,
    );
    // Level 6 factory assault: 50% slower spawns to reduce flooding.
    if (this.currentWinCondition() === CampaignWinCondition.DestroyFactories) {
      interval = Math.round(interval * 1.5);
    }
    if (this.elapsedMs - this.lastEnemySpawnMs < interval) return;
    if (this.countStandardEnemies() >= MAX_ENEMIES) return;

    // Factory levels spawn guards beside the factories; elsewhere, at map edges.
    const spawn =
      this.currentWinCondition() === CampaignWinCondition.DestroyFactories
        ? this.factorySpawnPoint()
        : this.edgeSpawnPoint();
    if (!spawn) return; // no valid spawn this tick — try again next tick

    const tier = rollEnemyTier();
    let variant = "standard";
    let maxHealth = tier.health;
    let speed = tier.speed;
    let disguised = false;
    let cloaked = false;

    if (this.state.currentLevel === WARDEN_LEVEL) {
      // The Warden level: pick from the full miniboss pool at equal probability.
      variant = GAUNTLET_POOL[Math.floor(Math.random() * GAUNTLET_POOL.length)]!;
    } else if (this.state.currentLevel === GHOST_LEVEL && Math.random() < GHOST_CHANCE) {
      variant = GHOST;
    } else if (this.state.currentLevel === NULLIFIER_LEVEL) {
      // The Upload: Nullifiers switch the player's kit off while they hold the
      // zone, backed by cloaked Ghosts and shielded Aegis units.
      const roll = Math.random();
      if (roll < NULLIFIER_CHANCE) variant = NULLIFIER;
      else if (roll < 0.55) variant = GHOST;
      else if (roll < 0.75) variant = AEGIS;
    } else if (this.state.currentLevel === 18) {
      // The Fragments: fake intel Mimics and mine-laying Trappers.
      const roll = Math.random();
      if (roll < 0.30) variant = MIMIC;
      else if (roll < 0.50) variant = TRAPPER;
    } else if (this.state.currentLevel === LURCHER_LEVEL) {
      // The Final Breach: Lurchers reel the player back down a corridor they
      // are supposed to be sprinting along, while Constructors reseal it.
      const roll = Math.random();
      if (roll < LURCHER_CHANCE) variant = LURCHER;
      else if (roll < 0.55) variant = KAMIKAZE;
      else if (roll < 0.75) variant = CONSTRUCTOR;
    } else if (this.state.currentLevel === CORE_LEVEL) {
      variant = CORE_POOL[Math.floor(Math.random() * CORE_POOL.length)]!;
    } else if (this.spawnsConstructors() && Math.random() < CONSTRUCTOR_CHANCE) {
      variant = CONSTRUCTOR;
    } else if (
      this.currentWinCondition() === CampaignWinCondition.RetrieveIntel &&
      Math.random() < TRAPPER_CHANCE
    ) {
      variant = TRAPPER;
    } else if (this.state.currentLevel === AEGIS_LEVEL && Math.random() < AEGIS_CHANCE) {
      variant = AEGIS;
    } else if (this.state.currentLevel === JAMMER_LEVEL && Math.random() < JAMMER_CHANCE) {
      variant = JAMMER;
    } else if (this.state.currentLevel === MIMIC_LEVEL && Math.random() < MIMIC_CHANCE) {
      variant = MIMIC;
    } else if (this.state.currentLevel === SAPPER_LEVEL && Math.random() < SAPPER_CHANCE) {
      variant = SAPPER;
    } else if (Math.random() < this.kamikazeChance()) {
      variant = KAMIKAZE;
    }

    // Jammer cap: only one jammer allowed on the field at a time.
    if (variant === JAMMER) {
      const hasJammer = this.state.tanks.some((t) => t.isEnemy && t.variant === JAMMER);
      if (hasJammer) variant = "standard";
    }

    // Resolve variant-specific stats (health, speed, flags) after the pick, so
    // the Gauntlet path and the per-level paths share the same setup.
    switch (variant) {
      case CONSTRUCTOR:
        maxHealth = CONSTRUCTOR_HP;
        speed = TANK_SPEED * CONSTRUCTOR_SPEED_FACTOR;
        break;
      case TRAPPER:
        maxHealth = 1;
        speed = TANK_SPEED * TRAPPER_SPEED_FACTOR;
        break;
      case MIMIC:
        maxHealth = MIMIC_HP;
        speed = TANK_SPEED * MIMIC_CREEP_FACTOR;
        disguised = true;
        break;
      case KAMIKAZE:
        maxHealth = 1;
        speed = TANK_SPEED * (KAMIKAZE_SPEED_MIN + Math.random() * (KAMIKAZE_SPEED_MAX - KAMIKAZE_SPEED_MIN));
        break;
      case GHOST:
        cloaked = true;
        break;
      case SAPPER:
        maxHealth = SAPPER_HP;
        speed = TANK_SPEED * SAPPER_SPEED_FACTOR;
        break;
      case LURCHER:
        maxHealth = LURCHER_HP;
        speed = TANK_SPEED * LURCHER_SPEED_FACTOR;
        break;
      case NULLIFIER:
        maxHealth = NULLIFIER_HP;
        speed = TANK_SPEED * NULLIFIER_SPEED_FACTOR;
        break;
      case JAMMER:
        // Emplaced: it never moves, so the player has to go to it.
        speed = 0;
        break;
    }

    this.state.tanks.push(
      new Tank({
        x: spawn.x,
        y: spawn.y,
        width: TANK_SIZE,
        height: TANK_SIZE,
        ownerId: `enemy-${this.enemySequence++}`,
        maxHealth,
        speed,
        direction: Direction.Down,
        isEnemy: true,
        variant,
        isDisguised: disguised,
        isCloaked: cloaked,
      }),
    );

    this.lastEnemySpawnMs = this.elapsedMs;
  }

  /**
   * The next clear map-edge spawn point, or null if every one is occupied.
   *
   * Scans all spawn tiles starting from the rotating offset and returns the first
   * that is clear, rather than only probing a single index. This keeps the round
   * robin's variety but never deadlocks: a spawn tile a denser map has walled off
   * (or one a stuck enemy is sitting on) is simply skipped instead of jamming the
   * whole release loop on a tile that can never clear.
   */
  private edgeSpawnPoint(): { x: number; y: number } | null {
    for (let k = 0; k < ENEMY_SPAWNS.length; k++) {
      const tile = ENEMY_SPAWNS[(this.enemySequence + k) % ENEMY_SPAWNS.length]!;
      const x = tile.x * TILE_SIZE;
      const y = tile.y * TILE_SIZE;
      if (this.isSpawnClear(x, y)) return { x, y };
    }
    return null;
  }

  /**
   * An Empty tile beside a random factory, for a factory-level guard spawn.
   *
   * Picks factories at random and probes their four neighbours (also in a random
   * order) for the first open, unoccupied cell; null if none can take a spawn.
   */
  private factorySpawnPoint(): { x: number; y: number } | null {
    const factories: number[] = [];
    for (let i = 0; i < GRID_LENGTH; i++) {
      if (this.state.grid.at(i) === TileType.Factory) factories.push(i);
    }
    if (factories.length === 0) return null;

    const neighbours: Array<[number, number]> = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];

    for (let attempt = 0; attempt < factories.length; attempt++) {
      const index = factories[Math.floor(Math.random() * factories.length)]!;
      const fx = index % GRID_WIDTH;
      const fy = Math.floor(index / GRID_WIDTH);

      for (const [dx, dy] of [...neighbours].sort(() => Math.random() - 0.5)) {
        const tx = fx + dx;
        const ty = fy + dy;
        if (!isInsideGrid(tx, ty)) continue;
        if (this.state.grid.at(tileIndex(tx, ty)) !== TileType.Empty) continue;

        const x = tx * TILE_SIZE;
        const y = ty * TILE_SIZE;
        if (this.isSpawnClear(x, y)) return { x, y };
      }
    }
    return null;
  }

  /** Levels that mix trench-laying Constructors into their standard spawns. */
  private spawnsConstructors(): boolean {
    const win = this.currentWinCondition();
    return win === CampaignWinCondition.DestroyFactories || win === CampaignWinCondition.DefuseBombs;
  }

  /** Kamikaze spawn probability for the current level. */
  private kamikazeChance(): number {
    switch (this.currentWinCondition()) {
      case CampaignWinCondition.ZoneControl:
        return KAMIKAZE_CHANCE_ZONE;
      case CampaignWinCondition.AssassinateBoss:
        return KAMIKAZE_CHANCE_BOSS;
      default:
        return 0;
    }
  }

  /**
   * Constructors wall off the cell they just vacated, dragging a brick trail.
   *
   * Only converts a cell that is Empty and clear of every tank, so a trench can
   * never entomb the player or another unit chasing close behind.
   */
  private layTrenches(): void {
    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      if (tank.variant !== CONSTRUCTOR) continue;

      const gx = Math.floor(tank.x / TILE_SIZE);
      const gy = Math.floor(tank.y / TILE_SIZE);
      const prev = this.constructorCells.get(tank.ownerId);

      if (prev && (prev.gx !== gx || prev.gy !== gy) && isInsideGrid(prev.gx, prev.gy)) {
        const index = tileIndex(prev.gx, prev.gy);
        if (this.state.grid.at(index) === TileType.Empty && !this.isTileOccupied(prev.gx, prev.gy)) {
          this.state.grid[index] = TileType.Brick;
        }
      }

      this.constructorCells.set(tank.ownerId, { gx, gy });
    }
  }

  /** True when any tank's hull overlaps the tile at `(tileX, tileY)`. */
  private isTileOccupied(tileX: number, tileY: number): boolean {
    const x = tileX * TILE_SIZE;
    const y = tileY * TILE_SIZE;
    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      if (boxesOverlap(x, y, TILE_SIZE, TILE_SIZE, tank.x, tank.y, tank.width, tank.height)) return true;
    }
    return false;
  }

  /** Recomputes the hunter field toward the player on a short interval. */
  private refreshHunterField(): void {
    if (this.tick % HUNTER_FIELD_REBUILD_TICKS !== 0) return;
    this.hunterField.rebuildToward(this.state.grid, this.playerTargets());
  }

  /**
   * Whether this tank is steered by the hunter flow field toward the player.
   *
   * True for the ordinary hunters, Aegis units and Mimics (disguised ones creep,
   * revealed ones sprint); false for the friendlies and every self-steering unit
   * — the bosses, Trappers and Jammers — which move by their own routines.
   */
  private usesHunterField(tank: Tank): boolean {
    if (!tank.isEnemy) return false;
    switch (tank.variant) {
      case SWEEPER:
      case ARTILLERY:
      case JUGGERNAUT:
      case CORE:
      case WARDEN:
      case TRAPPER:
      case JAMMER:
      case SAPPER:
      case BASTION:
      case ARCHITECT:
        return false;
      default:
        return true;
    }
  }

  private static readonly CARDINAL_DIRS: readonly Direction[] = [
    Direction.Up,
    Direction.Right,
    Direction.Down,
    Direction.Left,
  ];

  /**
   * A random cardinal direction out of the tank's current tile whose neighbour
   * is Empty or Brick, or null when walled in on every side.
   *
   * Used instead of a blind `random() * 4` so a tank pinned against a wall can
   * never re-roll straight back into it.
   */
  private randomPassableDir(tank: Tank, exclude?: Direction): Direction | null {
    const tx = Math.floor((tank.x + tank.width / 2) / TILE_SIZE);
    const ty = Math.floor((tank.y + tank.height / 2) / TILE_SIZE);

    const options: Direction[] = [];
    for (const dir of CampaignRoom.CARDINAL_DIRS) {
      if (dir === exclude) continue;
      const step = DIRECTION_VECTORS[dir];
      const nx = tx + step.x;
      const ny = ty + step.y;
      if (!isInsideGrid(nx, ny)) continue;
      const tile = this.state.grid.at(tileIndex(nx, ny));
      if (tile === TileType.Empty || tile === TileType.Brick) options.push(dir);
    }

    if (options.length === 0) return null;
    return options[Math.floor(Math.random() * options.length)]!;
  }

  /**
   * Nudges enemies that haven't moved for 750 ms. Instead of a separate chaotic
   * mode, the flow field keeps running normally — this is a per-tick fallback
   * that picks a random passable cardinal direction and moves the tank (skipping
   * tank-tank collision so clusters can break apart). Once the tank lands on a
   * new tile the flow field re-evaluates and usually gives a non-stuck route.
   */
  private tickAntiStuck(deltaMs: number): void {
    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      // Covers wanderers (Trappers, Jammers) as well as flow-field hunters —
      // any non-boss enemy can gridlock, and the ones that steer themselves
      // have no field to fall back on. Bosses keep their own routines.
      if (!tank.isEnemy || tank.isBoss) continue;

      // A Sapper standing its ground on purpose is not stuck.
      if (this.sapperHolding.has(tank.ownerId)) {
        const held = this.stuckTimers.get(tank.ownerId);
        if (held) {
          held.stuckMs = 0;
          held.prevX = tank.x;
          held.prevY = tank.y;
        }
        continue;
      }

      let entry = this.stuckTimers.get(tank.ownerId);
      if (!entry) {
        entry = { prevX: tank.x, prevY: tank.y, stuckMs: 0 };
        this.stuckTimers.set(tank.ownerId, entry);
      }

      const dx = Math.abs(tank.x - entry.prevX);
      const dy = Math.abs(tank.y - entry.prevY);
      if (dx < 1 && dy < 1) {
        entry.stuckMs += deltaMs;
      } else {
        entry.stuckMs = 0;
        entry.prevX = tank.x;
        entry.prevY = tank.y;
        continue;
      }

      if (entry.stuckMs < 750) continue;

      // A tank shoved off the tile grid by the separation pass can never turn
      // again under grid-aligned steering, so it stays frozen against a wall.
      // Re-snap it before anything else — this restores the alignment the
      // steering routines depend on.
      if (tank.x % TILE_SIZE !== 0 || tank.y % TILE_SIZE !== 0) {
        const snapX = Math.round(tank.x / TILE_SIZE) * TILE_SIZE;
        const snapY = Math.round(tank.y / TILE_SIZE) * TILE_SIZE;
        if (!isBlocked(this.state, snapX, snapY, tank.width, tank.height)) {
          tank.x = snapX;
          tank.y = snapY;
        }
      }

      // Turn to a random passable direction that isn't the current blocked one.
      tank.direction = this.randomPassableDir(tank, tank.direction) ?? tank.direction;

      // Move in the chosen direction, checking terrain only — tank-tank
      // collision is skipped so clustered enemies can push through each
      // other. Clamp to the next tile boundary to preserve grid alignment.
      const heading = DIRECTION_VECTORS[tank.direction];
      const hdx = heading.x * tank.speed;
      const hdy = heading.y * tank.speed;
      let nextX = tank.x;
      let nextY = tank.y;
      if (hdx !== 0) {
        const raw = tank.x + hdx;
        const t = Math.floor(tank.x / TILE_SIZE);
        if (hdx > 0) { const b = (t + 1) * TILE_SIZE; nextX = raw > b ? b : raw; }
        else { const b = tank.x % TILE_SIZE === 0 ? tank.x - TILE_SIZE : t * TILE_SIZE; nextX = raw < b ? b : raw; }
      }
      if (hdy !== 0) {
        const raw = tank.y + hdy;
        const t = Math.floor(tank.y / TILE_SIZE);
        if (hdy > 0) { const b = (t + 1) * TILE_SIZE; nextY = raw > b ? b : raw; }
        else { const b = tank.y % TILE_SIZE === 0 ? tank.y - TILE_SIZE : t * TILE_SIZE; nextY = raw < b ? b : raw; }
      }
      if (!isBlocked(this.state, nextX, nextY, tank.width, tank.height)) {
        tank.x = nextX;
        tank.y = nextY;
      }

      entry.prevX = tank.x;
      entry.prevY = tank.y;
      entry.stuckMs = 0;
    }
  }

  /**
   * Breaks enemy traffic jams left by this tick's steering.
   *
   * A cluster of field-followers can gridlock: each wants to advance but is
   * wedged flush against the hulls ahead, so none actually moves and — being
   * perfectly tile-aligned and not overlapping — {@link separateTanks} sees
   * nothing to disperse. For any mover that held station with another hull
   * directly in its path, a sub-pixel jitter is injected; the slight overlap it
   * creates is exactly what the separation pass needs to shove the pile apart,
   * and any tank left a hair off-grid re-snaps on its next step.
   */
  private jitterStuckMovers(before: Map<string, { x: number; y: number }>): void {
    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      const prev = before.get(tank.ownerId);
      if (!prev) continue;

      // Only nudge a tank that was aligned (a genuine decision point), did not
      // move at all, and is stalled by another hull rather than a wall.
      const aligned = tank.x % TILE_SIZE === 0 && tank.y % TILE_SIZE === 0;
      if (!aligned) continue;
      if (tank.x !== prev.x || tank.y !== prev.y) continue;
      if (!this.tankBlockingAhead(tank)) continue;

      tank.x += (Math.random() - 0.5) * 2 * TRAFFIC_JITTER;
      tank.y += (Math.random() - 0.5) * 2 * TRAFFIC_JITTER;
    }
  }

  /** True when another tank's hull occupies the tile directly ahead of `tank`. */
  private tankBlockingAhead(tank: Tank): boolean {
    const heading = DIRECTION_VECTORS[tank.direction];
    const ax = tank.x + heading.x * TILE_SIZE;
    const ay = tank.y + heading.y * TILE_SIZE;

    for (let i = 0; i < this.state.tanks.length; i++) {
      const other = this.state.tanks.at(i);
      if (other === tank) continue;
      if (boxesOverlap(ax, ay, tank.width, tank.height, other.x, other.y, other.width, other.height)) {
        return true;
      }
    }
    return false;
  }

  /** The player's current tile, as a flow-field seed (empty when dead). */
  private playerTargets(): { x: number; y: number }[] {
    // A standing decoy beacon *is* the target: every field-following enemy
    // routes to it instead, which is the entire effect of the ability.
    if (this.decoy) {
      return [
        {
          x: Math.floor(this.decoy.x / TILE_SIZE),
          y: Math.floor(this.decoy.y / TILE_SIZE),
        },
      ];
    }

    const targets: { x: number; y: number }[] = [];
    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      if (tank.isEnemy) continue;
      targets.push({
        x: Math.floor((tank.x + tank.width / 2) / TILE_SIZE),
        y: Math.floor((tank.y + tank.height / 2) / TILE_SIZE),
      });
    }
    return targets;
  }

  // -------------------------------------------------------------- input & fire

  /** Turns the player tank and keeps it rolling for the next few ticks. */
  private requestMove(ownerId: string, direction: Direction): void {
    const tank = this.findTank(ownerId);
    if (!tank) return;

    // A surge is committed: steering input is ignored until it ends, so the ram
    // travels the line it was launched along instead of being curved mid-charge
    // by a held key (which would also stack ordinary movement on top of it).
    if (this.ramActiveMs > 0 && ownerId === this.playerId) return;

    tank.direction = direction;
    this.moveIntents.set(ownerId, this.tick + MOVE_INTENT_TTL_TICKS);
  }

  private playerShoot(ownerId: string): void {
    const tank = this.findTank(ownerId);
    if (!tank) return;

    let cooldown = this.profileFor(tank).cooldownMs;
    if (this.state.currentLevel > 10) cooldown *= 0.70;
    // While any Jammer is on the field the player's weapons are throttled.
    if (this.jammersActive()) cooldown *= JAMMER_COOLDOWN_MULTIPLIER;

    if (!this.readyToShoot(tank, cooldown)) return;
    this.fire(tank);
  }

  /** True while any Jammer enemy is alive on the field. */
  private jammersActive(): boolean {
    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      if (tank.isEnemy && tank.variant === JAMMER) return true;
    }
    return false;
  }

  /**
   * True when `target` sits inside the aura of an Aegis unit and should soak a
   * shell for no damage.
   *
   * Only enemies are protected, and an Aegis never shields itself — only a
   * *different* Aegis can cover one.
   */
  private isAegisShielded(target: Tank): boolean {
    if (!target.isEnemy) return false;

    const tcx = target.x + target.width / 2;
    const tcy = target.y + target.height / 2;

    for (let i = 0; i < this.state.tanks.length; i++) {
      const shield = this.state.tanks.at(i);
      if (shield === target) continue;

      let radius: number;
      if (shield.variant === AEGIS) radius = AEGIS_RADIUS;
      else if (shield.variant === WARDEN) radius = WARDEN_SHIELD_RADIUS;
      else continue;

      const dx = shield.x + shield.width / 2 - tcx;
      const dy = shield.y + shield.height / 2 - tcy;
      if (Math.hypot(dx, dy) <= radius) return true;
    }
    return false;
  }

  /** Whether a tank may fire: cooldown elapsed, and (enemies) no shell in flight. */
  private readyToShoot(tank: Tank, cooldownMs: number): boolean {
    const lastShot = this.lastShotAtMs.get(tank.ownerId);
    if (lastShot !== undefined && this.elapsedMs - lastShot < cooldownMs) return false;
    if (tank.isEnemy) return !this.state.bullets.some((bullet) => bullet.ownerId === tank.ownerId);
    return true;
  }

  private profileFor(tank: Tank): TierProfile {
    if (tank.isEnemy) return ENEMY_PROFILE;
    return tierProfile(this.state.players.get(tank.ownerId)?.tier ?? 1);
  }

  /** Fires a volley from the tank's muzzle and starts its cooldown. */
  private fire(tank: Tank): void {
    const cooldownJitter = tank.isEnemy ? Math.random() * 1000 : 0;
    this.lastShotAtMs.set(tank.ownerId, this.elapsedMs + cooldownJitter);

    if (!tank.isEnemy) {
      const player = this.state.players.get(tank.ownerId);
      if (player) player.shotsFired++;
    }

    const profile = this.profileFor(tank);
    const heading = DIRECTION_VECTORS[tank.direction];
    const across = { x: -heading.y, y: heading.x };

    const bulletSpeed = !tank.isEnemy && this.state.currentLevel > 10
      ? profile.bulletSpeed * 1.20
      : profile.bulletSpeed;

    for (const offset of volleyOffsets(profile.volley)) {
      this.state.bullets.push(
        new Bullet({
          x: tank.x + (tank.width - BULLET_SIZE) / 2 + heading.x * (tank.width / 2) + across.x * offset,
          y: tank.y + (tank.height - BULLET_SIZE) / 2 + heading.y * (tank.height / 2) + across.y * offset,
          width: BULLET_SIZE,
          height: BULLET_SIZE,
          ownerId: tank.ownerId,
          damage: BULLET_DAMAGE,
          direction: tank.direction,
          speed: bulletSpeed,
          isEnemy: tank.isEnemy,
          piercesSteel: profile.piercesSteel,
        }),
      );
    }
  }

  // ------------------------------------------------------------------- helpers

  private findTank(ownerId: string): Tank | undefined {
    return this.state.tanks.find((tank) => tank.ownerId === ownerId);
  }

  /** Standard (non-boss) enemies on the field; the boss is exempt from the cap. */
  private countStandardEnemies(): number {
    let count = 0;
    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      if (tank.isEnemy && !tank.isBoss) count++;
    }
    return count;
  }

  /** A spawn point is clear when no wall and no other tank occupies it. */
  private isSpawnClear(x: number, y: number): boolean {
    if (isBlocked(this.state, x, y, TANK_SIZE, TANK_SIZE)) return false;

    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      if (
        x < tank.x + tank.width &&
        x + TANK_SIZE > tank.x &&
        y < tank.y + tank.height &&
        y + TANK_SIZE > tank.y
      ) {
        return false;
      }
    }

    return true;
  }

  /** Drops every tank and bullet belonging to `ownerId`. */
  private removeOwned(ownerId: string): void {
    for (let i = this.state.tanks.length - 1; i >= 0; i--) {
      if (this.state.tanks.at(i).ownerId === ownerId) this.state.tanks.splice(i, 1);
    }
    for (let i = this.state.bullets.length - 1; i >= 0; i--) {
      if (this.state.bullets.at(i).ownerId === ownerId) this.state.bullets.splice(i, 1);
    }
  }
}
