import { Room, type Client } from "colyseus";

import {
  CAMPAIGN_LEVELS,
  CAMPAIGN_UPGRADES,
  BossKind,
  BossTiming,
  CampaignMessage,
  CampaignPhase,
  CampaignWinCondition,
  ClientMessage,
  EMP_BOSS_DURATION_MS,
  EMP_COOLDOWN_MS,
  EMP_DURATION_MS,
  EMP_RADIUS_TILES,
  EMP_UNLOCK_LEVEL,
  EnemyVariant,
  LASER_BRICK_LIMIT,
  LASER_COOLDOWN_MS,
  LASER_DAMAGE,
  LASER_RANGE_TILES,
  LASER_UNLOCK_LEVEL,
  TRANSLOCATE_COOLDOWN_MS,
  TRANSLOCATE_SEARCH_TILES,
  TRANSLOCATE_UNLOCK_LEVEL,
  STRIKE_COOLDOWN_MS,
  STRIKE_DAMAGE,
  STRIKE_DELAY_MS,
  STRIKE_RADIUS_TILES,
  STRIKE_UNLOCK_LEVEL,
  bombSecondsForLevel,
  defendSecondsForLevel,
  levelAt,
  objectivesAreOrdered,
  purgeCountForLevel,
  rollSpawnVariant,
  zoneSecondsForLevel,
  type CampaignLevel,
  Direction,
  GRID_HEIGHT,
  GRID_LENGTH,
  GRID_WIDTH,
  BLAST_BRICK_RADIUS_TILES,
  BLAST_COOLDOWN_MS,
  BLAST_RADIUS_TILES,
  BLAST_UNLOCK_LEVEL,
  BOMB_DEFUSAL_DURATION_SECONDS,
  JAMMER_COOLDOWN_MULTIPLIER,
  AUTOLOADER_FIRE_FACTOR,
  campaignShootCooldownMs,
  DECOY_COOLDOWN_MS,
  DECOY_LURE_CHANCE,
  rollDecoyLure,
  DECOY_DURATION_MS,
  DECOY_MIN_COOLDOWN_MS,
  DECOY_UNLOCK_LEVEL,
  DECOY_UPGRADE_MS,
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
  UPGRADE_CHOICES,
  findUpgrade,
  isUpgradeOfferable,
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
  isAimedMessage,
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
  type EmpChangedMessage,
  type EmpFiredMessage,
  type LaserChangedMessage,
  type LaserFiredMessage,
  type StrikeChangedMessage,
  type TranslocateChangedMessage,
  type UpgradeOfferMessage,
  type TeleportChangedMessage,
  type TankDestroyedMessage,
} from "@battletank/shared";

import {
  BULLET_DAMAGE,
  BULLET_SIZE,
  DIRECTION_VECTORS,
  ENEMY_CHAOS_CHANCE,
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
 * How early a player's shot may arrive and still be honoured, in ms.
 *
 * The client throttles itself against the same reload formula the server
 * enforces, but the two clocks cannot line up exactly: the client measures in
 * wall time while the server measures in `elapsedMs`, which only advances once
 * per tick. Two shots sent exactly one reload apart can therefore be *stamped*
 * up to a whole tick closer together than that, and network jitter adds more on
 * top — so the second one was being silently dropped. The client had already
 * played its firing sound by then, which is what the bug looked like from the
 * outside: the gun fires and no shell comes out.
 *
 * It shows up once the reload is short, because the same fixed error is a much
 * larger share of it: an Autoloader-stacked, refitted tank reloads in ~340ms,
 * where one tick plus a little jitter is most of a tenth of the gap.
 *
 * A shot inside this window is accepted and then *stamped at the time it should
 * have arrived* (see {@link CampaignRoom.playerShoot}), so absorbing jitter can
 * never accumulate into a genuinely higher rate of fire.
 */
const SHOOT_JITTER_GRACE_MS = TICK_MS + 60;

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
 *
 * Trimmed 20% from the original 2.0-2.5: still quicker than the player, but
 * slow enough that a rusher spotted across the field can actually be shot or
 * driven away from rather than simply landing on them.
 */
const KAMIKAZE_SPEED_MIN = 1.6;
const KAMIKAZE_SPEED_MAX = 2.0;

/** The enemy `variant` string for the fast contact-detonating rushers. */
const KAMIKAZE = "kamikaze";

/** Slack, in px, for judging a kamikaze "in contact" with the player. */
const KAMIKAZE_CONTACT_PADDING = 6;

/**
 * How far from every player a rusher must appear, in tiles.
 *
 * A kamikaze is meant to be a threat the player sees coming and answers. One
 * released onto a spawn tile a few squares away is not a threat, it is a
 * coin-flip — so a spawn inside this radius is refused and the release either
 * moves to a farther tile or comes out as an ordinary tank.
 */
const KAMIKAZE_MIN_SPAWN_TILES = 10;

/** The Level 5 boss hitbox, three tiles square — massive. */
const SWEEPER_SIZE = TILE_SIZE * 3;

/** The boss's ballistic speed on each axis, in pixels per second. */
const SWEEPER_SPEED = 120;

/** The boss's hit points. */
const SWEEPER_HP = 32;

/** Chance a wall bounce turns into a homing lunge straight at the player. */
const SWEEPER_HOMING_CHANCE = 0.33;

/** The enemy `variant` string for the Level 6 trench-laying miniboss. */
const CONSTRUCTOR = "constructor";



/** A Constructor's hit points — tankier than the rank and file. */
const CONSTRUCTOR_HP = 1;

/** A Constructor's speed as a fraction of the player's base speed (25% slower). */
const CONSTRUCTOR_SPEED_FACTOR = 0.75;

/** The enemy `variant` string for the Level 8 mine-laying miniboss. */
const TRAPPER = "trapper";


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

/**
 * A hostile carrier's hit points.
 *
 * Higher than the allied one's: the raid levels are a race, and a carrier that
 * folds to two shells would never get far enough down the road to be one.
 */
const HOSTILE_CONVOY_HP = 14;

/** A hostile carrier's speed along its route, in px/s. */
const HOSTILE_CONVOY_SPEED = 46;

/** The payload breaker's speed while it is being escorted, in px/s. */
const PAYLOAD_VY = -52;

/** How close a player must be, in tiles, for the payload to roll. */
const PAYLOAD_ESCORT_TILES = 5;

/**
 * How far ahead of itself the breaker clears brick, in ms of travel.
 *
 * Far enough that it never grinds to a halt against a wall it is meant to be
 * eating, short enough that it is visibly cutting a doorway rather than
 * clearing the level from a distance.
 */
const PAYLOAD_BREACH_LOOKAHEAD_MS = 400;

/** The `variant` string for the Level 10 mobile artillery boss. */
const ARTILLERY = "artillery";

/**
 * The artillery boss's hit points.
 *
 * Up from 12. At the old figure a player who simply drove at it could finish
 * the fight before it had launched a second barrage — the flee logic buys it
 * distance, not time, and 12 shells is not much of either.
 */
const ARTILLERY_HP = 32;

/**
 * How much damage the artillery absorbs between relocations.
 *
 * The counter to closing on it. Running it down across the map is meant to be
 * the work of the fight, and at 25 hit points doing that once was still the
 * whole fight — so every five points it breaks contact and reappears somewhere
 * else on the field, and the approach has to be made again.
 */
const ARTILLERY_BLINK_DAMAGE = 5;

/** How far from every player a relocating artillery must land, in tiles. */
const ARTILLERY_BLINK_MIN_TILES = 12;

/** Placement attempts per relocation before it gives up and stays put. */
const ARTILLERY_BLINK_ATTEMPTS = 120;

/** The artillery boss hitbox, one and a half tiles square. */
const ARTILLERY_SIZE = Math.round(TILE_SIZE * 1.5);

/**
 * The artillery boss's flee speed, in pixels per second — half the player's,
 * whose {@link TANK_SPEED} px/tick works out to `TANK_SPEED * TICK_RATE` px/s.
 * It skulks away from the player to keep cover between them.
 */
const ARTILLERY_SPEED = TANK_SPEED * (1000 / TICK_MS) * 0.5;

/**
 * How close the player must get, in tiles, before the artillery runs.
 *
 * It used to flee from any range at all, which meant a boss at half the
 * player's speed still had the whole map to retreat across and the fight became
 * a chase with no end to it. Beyond this it holds its ground and shells; inside
 * it, it backs off — so closing the distance is still work, but work that
 * finishes.
 */
const ARTILLERY_FLEE_TILES = 11;


/** How often the artillery launches a mortar strike, in ms. */
const MORTAR_INTERVAL_MS = 4200;

/** How long a mortar is telegraphed before it detonates, in ms. */
const MORTAR_DETONATION_MS = 2000;

/** The `variant` string for the Level 11 shield miniboss. */
const AEGIS = "aegis";



/** Radius, in px, of the Aegis protective aura. */
const AEGIS_RADIUS = 3 * TILE_SIZE;

/** The `variant` string for the Level 12 jammer miniboss. */
const JAMMER = "jammer";



/** The `variant` string for the Level 13 disguised-loot miniboss. */
const MIMIC = "mimic";



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


/** The Juggernaut's hit points. */
const JUGGERNAUT_HP = 32;

/** The Juggernaut hitbox, two tiles square — massive. */
const JUGGERNAUT_SIZE = TILE_SIZE * 2;

/**
 * The Juggernaut's chase speed, in pixels per second — half the player's, whose
 * {@link TANK_SPEED} pixels-per-tick works out to `TANK_SPEED * TICK_RATE` px/s.
 */
const JUGGERNAUT_SPEED = TANK_SPEED * (1000 / TICK_MS) * 0.625;

/** The `variant` string for the Level 16 cloaking Ghost miniboss. */
const GHOST = "ghost";



/** How long (ms) a Ghost stays visible after it fires a shot. */
const GHOST_UNCLOAK_MS = 2000;


/** The `variant` string for the Level 15 Warden siege boss. */
const WARDEN = "warden";

/** The Warden's hit points. */
const WARDEN_HP = 72;

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




// ------------------------------------------------------------------ lurcher
//
// The first enemy that takes the player's spacing away from them. Everything
// else is avoided by positioning; this one reaches out and moves the player,
// which is the natural counter to a kit built around shields, blinks and kiting.

/** The `variant` string for the grappling Lurcher. */
const LURCHER = "lurcher";



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


/**
 * The Effigy's base hit points, before it copies anything.
 *
 * The number it actually fights on is this plus whatever the player's own hull
 * upgrades come to — see {@link CampaignRoom.effigyMirror}. A fixed pool was
 * the root of the fight being a let-down: the briefing promises a machine
 * carrying everything the Protocol watched the player use, and then fielded the
 * same twenty-point hull whether it was facing a bare chassis or one that had
 * banked four hulls, three reloads and three overdrives across forty levels.
 */
const EFFIGY_HP = 30;

/** Hit points the Effigy gains per Reinforced Hull the player banked. */
const EFFIGY_HP_PER_HULL = 4;

/**
 * How far off its row or column the player may be for the Effigy to aim, in px.
 *
 * The other half of why the duel was a let-down. The Effigy is steered by the
 * flow field and fired along whatever heading that steering had left it on,
 * gated only on line of sight — so it spent the fight shooting down empty
 * corridors it happened to be driving along. It turns onto the player before it
 * fires now, which is what a competent player does and what the level says it
 * does.
 */
const EFFIGY_AIM_SLACK = TILE_SIZE * 0.9;

/** Cooldown multiplier once the Effigy drops below half its health. */
const EFFIGY_ENRAGE_FACTOR = 0.55;

/** Gap between the wounded Effigy's called strikes, in ms. */
const EFFIGY_STRIKE_INTERVAL_MS = 5200;

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

/** Gap between the Effigy's ram surges, in ms. */
const EFFIGY_RAM_COOLDOWN_MS = 8000;

/** How far down a lane the Effigy will start a charge, in tiles. */
const EFFIGY_RAM_MIN_TILES = 3;
const EFFIGY_RAM_MAX_TILES = 11;

/** How far off a lane's centre line the player may be for a charge, in px. */
const EFFIGY_RAM_ALIGN_SLACK = TILE_SIZE * 0.75;

/** Gap between the Effigy's decoys, in ms. */
const EFFIGY_DECOY_COOLDOWN_MS = 13_000;

/** How long one of the Effigy's mirages stands before it fades, in ms. */
const EFFIGY_DECOY_DURATION_MS = 6000;

/** How close the player must be, in tiles, for a mirage to be worth dropping. */
const EFFIGY_DECOY_TRIGGER_TILES = 10;

/**
 * How long the Effigy may sit in one tile before it is treated as wedged.
 *
 * Bosses are exempt from the general anti-stuck pass, and this one is steered
 * by the flow field: anything that leaves it off the tile lattice — a blink or
 * a charge that ended mid-tile, a traffic jitter — leaves it unable to ever
 * turn again, so it drives into the nearest wall and stays there for the rest
 * of the fight. Measured in tiles rather than pixels so a hull grinding back
 * and forth against an obstacle still counts as stuck.
 */
const EFFIGY_STUCK_MS = 1500;

// ------------------------------------------------------------------ bastion
//
// A boss that cannot be beaten by out-shooting it. Its frontal plating turns
// every shell, and it keeps rotating to face the player — so the fight is a
// geometry problem, not a damage race, and the blink drive is the answer to it.

/** The `variant` string for the Level 12 Bastion boss. */
const BASTION = "bastion";


/** The Bastion's hit points. Low, because landing a hit at all is the work. */
const BASTION_HP = 28;

/** The Bastion's hitbox, two tiles square. */
const BASTION_SIZE = TILE_SIZE * 2;

/** The Bastion's advance speed, in px/s — slow enough to be circled. */
const BASTION_SPEED = TANK_SPEED * (1000 / TICK_MS) * 0.35;

/**
 * How long the Bastion takes to swing its gun 90 degrees, in ms.
 *
 * This is only the turret now — where its shells go, not where its armour is.
 */
const BASTION_TURN_INTERVAL_MS = 1100;

/**
 * How long each face stays unarmoured before the weak point moves on, in ms.
 *
 * The encounter's tuning knob: it is how long the player has to read which side
 * is open, get there, and put shells into it before it seals again.
 *
 * The weak point advances one cardinal at a time in a fixed direction rather
 * than jumping at random. A rotation can be anticipated and driven around,
 * which is a fight; a coin flip every two seconds is only a wait.
 */
const BASTION_WEAK_ROTATE_MS = 2000;

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


/** How many children each surviving tier splits into. */
const HYDRA_SPLIT_COUNT = 2;

/**
 * The Hydra's tiers, largest first. A unit splits into {@link HYDRA_SPLIT_COUNT}
 * of the next entry; the last tier is terminal and simply dies.
 */
const HYDRA_TIERS: readonly { size: number; health: number; speed: number }[] = [
  { size: TILE_SIZE * 3, health: 22, speed: TANK_SPEED * 0.5 },
  { size: TILE_SIZE * 2, health: 8, speed: TANK_SPEED * 0.85 },
  { size: TILE_SIZE, health: 3, speed: TANK_SPEED * 1.35 },
];

/** How far apart split children are nudged, in px, so they do not stack. */
const HYDRA_SPLIT_SPREAD = TILE_SIZE;

/**
 * The size at or below which a Hydra fragment behaves like an ordinary tank.
 *
 * Anything larger drives itself (see {@link moveHydra}) and ploughs through
 * whatever it meets. A multi-tile hull steered by the shared mover is refused
 * every step that would touch another tank, so the old three-tile Hydra spent
 * the fight wedged against its own escort instead of hunting the player.
 */
const HYDRA_CRUSHER_SIZE = TILE_SIZE;

// ---------------------------------------------------------------- architect
//
// The boss that is not the thing you shoot. It is immune while its pylons
// stand, and spends the fight closing the arena in from the edges — so the
// player's real opponent is the shrinking floor, and the pylons are the timer.

/** The `variant` string for the Level 20 Architect boss. */
const ARCHITECT = "architect";


/**
 * The Architect's hit points, once its pylons are down and it is exposed.
 *
 * Up from 14. The pylon phase is the interesting half of the fight and 14 hit
 * points meant the other half lasted about eight seconds: the walls stopped,
 * the boss trundled over, and it was dead before it had done anything with the
 * arena it had spent the whole encounter building.
 */
const ARCHITECT_HP = 46;

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

/**
 * The Architect's speed once its pylons are down, in px/s.
 *
 * It is stationary while it is sealed — it is building, not fighting — but a
 * boss that never moves at all once it is exposed simply stands there being
 * shot, which reads as broken rather than as beaten. Losing the pylons turns it
 * into a grinding hunter, fast enough that circling it costs the player ground.
 */
const ARCHITECT_SPEED = TANK_SPEED * (1000 / TICK_MS) * 0.65;

/**
 * Shells in an exposed Architect's lob barrage.
 *
 * A single telegraphed lob is one circle to step out of, which a player who is
 * already kiting the boss does without noticing. A spread has to be read.
 */
const ARCHITECT_LOB_SHELLS = 3;

/**
 * Gap between the Architect's charges, in ms.
 *
 * The answer to the complaint the exposed phase actually had: a boss whose only
 * move is walking toward you is beaten by walking away at a constant radius
 * forever. A charge breaks that circle — it closes the gap faster than the
 * player can widen it, so the fight has a rhythm of retreat and dodge instead
 * of one long orbit.
 */
const ARCHITECT_CHARGE_COOLDOWN_MS = 7000;

/** How long the Architect telegraphs a charge before it launches, in ms. */
const ARCHITECT_CHARGE_WINDUP_MS = 900;

/** How long a charge runs once it launches, in ms. */
const ARCHITECT_CHARGE_MS = 1100;

/** Charge speed, as a multiple of the exposed walking speed. */
const ARCHITECT_CHARGE_SPEED_FACTOR = 3;

/** Farthest the player may be, in tiles, for a charge to be worth starting. */
const ARCHITECT_CHARGE_MAX_TILES = 16;

/** Lob interval multiplier once the Architect is exposed — twice the rate. */
const ARCHITECT_ENRAGED_LOB_FACTOR = 0.5;

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


/** The Core's hit points — a large pool for the final boss. */
const CORE_HP = 72;

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
 * HP thresholds for Core phase transitions.
 *
 * Kept at roughly the fractions of the pool they were before — a little over
 * two thirds, and a little under a third — so the phases still last about as
 * long relative to each other now the pool itself is much bigger.
 */
const CORE_PHASE2_HP = 50;
const CORE_PHASE3_HP = 22;

/** Core Phase 2: shotgun fire interval, in ms. */
const CORE_PHASE2_SHOOT_MS = 1900;

/** Core Phase 2/3 chase speeds — fractions of the player's base px/s. */
const CORE_PHASE2_SPEED = TANK_SPEED * (1000 / TICK_MS) * 0.4;

/**
 * The Core's speed in its last phase — half again its phase-2 pace, and past
 * the player's own base speed.
 *
 * The spiral fire is meant to be dodged on the move, which only asks anything
 * of the player if the Core can actually stay with them. At 0.7 it could be
 * simply walked away from and the finale was fought at a comfortable distance.
 */
const CORE_PHASE3_SPEED = TANK_SPEED * (1000 / TICK_MS) * 1.05;

/** Core Phase 3: spiral fire rate — one bullet every 320ms. */
const CORE_SPIRAL_INTERVAL_MS = 320;

/** How often the Logic Core launches a mortar barrage, in ms. */
const CORE_MORTAR_INTERVAL_MS = 5500;

/** The enemy `variant` string for the Level 5 boss. */
const SWEEPER = "sweeper";

/**
 * Boss hulls that kill on contact.
 *
 * The heavy ones — anything that is meant to read as a machine you do not want
 * to be standing in front of. The Artillery is deliberately absent: it is a gun
 * that backs away, and being run over by it was never part of the fight.
 * Hydra bodies, the Architect and the Leviathan resolve their own contact
 * inside their movers, because they have to do it mid-step.
 */
const CRUSHING_BOSSES = new Set<string>([
  "sweeper",
  "juggernaut",
  "warden",
  "bastion",
  "core",
  "foundry",
]);

/**
 * Shells the relay absorbs before it falls, on a `defend_core` level.
 *
 * The arena's eagle dies to a single hit, which is right for a match that ends
 * when it does. It is wrong for a ninety-second hold: one enemy getting a shot
 * through a door ended the level instantly, with no warning and nothing the
 * player could have done about it once the shell was in the air. Four gives the
 * mistake a cost the player can see coming and fight back from.
 */
const RELAY_HITS = 4;

/** How far from every player a fallback release point must be, in tiles. */
const FALLBACK_SPAWN_MIN_TILES = 10;

/** Placement attempts before a fallback release gives up for this tick. */
const FALLBACK_SPAWN_ATTEMPTS = 80;

// ------------------------------------------------------------------ foundry

/** The `variant` string for the Act 4 Foundry boss. */
const FOUNDRY = "foundry";

/** The Foundry's hit points, once its intakes are down and it is exposed. */
const FOUNDRY_HP = 36;

/** The Foundry's hitbox, three tiles square. */
const FOUNDRY_SIZE = TILE_SIZE * 3;

/** Gap between the Foundry's production runs, in ms. */
const FOUNDRY_BUILD_INTERVAL_MS = 4000;

/** Gap between the Foundry's self-repairs while any intake still runs, in ms. */
const FOUNDRY_REPAIR_INTERVAL_MS = 1800;

/**
 * Hit points the Foundry knits back on per repair.
 *
 * Tuned to out-pace an average player's damage while the intakes run, so the
 * fight genuinely cannot be brute-forced — but only just, so a player who has
 * levelled three of the four can feel themselves starting to win.
 */
const FOUNDRY_REPAIR_AMOUNT = 2;

/** Gap between the starved Foundry's attacks, in ms. */
const FOUNDRY_EXPOSED_SHOOT_MS = 1700;

/**
 * How fast the starved Foundry grinds toward the player, in px/s.
 *
 * It used to stay bolted to the middle of the floor once its intakes were
 * down and fire the same four-way burst on a timer, which turned the finish
 * into parking off its axes and shooting a stationary target. Torn off its
 * mountings it crawls after the player through cover — slowly enough to
 * outrun, never slowly enough to ignore.
 */
const FOUNDRY_CRAWL_SPEED = TANK_SPEED * (1000 / TICK_MS) * 0.3;

/** Gap between the starved Foundry's salvage builds, in ms. */
const FOUNDRY_SALVAGE_INTERVAL_MS = 9000;

/**
 * Multiplier on the starved Foundry's attack gap once it is below half health.
 *
 * Its crawl speeds up by the inverse, so the second half of the fight is
 * noticeably faster than the first rather than the same loop twice.
 */
const FOUNDRY_WOUNDED_FACTOR = 0.7;

// -------------------------------------------------------------------- choir

/** The `variant` string for the Act 4 Choir twins. */
const CHOIR = "choir";

/** Each twin's hit points. */
const CHOIR_HP = 19;

/** A twin's hitbox, two tiles square. */
const CHOIR_SIZE = TILE_SIZE * 2;

/** A twin's speed as a fraction of the player's base speed. */
const CHOIR_SPEED_FACTOR = 0.85;

/** Gap between a twin's shells, in ms. */
const CHOIR_SHOOT_INTERVAL_MS = 1600;

/**
 * How long the surviving twin waits before reviving its partner, in ms.
 *
 * The whole encounter is this number: it is how long the player has to cross a
 * hall with a pillar down the middle and finish a second boss. Long enough to
 * be possible from anywhere in the room, short enough that it has to be planned
 * rather than stumbled into.
 */
const CHOIR_REVIVE_MS = 9000;

/** Damage the survivor takes when its partner falls — the shared pool. */
const CHOIR_SYMPATHY_DAMAGE = 4;

// ---------------------------------------------------------------- leviathan

/** The `variant` string for the Act 5 Leviathan boss. */
const LEVIATHAN = "leviathan";

/**
 * The Leviathan's hit points.
 *
 * Nearly doubled. Half its fight is spent submerged and untouchable, so a
 * health pool sized like a boss that stands still made the encounter about six
 * seconds of actual shooting split across two surfacings — the dive cycle never
 * got to be the fight it was written as.
 */
const LEVIATHAN_HP = 58;

/** The Leviathan's hitbox, three tiles square. */
const LEVIATHAN_SIZE = TILE_SIZE * 3;

/** The Leviathan's surfaced chase speed, in px/s. */
const LEVIATHAN_SPEED = TANK_SPEED * (1000 / TICK_MS) * 0.55;

/** How long it stays up and vulnerable, in ms. */
const LEVIATHAN_SURFACED_MS = 6000;

/** How long it stays under and untouchable, in ms. */
const LEVIATHAN_SUBMERGED_MS = 3200;

/**
 * How far ahead of surfacing the impact point is marked, in ms.
 *
 * Long enough to get a hull clear of a three-tile footprint from its middle.
 */
const LEVIATHAN_TELL_MS = 1500;

/**
 * How far from the marked point it will look for room to surface, in tiles.
 *
 * It comes up on the mark — centred where the player was standing when the
 * mark went down. It used to come up on a ring a few tiles out from wherever
 * the player was at the moment of surfacing, while the mark was drawn on the
 * player: the warning pointed at one place, the hull arrived beside it, and
 * the only way to dodge was to guess. The search only matters when the mark
 * lands on coolant; it never moves the surfacing point further than this.
 */
const LEVIATHAN_SURFACE_SEARCH_TILES = 4;

/**
 * How long it holds still after surfacing before the chase resumes, in ms.
 *
 * A player who stepped off the mark in time should not be run down by the
 * same lunge that just missed them.
 */
const LEVIATHAN_RISE_PAUSE_MS = 700;

// ---------------------------------------------------------------------------
// Act 4 units
//
// The Archive's own garrison. Everything here takes something away from the
// player rather than adding damage: a position they cannot walk up to, the
// cooldowns they were relying on, the objective they already finished. By this
// point the tank out-guns anything the campaign can reasonably field, so the
// pressure has to come from somewhere other than firepower.
// ---------------------------------------------------------------------------

/** A Sentinel's hit points — an emplacement, so it can afford to be tough. */
const SENTINEL_HP = 4;

/** How far a Sentinel can see and shoot, in tiles. */
const SENTINEL_RANGE_TILES = 14;

/** Gap between a Sentinel's shots, in ms. */
const SENTINEL_SHOOT_INTERVAL_MS = 1400;

/** How far from every player a Sentinel may be emplaced, in tiles. */
const SENTINEL_MIN_SPAWN_TILES = 8;

/** Placement attempts before a Sentinel release is downgraded to a tank. */
const SENTINEL_PLACEMENT_ATTEMPTS = 60;

/** A Howler's hit points. Fragile, and the reason to kill it first. */
const HOWLER_HP = 2;

/** A Howler's speed as a fraction of the player's base speed. */
const HOWLER_SPEED_FACTOR = 0.9;

/** Radius of a Howler's rally aura, in px. */
const HOWLER_RADIUS = 6 * TILE_SIZE;

/** Speed multiplier applied to ordinary enemies inside a Howler's aura. */
const HOWLER_SPEED_BONUS = 1.4;

/** A Leech's hit points. */
const LEECH_HP = 2;

/** A Leech's speed as a fraction of the player's base speed — it must catch up. */
const LEECH_SPEED_FACTOR = 1.25;

/** How close (px) a Leech must get to drain the player's cooldowns. */
const LEECH_CONTACT_PADDING = 4;

/** Minimum gap between drains from the same Leech, in ms. */
const LEECH_INTERVAL_MS = 2500;

/** An Overseer's hit points. */
const OVERSEER_HP = 3;

/** An Overseer's speed as a fraction of the player's base speed. */
const OVERSEER_SPEED_FACTOR = 0.7;

/** Gap between an Overseer's reinforcement drops, in ms. */
const OVERSEER_DROP_INTERVAL_MS = 6000;

/** How many tanks arrive in one drop. */
const OVERSEER_DROP_COUNT = 2;

/** A Reclaimer's hit points. */
const RECLAIMER_HP = 3;

/** A Reclaimer's speed as a fraction of the player's base speed. */
const RECLAIMER_SPEED_FACTOR = 0.85;

/** Gap between a Reclaimer's rebuilds, in ms. */
const RECLAIMER_INTERVAL_MS = 7000;

/**
 * How far a Reclaimer will reach to rebuild, in tiles.
 *
 * Short on purpose: it has to physically go to the wreckage, which is what
 * makes killing it a real answer rather than a chore performed at range.
 */
const RECLAIMER_RANGE_TILES = 6;

/** A Burrower's hit points. */
const BURROWER_HP = 3;

/** A Burrower's speed as a fraction of the player's base speed. */
const BURROWER_SPEED_FACTOR = 1.1;

/** How long a Burrower stays submerged and untargetable, in ms. */
const BURROWER_SUBMERGED_MS = 2600;

/** How long a Burrower stays up and vulnerable after surfacing, in ms. */
const BURROWER_SURFACED_MS = 4200;

/** How far from the player a Burrower resurfaces, in tiles. */
const BURROWER_SURFACE_TILES = 3;

/**
 * The single-player campaign room.
 *
 * Runs the same authoritative physics loop and systems as {@link BattleRoom} —
 * shells, tanks, flow-field pathing — but sequenced by the replicated
 * {@link CampaignState.phase} rather than a lobby/match cycle, and with the enemy
 * flow field converging on the player instead of an eagle.
 */
/**
 * One player's ability cooldowns and live effects.
 *
 * Every one of these used to be a single field on the room, which was correct
 * while the campaign was strictly solo. In co-op they have to be per-seat —
 * otherwise one player raising a shield puts everyone's on cooldown.
 */
/**
 * One boss body's mutable state.
 *
 * Slots are general-purpose and each routine says what it uses them for:
 *  - Sweeper: `vx`/`vy` are its ballistic velocity.
 *  - Artillery: `timerMs` counts toward the next barrage, `markHp` is the hit
 *    point mark at which it next relocates.
 *  - Bastion: `timerMs` is the turret swing, `altTimerMs` the weak-face walk.
 *  - Choir: `flag` marks the twin that has already been downed once.
 *  - Leviathan / Foundry: `timerMs` is the phase clock, `flag` the phase.
 */
interface BossState {
  vx: number;
  vy: number;
  timerMs: number;
  altTimerMs: number;
  markHp: number;
  flag: boolean;
  /** Which attack in a rotation fires next — the starved Foundry's. */
  pattern: number;
  /** A point the boss has committed to — the Leviathan's marked surfacing spot. */
  aimX: number;
  aimY: number;
}

interface AbilityState {
  shieldActiveMs: number;
  shieldCooldownMs: number;
  teleportCharges: number;
  teleportRechargeMs: number;
  blastCooldownMs: number;
  ramActiveMs: number;
  ramCooldownMs: number;
  ramDirection: Direction;
  decoy: { x: number; y: number; remainingMs: number } | null;
  decoyCooldownMs: number;
  blinkLockMs: number;
  strikeCooldownMs: number;
  empCooldownMs: number;
  laserCooldownMs: number;
  translocateCooldownMs: number;
}

/**
 * A fresh, everything-ready ability loadout.
 *
 * The blink bank starts at the *base* ceiling; {@link CampaignRoom.freshFor}
 * tops it up to whatever Phase Capacitor stacks that seat has bought, which is
 * the only place the upgrade is known.
 */
function freshAbilities(): AbilityState {
  return {
    shieldActiveMs: 0,
    shieldCooldownMs: 0,
    teleportCharges: TELEPORT_MAX_CHARGES,
    teleportRechargeMs: 0,
    blastCooldownMs: 0,
    ramActiveMs: 0,
    ramCooldownMs: 0,
    ramDirection: Direction.Up,
    decoy: null,
    decoyCooldownMs: 0,
    blinkLockMs: 0,
    strikeCooldownMs: 0,
    empCooldownMs: 0,
    laserCooldownMs: 0,
    translocateCooldownMs: 0,
  };
}

export class CampaignRoom extends Room<CampaignState> {
  /**
   * Seats in a co-op run. The campaign was authored and tuned around one tank,
   * so this is kept small deliberately — four is enough to be a party without
   * turning every level into a shooting gallery the enemies cannot reach.
   */
  override maxClients = 4;

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
  /**
   * sessionId -> elapsed-ms at which that seat returns to the field.
   *
   * Per-seat rather than a single timer: in co-op, one player dying must not
   * hold up or reset anyone else's respawn.
   */
  private readonly respawnAtMs = new Map<string, number>();

  /** elapsedMs of the last enemy release. */
  private lastEnemySpawnMs = 0;

  /** Milliseconds the player has held the uplink zone (zone_control levels). */
  private zoneProgressMs = 0;

  /** Milliseconds left to defuse every bomb (defuse_bombs levels). */
  private bombTimerMs = BOMB_MS;

  /**
   * True once the level's win condition has been satisfied.
   *
   * Separate from the level being cleared, because a level may schedule a boss
   * wave for the moment its objective lands: from here the objective readout
   * switches to the boss, and clearing the level waits on the wave.
   */
  private objectiveMet = false;

  /** Marked units destroyed so far (purge_marked levels). */
  private markedKilled = 0;

  /** Shells the relay can still absorb before it falls. */
  private relayHitsLeft = RELAY_HITS;

  /**
   * Grid indices of this level's objective tiles, in the order they must be
   * taken. Empty on a level that does not impose one, which every check reads
   * as "all of them are live".
   */
  private objectiveOrder: number[] = [];

  /** ownerIds of the units a purge level has marked as live targets. */
  private readonly markedIds = new Set<string>();

  /** Marked targets kept on the field at once on a purge level. */
  private static readonly PURGE_MARKS = 2;

  /**
   * Gap between one mark going up and the next, in ms.
   *
   * Marks used to be handed out the instant a slot opened, so the whole quota
   * was lit from the first second and a purge of six was over in fifteen: the
   * player shot the rings nearest them, and fresh ones lit up beside the
   * wrecks. Pacing them makes the level last about as long as its count says,
   * and makes every new mark something to go and find.
   */
  private static readonly PURGE_MARK_INTERVAL_MS = 6000;

  /** How long into a purge level the first mark goes up, in ms. */
  private static readonly PURGE_FIRST_MARK_MS = 3000;

  /** ms until the next mark may be handed out on a purge level. */
  private purgeMarkCooldownMs = 0;

  /** ownerId -> ms accumulated toward a Sentinel's next shot. */
  private readonly sentinelTimers = new Map<string, number>();

  /**
   * ownerId -> the speed a unit had before any Howler rallied it.
   *
   * Recorded the first time a unit comes within range of one, because an
   * ordinary tank's speed is rolled per body and is not written down anywhere
   * else — without this, dropping the rally would have to invent a figure.
   */
  private readonly rallyBaseSpeeds = new Map<string, number>();

  /** ownerId -> ms until this Leech may drain a player again. */
  private readonly leechTimers = new Map<string, number>();

  /** ownerId -> ms accumulated toward an Overseer's next reinforcement drop. */
  private readonly overseerTimers = new Map<string, number>();

  /** ownerId -> ms accumulated toward a Reclaimer's next rebuild. */
  private readonly reclaimerTimers = new Map<string, number>();

  /**
   * ownerId -> ms left in a Burrower's current phase.
   *
   * The phase itself is read from `isCloaked`: submerged Burrowers are cloaked,
   * which is also what makes them untargetable and near-invisible, so the two
   * can never disagree.
   */
  private readonly burrowerTimers = new Map<string, number>();

  /**
   * ownerId -> elapsedMs at which an EMP-suppressed unit may act again.
   *
   * Covers enemies and bosses alike. Held units keep their position and their
   * timers; they simply do not move or fire while the clock is running.
   */
  private readonly empHeldUntilMs = new Map<string, number>();

  /** Player-called strikes in flight: impact centre, radius, ms until impact. */
  private strikes: Array<{ x: number; y: number; radius: number; timerMs: number }> = [];

  /** ownerId of the active boss, or null. Its velocity lives alongside. */
  private bossId: string | null = null;

  /**
   * Per-boss timers and velocities, keyed by the boss tank's ownerId.
   *
   * Deliberately a small bag of general-purpose slots rather than a field per
   * boss type: each routine uses the two or three it needs and documents which,
   * which is far less code than eleven bespoke interfaces and keeps adding a
   * boss from meaning adding a state shape.
   */
  private readonly bossStates = new Map<string, BossState>();

  /** ownerId -> last grid cell a Constructor occupied, for its trench trail. */
  private readonly constructorCells = new Map<string, { gx: number; gy: number }>();

  /** ownerId -> ms since a Trapper last dropped a mine. */
  private readonly trapperMineTimers = new Map<string, number>();

  /** ownerId of the escort carrier, or null. */
  private convoyId: string | null = null;

  /** ms remaining before the carrier can take another tick of contact damage. */
  private convoyContactCooldownMs = 0;

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

  /** ms accumulated toward the Bastion's weak point moving to the next face. */
  private bastionWeakMs = 0;

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

  /** ms accumulated toward the exposed Architect's next charge. */
  private architectChargeCdMs = 0;

  /** ms left on the wind-up before the current charge launches; 0 when idle. */
  private architectWindupMs = 0;

  /** ms left on a charge that is already running; 0 when idle. */
  private architectChargeMs = 0;

  /** The heading a running charge is committed to, in radians. */
  private architectChargeAngle = 0;

  /** ownerId -> ms accumulated toward a Lurcher's next grapple. */
  private readonly lurcherTimers = new Map<string, number>();

  /** ms remaining on the Effigy's own shield. */
  private effigyShieldMs = 0;

  /** Cooldown timers for the Effigy's borrowed abilities. */
  private effigyShieldCdMs = 0;
  private effigyBlinkCdMs = 0;
  private effigyBlastCdMs = 0;
  private effigyShootMs = 0;

  /** ms accumulated toward the wounded Effigy's next called strike. */
  private effigyStrikeMs = 0;

  private effigyRamCdMs = 0;
  private effigyRamMs = 0;
  private effigyRamDirection: Direction = Direction.Up;
  private effigyDecoyCdMs = 0;

  /** ownerId -> ms left before one of the Effigy's mirages fades. */
  private readonly effigyMirages = new Map<string, number>();

  /** Watchdog for a wedged Effigy: last tile it occupied, and for how long. */
  private effigyStuck: { x: number; y: number; ms: number } | null = null;

  /** sessionId -> that player's ability cooldowns and live effects. */
  private readonly abilities = new Map<string, AbilityState>();

  /** sessionId -> upgrade id -> stacks taken. */
  private readonly upgrades = new Map<string, Map<string, number>>();

  /** sessionId -> the upgrade ids currently on the table for that player. */
  private readonly upgradeOffers = new Map<string, string[]>();

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

  /**
   * The route to any standing decoy beacon, kept alongside the hunter route.
   *
   * Two fields rather than one, because a beacon no longer replaces the player
   * as *the* target — it competes with them. A single field can only converge
   * on one set of sources, so splitting the attention needs a second one and a
   * per-enemy answer to which of them applies.
   */
  private readonly decoyField = new FlowField();

  /**
   * ownerIds of the enemies a standing beacon has actually fooled.
   *
   * Rolled once, when the beacon goes down or when a unit is released while one
   * is standing — not per tick, which would have hulls flickering between two
   * destinations and going nowhere. Cleared when the last beacon expires.
   */
  private readonly luredIds = new Set<string>();

  override onCreate(): void {
    this.setState(new CampaignState());

    // The player leaves the intro briefing: build the level and go live.
    // Only the host leaves staging, and only from staging — so a late-joining
    // client cannot restart a run that is already under way.
    this.onMessage(CampaignMessage.StartCampaign, (client) => {
      if (this.state.phase !== CampaignPhase.Staging) return;
      if (client.sessionId !== this.state.hostId) return;

      this.state.phase = CampaignPhase.Intro;
      console.log(
        `[room ${this.roomId}] campaign started with ${this.state.players.size} player(s)`,
      );
    });

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
      // Nobody advances while a hand is still on the table. The debrief is the
      // only place upgrades are handed out, so leaving one unspent silently
      // forfeits it — and in co-op one player pressing on would forfeit it for
      // everyone else too.
      if (this.hasUnspentUpgrade()) return;

      const next = this.state.currentLevel + 1;

      if (next > CAMPAIGN_LEVELS.length) {
        this.state.phase = CampaignPhase.CampaignComplete;
        console.log(`[room ${this.roomId}] campaign complete`);
        return;
      }

      // A resupply, where the level arriving asks for one. The last hardcoded
      // level number in the room: it used to be `if (next === 16)`, which is
      // exactly the kind of thing that silently moved to the wrong level every
      // time the campaign grew.
      const bonus = levelAt(next)?.params?.bonusLives ?? 0;
      if (bonus > 0) {
        this.state.lives += bonus;
        this.syncLives();
      }

      this.state.currentLevel = next;
      this.state.phase = CampaignPhase.Intro;
      console.log(`[room ${this.roomId}] advancing to level ${this.state.currentLevel}`);
    });

    this.onMessage(CampaignMessage.CheatWin, () => {
      if (this.state.phase !== CampaignPhase.Playing) return;

      // Steps the level forward the way playing it would, rather than jumping
      // to the end. On a level whose objective summons a boss wave those are
      // two different things, and a cheat that skipped straight past the wave
      // would hide exactly the levels most worth being able to skip to.
      //
      // Bosses go first, so a boss level's objective — "nothing is standing" —
      // is genuinely true by the time it is marked met.
      for (let i = this.state.tanks.length - 1; i >= 0; i--) {
        if (this.state.tanks.at(i).isBoss) this.state.tanks.splice(i, 1);
      }

      if (!this.objectiveMet) {
        this.objectiveMet = true;
        this.spawnBossWave(BossTiming.Objective);
        this.refreshObjective();
        // A wave answered the objective: the level is not over, and a second
        // press is what clears it.
        if (this.hasBoss()) return;
      }

      this.winLevel();
    });

    // Each ability acts on the seat that asked for it, never on "the player".
    this.onMessage(CampaignMessage.ActivateShield, (client) => {
      if (this.state.phase !== CampaignPhase.Playing) return;
      this.raiseShield(client.sessionId);
    });

    this.onMessage(CampaignMessage.Teleport, (client, payload: unknown) => {
      if (this.state.phase !== CampaignPhase.Playing) return;
      this.teleportPlayer(client.sessionId, payload);
    });

    this.onMessage(CampaignMessage.Blast, (client) => {
      if (this.state.phase !== CampaignPhase.Playing) return;
      this.fireBlast(client.sessionId);
    });

    this.onMessage(CampaignMessage.Ram, (client) => {
      if (this.state.phase !== CampaignPhase.Playing) return;
      this.startRam(client.sessionId);
    });

    this.onMessage(CampaignMessage.Decoy, (client) => {
      if (this.state.phase !== CampaignPhase.Playing) return;
      this.dropDecoy(client.sessionId);
    });

    // The only two abilities that carry a payload: both are aimed with the
    // mouse, so both arrive with a world point the server has to validate.
    this.onMessage(CampaignMessage.Strike, (client, payload: unknown) => {
      if (this.state.phase !== CampaignPhase.Playing) return;
      this.callStrike(client.sessionId, payload);
    });

    this.onMessage(CampaignMessage.Emp, (client) => {
      if (this.state.phase !== CampaignPhase.Playing) return;
      this.firePulse(client.sessionId);
    });

    this.onMessage(CampaignMessage.Laser, (client) => {
      if (this.state.phase !== CampaignPhase.Playing) return;
      this.fireLaser(client.sessionId);
    });

    this.onMessage(CampaignMessage.Translocate, (client, payload: unknown) => {
      if (this.state.phase !== CampaignPhase.Playing) return;
      this.translocate(client.sessionId, payload);
    });

    this.onMessage(CampaignMessage.ChooseUpgrade, (client, payload: unknown) => {
      // Only during the debrief, and only from the hand that seat was dealt.
      if (this.state.phase !== CampaignPhase.Outro) return;
      const id = (payload as { id?: unknown } | undefined)?.id;
      this.chooseUpgrade(client.sessionId, id);
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
    this.abilities.set(client.sessionId, this.freshFor(client.sessionId));

    // First one in runs the room and gets the Start button.
    if (!this.state.hostId) this.state.hostId = client.sessionId;

    // Someone joining a level already in progress drops straight in rather than
    // spectating until the next briefing — the invite link stays useful after
    // the run has started.
    if (this.state.phase === CampaignPhase.Playing) this.spawnPlayer(client.sessionId);

    console.log(
      `[room ${this.roomId}] ${name} joined the campaign (${this.state.players.size}/${this.maxClients})`,
    );
  }

  override onLeave(client: Client): void {
    this.removeOwned(client.sessionId);
    this.state.players.delete(client.sessionId);
    // An offer belonging to somebody who has gone must not hold the debrief
    // open — {@link hasUnspentUpgrade} would never come back false.
    this.upgradeOffers.delete(client.sessionId);
    this.moveIntents.delete(client.sessionId);
    this.lastShotAtMs.delete(client.sessionId);
    this.invulnerableUntilMs.delete(client.sessionId);
    this.abilities.delete(client.sessionId);
    this.respawnAtMs.delete(client.sessionId);

    // `playerId` now only names a fallback seat for the solo-era code paths;
    // hand it to whoever is still here rather than blanking it, so a departing
    // host does not leave the room without one.
    if (this.playerId === client.sessionId) {
      this.playerId = null;
      for (const [sessionId] of this.state.players) {
        this.playerId = sessionId;
        break;
      }
    }

    // The host leaving must not strand everyone else on a staging screen with
    // no Start button: pass the room to whoever is still in it.
    if (this.state.hostId === client.sessionId) {
      this.state.hostId = "";
      for (const [sessionId] of this.state.players) {
        this.state.hostId = sessionId;
        break;
      }
    }
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
    this.bombTimerMs = bombSecondsForLevel(this.state.currentLevel) * 1000;
    this.objectiveMet = false;
    this.markedKilled = 0;
    this.purgeMarkCooldownMs = CampaignRoom.PURGE_FIRST_MARK_MS;
    this.relayHitsLeft = RELAY_HITS;
    this.objectiveOrder = [];
    this.state.objectiveTargetTile = -1;
    this.bossStates.clear();
    this.sentinelTimers.clear();
    this.rallyBaseSpeeds.clear();
    this.leechTimers.clear();
    this.overseerTimers.clear();
    this.reclaimerTimers.clear();
    this.burrowerTimers.clear();
    this.markedIds.clear();
    this.luredIds.clear();
    this.empHeldUntilMs.clear();
    this.strikes = [];
    this.respawnAtMs.clear();
    this.bossId = null;
    this.moveIntents.clear();
    this.lastShotAtMs.clear();
    this.invulnerableUntilMs.clear();
    this.constructorCells.clear();
    this.trapperMineTimers.clear();
    this.ghostUncloakTimers.clear();
    this.convoyId = null;
    this.convoyContactCooldownMs = 0;
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
    this.effigyMirages.clear();
    this.effigyStuck = null;
    this.architectRingMs = 0;
    this.architectRings = 0;
    this.architectLobMs = 0;
    this.architectWarned = false;
    this.architectChargeCdMs = 0;
    this.architectWindupMs = 0;
    this.architectChargeMs = 0;
    this.coreMortarTimerMs = 0;
    this.resetShield();
    this.resetTeleport();
    this.resetBlast();
    this.resetRam();
    this.resetDecoy();
    this.resetLateAbilities();

    this.spawnAllPlayers();
    this.spawnBossWave(BossTiming.Start);

    // Both convoy objectives put a carrier on the field; which way it drives and
    // whose side it is on is decided by the win condition, not by the spawn.
    const win = this.currentWinCondition();
    if (
      win === CampaignWinCondition.Escort ||
      win === CampaignWinCondition.DestroyConvoy ||
      win === CampaignWinCondition.PushPayload
    ) {
      this.spawnConvoy();
    }

    this.rollObjectiveOrder();
    this.rebuildFields();
    this.refreshObjective();
  }

  /**
   * Deploys every boss the level schedules for `timing`.
   *
   * Called once at level start, and again the moment the objective is met — so
   * a level can end on its objective, open with a boss, or do the thing this
   * campaign's later acts lean on: finish the objective and find out what the
   * noise attracted. Multiple bodies of the same kind are supported throughout;
   * each gets its own {@link BossState}, so two Sweepers do not share a
   * velocity and two siege guns do not share a reload.
   */
  private spawnBossWave(timing: BossTiming): void {
    const bosses = this.level()?.bosses;
    if (!bosses) return;

    for (const spawn of bosses) {
      if ((spawn.when ?? BossTiming.Start) !== timing) continue;
      const count = Math.max(1, spawn.count ?? 1);
      for (let i = 0; i < count; i++) this.spawnBoss(spawn.kind, i, count);
    }
  }

  /**
   * Puts one boss body on the field.
   *
   * `index` and `total` spread a multi-body wave out along the top of the map,
   * so two Sweepers do not materialise inside one another and immediately spend
   * the fight shouldering each other into a wall.
   */
  private spawnBoss(kind: string, index: number, total: number): void {
    switch (kind) {
      case BossKind.Core: this.spawnCore(); break;
      case BossKind.Artillery: this.spawnArtillery(index, total); break;
      case BossKind.Warden: this.spawnWarden(); break;
      case BossKind.Bastion: this.spawnBastion(); break;
      case BossKind.Hydra: this.spawnHydra(index, total); break;
      case BossKind.Architect: this.spawnArchitect(); break;
      case BossKind.Effigy: this.spawnEffigy(); break;
      case BossKind.Juggernaut: this.spawnJuggernaut(); break;
      case BossKind.Foundry: this.spawnFoundry(); break;
      case BossKind.Choir: this.spawnChoir(); break;
      case BossKind.Leviathan: this.spawnLeviathan(); break;
      default: this.spawnSweeper(index, total); break;
    }
  }

  /**
   * A spread-out entry point along the top of the map for body `index` of
   * `total`, snapped to the tile grid.
   *
   * Grid-snapped because the shared movers only ever turn a hull standing on
   * the lattice; a boss dropped half a tile off drives in one direction until
   * it meets something and is stuck there for the rest of the level.
   */
  private bossEntryX(size: number, index: number, total: number): number {
    if (total <= 1) return centredSpawnX(size);

    // Spread across the middle two thirds of the map, clear of the walls.
    const usable = WORLD_WIDTH - 2 * TILE_SIZE - size;
    const step = usable / (total + 1);
    const raw = TILE_SIZE + step * (index + 1);
    const snapped = Math.round(raw / TILE_SIZE) * TILE_SIZE;
    return Math.max(TILE_SIZE, Math.min(WORLD_WIDTH - TILE_SIZE - size, snapped));
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

    // A hostile carrier is an enemy hull the player must shoot, so it starts at
    // the far end of its own run rather than on the player's spawn pad, and it
    // is flagged as an enemy so shells actually land on it.
    const hostile = this.currentWinCondition() === CampaignWinCondition.DestroyConvoy;

    // The escort carrier keeps the centre lane its canyon map is built around.
    // The breaker is nudged aside: the player spawns on that tile too, and two
    // hulls in one square start the level shoving each other.
    const start = hostile
      ? this.hostileConvoyStart()
      : this.currentWinCondition() === CampaignWinCondition.PushPayload
        ? { x: 27 * TILE_SIZE, y: 30 * TILE_SIZE }
        : { x: 30 * TILE_SIZE, y: 31 * TILE_SIZE };

    this.state.tanks.push(
      new Tank({
        x: start.x,
        y: start.y,
        width: TANK_SIZE,
        height: TANK_SIZE,
        ownerId: id,
        maxHealth: hostile ? HOSTILE_CONVOY_HP : CONVOY_HP,
        speed: 0,
        direction: hostile ? Direction.Left : Direction.Up,
        isEnemy: hostile,
        variant: CONVOY,
      }),
    );
  }

  /**
   * Where a hostile carrier begins its run: the corner opposite its own pad.
   *
   * Read off the map rather than hard-coded, because the two raid levels run
   * their road in different directions — one east to west, one south to north —
   * and the carrier should always start as far from its exit as the map allows.
   */
  private hostileConvoyStart(): { x: number; y: number } {
    const pad = this.firstTileOf(TileType.ExtractionZone);
    if (!pad) return { x: 30 * TILE_SIZE, y: 31 * TILE_SIZE };

    // Mirror the pad through the centre of the map, then find open ground near
    // the result so the carrier never starts inside a wall.
    const mirrorX = WORLD_WIDTH - pad.x - TANK_SIZE;
    const mirrorY = WORLD_HEIGHT - pad.y - TANK_SIZE;
    const spot = this.hydraChildSpot(
      mirrorX + TANK_SIZE / 2,
      mirrorY + TANK_SIZE / 2,
      TANK_SIZE,
      new Set<string>(),
    );
    return spot ?? { x: 30 * TILE_SIZE, y: 31 * TILE_SIZE };
  }

  /** World coordinates of the first tile of `tile`, scanning row-major. */
  private firstTileOf(tile: TileType): { x: number; y: number } | null {
    for (let i = 0; i < GRID_LENGTH; i++) {
      if (this.state.grid.at(i) !== tile) continue;
      const tx = i % GRID_WIDTH;
      const ty = Math.floor(i / GRID_WIDTH);
      return { x: tx * TILE_SIZE, y: ty * TILE_SIZE };
    }
    return null;
  }

  /** Spawns the Level 5 boss at top centre, moving ballistically down-right. */
  private spawnSweeper(index = 0, total = 1): void {
    const id = `boss-${this.enemySequence++}`;
    this.bossId = id;

    // Bodies after the first start along the other diagonal, so a pair does not
    // simply fly in formation for the whole fight.
    const state = this.bossState(id);
    state.vx = index % 2 === 0 ? SWEEPER_SPEED : -SWEEPER_SPEED;
    state.vy = SWEEPER_SPEED;

    this.state.tanks.push(
      new Tank({
        x: this.bossEntryX(SWEEPER_SIZE, index, total),
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
  private spawnArtillery(index = 0, total = 1): void {
    const id = `boss-${this.enemySequence++}`;
    this.bossId = id;

    const state = this.bossState(id);
    state.markHp = ARTILLERY_HP - ARTILLERY_BLINK_DAMAGE;
    // Stagger the reload across a battery, so two guns do not fire as one.
    state.timerMs = (MORTAR_INTERVAL_MS / Math.max(1, total)) * index;

    this.state.tanks.push(
      new Tank({
        x: this.bossEntryX(ARTILLERY_SIZE, index, total),
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
   * Only one face at a time takes damage (see {@link isBastionArmoured}), and
   * which face it is keeps moving, so it is placed with room on every side for
   * the player to work around it.
   */
  private spawnBastion(): void {
    const id = `boss-${this.enemySequence++}`;
    this.bossId = id;
    this.bastionTurnMs = 0;
    this.bastionWeakMs = 0;
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
        // Opens facing the player's approach, so the first opening is one they
        // can actually reach rather than one behind the boss.
        weakSide: Direction.Down,
      }),
    );
  }

  /**
   * Spawns a Hydra at its largest tier along the top of the map.
   *
   * `index` and `total` spread a pair out, as for every other multi-body wave:
   * two three-tile hulls dropped on the same entry point would spend the
   * opening seconds ploughing into each other instead of into the arena.
   */
  private spawnHydra(index = 0, total = 1): void {
    const tier = HYDRA_TIERS[0]!;
    const id = `boss-${this.enemySequence++}`;
    if (index === 0) this.bossId = id;

    this.state.tanks.push(
      new Tank({
        x: this.bossEntryX(tier.size, index, total),
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
   *
   * Every child is placed on the tile lattice. The smallest tier is steered by
   * the flow field, and that steering only ever turns a hull standing exactly
   * on a tile boundary — a fragment dropped half a tile off could drive in one
   * direction and never turn again, which is how they all ended up parked
   * against the map edge for the rest of the fight.
   */
  private splitHydra(parent: Tank): void {
    const tierIndex = HYDRA_TIERS.findIndex((tier) => tier.size === parent.width);
    const next = tierIndex >= 0 ? HYDRA_TIERS[tierIndex + 1] : undefined;
    if (!next) return;

    const cx = parent.x + parent.width / 2;
    const cy = parent.y + parent.height / 2;

    // Tiles already handed to a child in this split, so two fragments cannot be
    // sent to the same square when one of their preferred spots is walled.
    const taken = new Set<string>();

    for (let i = 0; i < HYDRA_SPLIT_COUNT; i++) {
      // Fan the children out to either side so they do not spawn stacked.
      const offset = (i - (HYDRA_SPLIT_COUNT - 1) / 2) * HYDRA_SPLIT_SPREAD * 2;
      const spot = this.hydraChildSpot(cx + offset, cy, next.size, taken);
      if (!spot) continue;
      const { x, y } = spot;
      taken.add(`${x},${y}`);

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
      // Anchored to the first child actually placed, not the first attempted —
      // a fragment that could not be fitted anywhere never exists.
      if (this.bossId === parent.ownerId) this.bossId = id;
    }
  }

  /**
   * Finds a tile-aligned, unobstructed home for a Hydra fragment.
   *
   * Searches outward in rings from the requested centre so a child displaced by
   * a wall still lands as close to where it split as the map allows. Returns
   * null only when nothing within the search is free, in which case the caller
   * drops that fragment rather than burying it in steel.
   */
  private hydraChildSpot(
    centreX: number,
    centreY: number,
    size: number,
    taken: ReadonlySet<string>,
  ): { x: number; y: number } | null {
    const maxX = WORLD_WIDTH - size;
    const maxY = WORLD_HEIGHT - size;
    const clamp = (value: number, limit: number): number =>
      Math.max(0, Math.min(limit, Math.round(value / TILE_SIZE) * TILE_SIZE));

    const baseX = clamp(centreX - size / 2, maxX);
    const baseY = clamp(centreY - size / 2, maxY);

    for (let ring = 0; ring <= 4; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          // Only the ring's own edge; the interior was covered by earlier rings.
          if (ring > 0 && Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;

          const x = baseX + dx * TILE_SIZE;
          const y = baseY + dy * TILE_SIZE;
          if (x < 0 || y < 0 || x > maxX || y > maxY) continue;
          if (taken.has(`${x},${y}`)) continue;
          if (isBlocked(this.state, x, y, size, size)) continue;

          return { x, y };
        }
      }
    }

    return null;
  }

  /**
   * Drives every oversized Hydra body straight at the nearest player.
   *
   * The tiers above one tile are bosses in the literal sense: they are not
   * steered by the flow field, they are not stopped by other hulls, and
   * anything they roll over — brick, the escort of adds the level spawns, the
   * player — is destroyed. Only the smallest tier is small enough to behave
   * like an ordinary tank, and that one keeps the shared steering.
   */
  private moveHydra(deltaMs: number): void {
    const dt = deltaMs / 1000;

    for (let i = 0; i < this.state.tanks.length; i++) {
      const body = this.state.tanks.at(i);
      if (body.variant !== HYDRA || body.width <= HYDRA_CRUSHER_SIZE) continue;

      const player = this.nearestPlayerTo(body);
      if (player) {
        const cx = body.x + body.width / 2;
        const cy = body.y + body.height / 2;
        const angle = Math.atan2(
          player.y + player.height / 2 - cy,
          player.x + player.width / 2 - cx,
        );
        // Tier speeds are px/tick, like every other tank's; the ballistic
        // movers here work in px/s.
        const speed = body.speed * (1000 / TICK_MS);

        const nextX = body.x + Math.cos(angle) * speed * dt;
        if (!this.sweeperHitsWall(nextX, body.y, body.width, body.height)) body.x = nextX;

        const nextY = body.y + Math.sin(angle) * speed * dt;
        if (!this.sweeperHitsWall(body.x, nextY, body.width, body.height)) body.y = nextY;

        body.direction = this.angleToDirection(angle);
      }

      if (this.crushJuggernautTiles(body.x, body.y, body.width, body.height)) {
        this.rebuildFields();
        this.onSweeperBounce(body, true);
      }
      this.crushEnemies(body);

      // A hull this size runs a player down the way every other boss does.
      for (const target of this.playerTanks()) {
        if (target.isInvulnerable) continue;
        if (
          boxesOverlap(body.x, body.y, body.width, body.height, target.x, target.y, target.width, target.height)
        ) {
          this.killPlayer(target.ownerId);
        }
      }
      if (this.state.phase !== CampaignPhase.Playing) return;
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

  /** Puts every seated player on the field. */
  private spawnAllPlayers(): void {
    for (const [sessionId] of this.state.players) this.spawnPlayer(sessionId);
  }

  /**
   * Puts one player's tank on its spawn pad, invulnerable for a moment.
   *
   * Seats are fanned out sideways from the pad so a co-op team does not all try
   * to materialise on the same tile — {@link getSafeSpawnPosition} would push
   * them apart anyway, but starting them spread keeps the search cheap and the
   * formation tidy.
   */
  private spawnPlayer(ownerId: string): boolean {
    if (!ownerId) return false;
    // Already on the field — nothing to do.
    if (this.findTank(ownerId)) return true;

    // On the escort level the carrier takes the centre pad, so players spawn
    // beside it rather than on top of it.
    const seat = this.seatIndex(ownerId);
    const offset = seat % 2 === 0 ? seat : -(seat + 1);
    const spawnCol =
      (this.currentWinCondition() === CampaignWinCondition.Escort ? PLAYER_SPAWN.x + 4 : PLAYER_SPAWN.x) +
      offset;

    const defaultX = Math.max(1, Math.min(GRID_WIDTH - 2, spawnCol)) * TILE_SIZE;
    const defaultY = PLAYER_SPAWN.y * TILE_SIZE;

    const { x, y } = this.getSafeSpawnPosition(defaultX, defaultY);

    if (isBlocked(this.state, x, y, TANK_SIZE, TANK_SIZE)) return false;

    const base = this.state.currentLevel > 5 ? TANK_SPEED * 1.15 : TANK_SPEED;
    // Overdrive and Reinforced Hull are read here, so a tank always comes back
    // built to whatever the run has earned so far.
    const speed = base * (1 + 0.12 * this.upgradeCount(ownerId, "speed"));
    const maxHealth = TANK_MAX_HEALTH + this.upgradeCount(ownerId, "hull");

    this.state.tanks.push(
      new Tank({
        x,
        y,
        width: TANK_SIZE,
        height: TANK_SIZE,
        ownerId,
        maxHealth,
        speed,
        direction: Direction.Up,
        isEnemy: false,
        isInvulnerable: true,
      }),
    );

    const invulnMs = this.state.currentLevel > 15
      ? PLAYER_INVULNERABILITY_MS * 2
      : PLAYER_INVULNERABILITY_MS;
    this.invulnerableUntilMs.set(ownerId, this.elapsedMs + invulnMs);
    this.respawnAtMs.delete(ownerId);

    // A fresh tank comes back with a fresh loadout, and the client is told so —
    // resetting the cooldowns without announcing them leaves every readout on
    // this seat counting down a timer the server has already thrown away.
    this.clearAbilities(ownerId);

    const player = this.state.players.get(ownerId);
    if (player) player.respawnInSeconds = 0;
    return true;
  }

  /**
   * Mirrors the shared lives pool onto every seat's record.
   *
   * `state.lives` is the team's, but each Player carries a copy for its own HUD
   * row — so every one of them has to be refreshed, not just the seat that
   * happened to trigger the change.
   */
  private syncLives(): void {
    for (const [, seat] of this.state.players) seat.lives = this.state.lives;
  }

  /** A stable 0-based index for a seat, used to fan spawns out. */
  private seatIndex(ownerId: string): number {
    let index = 0;
    for (const [sessionId] of this.state.players) {
      if (sessionId === ownerId) return index;
      index++;
    }
    return 0;
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
    this.tickStrikeCooldown(deltaMs);
    this.tickEmpCooldown(deltaMs);
    this.tickLaserCooldown(deltaMs);
    this.tickTranslocateCooldown(deltaMs);
    this.tickStrikes(deltaMs);
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
        // A pulsed unit keeps its position and its timers and simply stops.
        if (this.isSuppressed(tank)) return null;
        if (!this.usesHunterField(tank)) return null;

        // A unit that took the bait follows the beacon while one stands; the
        // rest carry on toward the player exactly as they would have.
        if (this.luredIds.has(tank.ownerId) && this.hasDecoy() && this.decoyField.isPopulated) {
          return this.decoyField;
        }

        return this.hunterField.isPopulated ? this.hunterField : null;
      },
      // A rusher is meant to be a threat the player sees coming and answers,
      // which means it has to actually come. Everything else keeps the noise.
      chaosFor: (tank) =>
        tank.variant === KAMIKAZE || tank.variant === EnemyVariant.Leech
          ? 0
          : ENEMY_CHAOS_CHANCE,
      // Rushers, every boss, Trappers, Jammers and disguised Mimics never fire.
      canShoot: (tank) =>
        !this.isSuppressed(tank) &&
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

    // Every oversized Hydra body drives itself and crushes what it touches.
    this.moveHydra(deltaMs);
    if (this.state.phase !== CampaignPhase.Playing) return;

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

    // The Archive's garrison, and the three bosses that arrive with it.
    this.tickArchiveUnits(deltaMs);
    this.tickFoundry(deltaMs);
    this.tickChoir(deltaMs);
    this.tickLeviathan(deltaMs);
    if (this.state.phase !== CampaignPhase.Playing) return;

    // The Architect walls the arena in while its pylons still stand.
    this.tickArchitect(deltaMs);
    if (this.state.phase !== CampaignPhase.Playing) return;

    // The Logic Core fires and moves through its phases.
    this.updateCore(deltaMs);
    this.moveCore(deltaMs);

    // A kamikaze reaching the player, the boss running it over, a mine, or a
    // mortar landing on the player is lethal. A kamikaze reaching the relay or
    // the carrier fails the level outright, which ends the tick.
    if (this.resolveKamikaze()) return;
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
      // On an ordered level every objective structure but the marked one is
      // sealed; the shell sparks off it exactly as it would off steel.
      hardensTile: (index) => !this.objectiveTileLive(index),
      protectsTile: (index, bullet) => this.relayAbsorbs(index, bullet),
      shieldsTarget: (target, bullet) =>
        this.isShieldUp(target) ||
        this.ramDeflects(target, bullet) ||
        this.isAegisShielded(target) ||
        this.isBastionArmoured(target, bullet) ||
        this.isArchitectSealed(target) ||
        this.isFoundrySealed(target) ||
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
      this.rebuildFields();
    }

    for (const spark of outcome.steelHits) {
      this.broadcast(ServerMessage.SteelHit, { x: spark.x, y: spark.y } satisfies SteelHitMessage);
    }

    let escortLost = false;
    for (const { tank } of outcome.destroyedTanks) {
      if (tank.variant === CONVOY) {
        this.broadcast(ServerMessage.TankDestroyed, {
          x: tank.x + tank.width / 2,
          y: tank.y + tank.height / 2,
          isEnemy: tank.isEnemy,
          heavy: true,
        } satisfies TankDestroyedMessage);

        // Whose carrier it was decides everything. On a raid the carrier is the
        // objective and killing it is the win; on an escort it is the cargo and
        // losing it costs a life. Both used to run the second path, so a player
        // who successfully stopped a hostile carrier had the level restarted on
        // them for it, with the objective readout counting down to nothing.
        this.convoyId = null;
        if (this.currentWinCondition() !== CampaignWinCondition.DestroyConvoy) escortLost = true;
      } else {
        this.onTankDestroyed(tank);
      }
    }
    if (escortLost) {
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
    //
    // The clock stops the moment the last charge is pulled. It used to keep
    // running while a boss wave was being fought over the wreckage, so clearing
    // every bomb and then taking too long over the boss detonated bombs that no
    // longer existed and reset the level.
    if (this.currentWinCondition() === CampaignWinCondition.DefuseBombs && !this.objectiveMet) {
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

    this.refreshPurgeMarks(deltaMs);
    this.syncObjectiveTarget();
    this.refreshObjective();
    if (this.checkObjectiveFailure()) return;
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
    return this.level()?.winCondition;
  }

  /**
   * The record for the level being played.
   *
   * Everything the room used to answer by comparing `currentLevel` against a
   * constant now comes through here instead. Undefined only past the end of the
   * authored campaign, which the callers all treat as "no special rules".
   */
  private level(): CampaignLevel | undefined {
    return levelAt(this.state.currentLevel);
  }

  /** Rank-and-file ceiling for this level. */
  private maxEnemies(): number {
    return this.level()?.params?.maxEnemies ?? MAX_ENEMIES;
  }

  /**
   * True for a level built as a one-on-one fight.
   *
   * A boss level with no spawn table of its own and no background pressure
   * wanted: the Effigy duel is the only one today, and saying it this way means
   * the next one does not need a second level number written into the room.
   */
  private isDuelLevel(level: CampaignLevel): boolean {
    return (
      level.winCondition === CampaignWinCondition.AssassinateBoss &&
      (level.bosses?.some((boss) => boss.kind === BossKind.Effigy) ?? false)
    );
  }

  /** Every boss body currently on the field. */
  private bossTanks(): Tank[] {
    const out: Tank[] = [];
    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      if (tank.isBoss) out.push(tank);
    }
    return out;
  }

  /**
   * Every boss body of one kind.
   *
   * The per-tick boss routines iterate this rather than reading a single
   * `bossId`, because a level may now field more than one of the same machine —
   * two Sweepers in the same arena, or a pair of siege guns.
   */
  private bossesOf(kind: string): Tank[] {
    return this.bossTanks().filter((tank) => tank.variant === kind);
  }

  /**
   * Mutable per-boss state, created on first use.
   *
   * The boss timers used to be single fields on the room, which was correct
   * while exactly one boss could ever be alive. With multiples they have to be
   * per-body — otherwise two Sweepers share one velocity and fly in formation,
   * and two Artillery pieces share one reload and fire as one gun.
   */
  private bossState(ownerId: string): BossState {
    let state = this.bossStates.get(ownerId);
    if (!state) {
      state = {
        vx: 0,
        vy: 0,
        timerMs: 0,
        altTimerMs: 0,
        markHp: 0,
        flag: false,
        pattern: 0,
        aimX: 0,
        aimY: 0,
      };
      this.bossStates.set(ownerId, state);
    }
    return state;
  }

  /** Recomputes the replicated objective label and value for the HUD. */
  private refreshObjective(): void {
    // Once the objective is done and a boss wave has answered it, the readout
    // stops describing a job that is finished and names what is left.
    if (this.objectiveMet && this.hasBoss()) {
      const hp = this.bossTanks().reduce((sum, boss) => sum + boss.currentHealth, 0);
      const bodies = this.bossTanks().length;
      this.setObjective(bodies > 1 ? `BOSSES: ${bodies} - HP: ${hp}` : `BOSS HP: ${hp}`, hp);
      return;
    }

    switch (this.currentWinCondition()) {
      case CampaignWinCondition.DestroyRadars: {
        const remaining = this.countRadar();
        this.setObjective(
          this.ordersObjectives
            ? `RADARS LEFT: ${remaining} - IN SEQUENCE`
            : `RADARS LEFT: ${remaining}`,
          remaining,
        );
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
        // A sealed boss's HP bar is meaningless — what has to be levelled first
        // is the objective, so the readout names that instead. Asked of the
        // boss on the field rather than of the level number, so the Architect's
        // pylons and the Foundry's intakes are one rule.
        const sealed = this.bossTanks().find(
          (boss) => this.isArchitectSealed(boss) || this.isFoundrySealed(boss),
        );
        if (sealed) {
          const standing = this.countRadar();
          const label = sealed.variant === FOUNDRY ? "INTAKES" : "PYLONS";
          this.setObjective(`${label} LEFT: ${standing}`, standing);
          break;
        }

        const bodies = this.bossTanks().length;
        const hp = this.bossTanks().reduce((sum, boss) => sum + boss.currentHealth, 0);
        this.setObjective(bodies > 1 ? `BOSSES: ${bodies} - HP: ${hp}` : `BOSS HP: ${hp}`, hp);
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
        this.setObjective(
          this.ordersObjectives
            ? `INTEL LEFT: ${remaining} - IN SEQUENCE`
            : `INTEL LEFT: ${remaining}`,
          remaining,
        );
        break;
      }
      case CampaignWinCondition.Escort:
        this.setObjective("ESCORT THE CARRIER NORTH", 0);
        break;
      case CampaignWinCondition.PushPayload: {
        const rolling = this.payloadRolling();
        this.setObjective(rolling ? "PAYLOAD ADVANCING" : "STAY WITH THE PAYLOAD", 0);
        break;
      }
      case CampaignWinCondition.DestroyConvoy: {
        const hp = this.convoyHealth();
        this.setObjective(`STOP THE CARRIER - HP: ${hp}`, hp);
        break;
      }
      case CampaignWinCondition.DefendCore: {
        const seconds = this.secondsToDefend();
        this.setObjective(
          `HOLD THE RELAY: ${seconds}s - INTEGRITY ${this.relayHitsLeft}/${RELAY_HITS}`,
          seconds,
        );
        break;
      }
      case CampaignWinCondition.PurgeMarked: {
        const left = Math.max(0, this.purgeTarget() - this.markedKilled);
        this.setObjective(`MARKED TARGETS LEFT: ${left}`, left);
        break;
      }
    }
  }

  /** The carrier's remaining hit points, or 0 once it is gone. */
  private convoyHealth(): number {
    if (!this.convoyId) return 0;
    return this.findTank(this.convoyId)?.currentHealth ?? 0;
  }

  /** True while a player is close enough for the payload to be advancing. */
  private payloadRolling(): boolean {
    if (!this.convoyId) return false;
    const convoy = this.findTank(this.convoyId);
    if (!convoy) return false;

    return this.playerTanks().some((player) => {
      const dx = player.x + player.width / 2 - (convoy.x + convoy.width / 2);
      const dy = player.y + player.height / 2 - (convoy.y + convoy.height / 2);
      return Math.hypot(dx, dy) <= PAYLOAD_ESCORT_TILES * TILE_SIZE;
    });
  }

  /** The boss's remaining hit points, or 0 once it is gone. */
  private bossHealth(): number {
    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      if (tank.isBoss) return tank.currentHealth;
    }
    return 0;
  }

  /**
   * Advances the level's objective, then decides whether the level is over.
   *
   * Two stages, because an objective is no longer always the finish line. The
   * first time the win condition comes true the level is *marked* complete and
   * any boss wave scheduled for that moment is deployed; the level itself is
   * only cleared once the objective is met and nothing flagged `isBoss` is
   * still standing. Levels with no objective wave behave exactly as before,
   * since the second test passes on the same tick as the first.
   */
  private checkWin(outcome: { radarsDestroyed: number; factoriesDestroyed: number }): boolean {
    if (!this.objectiveMet && this.objectiveComplete(outcome)) {
      this.objectiveMet = true;
      this.spawnBossWave(BossTiming.Objective);
      this.refreshObjective();
    }

    if (!this.objectiveMet) return false;
    if (this.hasBoss()) return false;
    return this.winLevel();
  }

  /** Whether the level's objective has just been satisfied. */
  private objectiveComplete(outcome: {
    radarsDestroyed: number;
    factoriesDestroyed: number;
  }): boolean {
    switch (this.currentWinCondition()) {
      case CampaignWinCondition.DestroyRadars:
        return outcome.radarsDestroyed > 0 && !this.gridHasRadar();
      case CampaignWinCondition.DestroyFactories:
        return outcome.factoriesDestroyed > 0 && this.countFactory() === 0;
      case CampaignWinCondition.DefuseBombs:
        // Bombs are defused by touch in the update loop; done once none remain.
        return !this.gridHasBomb();
      case CampaignWinCondition.RetrieveIntel:
        // Intel is collected by touch in the update loop; done once none remain.
        return !this.gridHasIntel();
      case CampaignWinCondition.Escort:
      case CampaignWinCondition.PushPayload:
        // The carrier reaching the pad is the objective either way; what differs
        // is what moves it there — see {@link moveConvoy}.
        return this.convoyOnExtraction();
      case CampaignWinCondition.DestroyConvoy:
        // Escort read backwards: the carrier is hostile, and killing it is the
        // objective. It reaching *its* pad is a loss, handled in the mover.
        return this.convoyId === null;
      case CampaignWinCondition.ReachExtraction:
        return this.playerOnExtraction();
      case CampaignWinCondition.SurviveTime:
        return this.elapsedMs >= this.surviveMs();
      case CampaignWinCondition.ZoneControl:
        return this.zoneProgressMs >= this.zoneMs();
      case CampaignWinCondition.DefendCore:
        // The relay falling is a loss, resolved where the grid is damaged; if
        // the clock runs out with it still standing, the hold succeeded.
        return this.elapsedMs >= this.defendMs();
      case CampaignWinCondition.PurgeMarked:
        return this.markedKilled >= this.purgeTarget();
      case CampaignWinCondition.AssassinateBoss:
        // The boss spawns at level start, so this is only true once the
        // player's shells have finally brought it down. The second stage in
        // {@link checkWin} then passes trivially — which is what lets a boss
        // level *also* schedule an objective wave, if one is ever wanted.
        return !this.hasBoss();
    }
    return false;
  }

  /** How long the current survival level lasts, in ms (Level 3 runs longer). */
  private surviveMs(): number {
    return surviveSecondsForLevel(this.state.currentLevel) * 1000;
  }

  /** How long this level's uplink hold runs, in ms. */
  private zoneMs(): number {
    return zoneSecondsForLevel(this.state.currentLevel) * 1000;
  }

  /** How long this level's relay must be kept standing, in ms. */
  private defendMs(): number {
    return defendSecondsForLevel(this.state.currentLevel) * 1000;
  }

  /** How many marked units this level asks for. */
  private purgeTarget(): number {
    return purgeCountForLevel(this.state.currentLevel);
  }

  /** Whole seconds left on the survival timer, floored at zero. */
  private secondsToSurvive(): number {
    return Math.max(0, Math.ceil((this.surviveMs() - this.elapsedMs) / 1000));
  }

  /** Whole seconds left on the relay hold, floored at zero. */
  private secondsToDefend(): number {
    return Math.max(0, Math.ceil((this.defendMs() - this.elapsedMs) / 1000));
  }

  /** Whole seconds of uplink hold still needed, floored at zero. */
  private secondsToHoldZone(): number {
    return Math.max(0, Math.ceil((this.zoneMs() - this.zoneProgressMs) / 1000));
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
    const tank = this.anyPlayer();
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
    const tank = this.anyPlayer();
    if (!tank) return;

    const minTX = Math.floor(tank.x / TILE_SIZE);
    const maxTX = Math.floor((tank.x + tank.width - 1) / TILE_SIZE);
    const minTY = Math.floor(tank.y / TILE_SIZE);
    const maxTY = Math.floor((tank.y + tank.height - 1) / TILE_SIZE);

    for (let ty = minTY; ty <= maxTY; ty++) {
      for (let tx = minTX; tx <= maxTX; tx++) {
        if (!isInsideGrid(tx, ty)) continue;
        const index = tileIndex(tx, ty);
        if (this.state.grid.at(index) !== TileType.Bomb) continue;
        if (!this.objectiveTileLive(index)) continue;

        this.state.grid[index] = TileType.Empty;
        this.advanceObjectiveOrder();
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
    this.syncLives();

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
    const tank = this.anyPlayer();
    if (!tank) return;

    const minTX = Math.floor(tank.x / TILE_SIZE);
    const maxTX = Math.floor((tank.x + tank.width - 1) / TILE_SIZE);
    const minTY = Math.floor(tank.y / TILE_SIZE);
    const maxTY = Math.floor((tank.y + tank.height - 1) / TILE_SIZE);

    for (let ty = minTY; ty <= maxTY; ty++) {
      for (let tx = minTX; tx <= maxTX; tx++) {
        if (!isInsideGrid(tx, ty)) continue;
        const index = tileIndex(tx, ty);
        if (this.state.grid.at(index) !== TileType.Intel) continue;
        // On an ordered level only the marked package reads; the rest are inert
        // until their turn, so driving over one costs nothing but the detour.
        if (!this.objectiveTileLive(index)) continue;

        this.state.grid[index] = TileType.Empty;
        this.advanceObjectiveOrder();
      }
    }
  }

  // ------------------------------------------------------- ordered objectives
  //
  // A counter to a kit that crosses ground freely. Once the blink, the ram and
  // the lance are all in hand, a level that scatters eight packages across a map
  // is answered by going to whichever is nearest and repeating — the terrain in
  // between never has to be dealt with. Imposing an order puts the terrain back:
  // the next package is rarely the near one, and knowing where they all are buys
  // nothing.
  //
  // The order is rolled per run, not authored, so a level cannot be learned once
  // and then driven from memory.

  /**
   * Rolls this level's objective order, if it has one.
   *
   * Collects every objective tile of the level's own kind and shuffles them.
   * Levels without the flag get an empty order, which every check below reads
   * as "everything is live" — so the unordered path costs nothing.
   */
  private rollObjectiveOrder(): void {
    this.objectiveOrder = [];
    this.state.objectiveTargetTile = -1;

    if (!objectivesAreOrdered(this.state.currentLevel)) return;

    const kind = this.objectiveTileKind();
    if (kind === null) return;

    for (let i = 0; i < GRID_LENGTH; i++) {
      if (this.state.grid.at(i) === kind) this.objectiveOrder.push(i);
    }

    // Fisher-Yates.
    for (let i = this.objectiveOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.objectiveOrder[i], this.objectiveOrder[j]] = [
        this.objectiveOrder[j]!,
        this.objectiveOrder[i]!,
      ];
    }

    this.syncObjectiveTarget();
  }

  /** The tile type this level's objective is made of, or null if it has none. */
  private objectiveTileKind(): TileType | null {
    switch (this.currentWinCondition()) {
      case CampaignWinCondition.DestroyRadars: return TileType.Radar;
      case CampaignWinCondition.DestroyFactories: return TileType.Factory;
      case CampaignWinCondition.RetrieveIntel: return TileType.Intel;
      case CampaignWinCondition.DefuseBombs: return TileType.Bomb;
      default: return null;
    }
  }

  /**
   * Whether the objective tile at `index` will answer right now.
   *
   * Always true on an unordered level. On an ordered one, only the head of the
   * remaining order counts.
   */
  private objectiveTileLive(index: number): boolean {
    if (!this.ordersObjectives) return true;
    return this.state.objectiveTargetTile === index;
  }

  /**
   * Drops the tile just taken and points at the next one still standing.
   *
   * Prunes as it goes, because an objective can leave the grid without the
   * player taking it — a Sweeper grinding over a radar mast, the Architect's
   * walls closing on one — and an order still pointing at a tile that is no
   * longer there would deadlock the level.
   */
  private advanceObjectiveOrder(): void {
    if (!this.ordersObjectives) return;
    // The tile just taken is the head of the order, and is no longer of the
    // objective's kind, so the prune in here drops it and names the next.
    this.objectiveOrder.shift();
    this.syncObjectiveTarget();
  }

  /** Re-reads the order against the grid and republishes the live target. */
  private syncObjectiveTarget(): void {
    if (!this.ordersObjectives) {
      if (this.state.objectiveTargetTile !== -1) this.state.objectiveTargetTile = -1;
      return;
    }

    const kind = this.objectiveTileKind();
    if (kind === null) return;

    // Drop anything the world took out from under the order — a Sweeper
    // grinding over a mast, the Architect's walls closing on one — because an
    // order still pointing at a tile that is no longer there deadlocks the level.
    while (
      this.objectiveOrder.length > 0 &&
      this.state.grid.at(this.objectiveOrder[0]!) !== kind
    ) {
      this.objectiveOrder.shift();
    }

    // And pick up anything that appeared after the roll. Nothing does that
    // today on an ordered level, but a Reclaimer rebuilding a structure the
    // player already levelled would otherwise leave a tile the objective counts
    // and the order will never name — which is the same deadlock from the other
    // direction, and a far more confusing one to be standing in front of.
    if (this.objectiveOrder.length === 0) {
      for (let i = 0; i < GRID_LENGTH; i++) {
        if (this.state.grid.at(i) === kind) this.objectiveOrder.push(i);
      }
    }

    const next = this.objectiveOrder[0] ?? -1;
    if (this.state.objectiveTargetTile !== next) this.state.objectiveTargetTile = next;
  }

  /** True while this level is imposing an order on its objectives. */
  private get ordersObjectives(): boolean {
    return objectivesAreOrdered(this.state.currentLevel);
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
    for (const abilities of this.abilities.values()) {
      if (abilities.blinkLockMs > 0) {
        abilities.blinkLockMs = Math.max(0, abilities.blinkLockMs - deltaMs);
      }
    }

    const range = LURCHER_RANGE_TILES * TILE_SIZE;

    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      if (tank.variant !== LURCHER) continue;

      // Each Lurcher reels in whoever is closest to it, so in co-op they split
      // across the team instead of every one of them ganging up on one seat.
      const player = this.nearestPlayerTo(tank);
      if (!player) continue;

      const px = player.x + player.width / 2;
      const py = player.y + player.height / 2;

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
        // And stop short of any hull, the Lurcher's own included. Without this
        // the yank drags the player into the grappler and the two end up
        // overlapping, wedged on each other with neither able to move.
        if (collidesWithTank(this.state, player, candX, candY)) break;
        toX = candX;
        toY = candY;
      }

      player.x = toX;
      player.y = toY;
      this.abilitiesOf(player.ownerId).blinkLockMs = LURCHER_LOCK_MS;

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
    this.effigyRamCdMs = 0;
    this.effigyRamMs = 0;
    this.effigyDecoyCdMs = 0;
    this.effigyStuck = null;
    this.effigyMirages.clear();

    this.effigyStrikeMs = 0;

    // The copy is built from the strongest tank it has been watching, which is
    // the one thing this encounter always claimed and never actually did.
    const hull = this.effigyMirror("hull");
    const speed = this.effigyMirror("speed");

    this.state.tanks.push(
      new Tank({
        x: centredSpawnX(TANK_SIZE),
        y: 4 * TILE_SIZE,
        width: TANK_SIZE,
        height: TANK_SIZE,
        ownerId: id,
        maxHealth: EFFIGY_HP + EFFIGY_HP_PER_HULL * hull,
        speed: TANK_SPEED * (1 + 0.12 * speed),
        direction: Direction.Down,
        isEnemy: true,
        variant: EFFIGY,
        isBoss: true,
      }),
    );

    console.log(
      `[room ${this.roomId}] effigy mirrors hull=${hull} speed=${speed} ` +
        `rate=${this.effigyMirror("rate")} shell=${this.effigyMirror("shell")}`,
    );
  }

  /**
   * How many of one upgrade the best tank on the field has banked.
   *
   * The maximum across seats rather than a sum: the Effigy is a copy of a tank,
   * not of a party, and in co-op it should be the equal of the best of them
   * rather than the four of them stapled together.
   */
  private effigyMirror(id: string): number {
    let best = 0;
    for (const [ownerId] of this.state.players) {
      best = Math.max(best, this.upgradeCount(ownerId, id));
    }
    return best;
  }

  /** True once the Effigy is down to half its health and stops holding back. */
  private isEffigyEnraged(boss: Tank): boolean {
    return boss.currentHealth * 2 <= boss.maxHealth;
  }

  /** One of the Effigy's cooldowns, shortened once it is wounded. */
  private effigyCooldown(boss: Tank, baseMs: number): number {
    return this.isEffigyEnraged(boss) ? Math.round(baseMs * EFFIGY_ENRAGE_FACTOR) : baseMs;
  }

  /**
   * Runs the Effigy's borrowed kit — every ability the player has: shield,
   * blink, blast, ram and decoy, each on its own cooldown and used the way a
   * competent player would use them.
   *
   * It shields when hurt, charges down an open lane, blinks away when the
   * player crowds it, blasts when they crowd it anyway, and leaves a copy of
   * itself standing where it was so the next few shells go into nothing.
   * Movement is otherwise the ordinary hunter field — the fight is about the
   * kit, not exotic pathing — with a watchdog on top of it, because a boss the
   * general anti-stuck pass deliberately skips has no other way out of a wall.
   */
  private updateEffigy(deltaMs: number): void {
    this.tickEffigyMirages(deltaMs);

    if (!this.bossId) return;
    const boss = this.findTank(this.bossId);
    if (!boss || boss.variant !== EFFIGY) return;

    // Its shield runs on the same shape of timer the player's does.
    if (this.effigyShieldMs > 0) {
      this.effigyShieldMs = Math.max(0, this.effigyShieldMs - deltaMs);
      if (this.effigyShieldMs === 0) {
        boss.isShielded = false;
        this.effigyShieldCdMs = this.effigyCooldown(boss, EFFIGY_SHIELD_COOLDOWN_MS);
      }
    } else if (this.effigyShieldCdMs > 0) {
      this.effigyShieldCdMs = Math.max(0, this.effigyShieldCdMs - deltaMs);
    }

    if (this.effigyBlinkCdMs > 0) this.effigyBlinkCdMs = Math.max(0, this.effigyBlinkCdMs - deltaMs);
    if (this.effigyBlastCdMs > 0) this.effigyBlastCdMs = Math.max(0, this.effigyBlastCdMs - deltaMs);
    if (this.effigyRamCdMs > 0) this.effigyRamCdMs = Math.max(0, this.effigyRamCdMs - deltaMs);
    if (this.effigyDecoyCdMs > 0) this.effigyDecoyCdMs = Math.max(0, this.effigyDecoyCdMs - deltaMs);

    // A charge is committed: it runs to its end before anything else happens.
    if (this.effigyRamMs > 0) {
      this.driveEffigyRam(boss, deltaMs);
      return;
    }

    // Ahead of the player check on purpose. While the player is dead the flow
    // field has no target, so the Effigy holds whatever heading it had, grinds
    // into a wall and stays there — and this is the only thing that frees it.
    // Gating the watchdog on a living player meant the one moment it was most
    // likely to wedge was the one moment nothing was watching.
    this.watchEffigyStuck(boss, deltaMs);

    const player = this.nearestPlayerTo(boss);
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
      this.effigyBlastCdMs = this.effigyCooldown(boss, EFFIGY_BLAST_COOLDOWN_MS);
      this.effigyBlast(boss);
      return;
    }

    // Blinks away when crowded, to reopen the range it wants to shoot from —
    // and leaves a mirage behind on the way out whenever it has one banked.
    if (this.effigyBlinkCdMs === 0 && dist <= EFFIGY_BLAST_TRIGGER_TILES * TILE_SIZE * 1.6) {
      this.effigyBlinkCdMs = this.effigyCooldown(boss, EFFIGY_BLINK_COOLDOWN_MS);
      this.maybeDropEffigyMirage(boss, dist);
      this.effigyBlink(boss, dx, dy);
      return;
    }

    // Charges down an open lane at mid range: the player's own ram, aimed back
    // at them, and lethal on contact for exactly as long as it is running.
    if (this.effigyRamCdMs === 0 && this.startEffigyRam(boss, dx, dy)) return;

    // Drops a mirage while the player is closing, so the shells they open with
    // go into a copy rather than into the boss.
    this.maybeDropEffigyMirage(boss, dist);

    // Wounded, it starts calling shells down as well — the last piece of the
    // player's own kit it had not copied, and the thing that stops the endgame
    // being decided by whoever can circle a pillar for longer.
    if (this.isEffigyEnraged(boss)) {
      this.effigyStrikeMs += deltaMs;
      if (this.effigyStrikeMs >= EFFIGY_STRIKE_INTERVAL_MS) {
        this.effigyStrikeMs -= EFFIGY_STRIKE_INTERVAL_MS;
        this.launchSapperLob(boss, player);
      }
    }

    // And shoots, briskly, the rest of the time — but only after turning onto
    // the player, and at the player's own rate of fire.
    const interval = Math.round(
      EFFIGY_SHOOT_INTERVAL_MS *
        Math.pow(AUTOLOADER_FIRE_FACTOR, this.effigyMirror("rate")) *
        (this.isEffigyEnraged(boss) ? EFFIGY_ENRAGE_FACTOR : 1),
    );

    this.effigyShootMs += deltaMs;
    if (this.effigyShootMs >= interval) {
      this.effigyShootMs -= interval;

      // Only onto a cardinal it can actually shoot down: the hull is
      // grid-aligned and so is its gun.
      let aim: Direction | null = null;
      if (Math.abs(dy) <= EFFIGY_AIM_SLACK) aim = dx > 0 ? Direction.Right : Direction.Left;
      else if (Math.abs(dx) <= EFFIGY_AIM_SLACK) aim = dy > 0 ? Direction.Down : Direction.Up;

      if (
        aim !== null &&
        this.hasClearLine(
          boss.x + boss.width / 2,
          boss.y + boss.height / 2,
          player.x + player.width / 2,
          player.y + player.height / 2,
        )
      ) {
        boss.direction = aim;
        this.fire(boss);
      }
    }
  }

  /**
   * Frees an Effigy that has stopped moving.
   *
   * It is steered by the flow field, and that steering only ever turns a tank
   * standing exactly on the tile lattice. A blink that lands it half a tile off
   * — which the ordinary mid-step blink does — therefore leaves it able to
   * drive in one direction and never turn again: it runs to the nearest wall
   * and sits there for the rest of the fight. Snapping it back onto the lattice
   * is the fix; a forced step covers the case where it is genuinely boxed in.
   */
  private watchEffigyStuck(boss: Tank, deltaMs: number): void {
    const tileX = Math.floor(boss.x / TILE_SIZE);
    const tileY = Math.floor(boss.y / TILE_SIZE);

    const previous = this.effigyStuck;
    if (!previous) {
      this.effigyStuck = { x: tileX, y: tileY, ms: 0 };
      return;
    }

    if (tileX !== previous.x || tileY !== previous.y) {
      previous.x = tileX;
      previous.y = tileY;
      previous.ms = 0;
      return;
    }

    previous.ms += deltaMs;
    if (previous.ms < EFFIGY_STUCK_MS) return;
    previous.ms = 0;

    const snapX = Math.round(boss.x / TILE_SIZE) * TILE_SIZE;
    const snapY = Math.round(boss.y / TILE_SIZE) * TILE_SIZE;
    if (
      (snapX !== boss.x || snapY !== boss.y) &&
      !isBlocked(this.state, snapX, snapY, boss.width, boss.height) &&
      !collidesWithTank(this.state, boss, snapX, snapY)
    ) {
      boss.x = snapX;
      boss.y = snapY;
    }

    // Still pinned: turn somewhere it can actually go and take the step itself.
    const escape = this.randomPassableDir(boss, boss.direction);
    if (escape === null) return;
    boss.direction = escape;
    moveTank(this.state, boss, false);

    previous.x = Math.floor(boss.x / TILE_SIZE);
    previous.y = Math.floor(boss.y / TILE_SIZE);
  }

  /**
   * Starts a charge when the player is sitting in an open lane.
   *
   * Aligned and at range, in the same window the player's own ram is useful in:
   * close enough to reach before they can walk out of it, far enough that it is
   * a charge rather than a bump.
   */
  private startEffigyRam(boss: Tank, dx: number, dy: number): boolean {
    const min = EFFIGY_RAM_MIN_TILES * TILE_SIZE;
    const max = EFFIGY_RAM_MAX_TILES * TILE_SIZE;

    let direction: Direction | null = null;
    if (Math.abs(dy) <= EFFIGY_RAM_ALIGN_SLACK && Math.abs(dx) >= min && Math.abs(dx) <= max) {
      direction = dx > 0 ? Direction.Right : Direction.Left;
    } else if (Math.abs(dx) <= EFFIGY_RAM_ALIGN_SLACK && Math.abs(dy) >= min && Math.abs(dy) <= max) {
      direction = dy > 0 ? Direction.Down : Direction.Up;
    }
    if (direction === null) return false;

    this.effigyRamCdMs = EFFIGY_RAM_COOLDOWN_MS;
    this.effigyRamMs = RAM_DURATION_MS;
    this.effigyRamDirection = direction;
    boss.direction = direction;

    this.broadcast(ServerMessage.RamChanged, {
      active: true,
      cooldownMs: 0,
      foreign: true,
    } satisfies RamChangedMessage);
    return true;
  }

  /**
   * Advances a running charge: brick gives way, steel ends it, and a player
   * caught by the hull is run down unless their deflector is up.
   *
   * The shield exception is the player's own rule played back at them — their
   * ram turns a rusher only while the deflector holds — so the counter to the
   * charge is the same one they have been using all campaign.
   */
  private driveEffigyRam(boss: Tank, deltaMs: number): void {
    this.effigyRamMs = Math.max(0, this.effigyRamMs - deltaMs);

    const heading = DIRECTION_VECTORS[this.effigyRamDirection];
    const step = TANK_SPEED * RAM_SPEED_FACTOR;
    const nextX = boss.x + heading.x * step;
    const nextY = boss.y + heading.y * step;

    boss.direction = this.effigyRamDirection;

    if (isBlocked(this.state, nextX, nextY, boss.width, boss.height)) {
      if (!this.ramThroughBrick(boss, nextX, nextY)) {
        this.endEffigyRam(boss);
        return;
      }
    }

    boss.x = nextX;
    boss.y = nextY;

    for (const player of this.playerTanks()) {
      if (player.isInvulnerable) continue;
      if (
        !boxesOverlap(boss.x, boss.y, boss.width, boss.height, player.x, player.y, player.width, player.height)
      ) {
        continue;
      }

      if (this.isShieldUp(player)) {
        this.endEffigyRam(boss);
        return;
      }
      this.killPlayer(player.ownerId);
      this.endEffigyRam(boss);
      return;
    }

    if (this.effigyRamMs === 0) this.endEffigyRam(boss);
  }

  /**
   * Ends a charge, re-seats the hull on the tile lattice, and tells the clients
   * to drop the surge effect.
   *
   * The re-seat is not cosmetic: a surge advances in steps that do not divide a
   * tile, and a flow-field mover left mid-tile can never turn again.
   */
  private endEffigyRam(boss?: Tank): void {
    if (boss) {
      const snapX = Math.round(boss.x / TILE_SIZE) * TILE_SIZE;
      const snapY = Math.round(boss.y / TILE_SIZE) * TILE_SIZE;
      if (
        !isBlocked(this.state, snapX, snapY, boss.width, boss.height) &&
        !collidesWithTank(this.state, boss, snapX, snapY)
      ) {
        boss.x = snapX;
        boss.y = snapY;
      }
    }
    if (this.effigyStuck) this.effigyStuck.ms = 0;
    this.effigyRamMs = 0;
    this.broadcast(ServerMessage.RamChanged, {
      active: false,
      cooldownMs: 0,
      foreign: true,
    } satisfies RamChangedMessage);
  }

  /**
   * Leaves a standing copy of the Effigy behind, if one is off cooldown.
   *
   * The player's decoy pulls enemy attention onto a beacon; the Effigy has no
   * allies to misdirect, so its version misdirects the player instead — a
   * mirage that looks exactly like the boss, walks at them like the boss, and
   * evaporates the moment a single shell finds it.
   */
  private maybeDropEffigyMirage(boss: Tank, dist: number): void {
    if (this.effigyDecoyCdMs > 0) return;
    if (dist > EFFIGY_DECOY_TRIGGER_TILES * TILE_SIZE) return;

    // Beside the boss, never on it. Dropped on the boss's own footprint the
    // two hulls overlapped, and since movement refuses any step that touches
    // another hull, neither could move again until the mirage faded — the
    // Effigy sat frozen inside its own decoy for the whole six seconds.
    const spot = this.mirageSpot(boss);
    if (!spot) return;

    this.effigyDecoyCdMs = EFFIGY_DECOY_COOLDOWN_MS;

    const id = `mirage-${this.enemySequence++}`;
    this.state.tanks.push(
      new Tank({
        x: spot.x,
        y: spot.y,
        width: boss.width,
        height: boss.height,
        ownerId: id,
        maxHealth: 1,
        speed: TANK_SPEED,
        direction: boss.direction,
        isEnemy: true,
        variant: EFFIGY,
      }),
    );
    this.effigyMirages.set(id, EFFIGY_DECOY_DURATION_MS);
  }

  /**
   * An open, tile-aligned spot beside `boss` for a mirage, or null.
   *
   * Searched in rings outward from the boss, taking the spot in each ring that
   * is nearest the player — the mirage is meant to be walked into, so it goes
   * between them rather than behind the boss.
   */
  private mirageSpot(boss: Tank): { x: number; y: number } | null {
    const baseX = Math.round(boss.x / TILE_SIZE) * TILE_SIZE;
    const baseY = Math.round(boss.y / TILE_SIZE) * TILE_SIZE;
    const maxX = WORLD_WIDTH - boss.width;
    const maxY = WORLD_HEIGHT - boss.height;
    const player = this.nearestPlayerTo(boss);

    for (let ring = 1; ring <= 3; ring++) {
      let best: { x: number; y: number } | null = null;
      let bestDistance = Infinity;

      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;

          const x = baseX + dx * TILE_SIZE;
          const y = baseY + dy * TILE_SIZE;
          if (x < 0 || y < 0 || x > maxX || y > maxY) continue;
          if (isBlocked(this.state, x, y, boss.width, boss.height)) continue;
          if (this.hullAt(x, y, boss.width, boss.height)) continue;

          const distance = player ? Math.hypot(player.x - x, player.y - y) : 0;
          if (distance < bestDistance) {
            best = { x, y };
            bestDistance = distance;
          }
        }
      }
      if (best) return best;
    }

    return null;
  }

  /** True when any hull at all — the asker's own included — overlaps the box. */
  private hullAt(x: number, y: number, w: number, h: number): boolean {
    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      if (boxesOverlap(x, y, w, h, tank.x, tank.y, tank.width, tank.height)) return true;
    }
    return false;
  }

  /** Fades out any mirage that has outlived its duration. */
  private tickEffigyMirages(deltaMs: number): void {
    for (const [ownerId, remaining] of this.effigyMirages) {
      const left = remaining - deltaMs;
      if (left > 0) {
        this.effigyMirages.set(ownerId, left);
        continue;
      }

      this.effigyMirages.delete(ownerId);
      const index = this.state.tanks.findIndex((tank) => tank.ownerId === ownerId);
      if (index >= 0) this.state.tanks.splice(index, 1);
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

    // Land square on the lattice. A blink taken mid-step preserves the fraction
    // of a tile the boss was standing off by, and a flow-field mover that is
    // not tile-aligned can never turn again — it drives into the nearest wall
    // and stops there, which is exactly how this fight used to end itself.
    const snapX = Math.round(boss.x / TILE_SIZE) * TILE_SIZE;
    const snapY = Math.round(boss.y / TILE_SIZE) * TILE_SIZE;
    if (
      !isBlocked(this.state, snapX, snapY, boss.width, boss.height) &&
      !collidesWithTank(this.state, boss, snapX, snapY)
    ) {
      boss.x = snapX;
      boss.y = snapY;
    }

    // Reuses the player's own blink effect, which is exactly the point —
    // flagged foreign so the client draws it without adopting the charge count
    // as its own and blanking the player's blink readout.
    this.broadcast(ServerMessage.TeleportChanged, {
      charges: 0,
      rechargeMs: 0,
      foreign: true,
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
      foreign: true,
      x: cx,
      y: cy,
      radius,
    } satisfies BlastChangedMessage);

    for (const player of this.playerTanks()) {
      if (player.isInvulnerable || this.isShieldUp(player)) continue;

      const dx = player.x + player.width / 2 - cx;
      const dy = player.y + player.height / 2 - cy;
      if (Math.hypot(dx, dy) > radius) continue;

      player.currentHealth = Math.max(0, player.currentHealth - 1);
      if (player.currentHealth === 0) this.killPlayer(player.ownerId);
    }
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

    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      if (tank.variant !== SAPPER) continue;

      // Each Sapper keeps its standoff band against whoever is nearest to it,
      // so in co-op they spread out across the team rather than all backing
      // away from the same seat.
      const player = this.nearestPlayerTo(tank);
      if (!player) continue;

      const px = player.x + player.width / 2;
      const py = player.y + player.height / 2;

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
    {
      for (let i = 0; i < this.state.tanks.length; i++) {
        const tank = this.state.tanks.at(i);
        if (tank.variant !== SAPPER) continue;

        // Shells go at whoever this Sapper is actually holding off.
        const player = this.nearestPlayerTo(tank);
        if (!player) continue;

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

    const bx = worldX - SAPPER_LOB_RADIUS;
    const by = worldY - SAPPER_LOB_RADIUS;
    const size = SAPPER_LOB_RADIUS * 2;

    // A blast is a place, not a person: everyone standing in it is caught.
    for (const player of this.playerTanks()) {
      if (player.isInvulnerable || this.isShieldUp(player)) continue;
      if (!boxesOverlap(bx, by, size, size, player.x, player.y, player.width, player.height)) {
        continue;
      }

      player.currentHealth = Math.max(0, player.currentHealth - SAPPER_LOB_DAMAGE);
      if (player.currentHealth === 0) this.killPlayer(player.ownerId);
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

  /** Detonates mines under any player: clears the tile and kills them. */
  private resolveMines(): void {
    // Every player treads on their own mines — checked per tank rather than
    // once for "the player", or in co-op only one seat would ever set one off.
    for (const tank of this.playerTanks()) {
      if (tank.isInvulnerable) continue;

      // A raised shield does not make the player intangible — the mine still
      // goes off, it is still spent, and the blast is simply soaked. Skipping
      // the pass instead would leave live charges armed under their tracks, to
      // catch them the moment the shield lapsed.
      const absorbed = this.isShieldUp(tank);

      const minTX = Math.floor(tank.x / TILE_SIZE);
      const maxTX = Math.floor((tank.x + tank.width - 1) / TILE_SIZE);
      const minTY = Math.floor(tank.y / TILE_SIZE);
      const maxTY = Math.floor((tank.y + tank.height - 1) / TILE_SIZE);

      let done = false;
      for (let ty = minTY; ty <= maxTY && !done; ty++) {
        for (let tx = minTX; tx <= maxTX && !done; tx++) {
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

          if (!absorbed) this.killPlayer(tank.ownerId);
          done = true;
        }
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
      // The carrier is gone. On a raid that is the objective met; on an escort
      // the loss is resolved where its health reached zero, not here.
      this.convoyId = null;
      return;
    }

    const dt = deltaMs / 1000;

    switch (this.currentWinCondition()) {
      case CampaignWinCondition.DestroyConvoy: {
        // A hostile carrier runs for its own pad, and reaching it is a loss.
        // It steers toward the pad on whichever axis is furthest out, so one
        // mover serves both the east-west road and the south-north crossing.
        const pad = this.firstTileOf(TileType.ExtractionZone);
        if (pad) {
          const dx = pad.x - convoy.x;
          const dy = pad.y - convoy.y;
          const step = HOSTILE_CONVOY_SPEED * dt;

          if (Math.abs(dx) >= Math.abs(dy)) {
            const nextX = convoy.x + Math.sign(dx) * step;
            if (!isBlocked(this.state, nextX, convoy.y, convoy.width, convoy.height)) {
              convoy.x = nextX;
            } else {
              // Blocked along the main axis: slide on the other one to get round.
              const slideY = convoy.y + Math.sign(dy || 1) * step;
              if (!isBlocked(this.state, convoy.x, slideY, convoy.width, convoy.height)) {
                convoy.y = slideY;
              }
            }
            convoy.direction = dx >= 0 ? Direction.Right : Direction.Left;
          } else {
            const nextY = convoy.y + Math.sign(dy) * step;
            if (!isBlocked(this.state, convoy.x, nextY, convoy.width, convoy.height)) {
              convoy.y = nextY;
            } else {
              const slideX = convoy.x + Math.sign(dx || 1) * step;
              if (!isBlocked(this.state, slideX, convoy.y, convoy.width, convoy.height)) {
                convoy.x = slideX;
              }
            }
            convoy.direction = dy >= 0 ? Direction.Down : Direction.Up;
          }
        }
        return;
      }

      case CampaignWinCondition.PushPayload: {
        // The breaker has no guidance of its own: it rolls only while a player
        // is beside it, so the level's pace is entirely the player's. Standing
        // and fighting is a real decision rather than a free pause.
        if (!this.payloadRolling()) return;

        // It is a hole-punch on tracks, and it goes in one direction: straight.
        // The walls between it and the door are brick, and it eats them —
        // which is the point of the machine and the reason the level's gaps
        // are the *player's* route rather than the payload's. Steel still
        // stops it, so a map can still tell it where not to go.
        this.crushPayloadTiles(convoy);

        const nextY = convoy.y + PAYLOAD_VY * dt;
        if (!isBlocked(this.state, convoy.x, nextY, convoy.width, convoy.height)) {
          convoy.y = nextY;
        }
        return;
      }

      default: {
        const nextY = convoy.y + CONVOY_VY * dt;
        if (!isBlocked(this.state, convoy.x, nextY, convoy.width, convoy.height)) {
          convoy.y = nextY;
        }
      }
    }
  }

  /**
   * Chews the brick directly ahead of the payload.
   *
   * Only brick, and only the row it is about to enter — the breaker opens a
   * doorway rather than a boulevard, so the player still has cover on either
   * side of the hole it makes. Objective tiles and steel are left alone, which
   * is what lets a map route it.
   */
  private crushPayloadTiles(payload: Tank): void {
    const aheadY = payload.y + PAYLOAD_VY * (PAYLOAD_BREACH_LOOKAHEAD_MS / 1000);
    const minTX = Math.floor(payload.x / TILE_SIZE);
    const maxTX = Math.floor((payload.x + payload.width - 1) / TILE_SIZE);
    const ty = Math.floor(aheadY / TILE_SIZE);

    let opened = false;
    for (let tx = minTX; tx <= maxTX; tx++) {
      if (!isInsideGrid(tx, ty)) continue;
      const index = tileIndex(tx, ty);
      if (this.state.grid.at(index) !== TileType.Brick) continue;

      this.state.grid[index] = TileType.Empty;
      opened = true;
    }

    if (opened) {
      this.rebuildFields();
      this.broadcast(ServerMessage.SteelHit, {
        x: payload.x + payload.width / 2,
        y: aheadY,
      } satisfies SteelHitMessage);
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
    // Only an *allied* carrier can be shouldered to death by enemy hulls. A
    // hostile one is an enemy itself, so the scan below found it overlapping
    // itself and chipped it down one point every half second until it died and
    // took the level with it — the player never had to do anything, and never
    // had any way to tell what was happening.
    const win = this.currentWinCondition();
    if (win !== CampaignWinCondition.Escort && win !== CampaignWinCondition.PushPayload) {
      return false;
    }

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
    this.failLevel("carrier destroyed");
  }

  /**
   * Costs the run a life and restarts the level, or ends it.
   *
   * The shape every "you did not lose a tank, you lost the objective" failure
   * takes: an escort carrier shot out, a relay levelled, a hostile carrier that
   * got away. Restarting rather than continuing is the only sensible reading —
   * the level's whole premise is gone.
   */
  private failLevel(reason: string): void {
    this.state.lives = Math.max(0, this.state.lives - 1);
    this.syncLives();

    if (this.state.lives <= 0) {
      this.state.phase = CampaignPhase.GameOver;
      console.log(`[room ${this.roomId}] ${reason} — game over`);
      return;
    }

    console.log(`[room ${this.roomId}] ${reason} — ${this.state.lives} lives left, retrying`);
    this.beginLevel();
  }

  /**
   * Objective failures that are not about the player's own hull.
   *
   * Run every tick, before the win check, so a level that has already been lost
   * cannot also be won on the same tick.
   *
   * Returns true when the level was reset or the run ended, which stops the
   * rest of the tick — everything after this point would be working on a world
   * that no longer exists.
   */
  private checkObjectiveFailure(): boolean {
    switch (this.currentWinCondition()) {
      case CampaignWinCondition.DefendCore:
        // The relay is the arena's eagle tile: gone from the grid means levelled.
        if (!this.gridHasTile(TileType.EagleBase)) {
          this.failLevel("relay destroyed");
          return true;
        }
        return false;

      case CampaignWinCondition.DestroyConvoy:
        // Reaching its own pad is the carrier getting away with the cargo.
        if (this.convoyId !== null && this.convoyOnExtraction()) {
          this.failLevel("carrier reached its exit");
          return true;
        }
        return false;

      default:
        return false;
    }
  }

  /**
   * Decides whether the relay survives this shell, on a `defend_core` level.
   *
   * Two rules in one place, because they are both about the same tile:
   *
   *  - A player's own shell never damages it. It is the thing they are
   *    defending, and a stray round from the defender ending the level is a
   *    loss nobody can read as their own decision.
   *  - An enemy shell chips it. The mast only falls on the last of
   *    {@link RELAY_HITS}, so the hold degrades visibly instead of ending on a
   *    single lucky shot through a door.
   */
  private relayAbsorbs(index: number, bullet: Bullet): boolean {
    if (this.currentWinCondition() !== CampaignWinCondition.DefendCore) return false;
    if (this.state.grid.at(index) !== TileType.EagleBase) return false;

    if (!bullet.isEnemy) return true;

    this.relayHitsLeft = Math.max(0, this.relayHitsLeft - 1);
    if (this.relayHitsLeft > 0) {
      // A hit that held: announce it where the relay stands, so the player can
      // hear the thing they are guarding being worked on from across the map.
      this.broadcast(ServerMessage.SteelHit, {
        x: (index % GRID_WIDTH) * TILE_SIZE + TILE_SIZE / 2,
        y: Math.floor(index / GRID_WIDTH) * TILE_SIZE + TILE_SIZE / 2,
      } satisfies SteelHitMessage);
      this.refreshObjective();
      return true;
    }

    return false;
  }

  /** True while any tile of `tile` is still on the grid. */
  private gridHasTile(tile: TileType): boolean {
    for (let i = 0; i < GRID_LENGTH; i++) {
      if (this.state.grid.at(i) === tile) return true;
    }
    return false;
  }

  /**
   * Marks live targets on a purge level, and tops the marks up as units arrive.
   *
   * Only marked hulls count, so the level is about reading the field rather
   * than clearing it: shooting an unmarked one costs the ammunition and the
   * time and nothing else. Marks are handed out to whatever is currently on the
   * field, which means they move around as the fight goes on.
   *
   * One at a time, {@link PURGE_MARK_INTERVAL_MS} apart, and on whichever hull
   * is furthest from every player — so each new mark is a trip across the
   * field rather than the tank beside the one just killed.
   */
  private refreshPurgeMarks(deltaMs: number): void {
    if (this.currentWinCondition() !== CampaignWinCondition.PurgeMarked) return;

    this.purgeMarkCooldownMs = Math.max(0, this.purgeMarkCooldownMs - deltaMs);

    // Enough marks alive at once to be findable, but never so many that the
    // level collapses into "shoot everything".
    const wanted = Math.min(
      CampaignRoom.PURGE_MARKS,
      Math.max(0, this.purgeTarget() - this.markedKilled),
    );

    // Drop marks whose hull has gone (destroyed by something other than the
    // player, or cleared by a level reset).
    for (const ownerId of [...this.markedIds]) {
      if (!this.findTank(ownerId)) this.markedIds.delete(ownerId);
    }
    if (this.markedIds.size >= wanted || this.purgeMarkCooldownMs > 0) return;

    let pick: Tank | null = null;
    let pickDistance = -1;
    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      if (!tank.isEnemy || tank.isBoss) continue;
      if (this.markedIds.has(tank.ownerId)) continue;
      // A disguised Mimic is already pretending to be something else; marking
      // one would give the disguise away for free.
      if (tank.isDisguised) continue;

      const cx = tank.x + tank.width / 2;
      const cy = tank.y + tank.height / 2;
      const player = this.nearestPlayer(cx, cy);
      const distance = player
        ? Math.hypot(player.x + player.width / 2 - cx, player.y + player.height / 2 - cy)
        : 0;
      if (distance > pickDistance) {
        pick = tank;
        pickDistance = distance;
      }
    }
    if (!pick) return;

    this.markedIds.add(pick.ownerId);
    pick.isMarked = true;
    this.purgeMarkCooldownMs = CampaignRoom.PURGE_MARK_INTERVAL_MS;
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

    // The outro is where the run is shaped: deal each survivor a hand while
    // they read the debrief. Not after the last level, though — there is no
    // next level for it to shape, and offering three cards to a player who has
    // just won reads as though the run were still going.
    if (this.state.currentLevel < CAMPAIGN_LEVELS.length) this.offerUpgrades();
    else this.upgradeOffers.clear();

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
   *
   * A rusher that reaches the relay on a hold, or the allied carrier, goes off
   * on that instead and takes it with it. Both used to shrug a rusher off — the
   * relay only counted shells, and the carrier took one point of contact damage
   * from it like any other hull — which made the one unit built to be stopped
   * at all costs the one the player could safely let through.
   *
   * Returns true when that failed the level: the world the rest of the tick
   * was working on has just been rebuilt.
   */
  private resolveKamikaze(): boolean {
    const pad = KAMIKAZE_CONTACT_PADDING;

    for (let i = this.state.tanks.length - 1; i >= 0; i--) {
      const enemy = this.state.tanks.at(i);
      if (!enemy.isEnemy || enemy.variant !== KAMIKAZE) continue;

      if (this.kamikazeHitsObjective(enemy)) return true;

      // A rusher detonates on whoever it actually reached.
      const player = this.nearestPlayerTo(enemy);
      if (!player || player.isInvulnerable || this.isShieldUp(player)) continue;

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

      return false; // the player is gone; no further contact to resolve this tick
    }
    return false;
  }

  /**
   * Sets `rusher` off on the relay or the allied carrier, if it has reached
   * either. Returns true when that cost the level.
   */
  private kamikazeHitsObjective(rusher: Tank): boolean {
    const pad = KAMIKAZE_CONTACT_PADDING;
    const rx = rusher.x - pad;
    const ry = rusher.y - pad;
    const rw = rusher.width + pad * 2;
    const rh = rusher.height + pad * 2;
    const win = this.currentWinCondition();

    if (win === CampaignWinCondition.DefendCore) {
      let reached = false;
      for (let index = 0; index < GRID_LENGTH && !reached; index++) {
        if (this.state.grid.at(index) !== TileType.EagleBase) continue;
        const tx = (index % GRID_WIDTH) * TILE_SIZE;
        const ty = Math.floor(index / GRID_WIDTH) * TILE_SIZE;
        reached = boxesOverlap(rx, ry, rw, rh, tx, ty, TILE_SIZE, TILE_SIZE);
      }
      if (!reached) return false;

      this.detonateRusher(rusher);
      // Level the whole mast, so a game over leaves it visibly gone.
      for (let index = 0; index < GRID_LENGTH; index++) {
        if (this.state.grid.at(index) === TileType.EagleBase) this.state.grid[index] = TileType.Empty;
      }
      this.relayHitsLeft = 0;
      this.failLevel("relay destroyed by a rusher");
      return true;
    }

    if (
      (win === CampaignWinCondition.Escort || win === CampaignWinCondition.PushPayload) &&
      this.convoyId
    ) {
      const convoy = this.findTank(this.convoyId);
      if (!convoy) return false;
      if (!boxesOverlap(rx, ry, rw, rh, convoy.x, convoy.y, convoy.width, convoy.height)) return false;

      this.detonateRusher(rusher);
      convoy.currentHealth = 0;
      const index = this.state.tanks.indexOf(convoy);
      if (index >= 0) this.state.tanks.splice(index, 1);
      this.broadcast(ServerMessage.TankDestroyed, {
        x: convoy.x + convoy.width / 2,
        y: convoy.y + convoy.height / 2,
        isEnemy: false,
        heavy: true,
      } satisfies TankDestroyedMessage);
      this.loseConvoy();
      return true;
    }

    return false;
  }

  /** Takes a rusher off the field in its own explosion. */
  private detonateRusher(rusher: Tank): void {
    const index = this.state.tanks.indexOf(rusher);
    if (index >= 0) this.state.tanks.splice(index, 1);
    this.onTankDestroyed(rusher);
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
    if (changed) this.rebuildFields();
  }

  // -------------------------------------------------------------- sweeper boss

  /**
   * Drives the boss one step under its own momentum.
   *
   * No pathing — it simply advances by its velocity and rebounds off steel or
   * the map edge, one axis at a time, crushing any brick or radar it rolls over.
   */
  private moveSweeper(deltaMs: number): void {
    const dt = deltaMs / 1000;

    // Every Sweeper on the field, each carrying its own velocity: a level may
    // field two of them, and a shared velocity would have flown them in
    // formation as one very wide wrecking ball.
    for (const boss of this.bossesOf(SWEEPER)) {
      const state = this.bossState(boss.ownerId);
      let bounced = false;

      const nextX = boss.x + state.vx * dt;
      if (this.sweeperHitsWall(nextX, boss.y, boss.width, boss.height)) {
        state.vx = -state.vx;
        bounced = true;
      } else {
        boss.x = nextX;
      }

      const nextY = boss.y + state.vy * dt;
      if (this.sweeperHitsWall(boss.x, nextY, boss.width, boss.height)) {
        state.vy = -state.vy;
        bounced = true;
      } else {
        boss.y = nextY;
      }

      if (bounced) {
        // The plain reversal above already points it back into open space; a
        // third of the time, override that with a lunge at the player instead.
        this.maybeHomingBounce(boss, dt);
        this.onSweeperBounce(boss);
      }

      this.crushTiles(boss.x, boss.y, boss.width, boss.height);
      this.crushEnemies(boss);
    }
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

    const player = this.nearestPlayerTo(boss);
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
      const state = this.bossState(boss.ownerId);
      state.vx = homingVx;
      state.vy = homingVy;
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

    const player = this.nearestPlayerTo(boss);
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
      this.rebuildFields();
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

    const player = this.nearestPlayerTo(boss);
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
      this.rebuildFields();
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
    const dt = deltaMs / 1000;

    for (const boss of this.bossesOf(ARTILLERY)) {
      const player = this.nearestPlayerTo(boss);
      if (!player) continue;

      const bossCx = boss.x + boss.width / 2;
      const bossCy = boss.y + boss.height / 2;
      const playerCx = player.x + player.width / 2;
      const playerCy = player.y + player.height / 2;

      // Only runs once the player is actually on top of it; from across the map
      // it stands and shells, so the approach is a push rather than a chase.
      if (Math.hypot(bossCx - playerCx, bossCy - playerCy) > ARTILLERY_FLEE_TILES * TILE_SIZE) {
        continue;
      }

      // Reverse of the angle to the player: head straight away from them.
      const angle = Math.atan2(bossCy - playerCy, bossCx - playerCx);
      const vx = Math.cos(angle) * ARTILLERY_SPEED;
      const vy = Math.sin(angle) * ARTILLERY_SPEED;

      const nextX = boss.x + vx * dt;
      if (!isBlocked(this.state, nextX, boss.y, boss.width, boss.height)) boss.x = nextX;

      const nextY = boss.y + vy * dt;
      if (!isBlocked(this.state, boss.x, nextY, boss.width, boss.height)) boss.y = nextY;
    }
  }

  // -------------------------------------------------------------- bastion boss

  /**
   * True when a shell is striking the Bastion's armoured plating.
   *
   * Three faces of four are sealed at any moment; the open one is
   * {@link Tank.weakSide}, and it steps round the hull on its own timer.
   *
   * Both earlier versions tied the armour to the hull's facing, and both failed
   * the same way: the Bastion re-aims at the player every
   * {@link BASTION_TURN_INTERVAL_MS}, so whichever face it kept sealed was
   * always the face the player was standing on. Rear-only meant the stern was
   * never reachable; bow-only meant the bow was always pointed at you and the
   * flanks were only open for the instant between swings. Cutting the armour
   * loose from the turret is what makes the fight a circle rather than a
   * stalemate: the opening is somewhere definite, it is visible, and it moves.
   *
   * A shell travelling in direction `d` strikes the face on the opposite side of
   * the hull, hence the `+ 2`.
   */
  private isBastionArmoured(target: Tank, bullet: Bullet): boolean {
    if (target.variant !== BASTION) return false;
    return target.weakSide !== ((bullet.direction + 2) % 4);
  }

  /** Swings the Bastion toward the player and walks it slowly forward. */
  private moveBastion(deltaMs: number): void {
    if (!this.bossId) return;
    const boss = this.findTank(this.bossId);
    if (!boss || boss.variant !== BASTION) return;

    const player = this.nearestPlayerTo(boss);
    if (!player) return;

    // The unarmoured face walks round the hull, independently of where the gun
    // is pointing. This, not the turret, is the fight.
    this.bastionWeakMs += deltaMs;
    if (this.bastionWeakMs >= BASTION_WEAK_ROTATE_MS) {
      this.bastionWeakMs -= BASTION_WEAK_ROTATE_MS;
      boss.weakSide = ((boss.weakSide + 1) % 4) as Direction;
    }

    // Swing the gun toward the player on its own timer.
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

    const pylons = this.architectPylons();

    // Steady suppressing fire, so the boss is visibly alive while it builds —
    // and twice as fast once the pylons are down, which is when it stops
    // building and has nothing left to do but fight.
    const lobInterval =
      pylons > 0
        ? ARCHITECT_LOB_INTERVAL_MS
        : ARCHITECT_LOB_INTERVAL_MS * ARCHITECT_ENRAGED_LOB_FACTOR;
    this.architectLobMs += deltaMs;
    if (this.architectLobMs >= lobInterval) {
      this.architectLobMs -= lobInterval;
      const target = this.anyPlayer();
      // Sealed it drops one shell to stay menacing while it works; exposed it
      // fires a spread, which has to be read rather than stepped out of.
      const shells = pylons > 0 ? 1 : ARCHITECT_LOB_SHELLS;
      if (target) {
        for (let i = 0; i < shells; i++) this.launchSapperLob(boss, target);
      }
    }

    if (pylons === 0) {
      this.driveArchitect(boss, deltaMs);
      return;
    }
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
   * Runs the exposed Architect: walk, wind up, charge.
   *
   * Only ever runs with the pylons down. Until then it is invulnerable and the
   * arena is the threat; afterwards the arena stops moving and it has to be one
   * itself.
   *
   * The cycle is deliberate. Walking alone was beatable by orbiting it at a
   * fixed radius and never being caught out, so the walk is now punctuated: it
   * stops, telegraphs, and then crosses the ground it was losing at three times
   * the speed. Retreating is still right — it just cannot be the only thing the
   * player is doing.
   */
  private driveArchitect(boss: Tank, deltaMs: number): void {
    const dt = deltaMs / 1000;

    // A charge already in flight is committed: it runs its heading to the end.
    if (this.architectChargeMs > 0) {
      this.architectChargeMs = Math.max(0, this.architectChargeMs - deltaMs);
      this.stepArchitect(
        boss,
        this.architectChargeAngle,
        ARCHITECT_SPEED * ARCHITECT_CHARGE_SPEED_FACTOR * dt,
      );
      this.resolveArchitectContact(boss);
      return;
    }

    const player = this.nearestPlayerTo(boss);
    if (!player) return;

    const cx = boss.x + boss.width / 2;
    const cy = boss.y + boss.height / 2;
    const angle = Math.atan2(player.y + player.height / 2 - cy, player.x + player.width / 2 - cx);

    // Winding up: it holds still and keeps re-aiming, so the telegraph names a
    // direction the player can still move out of rather than a guaranteed hit.
    if (this.architectWindupMs > 0) {
      this.architectWindupMs = Math.max(0, this.architectWindupMs - deltaMs);
      this.architectChargeAngle = angle;
      boss.direction = this.angleToDirection(angle);
      if (this.architectWindupMs === 0) this.architectChargeMs = ARCHITECT_CHARGE_MS;
      this.resolveArchitectContact(boss);
      return;
    }

    if (this.architectChargeCdMs > 0) {
      this.architectChargeCdMs = Math.max(0, this.architectChargeCdMs - deltaMs);
    } else if (
      Math.hypot(player.x + player.width / 2 - cx, player.y + player.height / 2 - cy) <=
      ARCHITECT_CHARGE_MAX_TILES * TILE_SIZE
    ) {
      this.architectChargeCdMs = ARCHITECT_CHARGE_COOLDOWN_MS;
      this.architectWindupMs = ARCHITECT_CHARGE_WINDUP_MS;
      this.architectChargeAngle = angle;

      // Borrows the player's own surge announcement — flagged foreign, so the
      // client draws and sounds it without touching anybody's ram cooldown.
      this.broadcast(ServerMessage.RamChanged, {
        active: true,
        cooldownMs: 0,
        foreign: true,
      } satisfies RamChangedMessage);
      this.resolveArchitectContact(boss);
      return;
    }

    this.stepArchitect(boss, angle, ARCHITECT_SPEED * dt);
    this.resolveArchitectContact(boss);
  }

  /** Moves the Architect one step along `angle`, crushing what it rolls over. */
  private stepArchitect(boss: Tank, angle: number, distance: number): void {
    const nextX = boss.x + Math.cos(angle) * distance;
    if (!this.sweeperHitsWall(nextX, boss.y, boss.width, boss.height)) boss.x = nextX;

    const nextY = boss.y + Math.sin(angle) * distance;
    if (!this.sweeperHitsWall(boss.x, nextY, boss.width, boss.height)) boss.y = nextY;

    boss.direction = this.angleToDirection(angle);

    if (this.crushJuggernautTiles(boss.x, boss.y, boss.width, boss.height)) {
      this.rebuildFields();
      this.onSweeperBounce(boss, true);
    }
  }

  /** Anything the Architect's hull is standing on dies — escort and player alike. */
  private resolveArchitectContact(boss: Tank): void {
    this.crushEnemies(boss);

    for (const target of this.playerTanks()) {
      if (target.isInvulnerable) continue;
      if (
        boxesOverlap(boss.x, boss.y, boss.width, boss.height, target.x, target.y, target.width, target.height)
      ) {
        this.killPlayer(target.ownerId);
      }
    }
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

    // The closing wall kills through a shield, like a boss hull does — and it
    // takes everyone it closed on, not just one of them.
    for (const player of this.playerTanks()) {
      if (player.isInvulnerable) continue;
      if (isBlocked(this.state, player.x, player.y, player.width, player.height)) {
        this.killPlayer(player.ownerId);
      }
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

    const player = this.nearestPlayerTo(boss);
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
      this.rebuildFields();
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
    const player = this.nearestPlayerTo(boss);
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
    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      if (tank.variant !== MIMIC || !tank.isDisguised) continue;

      // Springs on whoever walks into it, not on one nominated player.
      const player = this.nearestPlayerTo(tank);

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

  // --------------------------------------------------------------- upgrades

  /** How many stacks of `id` this player has taken. */
  private upgradeCount(ownerId: string, id: string): number {
    return this.upgrades.get(ownerId)?.get(id) ?? 0;
  }

  /**
   * A cooldown after Coolant Loop, floored so it can never reach zero.
   *
   * Multiplicative rather than additive: three stacks leave 51% of the original
   * wait instead of wiping it out, which keeps the abilities on a leash however
   * lucky the offers were.
   */
  private cooled(ownerId: string, ms: number): number {
    return Math.round(ms * Math.pow(0.8, this.upgradeCount(ownerId, "cool")));
  }

  /** Shield duration after Hardened Deflector. */
  private shieldDuration(ownerId: string): number {
    return SHIELD_DURATION_MS + 1500 * this.upgradeCount(ownerId, "shieldup");
  }

  /** Blink charge ceiling after Phase Capacitor. */
  private blinkCap(ownerId: string): number {
    return TELEPORT_MAX_CHARGES + this.upgradeCount(ownerId, "blink");
  }

  /** Decoy beacon lifetime after Loud Beacon. */
  private decoyDuration(ownerId: string): number {
    return DECOY_DURATION_MS + DECOY_UPGRADE_MS * this.upgradeCount(ownerId, "decoyup");
  }

  /**
   * Decoy cooldown after Coolant Loop, held to {@link DECOY_MIN_COOLDOWN_MS}.
   *
   * The one cooldown floored above what Coolant Loop alone would give: it only
   * starts once the beacon goes out, so a long beacon on a short cooldown kept
   * one standing most of the time.
   */
  private decoyCooldown(ownerId: string): number {
    return Math.max(DECOY_MIN_COOLDOWN_MS, this.cooled(ownerId, DECOY_COOLDOWN_MS));
  }

  /**
   * Deals a fresh hand of upgrade choices to every seat.
   *
   * Hands are rolled per player, so in co-op two people building the same run
   * still end up with different tanks. Anything already at its stack ceiling is
   * left out rather than offered as a dead pick, and so is any upgrade to an
   * ability the run has not unlocked yet — a "+1.5s shield duration" card in
   * front of a player with no shield buys nothing and invites them to read it
   * as the thing that grants one.
   */
  private offerUpgrades(): void {
    this.upgradeOffers.clear();

    for (const [sessionId] of this.state.players) {
      const pool = CAMPAIGN_UPGRADES.filter(
        (upgrade) =>
          this.upgradeCount(sessionId, upgrade.id) < upgrade.maxStacks &&
          isUpgradeOfferable(upgrade, this.state.currentLevel),
      );

      // Fisher-Yates over a copy, then take the first few.
      const shuffled = [...pool];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }

      const ids = shuffled.slice(0, UPGRADE_CHOICES).map((upgrade) => upgrade.id);
      this.upgradeOffers.set(sessionId, ids);
      this.sendUpgradeOffer(sessionId);
    }
  }

  /**
   * True while any seat still has an upgrade it has been dealt but not taken.
   *
   * An empty hand is not unspent: a player who already owns every upgrade the
   * run can offer them is dealt nothing, and must still be able to move on.
   */
  private hasUnspentUpgrade(): boolean {
    for (const ids of this.upgradeOffers.values()) {
      if (ids.length > 0) return true;
    }
    return false;
  }

  /** Pushes a seat's current offer (and holdings) to that client. */
  private sendUpgradeOffer(ownerId: string): void {
    const owned: Record<string, number> = {};
    for (const [id, stacks] of this.upgrades.get(ownerId) ?? []) owned[id] = stacks;

    this.sendTo(ownerId, ServerMessage.UpgradeOffer, {
      ids: this.upgradeOffers.get(ownerId) ?? [],
      owned,
    } satisfies UpgradeOfferMessage);
  }

  /**
   * Takes one of the upgrades on offer.
   *
   * The pick is validated against what was actually dealt to *this* seat, so a
   * crafted message cannot mint an arbitrary upgrade or take the same card
   * twice. Spending the hand clears it, which is also what stops a player
   * taking a second pick from the same level.
   */
  private chooseUpgrade(ownerId: string, id: unknown): void {
    if (typeof id !== "string") return;

    const offer = this.upgradeOffers.get(ownerId);
    if (!offer || !offer.includes(id)) return;

    const upgrade = findUpgrade(id);
    if (!upgrade) return;

    let owned = this.upgrades.get(ownerId);
    if (!owned) {
      owned = new Map<string, number>();
      this.upgrades.set(ownerId, owned);
    }

    const stacks = (owned.get(id) ?? 0) + 1;
    if (stacks > upgrade.maxStacks) return;
    owned.set(id, stacks);

    // Spare Crew is the one pick that pays out immediately rather than shaping
    // the next level; everything else is read where it is used.
    if (id === "life") {
      this.state.lives += 1;
      this.syncLives();
    }

    this.upgradeOffers.delete(ownerId);
    this.sendUpgradeOffer(ownerId);
  }

  // ------------------------------------------------------------------ co-op

  /**
   * Sends a message to one seat rather than the whole room.
   *
   * Ability readouts are personal: broadcasting a cooldown would light up every
   * team-mate's HUD as though they had spent the ability too.
   */
  private sendTo(ownerId: string, type: string, payload: unknown): void {
    for (const client of this.clients) {
      if (client.sessionId === ownerId) {
        client.send(type, payload);
        return;
      }
    }
  }

  /** That player's ability state, created on first use. */
  private abilitiesOf(ownerId: string): AbilityState {
    let state = this.abilities.get(ownerId);
    if (!state) {
      state = this.freshFor(ownerId);
      this.abilities.set(ownerId, state);
    }
    return state;
  }

  /**
   * A ready loadout for one seat, banked to that seat's own blink ceiling.
   *
   * Phase Capacitor raises the ceiling, so handing back a flat
   * {@link TELEPORT_MAX_CHARGES} made the upgrade look like it had done nothing:
   * the player took "+1 blink charge", started the next level on two, and had
   * to wait out a full recharge to ever see the third.
   */
  private freshFor(ownerId: string): AbilityState {
    const abilities = freshAbilities();
    abilities.teleportCharges = this.blinkCap(ownerId);
    return abilities;
  }

  /** Every living player tank on the field. */
  private playerTanks(): Tank[] {
    const players: Tank[] = [];
    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      // Enemies are out, and so is the escort carrier — it is friendly but it
      // is not a player and must never be treated as a target or an actor.
      if (tank.isEnemy || tank.variant === CONVOY) continue;
      players.push(tank);
    }
    return players;
  }

  /**
   * The living player closest to a point, or undefined when none are up.
   *
   * This is what every hunter, boss and standoff unit aims at. Nearest rather
   * than a fixed seat, so in co-op the threat follows whoever actually walked
   * into it instead of ignoring them to chase a team-mate across the map.
   */
  private nearestPlayer(x: number, y: number): Tank | undefined {
    let best: Tank | undefined;
    let bestDistance = Infinity;

    for (const tank of this.playerTanks()) {
      const dx = tank.x + tank.width / 2 - x;
      const dy = tank.y + tank.height / 2 - y;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = tank;
      }
    }

    return best;
  }

  /** The nearest player to a given tank — the usual form of the question. */
  private nearestPlayerTo(tank: Tank): Tank | undefined {
    return this.nearestPlayer(tank.x + tank.width / 2, tank.y + tank.height / 2);
  }

  /**
   * Any one living player.
   *
   * For the handful of checks that only care whether the team is still on the
   * field at all, rather than which member is closest.
   */
  private anyPlayer(): Tank | undefined {
    return this.playerTanks()[0];
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
  private abilitiesSuppressed(player: Tank | undefined): boolean {
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
    if (target.isEnemy) return false;
    const abilities = this.abilities.get(target.ownerId);
    if (!abilities || abilities.ramActiveMs <= 0) return false;
    // The shell is coming head-on when it travels opposite the charge.
    return bullet.direction === ((abilities.ramDirection + 2) % 4);
  }

  /** Launches the ram surge along that player's current facing. */
  private startRam(ownerId: string): void {
    if (!this.ramUnlocked()) return;

    const abilities = this.abilitiesOf(ownerId);
    if (abilities.ramActiveMs > 0 || abilities.ramCooldownMs > 0) return;

    const player = this.findTank(ownerId);
    if (!player || this.abilitiesSuppressed(player)) return;

    abilities.ramActiveMs = Math.round(RAM_DURATION_MS * (1 + 0.6 * this.upgradeCount(ownerId, "ramup")));
    abilities.ramDirection = player.direction;

    this.sendTo(ownerId, ServerMessage.RamChanged, {
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
    for (const [ownerId, abilities] of this.abilities) {
      if (abilities.ramActiveMs <= 0) {
        if (abilities.ramCooldownMs > 0) {
          abilities.ramCooldownMs = Math.max(0, abilities.ramCooldownMs - deltaMs);
          if (abilities.ramCooldownMs === 0) {
            this.sendTo(ownerId, ServerMessage.RamChanged, {
              active: false,
              cooldownMs: 0,
            } satisfies RamChangedMessage);
          }
        }
        continue;
      }

      const player = this.findTank(ownerId);
      if (!player) {
        this.endRam(ownerId);
        continue;
      }

      abilities.ramActiveMs = Math.max(0, abilities.ramActiveMs - deltaMs);

      // Advance along the locked heading. A wall simply ends the surge.
      player.direction = abilities.ramDirection;
      const heading = DIRECTION_VECTORS[abilities.ramDirection];
      const step = TANK_SPEED * RAM_SPEED_FACTOR;
      const nextX = player.x + heading.x * step;
      const nextY = player.y + heading.y * step;

      if (isBlocked(this.state, nextX, nextY, player.width, player.height)) {
        // Brick gives way to a charging hull; steel and the objective tiles do
        // not, and stop the surge dead.
        if (!this.ramThroughBrick(player, nextX, nextY)) {
          this.endRam(ownerId);
          continue;
        }
      }

      player.x = nextX;
      player.y = nextY;

      // Resolve whatever the hull is now inside.
      let ended = false;
      for (let i = this.state.tanks.length - 1; i >= 0; i--) {
        const tank = this.state.tanks.at(i);
        if (!tank.isEnemy) continue;
        if (!boxesOverlap(player.x, player.y, player.width, player.height, tank.x, tank.y, tank.width, tank.height)) {
          continue;
        }

        // A boss shrugs the charge off and runs the player down.
        if (tank.isBoss) {
          this.endRam(ownerId);
          if (!player.isInvulnerable) this.killPlayer(ownerId);
          ended = true;
          break;
        }

        // A rusher detonates — unless the deflector is up, which turns it.
        if (tank.variant === KAMIKAZE) {
          if (this.isShieldUp(player)) {
            this.state.tanks.splice(i, 1);
            this.onTankDestroyed(tank);
            continue;
          }
          this.endRam(ownerId);
          if (!player.isInvulnerable) this.killPlayer(ownerId);
          ended = true;
          break;
        }

        this.state.tanks.splice(i, 1);
        this.onTankDestroyed(tank);
      }

      if (!ended && abilities.ramActiveMs === 0) this.endRam(ownerId);
    }
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
    this.rebuildFields();
    return true;
  }

  /** Ends one player's surge and starts its cooldown. */
  private endRam(ownerId: string): void {
    const abilities = this.abilitiesOf(ownerId);
    if (abilities.ramActiveMs === 0 && abilities.ramCooldownMs > 0) return;
    abilities.ramActiveMs = 0;
    abilities.ramCooldownMs = this.cooled(ownerId, RAM_COOLDOWN_MS);

    this.sendTo(ownerId, ServerMessage.RamChanged, {
      active: false,
      cooldownMs: this.cooled(ownerId, RAM_COOLDOWN_MS),
    } satisfies RamChangedMessage);
  }

  /** Clears every player's ram state — used on death and on level change. */
  private resetRam(): void {
    for (const [ownerId, abilities] of this.abilities) {
      abilities.ramActiveMs = 0;
      abilities.ramCooldownMs = 0;
      this.sendTo(ownerId, ServerMessage.RamChanged, {
        active: false,
        cooldownMs: 0,
      } satisfies RamChangedMessage);
    }
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
  private dropDecoy(ownerId: string): void {
    if (!this.decoyUnlocked()) return;

    const abilities = this.abilitiesOf(ownerId);
    if (abilities.decoyCooldownMs > 0 || abilities.decoy) return;

    const player = this.findTank(ownerId);
    if (!player || this.abilitiesSuppressed(player)) return;

    abilities.decoy = {
      x: player.x + player.width / 2,
      y: player.y + player.height / 2,
      remainingMs: this.decoyDuration(ownerId),
    };

    this.rollDecoyLure();
    this.rebuildFields();

    // The beacon itself is visible to the whole team — it is a thing on the
    // battlefield, not a private readout — but the cooldown is personal.
    this.broadcast(ServerMessage.DecoyChanged, {
      cooldownMs: 0,
      x: abilities.decoy.x,
      y: abilities.decoy.y,
      durationMs: this.decoyDuration(ownerId),
    } satisfies DecoyChangedMessage);
  }

  /** Expires standing beacons and runs each player's decoy cooldown. */
  private tickDecoy(deltaMs: number): void {
    for (const [ownerId, abilities] of this.abilities) {
      if (abilities.decoy) {
        abilities.decoy.remainingMs -= deltaMs;
        if (abilities.decoy.remainingMs <= 0) {
          abilities.decoy = null;
          abilities.decoyCooldownMs = this.decoyCooldown(ownerId);
          if (!this.hasDecoy()) this.luredIds.clear();
          // Attention snaps back to the players the moment it goes out.
          this.rebuildFields();
          this.sendTo(ownerId, ServerMessage.DecoyChanged, {
            cooldownMs: this.decoyCooldown(ownerId),
          } satisfies DecoyChangedMessage);
        }
        continue;
      }

      if (abilities.decoyCooldownMs > 0) {
        abilities.decoyCooldownMs = Math.max(0, abilities.decoyCooldownMs - deltaMs);
        if (abilities.decoyCooldownMs === 0) {
          this.sendTo(ownerId, ServerMessage.DecoyChanged, {
            cooldownMs: 0,
          } satisfies DecoyChangedMessage);
        }
      }
    }
  }

  /** Clears every decoy — used on death and on level change. */
  private resetDecoy(): void {
    for (const [ownerId, abilities] of this.abilities) {
      abilities.decoy = null;
      abilities.decoyCooldownMs = 0;
      this.sendTo(ownerId, ServerMessage.DecoyChanged, {
        cooldownMs: 0,
      } satisfies DecoyChangedMessage);
    }
  }

  // ============================================================ called strike
  //
  // The first ability the player aims rather than points their hull at, and so
  // the first that arrives with a payload: the client sends a world point taken
  // from the mouse. Everything in it is validated — the point is attacker
  // controlled, and an unchecked one would let a client shell the far corner of
  // the map from safety.
  // ============================================================================

  /** True once the campaign has reached the level that grants the strike. */
  private strikeUnlocked(): boolean {
    return this.state.currentLevel >= STRIKE_UNLOCK_LEVEL;
  }

  /** Strike blast radius after Cluster Warhead, in px. */
  private strikeRadius(ownerId: string): number {
    return (STRIKE_RADIUS_TILES + this.upgradeCount(ownerId, "strikeup")) * TILE_SIZE;
  }

  /**
   * Calls a mortar down on a point the player picked.
   *
   * The aim point is clamped to the strike's range rather than rejected out of
   * hand: a click a little past the limit is a near miss on the player's part,
   * and dropping the ability entirely for it would feel broken. A click far
   * outside still only ever lands at the edge of the range.
   */
  private callStrike(ownerId: string, payload: unknown): void {
    if (!this.strikeUnlocked()) return;

    const abilities = this.abilitiesOf(ownerId);
    if (abilities.strikeCooldownMs > 0) return;

    const player = this.findTank(ownerId);
    if (!player || this.abilitiesSuppressed(player)) return;

    if (!isAimedMessage(payload)) return;
    const aim = payload;

    const originX = player.x + player.width / 2;
    const originY = player.y + player.height / 2;

    // Anywhere on the battlefield. The strike is a called fire mission, not a
    // grenade throw: the limit on it is the telegraph and the cooldown, and a
    // range ring only ever meant a click near the far wall quietly landed
    // somewhere the player had not pointed at.
    const x = Math.max(0, Math.min(WORLD_WIDTH, aim.x));
    const y = Math.max(0, Math.min(WORLD_HEIGHT, aim.y));
    const radius = this.strikeRadius(ownerId);

    this.strikes.push({ x, y, radius, timerMs: STRIKE_DELAY_MS });
    abilities.strikeCooldownMs = this.cooled(ownerId, STRIKE_COOLDOWN_MS);

    // Reuses the artillery telegraph, so an incoming friendly shell is drawn
    // with exactly the same language as an incoming hostile one.
    this.broadcast(ServerMessage.MortarWarning, {
      x,
      y,
      delay: STRIKE_DELAY_MS,
      radius,
      friendly: true,
    } satisfies MortarWarningMessage);

    this.pushStrikeHud(ownerId);
  }

  /** Runs down every called strike in flight and lands the ones that are due. */
  private tickStrikes(deltaMs: number): void {
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const strike = this.strikes[i]!;
      strike.timerMs -= deltaMs;
      if (strike.timerMs > 0) continue;

      this.strikes.splice(i, 1);
      this.landStrike(strike.x, strike.y, strike.radius);
    }
  }

  /**
   * Lands one called strike: damages enemies, breaks brick, spares the player.
   *
   * Deliberately damage rather than the blast's outright kill — the strike is
   * on a shorter cooldown and can be thrown from safety, so it has to chip
   * rather than clear. Bosses take it too, which is most of the point: it is
   * the only reach the player has into a fight they cannot close on.
   */
  private landStrike(x: number, y: number, radius: number): void {
    for (let i = this.state.tanks.length - 1; i >= 0; i--) {
      const tank = this.state.tanks.at(i);
      if (!tank.isEnemy) continue;

      const dx = tank.x + tank.width / 2 - x;
      const dy = tank.y + tank.height / 2 - y;
      if (Math.hypot(dx, dy) > radius) continue;

      // A submerged Burrower or Leviathan is not there to be hit.
      if (tank.isCloaked && (tank.variant === LEVIATHAN || tank.variant === EnemyVariant.Burrower)) {
        continue;
      }
      // The armour rules the shell path honours apply here too, or the strike
      // would be a way to ignore the puzzle every armoured boss is built on.
      if (this.isArchitectSealed(tank) || this.isFoundrySealed(tank)) continue;

      tank.currentHealth -= STRIKE_DAMAGE;
      if (tank.currentHealth > 0) continue;

      this.state.tanks.splice(i, 1);
      this.onTankDestroyed(tank);
    }

    // Brick only: steel and every objective tile ride it out, so no level's
    // puzzle can be opened up with a mortar.
    const minTX = Math.max(0, Math.floor((x - radius) / TILE_SIZE));
    const maxTX = Math.min(GRID_WIDTH - 1, Math.floor((x + radius) / TILE_SIZE));
    const minTY = Math.max(0, Math.floor((y - radius) / TILE_SIZE));
    const maxTY = Math.min(GRID_HEIGHT - 1, Math.floor((y + radius) / TILE_SIZE));

    let clearedBrick = false;
    for (let ty = minTY; ty <= maxTY; ty++) {
      for (let tx = minTX; tx <= maxTX; tx++) {
        if (!isInsideGrid(tx, ty)) continue;
        const index = tileIndex(tx, ty);
        if (this.state.grid.at(index) !== TileType.Brick) continue;

        const tileCx = tx * TILE_SIZE + TILE_SIZE / 2;
        const tileCy = ty * TILE_SIZE + TILE_SIZE / 2;
        if (Math.hypot(tileCx - x, tileCy - y) > radius) continue;

        this.state.grid[index] = TileType.Empty;
        clearedBrick = true;
      }
    }
    if (clearedBrick) this.rebuildFields();

    this.broadcast(ServerMessage.BlastChanged, {
      cooldownMs: 0,
      foreign: true,
      x,
      y,
      radius,
      brickRadius: radius,
    } satisfies BlastChangedMessage);
  }

  /** Runs down one seat's strike cooldown and announces it coming back. */
  private tickStrikeCooldown(deltaMs: number): void {
    for (const [ownerId, abilities] of this.abilities) {
      if (abilities.strikeCooldownMs <= 0) continue;
      abilities.strikeCooldownMs = Math.max(0, abilities.strikeCooldownMs - deltaMs);
      if (abilities.strikeCooldownMs === 0) this.pushStrikeHud(ownerId);
    }
  }

  /** Tells one seat where its strike cooldown stands. */
  private pushStrikeHud(ownerId: string): void {
    this.sendTo(ownerId, ServerMessage.StrikeChanged, {
      cooldownMs: this.abilitiesOf(ownerId).strikeCooldownMs,
    } satisfies StrikeChangedMessage);
  }

  // ================================================================ emp pulse
  //
  // The only thing in the kit that works on a boss. It does no damage at all —
  // it simply takes a few seconds away from everything nearby, which at this
  // point in the campaign is worth more than another gun would be.
  // ============================================================================

  /** True once the campaign has reached the level that grants the pulse. */
  private empUnlocked(): boolean {
    return this.state.currentLevel >= EMP_UNLOCK_LEVEL;
  }

  /** Fires the suppression pulse from one seat. */
  private firePulse(ownerId: string): void {
    if (!this.empUnlocked()) return;

    const abilities = this.abilitiesOf(ownerId);
    if (abilities.empCooldownMs > 0) return;

    const player = this.findTank(ownerId);
    if (!player || this.abilitiesSuppressed(player)) return;

    const cx = player.x + player.width / 2;
    const cy = player.y + player.height / 2;
    const radius = EMP_RADIUS_TILES * TILE_SIZE;
    const held = EMP_DURATION_MS + 1000 * this.upgradeCount(ownerId, "empup");

    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      if (!tank.isEnemy) continue;

      const dx = tank.x + tank.width / 2 - cx;
      const dy = tank.y + tank.height / 2 - cy;
      if (Math.hypot(dx, dy) > radius) continue;

      // A boss is held for a fraction of the time. Long enough to matter,
      // short enough that the fight is never simply paused into submission.
      const duration = tank.isBoss ? EMP_BOSS_DURATION_MS : held;
      this.empHeldUntilMs.set(tank.ownerId, this.elapsedMs + duration);
    }

    abilities.empCooldownMs = this.cooled(ownerId, EMP_COOLDOWN_MS);

    this.broadcast(ServerMessage.EmpFired, {
      x: cx,
      y: cy,
      radius,
      durationMs: held,
    } satisfies EmpFiredMessage);
    this.pushEmpHud(ownerId);
  }

  /** True while `tank` is held by a pulse and may neither move nor fire. */
  private isSuppressed(tank: Tank): boolean {
    const until = this.empHeldUntilMs.get(tank.ownerId);
    if (until === undefined) return false;
    if (this.elapsedMs < until) return true;

    this.empHeldUntilMs.delete(tank.ownerId);
    return false;
  }

  /** Runs down one seat's pulse cooldown and announces it coming back. */
  private tickEmpCooldown(deltaMs: number): void {
    for (const [ownerId, abilities] of this.abilities) {
      if (abilities.empCooldownMs <= 0) continue;
      abilities.empCooldownMs = Math.max(0, abilities.empCooldownMs - deltaMs);
      if (abilities.empCooldownMs === 0) this.pushEmpHud(ownerId);
    }
  }

  /** Tells one seat where its pulse cooldown stands. */
  private pushEmpHud(ownerId: string): void {
    this.sendTo(ownerId, ServerMessage.EmpChanged, {
      cooldownMs: this.abilitiesOf(ownerId).empCooldownMs,
    } satisfies EmpChangedMessage);
  }

  // ============================================================ translocator
  //
  // A jump to anywhere on the map with room for the hull. Distinct from the
  // blink in every way that matters: the blink is a short hop along the facing,
  // banked in charges and spent reflexively; this is one long-cooldown decision
  // that ignores the terrain between here and there entirely.
  // ============================================================================

  /** True once the campaign has reached the level that grants the jump. */
  private translocateUnlocked(): boolean {
    return this.state.currentLevel >= TRANSLOCATE_UNLOCK_LEVEL;
  }

  /**
   * Jumps the player to a point they picked.
   *
   * The aim point is attacker-controlled, so nothing about it is trusted: it is
   * snapped to the tile lattice — the whole movement model is grid-aligned, and
   * a hull left mid-tile can never turn again — then checked for terrain and
   * for other hulls before anything moves.
   *
   * A click a tile or so inside a wall lands beside it rather than being
   * refused: at this range that is a near miss, not a different intention. A
   * click the tank cannot see, or cannot fit on, jumps as far along that line
   * as it can instead — see {@link translocateAlongLine}.
   */
  private translocate(ownerId: string, payload: unknown): void {
    if (!this.translocateUnlocked()) return;

    const abilities = this.abilitiesOf(ownerId);
    if (abilities.translocateCooldownMs > 0) return;
    // A Lurcher's grapple clamps the whole phase drive, not just the blink.
    if (abilities.blinkLockMs > 0) return;

    const player = this.findTank(ownerId);
    if (!player || this.abilitiesSuppressed(player)) return;
    if (!isAimedMessage(payload)) return;

    // It only reaches somewhere the tank can actually see. Without that rule a
    // map-wide jump answered every level built around crossing ground — walk to
    // the extraction pad in particular stopped being a level at all, because
    // the pad was always one click away through the whole maze between.
    //
    // Coolant and open ground do not block the line, so it still crosses a
    // river or a room; walls do, so a route still has to be driven.
    //
    // A click past a wall is not refused, though: the jump goes as far along
    // that line as the tank can see and lands this side of the wall. Refusing
    // outright meant most clicks did nothing — on a built-up map nearly any
    // point worth jumping to has something in front of it — and a click that
    // silently kept its cooldown read as the button being broken.
    let spot = this.translocateSpot(player, payload.x, payload.y);
    if (
      !spot ||
      !this.hasClearLine(
        player.x + player.width / 2,
        player.y + player.height / 2,
        spot.x + player.width / 2,
        spot.y + player.height / 2,
      )
    ) {
      spot = this.translocateAlongLine(player, payload.x, payload.y);
    }
    if (!spot) return;

    const fromX = player.x;
    const fromY = player.y;
    player.x = spot.x;
    player.y = spot.y;

    abilities.translocateCooldownMs = Math.round(
      this.cooled(ownerId, TRANSLOCATE_COOLDOWN_MS) *
        Math.pow(0.8, this.upgradeCount(ownerId, "jumpup")),
    );

    // Drawn with the blink's own streak — it is the same drive, further.
    this.broadcast(ServerMessage.TeleportChanged, {
      charges: abilities.teleportCharges,
      rechargeMs: abilities.teleportRechargeMs,
      foreign: true,
      fromX,
      fromY,
      toX: spot.x,
      toY: spot.y,
    } satisfies TeleportChangedMessage);

    this.pushTranslocateHud(ownerId);
  }

  /** The nearest tile-aligned spot with room for the hull, or null. */
  private translocateSpot(
    player: Tank,
    worldX: number,
    worldY: number,
  ): { x: number; y: number } | null {
    const maxX = WORLD_WIDTH - player.width;
    const maxY = WORLD_HEIGHT - player.height;
    const clamp = (value: number, limit: number): number =>
      Math.max(0, Math.min(limit, Math.round(value / TILE_SIZE) * TILE_SIZE));

    const baseX = clamp(worldX - player.width / 2, maxX);
    const baseY = clamp(worldY - player.height / 2, maxY);

    for (let ring = 0; ring <= TRANSLOCATE_SEARCH_TILES; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          // Only this ring's own edge; the interior was covered by earlier rings.
          if (ring > 0 && Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;

          const x = baseX + dx * TILE_SIZE;
          const y = baseY + dy * TILE_SIZE;
          if (x < 0 || y < 0 || x > maxX || y > maxY) continue;
          if (isBlocked(this.state, x, y, player.width, player.height)) continue;
          if (collidesWithTank(this.state, player, x, y)) continue;

          return { x, y };
        }
      }
    }

    return null;
  }

  /**
   * The furthest spot toward `(worldX, worldY)` the tank can see and fit on.
   *
   * Walks back from the aim point toward the tank in half-tile steps and takes
   * the first tile-aligned spot that is open and in sight — so a click behind
   * a wall lands just this side of it. Null when nothing along the line is at
   * least a tile away, which leaves the jump unspent.
   */
  private translocateAlongLine(
    player: Tank,
    worldX: number,
    worldY: number,
  ): { x: number; y: number } | null {
    const fromX = player.x + player.width / 2;
    const fromY = player.y + player.height / 2;
    const dx = worldX - fromX;
    const dy = worldY - fromY;
    const dist = Math.hypot(dx, dy);
    if (dist < TILE_SIZE) return null;

    const maxX = WORLD_WIDTH - player.width;
    const maxY = WORLD_HEIGHT - player.height;
    const snap = (value: number, limit: number): number =>
      Math.max(0, Math.min(limit, Math.round(value / TILE_SIZE) * TILE_SIZE));

    for (let travelled = dist; travelled >= TILE_SIZE; travelled -= TILE_SIZE / 2) {
      const x = snap(fromX + (dx / dist) * travelled - player.width / 2, maxX);
      const y = snap(fromY + (dy / dist) * travelled - player.height / 2, maxY);
      if (Math.hypot(x - player.x, y - player.y) < TILE_SIZE) continue;
      if (isBlocked(this.state, x, y, player.width, player.height)) continue;
      if (collidesWithTank(this.state, player, x, y)) continue;
      if (!this.hasClearLine(fromX, fromY, x + player.width / 2, y + player.height / 2)) continue;
      return { x, y };
    }

    return null;
  }

  /** Runs down one seat's jump cooldown and announces it coming back. */
  private tickTranslocateCooldown(deltaMs: number): void {
    for (const [ownerId, abilities] of this.abilities) {
      if (abilities.translocateCooldownMs <= 0) continue;
      abilities.translocateCooldownMs = Math.max(0, abilities.translocateCooldownMs - deltaMs);
      if (abilities.translocateCooldownMs === 0) this.pushTranslocateHud(ownerId);
    }
  }

  /** Tells one seat where its jump cooldown stands. */
  private pushTranslocateHud(ownerId: string): void {
    this.sendTo(ownerId, ServerMessage.TranslocateChanged, {
      cooldownMs: this.abilitiesOf(ownerId).translocateCooldownMs,
    } satisfies TranslocateChangedMessage);
  }

  // ============================================================ cutting lance
  //
  // The only ability that damages a *line*. The blast clears a circle around
  // the player and the strike drops one on a point they picked; the lance is
  // the answer to a column of hulls coming down a corridor, and to a brick wall
  // that happens to have them behind it.
  // ============================================================================

  /** True once the campaign has reached the level that grants the lance. */
  private laserUnlocked(): boolean {
    return this.state.currentLevel >= LASER_UNLOCK_LEVEL;
  }

  /** Lance damage after Focusing Lens. */
  private laserDamage(ownerId: string): number {
    return LASER_DAMAGE + this.upgradeCount(ownerId, "laserup");
  }

  /**
   * Fires the cutting lance straight ahead.
   *
   * Walks the beam out from the muzzle a quarter-tile at a time — the same
   * granularity the enemy raycast uses, which is fine enough that a 32px wall
   * can never be stepped over. Along the way it:
   *
   *  - damages every enemy hull it crosses, once each, and keeps going;
   *  - cuts up to {@link LASER_BRICK_LIMIT} brick tiles, and is spent on the last;
   *  - stops dead against steel, water's far side, and every objective structure,
   *    none of which take a scratch.
   *
   * That last rule is what keeps it a tool rather than a skeleton key: a lance
   * that cut radar masts or factory vaults would let a player skip the actual
   * objective of a third of the campaign from across the map.
   */
  private fireLaser(ownerId: string): void {
    if (!this.laserUnlocked()) return;

    const abilities = this.abilitiesOf(ownerId);
    if (abilities.laserCooldownMs > 0) return;

    const player = this.findTank(ownerId);
    if (!player || this.abilitiesSuppressed(player)) return;

    const heading = DIRECTION_VECTORS[player.direction];
    const originX = player.x + player.width / 2;
    const originY = player.y + player.height / 2;
    const damage = this.laserDamage(ownerId);
    const maxDistance = LASER_RANGE_TILES * TILE_SIZE;
    const step = TILE_SIZE / 4;

    const hitTanks = new Set<string>();
    const cutTiles = new Set<number>();
    let bricksCut = 0;
    let blocked = false;
    let reach = player.width / 2;

    for (let distance = player.width / 2; distance <= maxDistance; distance += step) {
      const x = originX + heading.x * distance;
      const y = originY + heading.y * distance;

      if (x < 0 || y < 0 || x >= WORLD_WIDTH || y >= WORLD_HEIGHT) {
        blocked = true;
        break;
      }

      const tx = Math.floor(x / TILE_SIZE);
      const ty = Math.floor(y / TILE_SIZE);
      const index = tileIndex(tx, ty);
      const tile = this.state.grid.at(index);

      // Anything solid that is not brick turns the beam. Structural plate takes
      // no damage from it, and neither does anything a level is fought over.
      if (
        tile === TileType.Steel ||
        tile === TileType.EagleBase ||
        tile === TileType.Radar ||
        tile === TileType.Factory
      ) {
        blocked = true;
        break;
      }

      if (tile === TileType.Brick && !cutTiles.has(index)) {
        cutTiles.add(index);
        this.state.grid[index] = TileType.Empty;
        bricksCut++;
      }

      reach = distance;

      // Spent on the last brick it was budgeted for: it opens a doorway, not a
      // corridor to the far wall.
      if (bricksCut >= LASER_BRICK_LIMIT) break;
    }

    const endX = originX + heading.x * reach;
    const endY = originY + heading.y * reach;

    // Damage is resolved after the walk, so a hull standing in brick the beam
    // just cut is caught by the same shot that opened the wall.
    for (let i = this.state.tanks.length - 1; i >= 0; i--) {
      const tank = this.state.tanks.at(i);
      if (!tank.isEnemy || hitTanks.has(tank.ownerId)) continue;
      if (!this.segmentCrossesBox(originX, originY, endX, endY, tank)) continue;
      if (this.laserTurnedAside(tank, player.direction)) continue;

      hitTanks.add(tank.ownerId);
      tank.currentHealth -= damage;
      if (tank.currentHealth > 0) continue;

      this.state.tanks.splice(i, 1);
      this.onTankDestroyed(tank);
    }

    if (cutTiles.size > 0) {
      this.rebuildFields();
    }

    abilities.laserCooldownMs = this.cooled(ownerId, LASER_COOLDOWN_MS);

    this.broadcast(ServerMessage.LaserFired, {
      fromX: originX,
      fromY: originY,
      toX: endX,
      toY: endY,
      blocked,
    } satisfies LaserFiredMessage);

    this.pushLaserHud(ownerId);
  }

  /**
   * Whether a boss's armour turns the beam aside.
   *
   * The same rules the shell path honours, so no armoured encounter has a hole
   * in it that only the lance can walk through. `direction` is the beam's, which
   * is what the Bastion's open face is measured against.
   */
  private laserTurnedAside(target: Tank, direction: Direction): boolean {
    if (this.isArchitectSealed(target) || this.isFoundrySealed(target)) return true;
    if (this.isAegisShielded(target)) return true;
    // A submerged hull is not there to be hit.
    if (target.isCloaked && (target.variant === LEVIATHAN || target.variant === EnemyVariant.Burrower)) {
      return true;
    }
    // The Bastion's one open face, measured the way a shell would measure it:
    // a beam travelling in `direction` strikes the face on the far side.
    if (target.variant === BASTION) return target.weakSide !== ((direction + 2) % 4);
    return false;
  }

  /**
   * Whether the segment from `(x0, y0)` to `(x1, y1)` crosses a tank's box.
   *
   * Sampled rather than solved: the beam is axis-aligned, so walking it in
   * quarter-tile steps is exact enough and far easier to read than a
   * slab-clipping routine that would only ever be used here.
   */
  private segmentCrossesBox(x0: number, y0: number, x1: number, y1: number, tank: Tank): boolean {
    const length = Math.hypot(x1 - x0, y1 - y0);
    if (length === 0) return false;

    const ux = (x1 - x0) / length;
    const uy = (y1 - y0) / length;
    const step = TILE_SIZE / 4;

    for (let travelled = 0; travelled <= length; travelled += step) {
      const x = x0 + ux * travelled;
      const y = y0 + uy * travelled;
      if (x >= tank.x && x < tank.x + tank.width && y >= tank.y && y < tank.y + tank.height) {
        return true;
      }
    }
    return false;
  }

  /** Runs down one seat's lance cooldown and announces it coming back. */
  private tickLaserCooldown(deltaMs: number): void {
    for (const [ownerId, abilities] of this.abilities) {
      if (abilities.laserCooldownMs <= 0) continue;
      abilities.laserCooldownMs = Math.max(0, abilities.laserCooldownMs - deltaMs);
      if (abilities.laserCooldownMs === 0) this.pushLaserHud(ownerId);
    }
  }

  /** Tells one seat where its lance cooldown stands. */
  private pushLaserHud(ownerId: string): void {
    this.sendTo(ownerId, ServerMessage.LaserChanged, {
      cooldownMs: this.abilitiesOf(ownerId).laserCooldownMs,
    } satisfies LaserChangedMessage);
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
  private fireBlast(ownerId: string): void {
    if (!this.blastUnlocked()) return;

    const abilities = this.abilitiesOf(ownerId);
    if (abilities.blastCooldownMs > 0) return;

    const player = this.findTank(ownerId);
    if (!player || this.abilitiesSuppressed(player)) return;

    const cx = player.x + player.width / 2;
    const cy = player.y + player.height / 2;
    const radius = (BLAST_RADIUS_TILES + 2 * this.upgradeCount(ownerId, "blastup")) * TILE_SIZE;

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
      this.rebuildFields();
    }

    abilities.blastCooldownMs = this.cooled(ownerId, BLAST_COOLDOWN_MS);

    // The shockwave is a world event everyone should see; the cooldown that
    // follows belongs only to the player who spent it.
    this.broadcast(ServerMessage.BlastChanged, {
      cooldownMs: 0,
      x: cx,
      y: cy,
      radius,
      brickRadius,
    } satisfies BlastChangedMessage);

    this.sendTo(ownerId, ServerMessage.BlastChanged, {
      cooldownMs: this.cooled(ownerId, BLAST_COOLDOWN_MS),
    } satisfies BlastChangedMessage);
  }

  /** Counts each blast cooldown down and announces when it is ready again. */
  private tickBlast(deltaMs: number): void {
    for (const [ownerId, abilities] of this.abilities) {
      if (abilities.blastCooldownMs <= 0) continue;

      abilities.blastCooldownMs = Math.max(0, abilities.blastCooldownMs - deltaMs);
      if (abilities.blastCooldownMs > 0) continue;

      this.sendTo(ownerId, ServerMessage.BlastChanged, {
        cooldownMs: 0,
      } satisfies BlastChangedMessage);
    }
  }

  /** Clears every blast cooldown — used on death and on level change. */
  private resetBlast(): void {
    for (const [ownerId, abilities] of this.abilities) {
      abilities.blastCooldownMs = 0;
      this.sendTo(ownerId, ServerMessage.BlastChanged, {
        cooldownMs: 0,
      } satisfies BlastChangedMessage);
    }
  }

  /**
   * Returns the strike, the pulse and the lance to ready on every seat.
   *
   * The three later abilities, kept together because they share a shape: a
   * single cooldown and a single readout, with nothing else to unwind.
   */
  private resetLateAbilities(): void {
    for (const [ownerId, abilities] of this.abilities) {
      abilities.strikeCooldownMs = 0;
      abilities.empCooldownMs = 0;
      abilities.laserCooldownMs = 0;
      abilities.translocateCooldownMs = 0;
      this.pushStrikeHud(ownerId);
      this.pushEmpHud(ownerId);
      this.pushLaserHud(ownerId);
      this.pushTranslocateHud(ownerId);
    }
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
  private teleportPlayer(ownerId: string, payload?: unknown): void {
    if (!this.teleportUnlocked()) return;

    const abilities = this.abilitiesOf(ownerId);
    if (abilities.teleportCharges <= 0) return;
    // A Lurcher's grapple clamps the drive shut for a moment after it lands.
    if (abilities.blinkLockMs > 0) return;

    const player = this.findTank(ownerId);
    if (!player || this.abilitiesSuppressed(player)) return;

    // Aimed with the mouse, or straight ahead from the keyboard. The aimed
    // version is still snapped to a cardinal: the whole movement model is
    // grid-aligned, and a diagonal landing would leave the hull unable to turn.
    const heading = this.blinkHeading(player, payload);
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

    abilities.teleportCharges--;
    if (abilities.teleportRechargeMs <= 0) abilities.teleportRechargeMs = this.cooled(ownerId, TELEPORT_RECHARGE_MS);

    // The jump streak is a world event; the charge count is personal.
    this.broadcast(ServerMessage.TeleportChanged, {
      charges: abilities.teleportCharges,
      rechargeMs: abilities.teleportRechargeMs,
      fromX,
      fromY,
      toX: destX,
      toY: destY,
    } satisfies TeleportChangedMessage);
  }

  /**
   * Which way a blink goes: toward an aim point, or along the hull's facing.
   *
   * An aim point is reduced to whichever cardinal points most nearly at it, so
   * a mouse-driven blink lands on the tile lattice exactly like a keyboard one.
   * Without that a jump could end mid-tile, and a hull off the lattice can
   * never turn again under the shared grid-aligned movement.
   */
  private blinkHeading(player: Tank, payload: unknown): { x: number; y: number } {
    if (!isAimedMessage(payload)) return DIRECTION_VECTORS[player.direction];

    const dx = payload.x - (player.x + player.width / 2);
    const dy = payload.y - (player.y + player.height / 2);
    if (dx === 0 && dy === 0) return DIRECTION_VECTORS[player.direction];

    const direction =
      Math.abs(dx) >= Math.abs(dy)
        ? dx >= 0
          ? Direction.Right
          : Direction.Left
        : dy >= 0
          ? Direction.Down
          : Direction.Up;

    // The hull turns to match, so the blink reads as a move rather than a slide.
    player.direction = direction;
    return DIRECTION_VECTORS[direction];
  }

  /** Refills one blink charge at a time, per player, below the cap. */
  private tickTeleport(deltaMs: number): void {
    for (const [ownerId, abilities] of this.abilities) {
      if (abilities.teleportCharges >= this.blinkCap(ownerId)) {
        abilities.teleportRechargeMs = 0;
        continue;
      }

      if (abilities.teleportRechargeMs <= 0) abilities.teleportRechargeMs = this.cooled(ownerId, TELEPORT_RECHARGE_MS);

      abilities.teleportRechargeMs -= deltaMs;
      if (abilities.teleportRechargeMs > 0) continue;

      abilities.teleportCharges = Math.min(this.blinkCap(ownerId), abilities.teleportCharges + 1);
      abilities.teleportRechargeMs =
        abilities.teleportCharges < this.blinkCap(ownerId) ? this.cooled(ownerId, TELEPORT_RECHARGE_MS) : 0;

      this.sendTo(ownerId, ServerMessage.TeleportChanged, {
        charges: abilities.teleportCharges,
        rechargeMs: abilities.teleportRechargeMs,
      } satisfies TeleportChangedMessage);
    }
  }

  /** Returns every blink bank to full — used on death and on level change. */
  private resetTeleport(): void {
    for (const [ownerId, abilities] of this.abilities) {
      abilities.teleportCharges = this.blinkCap(ownerId);
      abilities.teleportRechargeMs = 0;
      abilities.blinkLockMs = 0;

      this.sendTo(ownerId, ServerMessage.TeleportChanged, {
        charges: abilities.teleportCharges,
        rechargeMs: 0,
      } satisfies TeleportChangedMessage);
    }
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
  private raiseShield(ownerId: string): void {
    if (!this.shieldUnlocked()) return;

    const abilities = this.abilitiesOf(ownerId);
    if (abilities.shieldActiveMs > 0 || abilities.shieldCooldownMs > 0) return;

    const player = this.findTank(ownerId);
    if (!player || this.abilitiesSuppressed(player)) return;

    abilities.shieldActiveMs = this.shieldDuration(ownerId);
    // Replicated on the tank, so team-mates see the bubble too.
    player.isShielded = true;

    this.sendTo(ownerId, ServerMessage.ShieldChanged, {
      active: true,
      durationMs: this.shieldDuration(ownerId),
    } satisfies ShieldChangedMessage);
  }

  /** Counts each shield down, drops it, then runs that player's cooldown. */
  private tickShield(deltaMs: number): void {
    for (const [ownerId, abilities] of this.abilities) {
      if (abilities.shieldActiveMs > 0) {
        abilities.shieldActiveMs = Math.max(0, abilities.shieldActiveMs - deltaMs);
        if (abilities.shieldActiveMs === 0) {
          const player = this.findTank(ownerId);
          if (player) player.isShielded = false;
          abilities.shieldCooldownMs = this.cooled(ownerId, SHIELD_COOLDOWN_MS);

          this.sendTo(ownerId, ServerMessage.ShieldChanged, {
            active: false,
            cooldownMs: this.cooled(ownerId, SHIELD_COOLDOWN_MS),
          } satisfies ShieldChangedMessage);
        }
        continue;
      }

      if (abilities.shieldCooldownMs > 0) {
        abilities.shieldCooldownMs = Math.max(0, abilities.shieldCooldownMs - deltaMs);
        if (abilities.shieldCooldownMs === 0) {
          this.sendTo(ownerId, ServerMessage.ShieldChanged, {
            active: false,
            ready: true,
          } satisfies ShieldChangedMessage);
        }
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

  /** Drops every shield and clears its timers — on death and level change. */
  private resetShield(): void {
    for (const [ownerId, abilities] of this.abilities) {
      abilities.shieldActiveMs = 0;
      abilities.shieldCooldownMs = 0;
      const player = this.findTank(ownerId);
      if (player) player.isShielded = false;

      this.sendTo(ownerId, ServerMessage.ShieldChanged, {
        active: false,
        ready: true,
      } satisfies ShieldChangedMessage);
    }
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
    // Every heavy hull on the field, not just whichever one `bossId` happens to
    // name. That singleton was fine while a level fielded one boss; on a wave of
    // four it meant three of them could drive straight over the player without
    // touching them, which reads as the boss being broken.
    for (const boss of this.bossTanks()) {
      if (!CRUSHING_BOSSES.has(boss.variant)) continue;
      // A submerged hull is not there to be run over.
      if (boss.isCloaked) continue;

      // Anyone the hull is inside gets run over, shield or no shield.
      for (const player of this.playerTanks()) {
        if (player.isInvulnerable) continue;

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
          this.killPlayer(player.ownerId);
        }
      }
      if (this.state.phase !== CampaignPhase.Playing) return;
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
  /**
   * Destroys one player's tank.
   *
   * `ownerId` names the seat; omitting it kills whichever player is on the
   * field, which is what the solo-era call sites mean. Only that player's
   * abilities are cleared — a team-mate's shield must not drop because someone
   * else died.
   */
  private killPlayer(ownerId?: string): void {
    const player = ownerId ? this.findTank(ownerId) : this.anyPlayer();
    if (!player) return;

    this.clearAbilities(player.ownerId);

    const index = this.state.tanks.indexOf(player);
    if (index >= 0) this.state.tanks.splice(index, 1);
    this.onTankDestroyed(player);
  }

  /** Returns one seat's whole loadout to ready, and tells that client. */
  private clearAbilities(ownerId: string): void {
    const player = this.findTank(ownerId);
    if (player) player.isShielded = false;
    this.abilities.set(ownerId, this.freshFor(ownerId));

    this.sendTo(ownerId, ServerMessage.ShieldChanged, { active: false, ready: true });
    this.sendTo(ownerId, ServerMessage.TeleportChanged, {
      charges: this.blinkCap(ownerId),
      rechargeMs: 0,
    });
    this.sendTo(ownerId, ServerMessage.BlastChanged, { cooldownMs: 0 });
    this.sendTo(ownerId, ServerMessage.RamChanged, { active: false, cooldownMs: 0 });
    this.sendTo(ownerId, ServerMessage.DecoyChanged, { cooldownMs: 0 });
    // The three later abilities have to be announced here too. The server
    // resets them with the rest of the loadout, but a client that is never told
    // keeps counting down a cooldown that is already over — the readout stays
    // dark and the key looks broken until the stale timer happens to expire.
    this.sendTo(ownerId, ServerMessage.StrikeChanged, { cooldownMs: 0 });
    this.sendTo(ownerId, ServerMessage.EmpChanged, { cooldownMs: 0 });
    this.sendTo(ownerId, ServerMessage.LaserChanged, { cooldownMs: 0 });
    this.sendTo(ownerId, ServerMessage.TranslocateChanged, { cooldownMs: 0 });
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
    for (const boss of this.bossesOf(ARTILLERY)) {
      const state = this.bossState(boss.ownerId);

      // Enough damage taken since the last jump: break contact and reappear.
      if (boss.currentHealth <= state.markHp) {
        state.markHp = boss.currentHealth - ARTILLERY_BLINK_DAMAGE;
        this.relocateArtillery(boss);
      }

      state.timerMs += deltaMs;
      if (state.timerMs >= MORTAR_INTERVAL_MS) {
        state.timerMs -= MORTAR_INTERVAL_MS;
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
   * Jumps the artillery to open ground well away from every player.
   *
   * Grid-aligned, because the shared movers only ever turn a hull standing on
   * the tile lattice — a boss dropped half a tile off could drive in one
   * direction and never turn again. Candidates are rejected until one is clear
   * of terrain, clear of other hulls and far enough from everyone; if the map
   * cannot offer one, it simply stays where it is rather than landing in a wall.
   */
  private relocateArtillery(boss: Tank): void {
    const fromX = boss.x;
    const fromY = boss.y;

    const maxTileX = Math.floor((WORLD_WIDTH - boss.width) / TILE_SIZE);
    const maxTileY = Math.floor((WORLD_HEIGHT - boss.height) / TILE_SIZE);
    const minDistance = ARTILLERY_BLINK_MIN_TILES * TILE_SIZE;

    for (let attempt = 0; attempt < ARTILLERY_BLINK_ATTEMPTS; attempt++) {
      const x = Math.floor(Math.random() * (maxTileX + 1)) * TILE_SIZE;
      const y = Math.floor(Math.random() * (maxTileY + 1)) * TILE_SIZE;

      if (isBlocked(this.state, x, y, boss.width, boss.height)) continue;
      if (collidesWithTank(this.state, boss, x, y)) continue;

      const cx = x + boss.width / 2;
      const cy = y + boss.height / 2;
      let clearOfPlayers = true;
      for (const player of this.playerTanks()) {
        const dx = player.x + player.width / 2 - cx;
        const dy = player.y + player.height / 2 - cy;
        if (Math.hypot(dx, dy) < minDistance) {
          clearOfPlayers = false;
          break;
        }
      }
      if (!clearOfPlayers) continue;

      boss.x = x;
      boss.y = y;

      // Drawn with the player's own blink effect, flagged foreign so it is only
      // an effect and never touches anyone's charge count.
      this.broadcast(ServerMessage.TeleportChanged, {
        charges: 0,
        rechargeMs: 0,
        foreign: true,
        fromX,
        fromY,
        toX: x,
        toY: y,
      } satisfies TeleportChangedMessage);
      return;
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
    const player = this.anyPlayer();
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
    for (const player of this.playerTanks()) {
      if (
        !player.isInvulnerable &&
        !this.isShieldUp(player) &&
        boxesOverlap(bx, by, bw, bh, player.x, player.y, player.width, player.height)
      ) {
        this.killPlayer(player.ownerId);
      }
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

    // A Choir twin brings its partner back unless both fall inside the window.
    if (tank.variant === CHOIR) this.onChoirTwinDown(tank);

    // Only a marked hull counts toward a purge; the decoys are free to shoot
    // and buy the player nothing but the time they spent doing it.
    if (this.markedIds.delete(tank.ownerId)) {
      this.markedKilled++;
      this.refreshObjective();
    }

    this.lastShotAtMs.delete(tank.ownerId);
    this.moveIntents.delete(tank.ownerId);
    this.constructorCells.delete(tank.ownerId);
    this.trapperMineTimers.delete(tank.ownerId);
    this.ghostUncloakTimers.delete(tank.ownerId);
    this.stuckTimers.delete(tank.ownerId);
    this.mimicLungeTimers.delete(tank.ownerId);
    this.sapperLobTimers.delete(tank.ownerId);
    this.lurcherTimers.delete(tank.ownerId);
    this.effigyMirages.delete(tank.ownerId);
    this.luredIds.delete(tank.ownerId);
    this.sentinelTimers.delete(tank.ownerId);
    this.rallyBaseSpeeds.delete(tank.ownerId);
    this.leechTimers.delete(tank.ownerId);
    this.overseerTimers.delete(tank.ownerId);
    this.reclaimerTimers.delete(tank.ownerId);
    this.burrowerTimers.delete(tank.ownerId);
    this.empHeldUntilMs.delete(tank.ownerId);
    this.bossStates.delete(tank.ownerId);

    // The HUD's boss slot follows whatever is still standing, so a wave of four
    // reads as a fight that is being won rather than one that keeps restarting.
    if (tank.isBoss) {
      const remaining = this.bossTanks().find((body) => body.ownerId !== tank.ownerId);
      this.bossId = remaining?.ownerId ?? null;
    }

    // Enemies just vanish; only the player's death costs a life.
    if (tank.isEnemy) return;

    this.invulnerableUntilMs.delete(tank.ownerId);

    // One shared pool for the team: any death costs the run a life, and the run
    // ends when it is empty regardless of who was still standing.
    this.state.lives = Math.max(0, this.state.lives - 1);

    this.syncLives();
    const player = this.state.players.get(tank.ownerId);

    if (this.state.lives <= 0) {
      this.state.phase = CampaignPhase.GameOver;
      console.log(`[room ${this.roomId}] out of lives — game over`);
      return;
    }

    this.respawnAtMs.set(tank.ownerId, this.elapsedMs + PLAYER_RESPAWN_DELAY_MS);
    if (player) player.respawnInSeconds = Math.ceil(PLAYER_RESPAWN_DELAY_MS / 1000);
  }

  /** Returns each dead player to the field once their delay is up. */
  private respawnPlayer(): void {
    for (const [ownerId, dueAt] of this.respawnAtMs) {
      const seat = this.state.players.get(ownerId);

      // The seat left mid-countdown: drop the pending respawn.
      if (!seat) {
        this.respawnAtMs.delete(ownerId);
        continue;
      }

      if (this.elapsedMs < dueAt) {
        seat.respawnInSeconds = Math.ceil((dueAt - this.elapsedMs) / 1000);
        continue;
      }

      // spawnPlayer clears the entry itself once the pad is actually free.
      this.spawnPlayer(ownerId);
    }
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

  // ==========================================================================
  // The Foundry — Act 4's boss
  //
  // Sealed while its intakes stand, like the Architect, but the resemblance
  // stops there: the Architect shrinks the room, the Foundry heals and builds.
  // Ignoring the intakes does not kill you, it simply means you never finish.
  // ==========================================================================

  /** Spawns the Foundry at the centre of its production floor. */
  private spawnFoundry(): void {
    const id = `boss-${this.enemySequence++}`;
    this.bossId = id;
    this.bossState(id).timerMs = 0;

    this.state.tanks.push(
      new Tank({
        x: centredSpawnX(FOUNDRY_SIZE),
        y: centredSpawnY(FOUNDRY_SIZE),
        width: FOUNDRY_SIZE,
        height: FOUNDRY_SIZE,
        ownerId: id,
        maxHealth: FOUNDRY_HP,
        speed: 0,
        direction: Direction.Down,
        isEnemy: true,
        variant: FOUNDRY,
        isBoss: true,
      }),
    );
  }

  /** True while the Foundry's intakes still stand and its plating holds. */
  private isFoundrySealed(target: Tank): boolean {
    return target.variant === FOUNDRY && this.countRadar() > 0;
  }

  /**
   * Runs the Foundry: build while sealed, patch itself, fight once starved.
   *
   * The repair is the whole of the first half. While any intake is running it
   * knits plating back on faster than a player can chip it off, so the fight
   * cannot be brute-forced. With the intakes gone the repair stops and the
   * Foundry tears itself off its mountings: it crawls after the player through
   * cover, rotates between three attacks, and keeps scavenging the odd hull —
   * so the finish is a fight on the move rather than a stationary target.
   */
  private tickFoundry(deltaMs: number): void {
    for (const boss of this.bossesOf(FOUNDRY)) {
      const intakes = this.countRadar();
      const state = this.bossState(boss.ownerId);
      state.timerMs += deltaMs;

      if (intakes > 0) {
        // Production: a tank at a time, and only while there is room for it.
        if (state.timerMs >= FOUNDRY_BUILD_INTERVAL_MS) {
          state.timerMs -= FOUNDRY_BUILD_INTERVAL_MS;
          this.foundryBuild();
        }

        // Patch. Never past full, and never while starved.
        state.altTimerMs += deltaMs;
        if (state.altTimerMs >= FOUNDRY_REPAIR_INTERVAL_MS) {
          state.altTimerMs -= FOUNDRY_REPAIR_INTERVAL_MS;
          boss.currentHealth = Math.min(boss.maxHealth, boss.currentHealth + FOUNDRY_REPAIR_AMOUNT);
        }
        continue;
      }

      if (this.isSuppressed(boss)) continue;

      const wounded = boss.currentHealth <= boss.maxHealth / 2;
      const player = this.nearestPlayerTo(boss);
      if (player) {
        this.crawlFoundry(boss, player, deltaMs, wounded);
        if (this.state.phase !== CampaignPhase.Playing) return;
      }

      const interval = Math.round(
        FOUNDRY_EXPOSED_SHOOT_MS * (wounded ? FOUNDRY_WOUNDED_FACTOR : 1),
      );
      if (state.timerMs >= interval) {
        // Never bank a second attack: the intakes falling mid-build, or a
        // pulse holding it, can leave far more than one interval on the clock.
        state.timerMs = Math.min(state.timerMs - interval, interval / 2);
        this.fireFoundryPattern(boss, player, state);
      }

      // It still builds, from whatever it can scavenge — slower than the line
      // ran, but enough that a player circling it is never alone with it.
      state.altTimerMs += deltaMs;
      if (state.altTimerMs >= FOUNDRY_SALVAGE_INTERVAL_MS) {
        state.altTimerMs -= FOUNDRY_SALVAGE_INTERVAL_MS;
        this.foundryBuild();
      }
    }
  }

  /** One hull off the Foundry's line, if there is room on the field for it. */
  private foundryBuild(): void {
    if (this.countStandardEnemies() >= this.maxEnemies()) return;
    const spawn = this.edgeSpawnPoint();
    if (!spawn) return;

    const profile = this.variantProfile(EnemyVariant.Standard);
    this.state.tanks.push(
      new Tank({
        x: spawn.x,
        y: spawn.y,
        width: TANK_SIZE,
        height: TANK_SIZE,
        ownerId: `enemy-${this.enemySequence++}`,
        maxHealth: profile.maxHealth,
        speed: profile.speed,
        direction: Direction.Down,
        isEnemy: true,
        variant: EnemyVariant.Standard,
      }),
    );
  }

  /** The starved Foundry's crawl: straight at the player, through cover. */
  private crawlFoundry(boss: Tank, player: Tank, deltaMs: number, wounded: boolean): void {
    const cx = boss.x + boss.width / 2;
    const cy = boss.y + boss.height / 2;
    const angle = Math.atan2(player.y + player.height / 2 - cy, player.x + player.width / 2 - cx);
    const speed = FOUNDRY_CRAWL_SPEED / (wounded ? FOUNDRY_WOUNDED_FACTOR : 1);
    const dt = deltaMs / 1000;

    const nextX = boss.x + Math.cos(angle) * speed * dt;
    if (!this.sweeperHitsWall(nextX, boss.y, boss.width, boss.height)) boss.x = nextX;
    const nextY = boss.y + Math.sin(angle) * speed * dt;
    if (!this.sweeperHitsWall(boss.x, nextY, boss.width, boss.height)) boss.y = nextY;
    boss.direction = this.angleToDirection(angle);

    if (this.crushJuggernautTiles(boss.x, boss.y, boss.width, boss.height)) {
      this.rebuildFields();
    }
    this.crushEnemies(boss);
    this.crushPlayersUnder(boss);
  }

  /**
   * One of the starved Foundry's three attacks, in rotation.
   *
   * A single-file burst down all four axes, then a five-wide wall of fast
   * shells from whichever face looks at the player, then a triple-width burst
   * down all four. Standing on an axis is punished by the first and last,
   * standing off one by the second, so no one square is safe for the whole
   * fight and the player has to read which one is coming.
   */
  private fireFoundryPattern(boss: Tank, player: Tank | undefined, state: BossState): void {
    const pattern = state.pattern % 3;
    state.pattern++;

    if (pattern === 1 && player) {
      const dx = player.x + player.width / 2 - (boss.x + boss.width / 2);
      const dy = player.y + player.height / 2 - (boss.y + boss.height / 2);
      const face =
        Math.abs(dx) >= Math.abs(dy)
          ? dx >= 0 ? Direction.Right : Direction.Left
          : dy >= 0 ? Direction.Down : Direction.Up;
      this.fireRadialWave(boss, 5, face, 1.25);
      return;
    }

    this.fireRadialWave(boss, pattern === 2 ? 3 : 1);
  }

  // ==========================================================================
  // The Choir — twins on one health pool
  //
  // Two bodies, one life. Killing one puts it out of action rather than
  // destroying it, and it gets back up unless its partner falls inside the
  // window. The map they are fought on has a pillar down the middle, so the
  // player cannot simply hold both in the same firing line and grind.
  // ==========================================================================

  /** Spawns both Choir twins, one either side of the hall. */
  private spawnChoir(): void {
    for (let i = 0; i < 2; i++) {
      const id = `boss-${this.enemySequence++}`;
      if (i === 0) this.bossId = id;
      this.bossState(id).flag = false;

      this.state.tanks.push(
        new Tank({
          x: this.bossEntryX(CHOIR_SIZE, i, 2),
          y: 4 * TILE_SIZE,
          width: CHOIR_SIZE,
          height: CHOIR_SIZE,
          ownerId: id,
          maxHealth: CHOIR_HP,
          speed: TANK_SPEED * CHOIR_SPEED_FACTOR,
          direction: Direction.Down,
          isEnemy: true,
          variant: CHOIR,
          isBoss: true,
        }),
      );
    }
  }

  /**
   * A twin has been destroyed: start (or close) the window on the pair.
   *
   * If the other twin is already down, both stay down and the encounter is
   * over. Otherwise the survivor is put on notice — it revives its partner once
   * {@link CHOIR_REVIVE_MS} passes without the player finishing the job.
   */
  private onChoirTwinDown(tank: Tank): void {
    const survivor = this.bossesOf(CHOIR).find((twin) => twin.ownerId !== tank.ownerId);
    if (!survivor) return;

    const state = this.bossState(survivor.ownerId);
    state.flag = true;
    state.timerMs = CHOIR_REVIVE_MS;

    // The survivor takes the blow it shared, so the pair really is one pool.
    survivor.currentHealth = Math.max(1, survivor.currentHealth - CHOIR_SYMPATHY_DAMAGE);
  }

  /** Runs the Choir: chase, shoot, and revive a fallen twin if left too long. */
  private tickChoir(deltaMs: number): void {
    for (const twin of this.bossesOf(CHOIR)) {
      const state = this.bossState(twin.ownerId);

      if (state.flag) {
        state.timerMs -= deltaMs;
        if (state.timerMs <= 0) {
          state.flag = false;
          this.reviveChoirTwin(twin);
        }
      }

      if (this.isSuppressed(twin)) continue;

      state.altTimerMs += deltaMs;
      if (state.altTimerMs < CHOIR_SHOOT_INTERVAL_MS) continue;
      state.altTimerMs -= CHOIR_SHOOT_INTERVAL_MS;

      const player = this.nearestPlayerTo(twin);
      if (!player) continue;
      if (
        this.hasClearLine(
          twin.x + twin.width / 2,
          twin.y + twin.height / 2,
          player.x + player.width / 2,
          player.y + player.height / 2,
        )
      ) {
        this.fire(twin);
      }
    }
  }

  /** Puts a downed twin back on the field beside the one that outlived it. */
  private reviveChoirTwin(survivor: Tank): void {
    const id = `boss-${this.enemySequence++}`;
    const spot = this.hydraChildSpot(
      survivor.x + survivor.width / 2 + CHOIR_SIZE * 2,
      survivor.y + survivor.height / 2,
      CHOIR_SIZE,
      new Set<string>(),
    );
    if (!spot) return;

    this.bossState(id).flag = false;
    this.state.tanks.push(
      new Tank({
        x: spot.x,
        y: spot.y,
        width: CHOIR_SIZE,
        height: CHOIR_SIZE,
        ownerId: id,
        maxHealth: CHOIR_HP,
        // Comes back on half a tank, so a player who nearly closed the window
        // is not sent all the way back to the start of the fight.
        currentHealth: Math.max(1, Math.round(CHOIR_HP / 2)),
        speed: TANK_SPEED * CHOIR_SPEED_FACTOR,
        direction: survivor.direction,
        isEnemy: true,
        variant: CHOIR,
        isBoss: true,
      }),
    );

    this.broadcast(ServerMessage.BossBounce, {
      x: spot.x + CHOIR_SIZE / 2,
      y: spot.y + CHOIR_SIZE / 2,
      subtle: false,
    } satisfies BossBounceMessage);
  }

  // ==========================================================================
  // The Leviathan — Act 5's burrowing boss
  //
  // The Burrower's mechanic at boss scale, and the reason its arena is islands
  // in coolant: it is untouchable while it is down, so the fight is entirely
  // about where the player chooses to be standing when it comes back up.
  // ==========================================================================

  /** Spawns the Leviathan in the middle of the flooded floor. */
  private spawnLeviathan(): void {
    const id = `boss-${this.enemySequence++}`;
    this.bossId = id;
    const state = this.bossState(id);
    state.timerMs = LEVIATHAN_SURFACED_MS;
    state.flag = false;

    this.state.tanks.push(
      new Tank({
        x: centredSpawnX(LEVIATHAN_SIZE),
        y: centredSpawnY(LEVIATHAN_SIZE),
        width: LEVIATHAN_SIZE,
        height: LEVIATHAN_SIZE,
        ownerId: id,
        maxHealth: LEVIATHAN_HP,
        speed: 0,
        direction: Direction.Down,
        isEnemy: true,
        variant: LEVIATHAN,
        isBoss: true,
      }),
    );
  }

  /**
   * Runs the Leviathan's dive cycle.
   *
   * Surfaced it grinds toward the player and crushes what it rolls over;
   * submerged it is cloaked — which is what makes it untargetable — and simply
   * counts down. Coming up is telegraphed a beat early so the player has a
   * chance to be somewhere else, which is the entire skill of the fight.
   */
  private tickLeviathan(deltaMs: number): void {
    for (const boss of this.bossesOf(LEVIATHAN)) {
      const state = this.bossState(boss.ownerId);
      state.timerMs -= deltaMs;

      if (boss.isCloaked) {
        // Commit to the surfacing point one beat before it arrives, and mark
        // it. The mark is exactly where it comes up, so stepping off the mark
        // is the whole of the dodge.
        if (!state.flag && state.timerMs <= LEVIATHAN_TELL_MS) {
          const spot = this.leviathanSurfacePoint(boss);
          state.flag = true;
          state.aimX = spot?.x ?? boss.x;
          state.aimY = spot?.y ?? boss.y;
          this.broadcast(ServerMessage.MortarWarning, {
            x: state.aimX + boss.width / 2,
            y: state.aimY + boss.height / 2,
            delay: LEVIATHAN_TELL_MS,
            // Out to the corners of the hull, not just its inscribed circle.
            radius: Math.round(LEVIATHAN_SIZE * 0.7),
          } satisfies MortarWarningMessage);
        }

        if (state.timerMs > 0) continue;

        if (state.flag) {
          boss.x = state.aimX;
          boss.y = state.aimY;
        }
        boss.isCloaked = false;
        state.flag = false;
        state.timerMs = LEVIATHAN_SURFACED_MS;
        state.altTimerMs = LEVIATHAN_RISE_PAUSE_MS;
        this.onSweeperBounce(boss);

        // Coming up is the attack: whatever is still on the mark is under it.
        if (this.crushJuggernautTiles(boss.x, boss.y, boss.width, boss.height)) {
          this.rebuildFields();
        }
        this.crushEnemies(boss);
        this.crushPlayersUnder(boss);
        if (this.state.phase !== CampaignPhase.Playing) return;
        continue;
      }

      if (state.timerMs <= 0) {
        boss.isCloaked = true;
        state.flag = false;
        state.timerMs = LEVIATHAN_SUBMERGED_MS;
        continue;
      }

      if (this.isSuppressed(boss)) continue;

      // A beat to get its bearings after coming up, so a player who has just
      // stepped off the mark is not run down by the same lunge.
      if (state.altTimerMs > 0) {
        state.altTimerMs = Math.max(0, state.altTimerMs - deltaMs);
        continue;
      }

      // Surfaced: a slow, heavy chase that ploughs through cover.
      const player = this.nearestPlayerTo(boss);
      if (!player) continue;

      const cx = boss.x + boss.width / 2;
      const cy = boss.y + boss.height / 2;
      const angle = Math.atan2(player.y + player.height / 2 - cy, player.x + player.width / 2 - cx);
      const dt = deltaMs / 1000;

      const nextX = boss.x + Math.cos(angle) * LEVIATHAN_SPEED * dt;
      if (!this.sweeperHitsWall(nextX, boss.y, boss.width, boss.height)) boss.x = nextX;
      const nextY = boss.y + Math.sin(angle) * LEVIATHAN_SPEED * dt;
      if (!this.sweeperHitsWall(boss.x, nextY, boss.width, boss.height)) boss.y = nextY;
      boss.direction = this.angleToDirection(angle);

      if (this.crushJuggernautTiles(boss.x, boss.y, boss.width, boss.height)) {
        this.rebuildFields();
      }
      this.crushEnemies(boss);

      for (const target of this.playerTanks()) {
        if (target.isInvulnerable) continue;
        if (
          boxesOverlap(boss.x, boss.y, boss.width, boss.height, target.x, target.y, target.width, target.height)
        ) {
          this.killPlayer(target.ownerId);
        }
      }
      if (this.state.phase !== CampaignPhase.Playing) return;
    }
  }

  /**
   * Where the Leviathan will come back up: centred on the nearest player.
   *
   * Searched outward from there only when that exact spot is coolant or wall,
   * and never further than {@link LEVIATHAN_SURFACE_SEARCH_TILES} — the arena
   * is mostly coolant, and a boss that materialised in it would be stuck there
   * for the rest of the level. Null holds it where it went down.
   */
  private leviathanSurfacePoint(boss: Tank): { x: number; y: number } | null {
    const player = this.nearestPlayerTo(boss);
    if (!player) return null;

    const tileX = Math.round((player.x + player.width / 2 - boss.width / 2) / TILE_SIZE);
    const tileY = Math.round((player.y + player.height / 2 - boss.height / 2) / TILE_SIZE);

    for (let radius = 0; radius <= LEVIATHAN_SURFACE_SEARCH_TILES; radius++) {
      const ring: Array<[number, number]> = [];
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          ring.push([tileX + dx, tileY + dy]);
        }
      }

      const offset = Math.floor(Math.random() * Math.max(1, ring.length));
      for (let k = 0; k < ring.length; k++) {
        const [tx, ty] = ring[(offset + k) % ring.length]!;
        const x = tx * TILE_SIZE;
        const y = ty * TILE_SIZE;
        if (x < TILE_SIZE || y < TILE_SIZE) continue;
        if (x + boss.width > WORLD_WIDTH - TILE_SIZE) continue;
        if (y + boss.height > WORLD_HEIGHT - TILE_SIZE) continue;
        if (this.sweeperHitsWall(x, y, boss.width, boss.height)) continue;
        return { x, y };
      }
    }

    return null;
  }

  /** Kills every player whose hull `boss` is overlapping. */
  private crushPlayersUnder(boss: Tank): void {
    for (const target of this.playerTanks()) {
      if (target.isInvulnerable) continue;
      if (
        boxesOverlap(boss.x, boss.y, boss.width, boss.height, target.x, target.y, target.width, target.height)
      ) {
        this.killPlayer(target.ownerId);
      }
    }
  }

  /**
   * Fires shells outward along all four cardinals.
   *
   * Shared by the Foundry and anything else that wants a plain omnidirectional
   * burst; the Logic Core keeps its own, because its waves are tuned per phase.
   * Pass `only` to fire from a single face — an aimed volley rather than a
   * burst — and `speedFactor` to hurry the shells along.
   */
  private fireRadialWave(
    boss: Tank,
    perDirection: number,
    only?: Direction,
    speedFactor = 1,
  ): void {
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
      if (only !== undefined && dir !== only) continue;
      for (let n = 0; n < perDirection; n++) {
        const offset = n - (perDirection - 1) / 2;
        this.state.bullets.push(
          new Bullet({
            x: cx - halfBullet + hx * (boss.width / 2) + px * offset * spread,
            y: cy - halfBullet + hy * (boss.height / 2) + py * offset * spread,
            width: BULLET_SIZE,
            height: BULLET_SIZE,
            ownerId: boss.ownerId,
            damage: BULLET_DAMAGE,
            direction: dir,
            speed: ENEMY_PROFILE.bulletSpeed * speedFactor,
            isEnemy: true,
            piercesSteel: false,
          }),
        );
      }
    }
  }

  // ==========================================================================
  // Act 4 units
  //
  // Each of these takes something away rather than adding damage. They share
  // one tick pass so the ordering between them is written down in one place.
  // ==========================================================================

  /** Runs every Archive-era unit on the field for one tick. */
  private tickArchiveUnits(deltaMs: number): void {
    this.tickSentinels(deltaMs);
    this.tickHowlers();
    this.tickLeeches(deltaMs);
    this.tickOverseers(deltaMs);
    this.tickReclaimers(deltaMs);
    this.tickBurrowers(deltaMs);
  }

  /**
   * A clear tile for a Sentinel, well away from every player.
   *
   * An emplacement released at a map edge would spend the level covering a
   * corridor nobody walks down, so it is placed out on the field instead —
   * somewhere with a view, but never close enough to open on the player before
   * they have had a chance to see where it went.
   */
  private sentinelPost(): { x: number; y: number } | null {
    const players = this.playerTanks();
    const minDistance = SENTINEL_MIN_SPAWN_TILES * TILE_SIZE;
    const maxTileX = GRID_WIDTH - 2;
    const maxTileY = GRID_HEIGHT - 2;

    for (let attempt = 0; attempt < SENTINEL_PLACEMENT_ATTEMPTS; attempt++) {
      const tx = 1 + Math.floor(Math.random() * maxTileX);
      const ty = 1 + Math.floor(Math.random() * maxTileY);
      const x = tx * TILE_SIZE;
      const y = ty * TILE_SIZE;
      if (!this.isSpawnClear(x, y)) continue;

      const cx = x + TANK_SIZE / 2;
      const cy = y + TANK_SIZE / 2;
      const tooClose = players.some(
        (player) =>
          Math.hypot(player.x + player.width / 2 - cx, player.y + player.height / 2 - cy) <
          minDistance,
      );
      if (tooClose) continue;

      return { x, y };
    }

    return null;
  }

  /**
   * Sentinels: turn toward the nearest player they can see, and shell them.
   *
   * They never move, so a Sentinel is a piece of the map that shoots back —
   * the answer is to break the line of sight or to go and kill it, not to
   * out-manoeuvre it.
   */
  private tickSentinels(deltaMs: number): void {
    for (const tank of this.variantTanks(EnemyVariant.Sentinel)) {
      if (this.isSuppressed(tank)) continue;

      const elapsed = (this.sentinelTimers.get(tank.ownerId) ?? 0) + deltaMs;
      const player = this.nearestPlayerTo(tank);
      if (!player) {
        this.sentinelTimers.set(tank.ownerId, elapsed);
        continue;
      }

      const cx = tank.x + tank.width / 2;
      const cy = tank.y + tank.height / 2;
      const px = player.x + player.width / 2;
      const py = player.y + player.height / 2;
      const dx = px - cx;
      const dy = py - cy;

      if (Math.hypot(dx, dy) > SENTINEL_RANGE_TILES * TILE_SIZE) {
        this.sentinelTimers.set(tank.ownerId, elapsed);
        continue;
      }

      // Face whichever cardinal points closest to the player, then only fire if
      // the shot would actually get there.
      tank.direction =
        Math.abs(dx) >= Math.abs(dy)
          ? dx >= 0
            ? Direction.Right
            : Direction.Left
          : dy >= 0
            ? Direction.Down
            : Direction.Up;

      if (elapsed < SENTINEL_SHOOT_INTERVAL_MS) {
        this.sentinelTimers.set(tank.ownerId, elapsed);
        continue;
      }

      this.sentinelTimers.set(tank.ownerId, 0);
      if (this.hasClearLine(cx, cy, px, py)) this.fire(tank);
    }
  }

  /**
   * Howlers: hurry along every ordinary enemy standing near them.
   *
   * The inverse of the Aegis — it does not protect anything, it makes
   * everything around it faster, so a swarm the player was comfortably kiting
   * suddenly is not. Applied by rewriting speed each tick rather than by a
   * lasting buff, so killing the Howler takes the effect away immediately.
   */
  private tickHowlers(): void {
    const howlers = this.variantTanks(EnemyVariant.Howler).filter(
      (howler) => !this.isSuppressed(howler),
    );

    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      if (!tank.isEnemy || tank.isBoss) continue;
      // An emplacement has no speed to raise, and a Howler does not rally itself.
      if (tank.variant === EnemyVariant.Howler || tank.speed === 0) continue;

      if (!this.rallyBaseSpeeds.has(tank.ownerId)) {
        this.rallyBaseSpeeds.set(tank.ownerId, tank.speed);
      }
      const base = this.baseSpeedFor(tank);
      const cx = tank.x + tank.width / 2;
      const cy = tank.y + tank.height / 2;

      const rallied = howlers.some((howler) => {
        const dx = howler.x + howler.width / 2 - cx;
        const dy = howler.y + howler.height / 2 - cy;
        return Math.hypot(dx, dy) <= HOWLER_RADIUS;
      });

      tank.speed = rallied ? base * HOWLER_SPEED_BONUS : base;
    }
  }

  /**
   * The speed a tank has when nothing is buffing it.
   *
   * Kept as a lookup rather than stashed on the tank: `Tank` is replicated
   * state and a "speed I would have had" field would be one more thing on the
   * wire for every hull on the map, to serve one enemy type.
   */
  private baseSpeedFor(tank: Tank): number {
    switch (tank.variant) {
      case EnemyVariant.Constructor: return TANK_SPEED * CONSTRUCTOR_SPEED_FACTOR;
      case EnemyVariant.Trapper: return TANK_SPEED * TRAPPER_SPEED_FACTOR;
      case EnemyVariant.Sapper: return TANK_SPEED * SAPPER_SPEED_FACTOR;
      case EnemyVariant.Lurcher: return TANK_SPEED * LURCHER_SPEED_FACTOR;
      case EnemyVariant.Nullifier: return TANK_SPEED * NULLIFIER_SPEED_FACTOR;
      case EnemyVariant.Leech: return TANK_SPEED * LEECH_SPEED_FACTOR;
      case EnemyVariant.Overseer: return TANK_SPEED * OVERSEER_SPEED_FACTOR;
      case EnemyVariant.Reclaimer: return TANK_SPEED * RECLAIMER_SPEED_FACTOR;
      case EnemyVariant.Burrower: return TANK_SPEED * BURROWER_SPEED_FACTOR;
      // Mimics change speed as they creep, spring and chase, and a rusher's
      // speed is rolled per body — neither has a fixed base to restore.
      case EnemyVariant.Mimic:
      case EnemyVariant.Kamikaze:
        return tank.speed;
      default:
        // An ordinary tank's speed came from its tier roll, which is not
        // recorded anywhere: hold whatever it has, so a rally can be undone
        // without inventing a figure the unit never had.
        return this.rallyBaseSpeeds.get(tank.ownerId) ?? tank.speed;
    }
  }

  /**
   * Leeches: contact drains the player's banked cooldowns.
   *
   * It never kills anyone. It simply makes the kit unavailable at the moment
   * the player was about to reach for it, which is a far better answer to a
   * loadout this deep into a run than another hull with more hit points.
   */
  private tickLeeches(deltaMs: number): void {
    for (const leech of this.variantTanks(EnemyVariant.Leech)) {
      const cooldown = Math.max(0, (this.leechTimers.get(leech.ownerId) ?? 0) - deltaMs);
      if (cooldown > 0 || this.isSuppressed(leech)) {
        this.leechTimers.set(leech.ownerId, cooldown);
        continue;
      }

      const drained = this.playerTanks().find(
        (player) =>
          !player.isInvulnerable &&
          boxesOverlap(
            leech.x - LEECH_CONTACT_PADDING,
            leech.y - LEECH_CONTACT_PADDING,
            leech.width + LEECH_CONTACT_PADDING * 2,
            leech.height + LEECH_CONTACT_PADDING * 2,
            player.x,
            player.y,
            player.width,
            player.height,
          ),
      );
      if (!drained) {
        this.leechTimers.set(leech.ownerId, 0);
        continue;
      }

      this.leechTimers.set(leech.ownerId, LEECH_INTERVAL_MS);
      this.drainAbilities(drained.ownerId);
    }
  }

  /** Puts one seat's whole kit back on cooldown, and tells their client. */
  private drainAbilities(ownerId: string): void {
    const abilities = this.abilitiesOf(ownerId);

    abilities.shieldActiveMs = 0;
    abilities.shieldCooldownMs = this.cooled(ownerId, SHIELD_COOLDOWN_MS);
    abilities.blastCooldownMs = this.cooled(ownerId, BLAST_COOLDOWN_MS);
    abilities.ramCooldownMs = this.cooled(ownerId, RAM_COOLDOWN_MS);
    abilities.decoyCooldownMs = this.decoyCooldown(ownerId);
    abilities.strikeCooldownMs = this.cooled(ownerId, STRIKE_COOLDOWN_MS);
    abilities.empCooldownMs = this.cooled(ownerId, EMP_COOLDOWN_MS);
    abilities.laserCooldownMs = this.cooled(ownerId, LASER_COOLDOWN_MS);
    abilities.translocateCooldownMs = this.cooled(ownerId, TRANSLOCATE_COOLDOWN_MS);
    abilities.teleportCharges = 0;
    abilities.teleportRechargeMs = this.cooled(ownerId, TELEPORT_RECHARGE_MS);

    const tank = this.findTank(ownerId);
    if (tank) tank.isShielded = false;

    this.sendTo(ownerId, ServerMessage.ShieldChanged, {
      active: false,
      cooldownMs: abilities.shieldCooldownMs,
    } satisfies ShieldChangedMessage);
    this.sendTo(ownerId, ServerMessage.TeleportChanged, {
      charges: abilities.teleportCharges,
      rechargeMs: abilities.teleportRechargeMs,
    } satisfies TeleportChangedMessage);
    this.sendTo(ownerId, ServerMessage.BlastChanged, {
      cooldownMs: abilities.blastCooldownMs,
    } satisfies BlastChangedMessage);
    this.sendTo(ownerId, ServerMessage.RamChanged, {
      active: false,
      cooldownMs: abilities.ramCooldownMs,
    } satisfies RamChangedMessage);
    this.sendTo(ownerId, ServerMessage.DecoyChanged, {
      cooldownMs: abilities.decoyCooldownMs,
    } satisfies DecoyChangedMessage);
    this.pushStrikeHud(ownerId);
    this.pushEmpHud(ownerId);
    this.pushLaserHud(ownerId);
    this.pushTranslocateHud(ownerId);
  }

  /**
   * Overseers: call in a pair of ordinary tanks on a timer.
   *
   * The reason a level can feel endless without the spawn cap ever being
   * raised. Drops land at the map edge rather than beside the Overseer, so it
   * is a reinforcement call rather than a bodyguard, and they still respect the
   * level's ceiling — an Overseer accelerates the flow, it does not flood.
   */
  private tickOverseers(deltaMs: number): void {
    for (const overseer of this.variantTanks(EnemyVariant.Overseer)) {
      if (this.isSuppressed(overseer)) continue;

      const elapsed = (this.overseerTimers.get(overseer.ownerId) ?? 0) + deltaMs;
      if (elapsed < OVERSEER_DROP_INTERVAL_MS) {
        this.overseerTimers.set(overseer.ownerId, elapsed);
        continue;
      }
      this.overseerTimers.set(overseer.ownerId, 0);

      for (let i = 0; i < OVERSEER_DROP_COUNT; i++) {
        if (this.countStandardEnemies() >= this.maxEnemies()) break;
        const spawn = this.edgeSpawnPoint();
        if (!spawn) break;

        const profile = this.variantProfile(EnemyVariant.Standard);
        this.state.tanks.push(
          new Tank({
            x: spawn.x,
            y: spawn.y,
            width: TANK_SIZE,
            height: TANK_SIZE,
            ownerId: `enemy-${this.enemySequence++}`,
            maxHealth: profile.maxHealth,
            speed: profile.speed,
            direction: Direction.Down,
            isEnemy: true,
            variant: EnemyVariant.Standard,
          }),
        );
      }
    }
  }

  /**
   * Reclaimers: rebuild the objective structures the player has levelled.
   *
   * Only ever restores what the level is *about* — a radar mast or a factory —
   * and only from close range, so the answer is to kill the crew rather than to
   * work faster. Without the range limit it would be an unloseable race; with
   * it, the level teaches target priority.
   */
  private tickReclaimers(deltaMs: number): void {
    const win = this.currentWinCondition();
    const restores =
      win === CampaignWinCondition.DestroyFactories
        ? TileType.Factory
        : win === CampaignWinCondition.DestroyRadars
          ? TileType.Radar
          : null;
    if (restores === null) return;

    for (const crew of this.variantTanks(EnemyVariant.Reclaimer)) {
      if (this.isSuppressed(crew)) continue;

      const elapsed = (this.reclaimerTimers.get(crew.ownerId) ?? 0) + deltaMs;
      if (elapsed < RECLAIMER_INTERVAL_MS) {
        this.reclaimerTimers.set(crew.ownerId, elapsed);
        continue;
      }
      this.reclaimerTimers.set(crew.ownerId, 0);

      // Rebuild the nearest levelled piece of the level's own structures — and
      // only ever a tile that carried one when the level began. It used to take
      // any empty tile in reach, which with two crews on the field meant fresh
      // factories sprouting wherever they happened to drive: the count climbed
      // faster than the player could bring it down, on open ground that had
      // never held a factory at all.
      const original = this.level()?.mapGrid;
      if (!original) return;

      const tileX = Math.floor((crew.x + crew.width / 2) / TILE_SIZE);
      const tileY = Math.floor((crew.y + crew.height / 2) / TILE_SIZE);

      let site = -1;
      let siteReach = Infinity;
      for (let index = 0; index < GRID_LENGTH; index++) {
        if (original[index] !== restores) continue;
        if (this.state.grid.at(index) !== TileType.Empty) continue;

        const tx = index % GRID_WIDTH;
        const ty = Math.floor(index / GRID_WIDTH);
        const reach = Math.max(Math.abs(tx - tileX), Math.abs(ty - tileY));
        if (reach > RECLAIMER_RANGE_TILES || reach >= siteReach) continue;
        if (this.tankOnTile(tx, ty)) continue;

        site = index;
        siteReach = reach;
      }
      if (site < 0) continue;

      this.state.grid[site] = restores;
      this.rebuildFields();
      this.refreshObjective();
    }
  }

  /** True when any hull is standing on tile `(tx, ty)`. */
  private tankOnTile(tx: number, ty: number): boolean {
    const x = tx * TILE_SIZE;
    const y = ty * TILE_SIZE;
    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      if (boxesOverlap(x, y, TILE_SIZE, TILE_SIZE, tank.x, tank.y, tank.width, tank.height)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Burrowers: submerge, cross the map unseen, and come up beside the player.
   *
   * Cloaked while under, which is also what makes them untargetable — the
   * shell-collision pass already skips a cloaked hull, so there is one rule
   * rather than two that can disagree. The surfacing point is deliberately a
   * few tiles off rather than underneath: a unit that materialises on top of
   * the player is not a threat, it is a coin flip.
   */
  private tickBurrowers(deltaMs: number): void {
    for (const digger of this.variantTanks(EnemyVariant.Burrower)) {
      const remaining = (this.burrowerTimers.get(digger.ownerId) ?? BURROWER_SURFACED_MS) - deltaMs;
      if (remaining > 0) {
        this.burrowerTimers.set(digger.ownerId, remaining);
        continue;
      }

      if (digger.isCloaked) {
        // Coming up. Find open ground near a player and appear there.
        const spot = this.burrowerSurfacePoint(digger);
        if (spot) {
          digger.x = spot.x;
          digger.y = spot.y;
        }
        digger.isCloaked = false;
        this.burrowerTimers.set(digger.ownerId, BURROWER_SURFACED_MS);
      } else {
        digger.isCloaked = true;
        this.burrowerTimers.set(digger.ownerId, BURROWER_SUBMERGED_MS);
      }
    }
  }

  /** Open, tile-aligned ground a few tiles from a player for a Burrower. */
  private burrowerSurfacePoint(digger: Tank): { x: number; y: number } | null {
    const player = this.nearestPlayerTo(digger);
    if (!player) return null;

    const tileX = Math.floor((player.x + player.width / 2) / TILE_SIZE);
    const tileY = Math.floor((player.y + player.height / 2) / TILE_SIZE);

    // Walk the ring at the intended distance, starting from a random point on
    // it, so it does not always come up on the same side.
    const ring: Array<[number, number]> = [];
    const r = BURROWER_SURFACE_TILES;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        ring.push([tileX + dx, tileY + dy]);
      }
    }

    const offset = Math.floor(Math.random() * ring.length);
    for (let k = 0; k < ring.length; k++) {
      const [tx, ty] = ring[(offset + k) % ring.length]!;
      if (!isInsideGrid(tx, ty)) continue;

      const x = tx * TILE_SIZE;
      const y = ty * TILE_SIZE;
      if (this.isSpawnClear(x, y)) return { x, y };
    }

    return null;
  }

  /** Every live tank of one rank-and-file variant. */
  private variantTanks(variant: string): Tank[] {
    const out: Tank[] = [];
    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      if (tank.isEnemy && tank.variant === variant) out.push(tank);
    }
    return out;
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
    // A duel level fields nothing but its boss. The Effigy fight is written as
    // one — "no armor to flank, no pylons to drop, no adds to clear" — and used
    // to get the standard boss-level escort anyway, which crowded the arena and
    // turned the one deliberately one-on-one fight in the campaign into another
    // swarm. An empty spawn table now says that, rather than a level number.
    const level = this.level();
    if (level && !level.spawns && this.isDuelLevel(level)) return;

    let interval = Math.max(
      SPAWN_INTERVAL_MIN_MS,
      SPAWN_INTERVAL_BASE_MS - this.state.currentLevel * SPAWN_INTERVAL_PER_LEVEL_MS,
    );
    interval = Math.round(interval * (level?.params?.spawnIntervalFactor ?? 1));

    if (this.elapsedMs - this.lastEnemySpawnMs < interval) return;
    if (this.countStandardEnemies() >= this.maxEnemies()) return;

    // Factory levels post guards beside the factories; elsewhere, at map edges.
    let spawn =
      this.currentWinCondition() === CampaignWinCondition.DestroyFactories
        ? this.factorySpawnPoint()
        : this.edgeSpawnPoint();
    if (!spawn) return; // no valid spawn this tick — try again next tick

    // The level's own table decides what comes out, with the per-variant caps
    // it declares honoured by the roll rather than patched up afterwards.
    let variant: string = rollSpawnVariant(level?.spawns, (v) => this.countVariant(v));

    // Kamikazes were never in any level's table: they are the campaign's
    // background pressure, ramping with the level, and a table entry would have
    // meant writing the same row into nearly every level.
    if (variant === EnemyVariant.Standard && Math.random() < this.kamikazeChance()) {
      variant = EnemyVariant.Kamikaze;
    }

    // A rusher has to be seen coming: hand it a spawn tile well clear of every
    // player, and if the map cannot offer one this tick, release an ordinary
    // tank rather than dropping a bomb in the player's lap.
    if (variant === EnemyVariant.Kamikaze) {
      const distant = this.distantSpawnPoint(KAMIKAZE_MIN_SPAWN_TILES);
      if (distant) spawn = distant;
      else variant = EnemyVariant.Standard;
    }

    // A Sentinel is an emplacement, not a patrol: it never moves, so releasing
    // one at a map edge would leave it covering a corridor nobody uses. Put it
    // somewhere it can see the player instead.
    if (variant === EnemyVariant.Sentinel) {
      const post = this.sentinelPost();
      if (post) spawn = post;
      else variant = EnemyVariant.Standard;
    }

    const profile = this.variantProfile(variant);

    this.state.tanks.push(
      new Tank({
        x: spawn.x,
        y: spawn.y,
        width: TANK_SIZE,
        height: TANK_SIZE,
        ownerId: `enemy-${this.enemySequence++}`,
        maxHealth: profile.maxHealth,
        speed: profile.speed,
        direction: Direction.Down,
        isEnemy: true,
        variant,
        isDisguised: profile.disguised,
        isCloaked: profile.cloaked,
      }),
    );

    // A hull released while a beacon is standing has not seen the player yet,
    // so it takes the same coin flip everything already on the field took.
    if (this.hasDecoy() && Math.random() < DECOY_LURE_CHANCE) {
      this.luredIds.add(this.state.tanks.at(this.state.tanks.length - 1).ownerId);
    }

    this.lastEnemySpawnMs = this.elapsedMs;
  }

  /**
   * Health, speed and starting flags for one rank-and-file variant.
   *
   * Split out of the release path because two other things now build enemies —
   * the Overseer's reinforcement drops and a Foundry's production line — and all
   * three have to agree on what, say, a Sapper actually is.
   */
  private variantProfile(variant: string): {
    maxHealth: number;
    speed: number;
    disguised: boolean;
    cloaked: boolean;
  } {
    const tier = rollEnemyTier();
    const out = {
      maxHealth: tier.health,
      speed: tier.speed,
      disguised: false,
      cloaked: false,
    };

    switch (variant) {
      case EnemyVariant.Constructor:
        out.maxHealth = CONSTRUCTOR_HP;
        out.speed = TANK_SPEED * CONSTRUCTOR_SPEED_FACTOR;
        break;
      case EnemyVariant.Trapper:
        out.maxHealth = 1;
        out.speed = TANK_SPEED * TRAPPER_SPEED_FACTOR;
        break;
      case EnemyVariant.Mimic:
        out.maxHealth = MIMIC_HP;
        out.speed = TANK_SPEED * MIMIC_CREEP_FACTOR;
        out.disguised = true;
        break;
      case EnemyVariant.Kamikaze:
        out.maxHealth = 1;
        out.speed =
          TANK_SPEED * (KAMIKAZE_SPEED_MIN + Math.random() * (KAMIKAZE_SPEED_MAX - KAMIKAZE_SPEED_MIN));
        break;
      case EnemyVariant.Ghost:
        out.cloaked = true;
        break;
      case EnemyVariant.Sapper:
        out.maxHealth = SAPPER_HP;
        out.speed = TANK_SPEED * SAPPER_SPEED_FACTOR;
        break;
      case EnemyVariant.Lurcher:
        out.maxHealth = LURCHER_HP;
        out.speed = TANK_SPEED * LURCHER_SPEED_FACTOR;
        break;
      case EnemyVariant.Nullifier:
        out.maxHealth = NULLIFIER_HP;
        out.speed = TANK_SPEED * NULLIFIER_SPEED_FACTOR;
        break;
      case EnemyVariant.Jammer:
        // Emplaced: it never moves, so the player has to go to it. And one
        // shell finishes it — reaching it under a throttled gun is the whole
        // cost, and grinding through a full hull on arrival charged it twice.
        out.maxHealth = 1;
        out.speed = 0;
        break;
      case EnemyVariant.Sentinel:
        out.maxHealth = SENTINEL_HP;
        out.speed = 0;
        break;
      case EnemyVariant.Howler:
        out.maxHealth = HOWLER_HP;
        out.speed = TANK_SPEED * HOWLER_SPEED_FACTOR;
        break;
      case EnemyVariant.Leech:
        out.maxHealth = LEECH_HP;
        out.speed = TANK_SPEED * LEECH_SPEED_FACTOR;
        break;
      case EnemyVariant.Overseer:
        out.maxHealth = OVERSEER_HP;
        out.speed = TANK_SPEED * OVERSEER_SPEED_FACTOR;
        break;
      case EnemyVariant.Reclaimer:
        out.maxHealth = RECLAIMER_HP;
        out.speed = TANK_SPEED * RECLAIMER_SPEED_FACTOR;
        break;
      case EnemyVariant.Burrower:
        out.maxHealth = BURROWER_HP;
        out.speed = TANK_SPEED * BURROWER_SPEED_FACTOR;
        break;
    }

    return out;
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

    // The fixed release points are authored for an open field, and a map is
    // free to put something else there. Deep Water floods all five of them, so
    // this returned null on every tick and the level fielded nothing at all
    // except its boss. Fall back to open ground anywhere well away from the
    // players rather than quietly cancelling the level's entire opposition.
    return this.fallbackSpawnPoint();
  }

  /**
   * Any clear, tile-aligned ground a long way from every player.
   *
   * Deliberately a scan rather than more authored points: the next map to break
   * the assumption will break it somewhere else.
   */
  private fallbackSpawnPoint(): { x: number; y: number } | null {
    const players = this.playerTanks();
    const minDistance = FALLBACK_SPAWN_MIN_TILES * TILE_SIZE;

    for (let attempt = 0; attempt < FALLBACK_SPAWN_ATTEMPTS; attempt++) {
      const tx = 1 + Math.floor(Math.random() * (GRID_WIDTH - 2));
      const ty = 1 + Math.floor(Math.random() * (GRID_HEIGHT - 2));
      const x = tx * TILE_SIZE;
      const y = ty * TILE_SIZE;
      if (!this.isSpawnClear(x, y)) continue;

      const cx = x + TANK_SIZE / 2;
      const cy = y + TANK_SIZE / 2;
      const tooClose = players.some(
        (player) =>
          Math.hypot(player.x + player.width / 2 - cx, player.y + player.height / 2 - cy) <
          minDistance,
      );
      if (tooClose) continue;

      return { x, y };
    }

    return null;
  }

  /**
   * A clear edge spawn tile at least `minTiles` from every player, or null.
   *
   * Used for the units that are only fair at a distance. Falls back to nothing
   * rather than to the nearest tile: the caller downgrades the spawn instead,
   * which is always better than releasing the unit on top of someone.
   */
  private distantSpawnPoint(minTiles: number): { x: number; y: number } | null {
    const players = this.playerTanks();
    const minDistance = minTiles * TILE_SIZE;

    for (let k = 0; k < ENEMY_SPAWNS.length; k++) {
      const tile = ENEMY_SPAWNS[(this.enemySequence + k) % ENEMY_SPAWNS.length]!;
      const x = tile.x * TILE_SIZE;
      const y = tile.y * TILE_SIZE;
      if (!this.isSpawnClear(x, y)) continue;

      const cx = x + TANK_SIZE / 2;
      const cy = y + TANK_SIZE / 2;
      const tooClose = players.some(
        (player) =>
          Math.hypot(player.x + player.width / 2 - cx, player.y + player.height / 2 - cy) <
          minDistance,
      );
      if (!tooClose) return { x, y };
    }

    return null;
  }

  /** How many live enemies carry a given variant. */
  private countVariant(variant: string): number {
    let count = 0;
    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      if (tank.isEnemy && tank.variant === variant) count++;
    }
    return count;
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
    this.rebuildFields();
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
    // Only the smallest Hydra fragment is an ordinary tank; the bigger tiers
    // steer themselves in moveHydra and shoulder everything else aside.
    if (tank.variant === HYDRA) return tank.width <= HYDRA_CRUSHER_SIZE;
    // A charging Effigy is committed to its lane: the field would curve the
    // surge mid-flight and stack ordinary movement on top of it, exactly as it
    // would for a player who kept steering during their own ram.
    if (tank.variant === EFFIGY && tank.ownerId === this.bossId && this.effigyRamMs > 0) return false;
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
      case FOUNDRY:
      case LEVIATHAN:
      // Emplacements: they never move at all, so a route would be meaningless.
      case EnemyVariant.Sentinel:
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
      // any of them can gridlock, and the ones that steer themselves have no
      // field to fall back on.
      //
      // Bosses that drive themselves keep their own routines and are skipped.
      // Bosses steered by the *flow field* are not: the smallest Hydra
      // fragments and the Effigy move exactly like ordinary tanks and wedge
      // exactly like them, and being flagged `isBoss` was the only reason they
      // used to sit against a wall for the rest of the fight with nothing to
      // free them.
      if (!tank.isEnemy) continue;
      if (tank.isBoss && !this.usesHunterField(tank)) continue;

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
    const targets: { x: number; y: number }[] = [];

    // On a hold, the relay is a target in its own right. Without this the field
    // converges on the player alone, so walking away from the bunker took the
    // entire attack with you — which wins the level by refusing to defend it.
    // As one source among several, the field sends whoever is nearest the relay
    // at the relay and everyone else at the player, and standing somewhere
    // useful becomes the point again.
    if (this.currentWinCondition() === CampaignWinCondition.DefendCore) {
      const relay = this.firstTileOf(TileType.EagleBase);
      if (relay) {
        targets.push({
          x: Math.floor(relay.x / TILE_SIZE),
          y: Math.floor(relay.y / TILE_SIZE),
        });
      }
    }

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

  /** Tiles of every standing decoy beacon. */
  private decoyTargets(): { x: number; y: number }[] {
    const beacons: { x: number; y: number }[] = [];
    for (const abilities of this.abilities.values()) {
      if (!abilities.decoy) continue;
      beacons.push({
        x: Math.floor(abilities.decoy.x / TILE_SIZE),
        y: Math.floor(abilities.decoy.y / TILE_SIZE),
      });
    }
    return beacons;
  }

  /** True while at least one beacon is standing. */
  private hasDecoy(): boolean {
    for (const abilities of this.abilities.values()) if (abilities.decoy) return true;
    return false;
  }

  /**
   * Rebuilds both routes from the current map.
   *
   * Always both: a decoy route left stale while the map changed under it would
   * walk the units it had fooled into a wall, which reads as the ability
   * breaking rather than as it wearing off.
   */
  private rebuildFields(): void {
    this.hunterField.rebuildToward(this.state.grid, this.playerTargets());

    const beacons = this.decoyTargets();
    if (beacons.length > 0) this.decoyField.rebuildToward(this.state.grid, beacons);
  }

  /**
   * Decides, once, which of the enemies on the field this beacon fools.
   *
   * Pulling the entire field made the beacon an "everything stops attacking me"
   * button, and the upgrade that lengthens it made that last most of a fight.
   * Half of them take the bait; the other half keep coming, so the beacon buys
   * breathing room rather than immunity.
   */
  private rollDecoyLure(): void {
    const candidates: string[] = [];
    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      if (this.usesHunterField(tank)) candidates.push(tank.ownerId);
    }

    this.luredIds.clear();
    for (const id of rollDecoyLure(candidates)) this.luredIds.add(id);
  }

  // -------------------------------------------------------------- input & fire

  /** Turns the player tank and keeps it rolling for the next few ticks. */
  private requestMove(ownerId: string, direction: Direction): void {
    const tank = this.findTank(ownerId);
    if (!tank) return;

    // A surge is committed: steering input is ignored until it ends, so the ram
    // travels the line it was launched along instead of being curved mid-charge
    // by a held key (which would also stack ordinary movement on top of it).
    if (this.abilities.get(ownerId)?.ramActiveMs) return;

    tank.direction = direction;
    this.moveIntents.set(ownerId, this.tick + MOVE_INTENT_TTL_TICKS);
  }

  private playerShoot(ownerId: string): void {
    const tank = this.findTank(ownerId);
    if (!tank) return;

    // The whole reload — base, the late-campaign refit, Autoloader stacks and
    // any Jammer throttle — comes from the shared formula, because the client
    // throttles its own input against exactly the same numbers.
    const cooldown = campaignShootCooldownMs(
      this.state.currentLevel,
      this.upgradeCount(ownerId, "rate"),
      this.jammersActive(),
    );

    const lastShot = this.lastShotAtMs.get(ownerId);
    if (lastShot === undefined) {
      this.fire(tank);
      return;
    }

    const sinceLastShot = this.elapsedMs - lastShot;
    if (sinceLastShot < cooldown - SHOOT_JITTER_GRACE_MS) return;

    // Early, but only by clock skew: honour the shot and stamp it at the moment
    // it was actually due, so the long-run cadence stays exactly the reload.
    if (sinceLastShot < cooldown) {
      this.fire(tank, lastShot + cooldown);
      return;
    }

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
   * Only enemies are protected, and nothing that projects a shield is ever
   * covered by another one — Aegis or Warden, either way round. Two of them
   * inside each other's radius make a mutually invulnerable pair that can only
   * be broken by killing both in the same instant, which is not a puzzle, it is
   * a wall. Aegis-on-Aegis was closed first, but a Warden and its Aegis escort
   * still sheltered each other. A shield carrier protects the rank and file;
   * it takes its own shells.
   */
  private isAegisShielded(target: Tank): boolean {
    if (!target.isEnemy) return false;
    if (target.variant === AEGIS || target.variant === WARDEN) return false;

    const tcx = target.x + target.width / 2;
    const tcy = target.y + target.height / 2;

    for (let i = 0; i < this.state.tanks.length; i++) {
      const shield = this.state.tanks.at(i);
      if (shield === target) continue;

      let radius: number;
      if (shield.variant === AEGIS) {
        radius = AEGIS_RADIUS;
      } else if (shield.variant === WARDEN) {
        radius = WARDEN_SHIELD_RADIUS;
      } else {
        continue;
      }

      const dx = shield.x + shield.width / 2 - tcx;
      const dy = shield.y + shield.height / 2 - tcy;
      if (Math.hypot(dx, dy) <= radius) return true;
    }
    return false;
  }

  /**
   * Whether a tank may fire: cooldown elapsed, and (enemies) no shell in flight.
   *
   * Enemies only. {@link playerShoot} runs its own gate, because a player's
   * shot has crossed a network and is allowed a jitter grace this strict
   * comparison cannot express.
   */
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

  /**
   * Fires a volley from the tank's muzzle and starts its cooldown.
   *
   * `stampMs` overrides when the shot is recorded as having happened. Only
   * {@link playerShoot} passes it, to hold a jitter-absorbed shot to its proper
   * place in the cadence rather than letting the reload creep forward.
   */
  private fire(tank: Tank, stampMs?: number): void {
    const cooldownJitter = tank.isEnemy ? Math.random() * 1000 : 0;
    this.lastShotAtMs.set(tank.ownerId, stampMs ?? this.elapsedMs + cooldownJitter);

    if (!tank.isEnemy) {
      const player = this.state.players.get(tank.ownerId);
      if (player) player.shotsFired++;
    }

    const profile = this.profileFor(tank);
    const heading = DIRECTION_VECTORS[tank.direction];
    const across = { x: -heading.y, y: heading.x };

    // Hot Loads stack on top of the late-campaign shell boost. Capped below the
    // tile size: a shell that crosses a whole tile in one tick can jump a wall.
    const boosted = !tank.isEnemy && this.state.currentLevel > 10
      ? profile.bulletSpeed * 1.20
      : profile.bulletSpeed;

    // The mirror boss fires the player's shells, Hot Loads and all. Every other
    // enemy takes the flat profile.
    const mirrors = tank.variant === EFFIGY;
    const shellStacks = mirrors
      ? this.effigyMirror("shell")
      : this.upgradeCount(tank.ownerId, "shell");
    const bulletSpeed = tank.isEnemy && !mirrors
      ? boosted
      : Math.min(TILE_SIZE - 1, boosted * (1 + 0.2 * shellStacks));

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
