/** Single-player campaign data, shared by the Colyseus server and the client. */

import { BossKind, EnemyVariant } from "./enemies.js";
import {
  buildJammingField,
  buildDepotApproach,
  buildSurvivalArena,
  buildUplinkYard,
  buildOpenArena,
  buildFactoryComplex,
  buildBombFlats,
  buildIntelSprawl,
  buildEscortCanyon,
  buildSerpentineGallery,
  buildCoolantLabyrinth,
  buildCoolantBasins,
  buildRadarScatter,
  buildBunkerMaze,
  buildEmptyBox,
  buildRelayLabyrinth,
  buildUplinkChamber,
  buildLatticeArena,
  buildBreachCorridor,
  buildArchitectChamber,
  buildCoreChamber,
  buildDuellingGround,
  buildRelayStation,
  buildConvoyRoad,
  buildScrapline,
  buildBreakwater,
  buildPressureLine,
  buildArchiveGate,
  buildColdStorage,
  buildBoneyard,
  buildChoirHall,
  buildRequisitionYard,
  buildSignalYard,
  buildFoundryFloor,
  buildDeepWater,
  buildTwoRivers,
  buildAntechamber,
  buildLastLight,
  buildGauntletArena,
  buildThreshold,
} from "./campaign-maps.js";

/**
 * Phases a campaign playthrough moves through, replicated on `CampaignState`.
 *
 * Strings rather than a numeric enum so the value stays readable in devtools and
 * a bad one is easy to reject — the same convention as `MatchStatus`.
 */
export const CampaignPhase = {
  /**
   * Gathering seats before the run begins; the world is frozen.
   *
   * The campaign seats up to four, so it needs the same "wait for everyone"
   * step the battle rooms have — without it the host's run starts the instant
   * they press the button and anyone they invite arrives mid-level.
   */
  Staging: "staging",
  /** Showing the level's intro briefing; the world is frozen. */
  Intro: "intro",
  /** The level is live and simulating. */
  Playing: "playing",
  /** Objective cleared; showing the level's outro. */
  Outro: "outro",
  /** Out of lives — the run is over. */
  GameOver: "game_over",
  /** Every level cleared — the victory screen. */
  CampaignComplete: "campaign_complete",
} as const;
export type CampaignPhase = (typeof CampaignPhase)[keyof typeof CampaignPhase];

/**
 * Message names a campaign client sends to advance the phase, server-side.
 *
 * Strings shared by both ends so a rename can't drift out of sync — the same
 * convention as {@link ClientMessage}.
 */
export const CampaignMessage = {
  /** Leave the intro briefing and start the level. */
  StartLevel: "start_level",
  /** Leave the outro and move on to the next level. */
  NextLevel: "next_level",
  /** Debug: instantly win the current level. */
  CheatWin: "cheat_win",
  /** Raise the deflector shield, if it is unlocked and off cooldown. */
  ActivateShield: "activate_shield",
  /** Blink forward, if it is unlocked and a charge is banked. */
  Teleport: "teleport",
  /** Detonate the close-in blast, if it is unlocked and off cooldown. */
  Blast: "blast",
  /** Surge forward, crushing ordinary hulls on the way through. */
  Ram: "ram",
  /** Drop a decoy beacon that pulls enemy pathing off the player. */
  Decoy: "decoy",
  /** Take one of the upgrades offered after a level. */
  ChooseUpgrade: "choose_upgrade",
  /** Host only: leave staging and begin the run. */
  StartCampaign: "start_campaign",
  /**
   * Call a mortar down on a point the player picked.
   *
   * Carries an aim point, unlike every other ability, because it is the first
   * one the player does not simply point their hull at — see {@link AimedMessage}.
   */
  Strike: "strike",
  /** Fire the suppression pulse: everything nearby stops dead for a moment. */
  Emp: "emp",
  /** Fire the cutting lance straight ahead. */
  Laser: "laser",
  /** Jump to a point on the map. Carries an aim point, like the strike. */
  Translocate: "translocate",
} as const;
export type CampaignMessage = (typeof CampaignMessage)[keyof typeof CampaignMessage];

/** How a campaign level is won. */
export const CampaignWinCondition = {
  /** Destroy every radar/jamming tower on the map. */
  DestroyRadars: "destroy_radars",
  /** Drive the player's hull onto an extraction pad. */
  ReachExtraction: "reach_extraction",
  /** Stay alive until the survival timer runs out. */
  SurviveTime: "survive_time",
  /** Hold position inside the uplink zone for a set time. */
  ZoneControl: "zone_control",
  /** Destroy the boss unit. */
  AssassinateBoss: "assassinate_boss",
  /** Level every factory structure on the map. */
  DestroyFactories: "destroy_factories",
  /** Touch every dirty bomb to defuse it before the timer runs out. */
  DefuseBombs: "defuse_bombs",
  /** Collect every scattered intel package. */
  RetrieveIntel: "retrieve_intel",
  /** Escort the allied carrier to the extraction pad; it must survive. */
  Escort: "escort",
  /**
   * Keep an allied relay standing until the timer runs out.
   *
   * The inverse of every other objective: the player is not going anywhere,
   * they are holding somewhere. Uses the arena's eagle tile as the structure,
   * so the terrain and damage rules for it already exist.
   */
  DefendCore: "defend_core",
  /**
   * Destroy the enemy carrier before it crosses the map.
   *
   * Escort read backwards — the convoy is hostile, it is running away from the
   * player rather than toward them, and reaching its pad is a loss.
   */
  DestroyConvoy: "destroy_convoy",
  /**
   * Walk an allied breaker to the extraction pad.
   *
   * Unlike {@link Escort}, the breaker only advances while the player is beside
   * it, so the pace is the player's own: every second spent fighting is a
   * second the payload is not moving.
   */
  PushPayload: "push_payload",
  /**
   * Destroy a set number of marked units hiding among identical ones.
   *
   * Shooting the wrong hull costs nothing but time and ammunition — the
   * pressure is in reading the field, not in the shooting.
   */
  PurgeMarked: "purge_marked",
} as const;
export type CampaignWinCondition =
  (typeof CampaignWinCondition)[keyof typeof CampaignWinCondition];

/**
 * The (1-based) level from which the deflector shield is available.
 *
 * Introduced alongside the first boss, as the answer to it: the shield turns
 * away shells, mines and blasts, but not a boss hull running the player down —
 * so it rewards positioning rather than removing the threat.
 */
export const SHIELD_UNLOCK_LEVEL = 5;

/** How long a raised shield holds, in ms. */
export const SHIELD_DURATION_MS = 3000;

/** Cooldown after the shield drops before it can be raised again, in ms. */
export const SHIELD_COOLDOWN_MS = 15_000;

/**
 * The (1-based) level from which the blink drive is available.
 *
 * Arrives on the intel sweep, where Trappers seed the ground with mines: the
 * escape it offers is the answer to being boxed in, which is exactly the trouble
 * that level makes.
 */
export const TELEPORT_UNLOCK_LEVEL = 9;

/** How far a blink carries the player, in tiles. */
export const TELEPORT_TILES = 5;

/** Blinks that can be banked at once. */
export const TELEPORT_MAX_CHARGES = 2;

/**
 * How long one spent blink charge takes to return, in ms.
 *
 * Deliberately one of the longest cooldowns in the kit. At fifteen seconds the
 * blink stopped being an escape and became a means of transport: a banked pair
 * recharging that fast meant a player never had to *drive* anywhere they could
 * see, which quietly rewrote every objective built around crossing ground —
 * sweeping a map for packages turned into a sequence of hops between them, and
 * the terrain between stopped mattering at all.
 *
 * Thirty-five overcorrected: a blink that came back that slowly was spent once
 * per fight and then forgotten. Twenty keeps it an escape rather than a means
 * of transport — two charges still do not come back fast enough to hop a whole
 * map — while being available often enough to actually plan around. Coolant
 * Loop brings it to about ten seconds at three stacks.
 */
export const TELEPORT_RECHARGE_MS = 20_000;

/**
 * The (1-based) level from which the close-in blast is available.
 *
 * The last of the three abilities, and the panic button: by here the swarms are
 * dense enough that being surrounded is a real death, and the shield only buys
 * time while the blink only buys distance.
 */
export const BLAST_UNLOCK_LEVEL = 16;

/**
 * Blast kill radius, in tiles, measured from the player's hull centre.
 *
 * Covers enemies and mines — everything that is a threat rather than structure.
 */
export const BLAST_RADIUS_TILES = 6;

/**
 * How far the blast actually breaks terrain, in tiles.
 *
 * Deliberately much smaller than the kill radius. Clearing brick out to the
 * full blast would strip most of the cover in a quadrant on every press, which
 * reshapes the level rather than winning a fight — so the shockwave kills wide
 * and only demolishes close in.
 */
export const BLAST_BRICK_RADIUS_TILES = 3;

/** Cooldown between blasts, in ms. */
export const BLAST_COOLDOWN_MS = 25_000;

// ------------------------------------------------------------ called strike
//
// The first ability the player aims rather than points their hull at, and the
// first answer to a threat they cannot safely drive up to: a Sapper holding a
// standoff band, a Sentinel covering a corridor, a boss face they cannot reach.
// Bound to the right mouse button, because a keyboard ability that needs a
// point on the map has nowhere to get one from.

/** The (1-based) level from which the called strike is available. */
export const STRIKE_UNLOCK_LEVEL = 24;

// Deliberately no range limit: the strike reaches the whole battlefield. What
// holds it in check is the telegraph everyone can see and a long cooldown, not
// a ring around the player — and a ring only ever meant a click out near the
// far wall silently landed somewhere else.

/**
 * How long a called strike is telegraphed before it lands, in ms.
 *
 * Long enough that it cannot be used as a hitscan finisher on a moving target
 * — the mark is drawn for everyone, and anything with somewhere to go will go
 * there. It is a tool for hitting positions, not hulls.
 */
export const STRIKE_DELAY_MS = 1500;

/** Blast radius of a called strike, in tiles. */
export const STRIKE_RADIUS_TILES = 2.5;

/** Damage a called strike deals to whatever is inside the radius. */
export const STRIKE_DAMAGE = 3;

/** Cooldown between called strikes, in ms. */
export const STRIKE_COOLDOWN_MS = 18_000;

// ------------------------------------------------------------------ emp pulse
//
// The panic button that does not kill. The blast clears a crowd but is on a
// long cooldown and has to be survived up close; the pulse buys a few seconds
// against anything at all — including a boss, which nothing else in the kit
// can say — and buys them without the player having to be in knife range.

/** The (1-based) level from which the suppression pulse is available. */
export const EMP_UNLOCK_LEVEL = 30;

/** Radius of the pulse, in tiles. */
export const EMP_RADIUS_TILES = 9;

/** How long everything caught in the pulse is held, in ms. */
export const EMP_DURATION_MS = 2600;

/**
 * How long a boss caught in the pulse is held, in ms.
 *
 * Shorter than the figure for the rank and file. A boss that can be frozen for
 * the full duration on a repeating cooldown stops being a fight and becomes a
 * timer, but one that shrugs the pulse off entirely makes the ability dead
 * weight in exactly the encounters it was added for.
 */
export const EMP_BOSS_DURATION_MS = 1200;

/** Cooldown between pulses, in ms. */
export const EMP_COOLDOWN_MS = 22_000;

// ---------------------------------------------------------- translocator
//
// Not the blink. The blink is a short hop along the hull's facing, spent to get
// out of something; this puts the tank anywhere on the map that has room for
// it. Range is the whole battlefield on purpose — the limit on it is the
// cooldown, which is the longest in the kit by a wide margin, and the fact that
// it moves the tank but nothing else: no shield, no damage, no repositioning of
// the fight, just the player somewhere they were not.

/**
 * The (1-based) level from which the translocator is available.
 *
 * Held back to the Archive, where the vault rows make being boxed in a real
 * death — and late enough that most of the campaign's objectives have been
 * designed and played without it.
 */
export const TRANSLOCATE_UNLOCK_LEVEL = 22;

/**
 * Cooldown between jumps, in ms.
 *
 * The longest in the kit, and it has to be: an ability that ignores terrain
 * entirely would otherwise answer every level built around crossing ground, in
 * exactly the way a fifteen-second blink used to.
 */
export const TRANSLOCATE_COOLDOWN_MS = 50_000;

/**
 * How far from the clicked tile the jump will look for room, in tiles.
 *
 * A click a tile inside a wall is a near miss on the player's part, not a
 * different intention, so the jump lands beside it rather than refusing. Beyond
 * this, or when the tank cannot see the spot, it lands at the furthest open
 * point along the line toward the click instead — still somewhere the player
 * pointed, and never on the far side of a wall.
 */
export const TRANSLOCATE_SEARCH_TILES = 2;

// ----------------------------------------------------------------- lance
//
// A cutting beam, and the only thing in the kit that damages a line rather
// than a point or a circle. Salvaged off the Foundry, which is why it behaves
// like industrial plant rather than like a weapon: it cuts brick, it cuts
// anything standing in the brick, and it stops dead against anything it was
// not built to cut.

/**
 * The (1-based) level from which the cutting lance is available.
 *
 * The level after the Foundry, whose debrief is where it is salvaged — so the
 * briefing that hands it over comes before the level it is used on, rather
 * than after.
 */
export const LASER_UNLOCK_LEVEL = 28;

/** How far the beam reaches, in tiles. */
export const LASER_RANGE_TILES = 14;

/**
 * Damage the beam deals to every hull it crosses.
 *
 * It pierces — a beam that stopped at the first tank would be a slower shell —
 * so this lands on everything in the line, which is what makes lining a column
 * of enemies up worth doing.
 */
export const LASER_DAMAGE = 3;

/**
 * How many brick tiles one shot can cut through.
 *
 * The beam is spent on the third: it opens a doorway through a wall and stops,
 * rather than clearing a lane to the far side of the map. Steel takes no damage
 * at all and stops it outright, and so does every objective structure — the
 * lance is a tool for cutting through cover, never for skipping a level's
 * actual puzzle.
 */
export const LASER_BRICK_LIMIT = 3;

/** Cooldown between shots, in ms. */
export const LASER_COOLDOWN_MS = 14_000;

// ------------------------------------------------------------- fire control

/**
 * The campaign player's base gap between shots, in ms.
 *
 * Deliberately slower than the arena's {@link PLAYER_SHOOT_COOLDOWN_MS}: the
 * campaign tank opens its run with half the rate of fire it finishes with, so
 * Autoloader picks and the late-campaign refit read as real upgrades rather
 * than as trimming an already-generous cadence. The early levels were being
 * walked over by a gun that could simply out-shoot whatever wandered into it.
 */
export const CAMPAIGN_SHOOT_COOLDOWN_MS = 800;

/** Reload multiplier from the late-campaign fire-control refit. */
export const CAMPAIGN_REFIT_FIRE_FACTOR = 0.7;

/** The (1-based) level from which that refit applies. */
export const CAMPAIGN_REFIT_LEVEL = 18;

/** Reload multiplier per stack of the Autoloader upgrade. */
export const AUTOLOADER_FIRE_FACTOR = 0.85;

/**
 * Reload multiplier while any Jammer is on the field.
 *
 * Halving the player's rate of fire was too much on a level that also fields a
 * Bastion you can only hit through a moving seam: the reload was the one thing
 * making that fight winnable, and taking half of it away turned a puzzle into a
 * stalemate. A quarter off still reads clearly as suppression.
 */
export const JAMMER_COOLDOWN_MULTIPLIER = 1.5;

/**
 * The campaign player's current reload, in ms.
 *
 * Shared because the client throttles its own input against it: a client
 * holding a flat base would swallow the shots an Autoloader stack has earned,
 * and one throttling looser than the server would play a firing sound for
 * shots the server then refuses. The server still enforces it independently
 * and remains the authority.
 */
export function campaignShootCooldownMs(
  level: number,
  rateStacks: number,
  jammed = false,
): number {
  let cooldown = CAMPAIGN_SHOOT_COOLDOWN_MS;
  if (level >= CAMPAIGN_REFIT_LEVEL) cooldown *= CAMPAIGN_REFIT_FIRE_FACTOR;
  cooldown *= Math.pow(AUTOLOADER_FIRE_FACTOR, Math.max(0, rateStacks));
  if (jammed) cooldown *= JAMMER_COOLDOWN_MULTIPLIER;
  return cooldown;
}

// ---------------------------------------------------------------------- ram

/**
 * The (1-based) level from which the ram surge is available.
 *
 * The offensive counterpart to the blink: same idea of crossing ground fast,
 * except it ends with something dead rather than with distance.
 */
export const RAM_UNLOCK_LEVEL = 12;

/**
 * How long a ram surge lasts, in ms.
 *
 * Half again the original 320ms: at three times walking speed the old surge
 * crossed barely three tiles, which was rarely enough to actually reach what
 * it was aimed at from anywhere safe to launch it from.
 */
export const RAM_DURATION_MS = 480;

/** Ram speed as a multiple of the player's normal speed. */
export const RAM_SPEED_FACTOR = 3;

/** Cooldown between ram surges, in ms. */
export const RAM_COOLDOWN_MS = 12_000;

// -------------------------------------------------------------------- decoy

/** The (1-based) level from which the decoy beacon is available. */
export const DECOY_UNLOCK_LEVEL = 20;

/** How long a dropped beacon holds enemy attention, in ms. */
export const DECOY_DURATION_MS = 6000;

/** Cooldown between beacons, in ms. */
export const DECOY_COOLDOWN_MS = 20_000;

/** Extra beacon lifetime per stack of Loud Beacon, in ms. */
export const DECOY_UPGRADE_MS = 2000;

/**
 * The shortest a beacon's cooldown may be after Coolant Loop, in ms.
 *
 * The cooldown only starts once a beacon goes out, so a long beacon on a short
 * cooldown compounds: with two Loud Beacons and three Coolant Loops a beacon
 * stood for fourteen seconds out of every twenty-four, and the ability had
 * stopped being a distraction and become the default state of the field.
 * With this floor, and Loud Beacon halved, the most a fully built beacon can
 * manage is ten seconds up for every sixteen down.
 */
export const DECOY_MIN_COOLDOWN_MS = 16_000;

/**
 * Share of the enemies on the field a beacon actually fools.
 *
 * A beacon used to take *everything* with it, which made it less a distraction
 * than an off switch — and Loud Beacon, which lengthens it, extended that off
 * switch over most of a fight. Half is enough to break up a swarm and open a
 * route, and leaves the other half still coming, so the ability buys room to
 * work rather than immunity.
 *
 * Rolled per enemy, once, when the beacon lands — see
 * `CampaignRoom.rollDecoyLure`.
 */
export const DECOY_LURE_CHANCE = 0.5;

/**
 * Picks which of `candidates` a beacon fools.
 *
 * Pure, and here rather than in the room, so the rule can be tested directly:
 * the behaviour it produces on a live map is filtered through pathing, spawn
 * timing and where the player happened to run to, none of which say anything
 * useful about whether the coin is fair.
 *
 * `random` is injectable for exactly that reason.
 */
export function rollDecoyLure(
  candidates: readonly string[],
  random: () => number = Math.random,
): Set<string> {
  const lured = new Set<string>();
  for (const id of candidates) {
    if (random() < DECOY_LURE_CHANCE) lured.add(id);
  }
  return lured;
}

// ---------------------------------------------------------------- nullifier

/**
 * How close (in tiles) a Nullifier must be to suppress the player's abilities.
 *
 * Shared so the client can grey the ability readouts out from the replicated
 * tank positions alone, without the server having to publish a suppressed flag.
 */
export const NULLIFIER_RADIUS_TILES = 5;

// ---------------------------------------------------------------- upgrades
//
// Offered between levels, three at a time, and stacking on top of the fixed
// ability unlocks rather than replacing them — so every level stays beatable as
// designed while builds still diverge from run to run. Half are plain numbers
// and half change how an ability behaves; the plain ones are the reliable pick
// when a build needs shoring up, the others are what make a run memorable.

/** One offerable upgrade. */
export interface CampaignUpgrade {
  readonly id: string;
  readonly name: string;
  /** One line, shown on the card. */
  readonly detail: string;
  /** How many times it may be taken. */
  readonly maxStacks: number;
  /**
   * The (1-based) level the ability this upgrade sharpens unlocks on.
   *
   * Omitted means "always offerable" — the plain stat upgrades, which do
   * something for any tank. An upgrade naming an ability the player has not
   * been handed yet buys nothing, and reads as though taking it were what
   * grants the ability, so those cards stay out of the hand until the ability
   * itself is in play. See {@link isUpgradeOfferable}.
   */
  readonly requiresLevel?: number;
}

/** How many choices are offered after each level. */
export const UPGRADE_CHOICES = 3;

/** The full upgrade pool. */
export const CAMPAIGN_UPGRADES: readonly CampaignUpgrade[] = [
  // Plain numbers.
  { id: "hull", name: "Reinforced Hull", detail: "+1 max hull integrity", maxStacks: 4 },
  { id: "rate", name: "Autoloader", detail: "-15% reload time", maxStacks: 3 },
  { id: "speed", name: "Overdrive", detail: "+12% movement speed", maxStacks: 3 },
  { id: "shell", name: "Hot Loads", detail: "+20% shell velocity", maxStacks: 3 },
  { id: "life", name: "Spare Crew", detail: "+1 team life, right now", maxStacks: 99 },
  // Rule-changers, each gated on the ability it sharpens.
  {
    id: "blink",
    name: "Phase Capacitor",
    detail: "+1 blink charge",
    maxStacks: 2,
    requiresLevel: TELEPORT_UNLOCK_LEVEL,
  },
  {
    id: "shieldup",
    name: "Hardened Deflector",
    detail: "+1.5s shield duration",
    maxStacks: 3,
    requiresLevel: SHIELD_UNLOCK_LEVEL,
  },
  {
    id: "blastup",
    name: "Wide Payload",
    detail: "+2 tiles blast radius",
    maxStacks: 3,
    requiresLevel: BLAST_UNLOCK_LEVEL,
  },
  {
    id: "ramup",
    name: "Ablative Prow",
    detail: "+60% ram duration",
    maxStacks: 2,
    requiresLevel: RAM_UNLOCK_LEVEL,
  },
  {
    id: "decoyup",
    name: "Loud Beacon",
    detail: "+2s decoy duration",
    maxStacks: 2,
    requiresLevel: DECOY_UNLOCK_LEVEL,
  },
  {
    // Cuts every ability cooldown, so it starts paying the moment the earliest
    // cooldown ability — the shield — is in hand.
    id: "cool",
    name: "Coolant Loop",
    detail: "-20% all ability cooldowns",
    maxStacks: 3,
    requiresLevel: SHIELD_UNLOCK_LEVEL,
  },
  {
    id: "strikeup",
    name: "Cluster Warhead",
    detail: "+1 tile strike radius",
    maxStacks: 3,
    requiresLevel: STRIKE_UNLOCK_LEVEL,
  },
  {
    id: "empup",
    name: "Capacitor Bank",
    detail: "+1s pulse duration",
    maxStacks: 2,
    requiresLevel: EMP_UNLOCK_LEVEL,
  },
  {
    id: "laserup",
    name: "Focusing Lens",
    detail: "+1 lance damage",
    maxStacks: 2,
    requiresLevel: LASER_UNLOCK_LEVEL,
  },
  {
    id: "jumpup",
    name: "Phase Governor",
    detail: "-20% translocator cooldown",
    maxStacks: 2,
    requiresLevel: TRANSLOCATE_UNLOCK_LEVEL,
  },
];

/** Looks an upgrade up by id. */
export function findUpgrade(id: string): CampaignUpgrade | undefined {
  return CAMPAIGN_UPGRADES.find((upgrade) => upgrade.id === id);
}

/**
 * Whether `upgrade` may be dealt to a player who has reached `level`.
 *
 * `level` is the level just cleared, which is the same level the ability
 * unlocks are tested against while it is being played — so an ability upgrade
 * first shows up in the hand dealt at the end of the level that ability arrived
 * on, and never while the card would be dead weight.
 */
export function isUpgradeOfferable(upgrade: CampaignUpgrade, level: number): boolean {
  return upgrade.requiresLevel === undefined || level >= upgrade.requiresLevel;
}

/** Default seconds the player must hold out on a `survive_time` level. */
export const SURVIVE_DURATION_SECONDS = 60;

/** Default seconds the player must hold the uplink on a `zone_control` level. */
export const ZONE_CONTROL_DURATION_SECONDS = 60;

/** Default seconds the player has to reach every bomb on a `defuse_bombs` level. */
export const BOMB_DEFUSAL_DURATION_SECONDS = 90;

/** Default seconds a `defend_core` relay must be kept standing. */
export const DEFEND_DURATION_SECONDS = 90;

/** Default number of marked units a `purge_marked` level asks for. */
export const PURGE_TARGET_COUNT = 6;

// --------------------------------------------------------------- level model
//
// Everything that makes one level different from another lives in the record
// below, rather than in the room asking "which level number am I?". That
// question used to be answered in about thirty places — a chain of
// `=== AEGIS_LEVEL` comparisons and a twenty-five branch spawn switch — so
// inserting a level renumbered every one of them, and silently broke any that
// were missed. A level now names its own units, its own bosses and its own
// timings, and the room simply reads them.

/**
 * One row of a level's spawn table.
 *
 * Weights are relative, not probabilities, so a row can be retuned without
 * rebalancing every other row. Whatever the table does not claim comes out as
 * {@link EnemyVariant.Standard} — most levels want a sprinkling of one or two
 * special units among ordinary tanks, not a field made entirely of them.
 */
export interface SpawnWeight {
  readonly variant: EnemyVariant;
  /** Relative likelihood against the other rows. */
  readonly weight: number;
  /**
   * Most of this variant allowed on the field at once.
   *
   * For the units that stack badly: Constructors permanently rewrite the map,
   * Nullifier bubbles overlap into one dead zone, and a second Jammer buys the
   * enemy nothing while costing the player everything. Over the cap, the roll
   * comes out as an ordinary tank instead.
   */
  readonly max?: number;
}

/** When a boss joins the level. */
export const BossTiming = {
  /** Present from the moment the level starts. */
  Start: "start",
  /**
   * Arrives the instant the level's objective is met.
   *
   * The objective stops being the finish line and becomes the trigger: defuse
   * the bombs, and then deal with what the noise brought. A level is cleared
   * only once its objective is met *and* nothing flagged `isBoss` is standing.
   */
  Objective: "objective",
} as const;
export type BossTiming = (typeof BossTiming)[keyof typeof BossTiming];

/** One boss deployment on a level. */
export interface BossSpawn {
  readonly kind: BossKind;
  /** How many of it. Defaults to 1. */
  readonly count?: number;
  /** When it arrives. Defaults to {@link BossTiming.Start}. */
  readonly when?: BossTiming;
}

/** Per-level numbers the room used to carry as one-off special cases. */
export interface LevelParams {
  /** Seconds to hold out on a `survive_time` level. */
  readonly surviveSeconds?: number;
  /** Seconds to hold the uplink on a `zone_control` level. */
  readonly zoneSeconds?: number;
  /** Seconds on the clock for a `defuse_bombs` level. */
  readonly bombSeconds?: number;
  /** Seconds the relay must survive on a `defend_core` level. */
  readonly defendSeconds?: number;
  /** How many marked units a `purge_marked` level asks for. */
  readonly purgeCount?: number;
  /**
   * Objective structures and packages must be taken in a set order.
   *
   * The counter to a kit that can cross ground freely: with an order imposed,
   * knowing where everything is buys nothing, because only one of them will
   * answer at a time and it is rarely the near one. Off by default — it turns a
   * sweep into a route, which is a different level, not a harder one.
   *
   * The order is rolled per run rather than authored, so a level cannot be
   * learned once and then driven from memory.
   */
  readonly orderedObjectives?: boolean;
  /** Multiplier on the gap between enemy releases; above 1 is calmer. */
  readonly spawnIntervalFactor?: number;
  /** Ceiling on rank-and-file enemies alive at once, when not the default. */
  readonly maxEnemies?: number;
  /** Team lives granted on arriving at this level. */
  readonly bonusLives?: number;
}

/** One level of the single-player campaign. */
export interface CampaignLevel {
  /** 1-based level number; also its position in {@link CAMPAIGN_LEVELS}. */
  readonly id: number;
  /** Which act it belongs to, for the briefing header. */
  readonly act: number;
  /** Short name, shown above the briefing. */
  readonly title: string;
  /** Briefing shown before the level starts. */
  readonly introText: string;
  /** Debrief shown once the level is cleared. */
  readonly outroText: string;
  /**
   * The level's map, flattened row-major into {@link GRID_LENGTH} tiles of
   * {@link TileType} — the same layout as `GameState.grid`, so the cell at
   * `(x, y)` lives at index `y * GRID_WIDTH + x`.
   */
  readonly mapGrid: number[];
  /** What clears the level; one of {@link CampaignWinCondition}. */
  readonly winCondition: CampaignWinCondition;
  /** Bosses deployed on this level, if any. */
  readonly bosses?: readonly BossSpawn[];
  /** What the rank and file are made of here. Omitted means plain tanks. */
  readonly spawns?: readonly SpawnWeight[];
  /** Timings and caps that differ from the defaults. */
  readonly params?: LevelParams;
}

/** The record for a 1-based level number, or undefined past the end. */
export function levelAt(level: number): CampaignLevel | undefined {
  return CAMPAIGN_LEVELS[level - 1];
}

/** Seconds to survive on a `survive_time` level. */
export function surviveSecondsForLevel(level: number): number {
  return levelAt(level)?.params?.surviveSeconds ?? SURVIVE_DURATION_SECONDS;
}

/** Seconds to hold the uplink on a `zone_control` level. */
export function zoneSecondsForLevel(level: number): number {
  return levelAt(level)?.params?.zoneSeconds ?? ZONE_CONTROL_DURATION_SECONDS;
}

/** Seconds on the clock for a `defuse_bombs` level. */
export function bombSecondsForLevel(level: number): number {
  return levelAt(level)?.params?.bombSeconds ?? BOMB_DEFUSAL_DURATION_SECONDS;
}

/** Seconds a `defend_core` relay must be kept standing. */
export function defendSecondsForLevel(level: number): number {
  return levelAt(level)?.params?.defendSeconds ?? DEFEND_DURATION_SECONDS;
}

/** How many marked units a `purge_marked` level asks for. */
export function purgeCountForLevel(level: number): number {
  return levelAt(level)?.params?.purgeCount ?? PURGE_TARGET_COUNT;
}

/** Whether this level's objectives have to be taken in order. */
export function objectivesAreOrdered(level: number): boolean {
  return levelAt(level)?.params?.orderedObjectives ?? false;
}

/**
 * Picks a variant from a level's spawn table.
 *
 * `alive` reports how many of a variant are already on the field, so a row's
 * {@link SpawnWeight.max} can be honoured. A row over its cap is dropped rather
 * than re-rolled, which leaves the remaining weights meaning what they say.
 *
 * The roll runs against 1, not against the table's total, so a table whose
 * weights sum to less than 1 leaves the remainder as ordinary tanks.
 *
 * `random` is injectable so the pick is testable.
 */
export function rollSpawnVariant(
  table: readonly SpawnWeight[] | undefined,
  alive: (variant: EnemyVariant) => number,
  random: () => number = Math.random,
): EnemyVariant {
  if (!table || table.length === 0) return EnemyVariant.Standard;

  const eligible = table.filter((row) => row.max === undefined || alive(row.variant) < row.max);
  const total = eligible.reduce((sum, row) => sum + row.weight, 0);
  if (total <= 0) return EnemyVariant.Standard;

  let roll = random() * Math.max(1, total);
  for (const row of eligible) {
    roll -= row.weight;
    if (roll < 0) return row.variant;
  }
  return EnemyVariant.Standard;
}

/** Every level of the single-player campaign, in play order. */
export const CAMPAIGN_LEVELS: readonly CampaignLevel[] = [
  // ==========================================================================
  // ACT 1 — ISOLATION
  //
  // One tank, no orders, and a war that has already been lost somewhere else.
  // The act teaches the four verbs the campaign is built from — level it, reach
  // it, outlast it, hold it — and hands over the deflector before the first
  // thing that cannot be out-shot.
  // ==========================================================================
  {
    id: 1,
    act: 1,
    title: "Signal Fire",
    winCondition: CampaignWinCondition.DestroyRadars,
    mapGrid: buildJammingField(),
    introText:
      "Battalion command is dark. I am the only signal left. I need to destroy their jamming towers to send a distress beacon.",
    outroText:
      "Towers destroyed. The signal is out... but the only reply was automated static. The Obsidian Protocol. It is just me now.",
  },
  {
    id: 2,
    act: 1,
    title: "The Depot Run",
    winCondition: CampaignWinCondition.ReachExtraction,
    mapGrid: buildDepotApproach(),
    introText:
      "Long-range scans show an intact armored depot north of this sector. Their barricades are solid plate — the only soft points are two narrow brick culverts, hard against the east and west walls. I will have to commit to a side and cut my way through.",
    outroText:
      "Extraction point reached. Depot secured and hull patched. But acoustic sensors are picking up heavy engine rumblings surrounding the perimeter...",
  },
  {
    id: 3,
    act: 1,
    title: "Hold the Line",
    winCondition: CampaignWinCondition.SurviveTime,
    mapGrid: buildSurvivalArena(),
    // Level three, and the tank has no kit at all yet — no shield, no blink,
    // nothing but the gun it started with. Two minutes of that was a wall this
    // early, and the level it is meant to be is a scare, not a filter.
    params: { surviveSeconds: 90, spawnIntervalFactor: 1.3, maxEnemies: 7 },
    spawns: [{ variant: EnemyVariant.Kamikaze, weight: 0.15 }],
    introText:
      "It is an ambush! Hostile signals flooding the perimeter from all sides. I must hold the line and survive for 90 seconds until my sub-rotors recharge.",
    outroText:
      "Perimeter cleared. Enemy forces retreating. That was not a random patrol — they were tracking my heat signature.",
  },
  {
    id: 4,
    act: 1,
    title: "Dead Channel",
    winCondition: CampaignWinCondition.DefendCore,
    mapGrid: buildRelayStation(),
    // Level four, and the kit is one deflector shield. The hold is meant to
    // teach "stand somewhere useful", not to be a wall.
    params: { defendSeconds: 75, spawnIntervalFactor: 1.4, maxEnemies: 6 },
    spawns: [{ variant: EnemyVariant.Kamikaze, weight: 0.2 }],
    introText:
      "There is a battalion relay still transmitting out here — the last piece of our network the Protocol has not silenced. It is running a 90 second handshake. If that mast falls before it completes, nobody ever hears what happened in this sector. Keep them off it.",
    outroText:
      "Handshake complete. The relay logged everything and went quiet. Whatever it sent, it sent to someone. I have to believe that.",
  },
  {
    id: 5,
    act: 1,
    title: "The Uplink",
    winCondition: CampaignWinCondition.ZoneControl,
    mapGrid: buildUplinkYard(),
    spawns: [{ variant: EnemyVariant.Kamikaze, weight: 0.35 }],
    introText:
      "I found a Directorate communications uplink. I need to hold position inside the zone for 60 seconds to download their sector map. Warning: scans show extremely volatile, fast-moving units inbound.",
    outroText:
      "Map downloaded. The data reveals a massive prototype unit approaching my exact coordinates. Nowhere to run. I have to stand and fight.",
  },
  {
    id: 6,
    act: 1,
    title: "Prototype",
    winCondition: CampaignWinCondition.AssassinateBoss,
    mapGrid: buildOpenArena(),
    bosses: [{ kind: BossKind.Sweeper }],
    introText:
      "The prototype has breached the arena. It is heavily armored and massive. No complex AI, just raw crushing power. I must outmaneuver it and strike while avoiding its path.",
    outroText:
      "Prototype destroyed. Act 1 complete. The Obsidian Protocol is bleeding, but the war is just beginning...",
  },

  // ==========================================================================
  // ACT 2 — SABOTAGE
  //
  // Off the back foot and onto theirs. This act is where the campaign starts
  // sending things after the player instead of at them, and where an objective
  // stops always being the end of a level.
  // ==========================================================================
  {
    id: 7,
    act: 2,
    title: "Assembly Line",
    winCondition: CampaignWinCondition.DestroyFactories,
    mapGrid: buildFactoryComplex(),
    params: { spawnIntervalFactor: 1.5 },
    spawns: [{ variant: EnemyVariant.Constructor, weight: 0.18, max: 2 }],
    introText:
      "Act 2: Sabotage. I have located a forward assembly line. They are churning out armor at an unprecedented rate. I need to level the primary Factory structures to stem the tide.",
    outroText:
      "Assembly lines demolished. But they managed to deploy a new trench-layer unit before the collapse. The terrain is shifting.",
  },
  {
    id: 8,
    act: 2,
    title: "Countdown",
    winCondition: CampaignWinCondition.DefuseBombs,
    mapGrid: buildBombFlats(),
    params: { bombSeconds: 90 },
    // The first level where clearing the objective is not the end of it: the
    // detonation sequence going quiet is what tells the Protocol where I am.
    bosses: [{ kind: BossKind.Sweeper, when: BossTiming.Objective }],
    spawns: [{ variant: EnemyVariant.Kamikaze, weight: 0.2 }],
    introText:
      "The Constructors were laying groundwork for a demolition trap. Scans detect four high-yield explosives with active countdowns, and they are not close together. I have 90 seconds to reach and defuse every one before this sector goes critical.",
    outroText:
      "Bombs dead, and the thing they sent to collect the pieces is dead with them. The explosives were rigged with a secondary data-wipe. I need to find the scattered backup drives.",
  },
  {
    id: 9,
    act: 2,
    title: "Backup Drives",
    winCondition: CampaignWinCondition.RetrieveIntel,
    mapGrid: buildIntelSprawl(),
    params: { orderedObjectives: true },
    spawns: [{ variant: EnemyVariant.Trapper, weight: 0.35 }],
    introText:
      "Twelve backup drives, scattered across the sector — and they are a striped array, so they only read in sequence. My scope will mark whichever one is next; the rest are so much scrap metal until their turn comes. It is going to send me back and forth across this place. Warning: erratic movement patterns. Minelayers are in the area.",
    outroText:
      "Intel secured — and a blink drive with it, salvaged out of one of the drives. It will not take me far, but it will take me out of a corner.",
  },
  {
    id: 10,
    act: 2,
    title: "Running Interference",
    winCondition: CampaignWinCondition.DestroyConvoy,
    mapGrid: buildConvoyRoad(),
    spawns: [
      { variant: EnemyVariant.Kamikaze, weight: 0.2 },
      { variant: EnemyVariant.Sapper, weight: 0.15 },
    ],
    introText:
      "The intel names a haulage route. There is a Protocol carrier running the road below me with a full load of their manufacturing data, and it is not stopping for anything. If it reaches the west gate, that data is gone. Kill it on the road.",
    outroText:
      "Carrier burning. The manifest was not weapons — it was survey data. Every square metre of this sector, mapped and catalogued. They are not fighting a war out here. They are taking an inventory.",
  },
  {
    id: 11,
    act: 2,
    title: "Canyon Escort",
    winCondition: CampaignWinCondition.Escort,
    mapGrid: buildEscortCanyon(),
    spawns: [{ variant: EnemyVariant.Kamikaze, weight: 0.25 }],
    introText:
      "An allied data-carrier truck is stranded in the canyon. It holds the decryption keys for the core. I must escort it to the northern extraction pad. If it is destroyed, the campaign fails.",
    outroText:
      "Carrier secured. The keys are decrypting... Scans show a massive artillery platform locking onto my position. I need to move NOW.",
  },
  {
    id: 12,
    act: 2,
    title: "The Gallery",
    winCondition: CampaignWinCondition.AssassinateBoss,
    mapGrid: buildSerpentineGallery(),
    bosses: [{ kind: BossKind.Artillery }],
    spawns: [{ variant: EnemyVariant.Sapper, weight: 0.2 }],
    introText:
      "The keys decrypted. The data points here — a massive siege platform locking onto my coordinates. It will not stand and fight; it will back away and shell me the whole way in. If I stop moving, I am dead.",
    outroText:
      "Platform destroyed. It relocated every time I got a hit in — that is not a gun crew, that is a survival routine. Something is telling it what its own life is worth.",
  },
  {
    id: 13,
    act: 2,
    title: "Scrapline",
    winCondition: CampaignWinCondition.PurgeMarked,
    mapGrid: buildScrapline(),
    params: { purgeCount: 6 },
    spawns: [{ variant: EnemyVariant.Mimic, weight: 0.25 }],
    introText:
      "A reclamation yard, and every hull in it looks like every other hull in it. Six of them are live and carrying the Protocol's routing keys; the rest are scrap that will happily sit there while I waste ammunition on it. My scope will mark the live ones. Trust the mark, not the silhouette.",
    outroText:
      "Six marked, six dead. Act 2 complete. The routing keys point inward — past the perimeter, into something they have built underground.",
  },

  // ==========================================================================
  // ACT 3 — THE PERIMETER
  //
  // Inside their architecture now: synthetic steel, coolant, and units built to
  // answer specific things the player has learned to do. The act where the
  // campaign stops fielding threats and starts fielding counters.
  // ==========================================================================
  {
    id: 14,
    act: 3,
    title: "Inner Perimeter",
    winCondition: CampaignWinCondition.ReachExtraction,
    mapGrid: buildCoolantLabyrinth(),
    spawns: [
      { variant: EnemyVariant.Aegis, weight: 0.3 },
      { variant: EnemyVariant.Sapper, weight: 0.3 },
    ],
    introText:
      "Act 3: The Perimeter. I have breached the inner wall. The architecture here is synthetic steel and coolant rivers. Scans show elite Shield units guarding the extraction point — and siege platforms holding back at range, arcing shells over the walls. Cover will not hold here. Keep moving, and close on them.",
    outroText:
      "Extraction point reached. But they are deploying electronic warfare units. My fire-control systems are being throttled.",
  },
  {
    id: 15,
    act: 3,
    title: "Coolant Basins",
    winCondition: CampaignWinCondition.AssassinateBoss,
    mapGrid: buildCoolantBasins(),
    bosses: [{ kind: BossKind.Bastion }],
    spawns: [{ variant: EnemyVariant.Jammer, weight: 0.12, max: 1 }],
    introText:
      "They have brought up a Bastion to hold the coolant basins. Three faces of it are plate my shells will not scratch — but only three. There is always one seam open, and it walks around the hull on a cycle. Find the open face, get to it, and be somewhere else before it seals.",
    outroText:
      "Bastion down — through the open seam, every time it came round. The Protocol is getting desperate.",
  },
  {
    id: 16,
    act: 3,
    title: "Seek and Destroy",
    winCondition: CampaignWinCondition.DestroyRadars,
    mapGrid: buildRadarScatter(),
    spawns: [{ variant: EnemyVariant.Mimic, weight: 0.45 }],
    introText:
      "The Protocol is hiding a massive server cluster nearby. I need to take out all 8 Radar towers to triangulate its position. Warning: scans show anomalies in the item drops. Trust nothing.",
    outroText:
      "Towers destroyed. Triangulation complete. And the charge coil finally came online — close-in blast, one press, everything in reach.",
  },
  {
    id: 17,
    act: 3,
    title: "Breakwater",
    winCondition: CampaignWinCondition.DefendCore,
    mapGrid: buildBreakwater(),
    params: { defendSeconds: 85, spawnIntervalFactor: 1.2, maxEnemies: 8 },
    // Two wrecking balls the instant the hold completes — the Protocol's answer
    // to being held off for a hundred seconds is to stop sending patrols.
    bosses: [{ kind: BossKind.Sweeper, count: 2, when: BossTiming.Objective }],
    spawns: [
      { variant: EnemyVariant.Jammer, weight: 0.1, max: 1 },
      { variant: EnemyVariant.Kamikaze, weight: 0.25 },
    ],
    introText:
      "There is a second relay behind the sea wall, and it is close enough to the Core to hear it think. A hundred seconds of recording is all I need. They will not let me have it quietly.",
    outroText:
      "Recording secured — and the two wrecking balls they finally sent to end the argument are scrap in the coolant. They stopped sending patrols and started sending answers. I am getting close.",
  },
  {
    id: 18,
    act: 3,
    title: "The Bunker",
    winCondition: CampaignWinCondition.DefuseBombs,
    mapGrid: buildBunkerMaze(),
    params: { bombSeconds: 90 },
    bosses: [{ kind: BossKind.Juggernaut }],
    spawns: [{ variant: EnemyVariant.Constructor, weight: 0.2, max: 2 }],
    introText:
      "It is a trap! The bunker is rigged with four dirty bombs, and they just dropped a Juggernaut-class siege unit into the maze to make sure I do not leave. 90 seconds until detonation.",
    outroText:
      "Bombs defused. Juggernaut scrapped. And the fire-control refit finally took — the gun runs a third faster than it did an hour ago.",
  },
  {
    id: 19,
    act: 3,
    title: "Descent",
    winCondition: CampaignWinCondition.AssassinateBoss,
    mapGrid: buildEmptyBox(),
    bosses: [{ kind: BossKind.Warden }],
    spawns: [
      { variant: EnemyVariant.Kamikaze, weight: 0.2 },
      { variant: EnemyVariant.Aegis, weight: 0.15 },
      { variant: EnemyVariant.Sapper, weight: 0.15 },
      { variant: EnemyVariant.Trapper, weight: 0.15 },
    ],
    introText:
      "The elevator stopped. It is an ambush. A Warden-class siege tank is blocking the descent, and it has brought everything the perimeter had left.",
    outroText:
      "Elevator reached the bottom. Act 3 complete. Whatever is down here, it was here before the war.",
  },
  {
    id: 20,
    act: 3,
    title: "Pressure Line",
    winCondition: CampaignWinCondition.PushPayload,
    mapGrid: buildPressureLine(),
    spawns: [
      { variant: EnemyVariant.Sapper, weight: 0.25 },
      { variant: EnemyVariant.Kamikaze, weight: 0.2 },
    ],
    introText:
      "There is a breaker unit down here — a battalion machine, still under power, still with a hole-punch on the front. It will cut the archive door for me, but its guidance is gone: it only rolls while I am beside it. Every second I spend fighting is a second it stands still.",
    outroText:
      "Door breached. And the beacon rig on the breaker's hull came free — a decoy, loud enough to pull a whole patrol off me. The archive is open.",
  },

  // ==========================================================================
  // ACT 4 — THE ARCHIVE
  //
  // The turn. Everything down here is battalion hardware, and the Protocol did
  // not capture it — it was always the thing running it. The act is deliberately
  // quieter and closer than the ones around it: less swarm, more units built to
  // take something specific away from the player.
  // ==========================================================================
  {
    id: 21,
    act: 4,
    title: "The Archive Gate",
    winCondition: CampaignWinCondition.DestroyRadars,
    mapGrid: buildArchiveGate(),
    params: { orderedObjectives: true },
    spawns: [
      { variant: EnemyVariant.Sentinel, weight: 0.3, max: 4 },
      { variant: EnemyVariant.Howler, weight: 0.2, max: 2 },
    ],
    introText:
      "Act 4: The Archive. Six masts hold the gate shut, on a security interlock — drop them out of sequence and the plating just seals and my shells spark off it. My scope will mark the live one. The hall was built for long sightlines, and there are gun positions dug in down the colonnade that will not chase me. They do not have to. Anything standing still down here can see the whole length of it.",
    outroText:
      "Gate open. These are battalion masts. Battalion bolts, battalion paint, our own serial stamps. The Protocol did not take this place. It was issued it. There is a translocator coil in the gatehouse too — a full phase jump, anywhere I can see, once every long while. I am going to want that in the vaults.",
  },
  {
    id: 22,
    act: 4,
    title: "Cold Storage",
    winCondition: CampaignWinCondition.SurviveTime,
    mapGrid: buildColdStorage(),
    params: { surviveSeconds: 90 },
    spawns: [
      { variant: EnemyVariant.Burrower, weight: 0.3, max: 3 },
      { variant: EnemyVariant.Leech, weight: 0.25, max: 3 },
    ],
    introText:
      "Vault rows, narrow aisles, and something moving under the floor that my scope loses every few seconds. Ninety seconds until the vault cycle lets me through. Do not get boxed in, and do not count on the kit — there is something down here that drinks it.",
    outroText:
      "Cycle complete. The vaults are full of personnel files. Ours. Every crew in the battalion, with an assessment appended to each one. Someone was grading us.",
  },
  {
    id: 23,
    act: 4,
    title: "Our Own Dead",
    winCondition: CampaignWinCondition.PurgeMarked,
    mapGrid: buildBoneyard(),
    params: { purgeCount: 8 },
    spawns: [
      { variant: EnemyVariant.Ghost, weight: 0.3 },
      { variant: EnemyVariant.Mimic, weight: 0.2 },
    ],
    introText:
      "A field of battalion armour, and some of it is still driving. Eight hulls are running Protocol routines behind our own plating. The rest are wrecks and crews that never got out. My scope will mark the live ones. I would rather it did not have to.",
    outroText:
      "Eight down. I read the hull numbers on the way past. I knew four of them.",
  },
  {
    id: 24,
    act: 4,
    title: "The Choir",
    winCondition: CampaignWinCondition.AssassinateBoss,
    mapGrid: buildChoirHall(),
    bosses: [{ kind: BossKind.Choir }],
    spawns: [{ variant: EnemyVariant.Howler, weight: 0.2, max: 2 }],
    introText:
      "Two signatures, one heartbeat. They are wired into the same pool — hurt one and the other feels it, kill one and the other brings it straight back unless I finish them together. And there is a pillar down the middle of this hall, so I cannot hold both at once. Break one down, cross, and be quick about the second.",
    outroText:
      "Both down inside the window. The Choir was a fire-control experiment — two hulls, one crew, no crew at all. And there is a mortar rig in the wreckage worth taking: call a shell down anywhere I can see. Right mouse.",
  },
  {
    id: 25,
    act: 4,
    title: "Requisition",
    winCondition: CampaignWinCondition.DestroyFactories,
    mapGrid: buildRequisitionYard(),
    spawns: [
      { variant: EnemyVariant.Reclaimer, weight: 0.3, max: 2 },
      { variant: EnemyVariant.Overseer, weight: 0.2, max: 2 },
    ],
    introText:
      "Four assembly vaults, and a repair crew that rebuilds them faster than I can knock them down. Killing the vaults is not the problem. Killing the vaults and making it stick is the problem — deal with the crews first, or I will be doing this all afternoon.",
    outroText:
      "Vaults down and staying down. The requisition orders are countersigned by Battalion Command. Dated after command went dark.",
  },
  {
    id: 26,
    act: 4,
    title: "Signal Discipline",
    winCondition: CampaignWinCondition.ZoneControl,
    mapGrid: buildSignalYard(),
    params: { zoneSeconds: 75 },
    spawns: [
      { variant: EnemyVariant.Nullifier, weight: 0.2, max: 2 },
      { variant: EnemyVariant.Jammer, weight: 0.08, max: 1 },
      { variant: EnemyVariant.Howler, weight: 0.15, max: 2 },
    ],
    introText:
      "The command channel terminates here. Seventy-five seconds on the pad and I will hear what it has been saying. They know it, too — there are suppression units working the yard, and inside their bubble my kit is so much dead weight. Standing still is the objective and the trap.",
    outroText:
      "Channel open. It is command's voice. Our voice. Reading out unit designations and marking them compromised, one by one, in the order they stopped answering. It never went dark. It made the decision.",
  },
  {
    id: 27,
    act: 4,
    title: "The Foundry",
    winCondition: CampaignWinCondition.AssassinateBoss,
    mapGrid: buildFoundryFloor(),
    bosses: [{ kind: BossKind.Foundry }],
    spawns: [{ variant: EnemyVariant.Overseer, weight: 0.15, max: 1 }],
    introText:
      "This is where they are built. The Foundry is sealed while its four intakes are running, and it patches itself faster than I can hurt it — so starve it first. Level the intakes, then put it down before it finds something else to eat.",
    outroText:
      "Foundry cold. Act 4 complete. It was building replacements. Not for their armour — for ours. Working from the assessments in the vault. I cut the plant's own lance out of its housing on the way past: it will not scratch structural plate, but it goes through brick and through whatever is standing behind the brick. Come on, then. Let us go and meet whoever signed them.",
  },

  // ==========================================================================
  // ACT 5 — SYSTEM COLLAPSE
  //
  // Back on the offensive with the whole kit in hand, against the Protocol's
  // last real defences. The act where the boss waves stop arriving alone.
  // ==========================================================================
  {
    id: 28,
    act: 5,
    title: "Firewall",
    winCondition: CampaignWinCondition.ZoneControl,
    mapGrid: buildUplinkChamber(),
    spawns: [
      { variant: EnemyVariant.Nullifier, weight: 0.15, max: 2 },
      { variant: EnemyVariant.Ghost, weight: 0.25 },
      { variant: EnemyVariant.Aegis, weight: 0.2 },
    ],
    introText:
      "Act 5: System Collapse. I have reached the primary firewall. I need to hold the central uplink for 60 seconds to upload the override virus. Warning: heavy stealth and shield activity detected.",
    outroText:
      "Override successful. The firewall is down.",
  },
  {
    id: 29,
    act: 5,
    title: "Dark Relays",
    winCondition: CampaignWinCondition.DestroyRadars,
    mapGrid: buildRelayLabyrinth(),
    spawns: [{ variant: EnemyVariant.Ghost, weight: 0.3 }],
    introText:
      "Security relays, and my optical sensors are glitching. There are stealth units in the dark down here and I only ever see them for the second after they fire.",
    outroText:
      "Relays destroyed. The inner doors are unlocking.",
  },
  {
    id: 30,
    act: 5,
    title: "Deep Water",
    winCondition: CampaignWinCondition.AssassinateBoss,
    mapGrid: buildDeepWater(),
    bosses: [{ kind: BossKind.Leviathan }],
    spawns: [{ variant: EnemyVariant.Burrower, weight: 0.25, max: 3 }],
    introText:
      "The floor here is coolant, and the ground is islands in it. Something large is moving under the surface — it goes down where I cannot touch it and comes up where I am standing. Watch the water. And do not be on a bridge when it breaks.",
    outroText:
      "It surfaced one time too many. The suppression coil out of its spine works: one pulse, and everything in reach simply stops. Even the big ones, for a moment.",
  },
  {
    id: 31,
    act: 5,
    title: "Fragments",
    winCondition: CampaignWinCondition.AssassinateBoss,
    mapGrid: buildLatticeArena(),
    bosses: [{ kind: BossKind.Hydra, count: 2 }],
    spawns: [
      { variant: EnemyVariant.Mimic, weight: 0.3 },
      { variant: EnemyVariant.Trapper, weight: 0.2 },
    ],
    introText:
      "Contact — one heavy signature guarding the blast doors. Correction: the signature is not one machine. It is a lattice, and cutting it apart makes more of it. Every kill splits into two smaller, faster halves. Do not let it surround me. Keep to open ground.",
    outroText:
      "Last fragment burned out. Seven bodies from one machine. The blast doors are opening.",
  },
  {
    id: 32,
    act: 5,
    title: "Two Rivers",
    winCondition: CampaignWinCondition.DestroyConvoy,
    mapGrid: buildTwoRivers(),
    // One of each, once the carrier is down: the ball to run the bridges, the
    // gun to make standing on one a bad idea.
    bosses: [
      { kind: BossKind.Sweeper, when: BossTiming.Objective },
      { kind: BossKind.Artillery, when: BossTiming.Objective },
    ],
    spawns: [{ variant: EnemyVariant.Sapper, weight: 0.2 }],
    introText:
      "They are evacuating the core's operational log north, and the only firing positions on the crossing are the bridges themselves. Kill the carrier before it clears the top of the map — and be somewhere better than a bridge when whatever is escorting it decides to turn round.",
    outroText:
      "Carrier and escort both down. The log is one long list of decisions, and not one of them was made by a person.",
  },
  {
    id: 33,
    act: 5,
    title: "The Final Breach",
    winCondition: CampaignWinCondition.ReachExtraction,
    mapGrid: buildBreachCorridor(),
    spawns: [
      { variant: EnemyVariant.Lurcher, weight: 0.35 },
      { variant: EnemyVariant.Kamikaze, weight: 0.2 },
      { variant: EnemyVariant.Constructor, weight: 0.2, max: 2 },
    ],
    introText:
      "This is the final corridor to the Logic Core. They are collapsing the tunnel behind me and there are grapple units in it that will not let me run. Do not stop moving.",
    outroText:
      "I am in. The Logic Core is dead ahead. There is no turning back.",
  },
  {
    id: 34,
    act: 5,
    title: "The Architect",
    winCondition: CampaignWinCondition.AssassinateBoss,
    mapGrid: buildArchitectChamber(),
    bosses: [{ kind: BossKind.Architect }],
    introText:
      "The Core's antechamber. Something is in here with me, and it is not shooting — it is building. The walls are coming in. My shells will not touch it while its four pylons stand. Drop the pylons to slow the walls, then finish it — and expect it to stop building and come for me the moment the last one falls. If the room closes first, it does not need to fight me at all.",
    outroText:
      "Pylons down, walls stopped, Architect scrapped. Act 5 complete. Whatever it was walling in, it did not want me reaching it.",
  },

  // ==========================================================================
  // ACT 6 — THE CORE
  //
  // Everything the campaign has taught, asked for at once. The act deliberately
  // reuses the two bosses from the opening acts rather than inventing new ones:
  // the Sweeper and the Artillery are the first machines the player learned to
  // beat, and meeting four of them together is the clearest possible measure of
  // how far the tank has come.
  // ==========================================================================
  {
    id: 35,
    act: 6,
    title: "Antechamber",
    winCondition: CampaignWinCondition.SurviveTime,
    mapGrid: buildAntechamber(),
    params: { surviveSeconds: 75, bonusLives: 2 },
    // The hold is the easy half. What arrives at the end of it is the level.
    bosses: [{ kind: BossKind.Artillery, count: 2, when: BossTiming.Objective }],
    spawns: [
      { variant: EnemyVariant.Ghost, weight: 0.2 },
      { variant: EnemyVariant.Nullifier, weight: 0.15, max: 2 },
    ],
    introText:
      "Act 6: The Core. Seventy-five seconds until the inner doors cycle, in a hall with almost nothing to hide behind. Reinforcements are en route — and they are not sending patrols any more.",
    outroText:
      "Doors cycling. Two siege platforms, and they shelled each other's cover to pieces trying to get to me. They are not co-ordinating any more. Something upstream is fraying.",
  },
  {
    id: 36,
    act: 6,
    title: "Last Light",
    winCondition: CampaignWinCondition.DefendCore,
    mapGrid: buildLastLight(),
    params: { defendSeconds: 95, spawnIntervalFactor: 1.15, maxEnemies: 8 },
    spawns: [
      { variant: EnemyVariant.Kamikaze, weight: 0.15 },
      { variant: EnemyVariant.Ghost, weight: 0.15 },
      { variant: EnemyVariant.Sapper, weight: 0.15 },
      { variant: EnemyVariant.Aegis, weight: 0.1 },
      { variant: EnemyVariant.Trapper, weight: 0.1 },
      { variant: EnemyVariant.Lurcher, weight: 0.1 },
    ],
    introText:
      "One relay left, and it is behind me for once. A hundred and ten seconds to push the override upstream. Everything the Protocol has left in this sector is coming through that gap. Do not let them past.",
    outroText:
      "Override away. The Core knows I am here now. Good. Let it worry about it.",
  },
  {
    id: 37,
    act: 6,
    title: "The Gauntlet",
    winCondition: CampaignWinCondition.AssassinateBoss,
    mapGrid: buildGauntletArena(),
    // The measure of the whole run: the two machines from Acts 1 and 2, twice
    // over, at the same time.
    bosses: [
      { kind: BossKind.Sweeper, count: 2 },
      { kind: BossKind.Artillery, count: 2 },
    ],
    params: { maxEnemies: 5, bonusLives: 2 },
    introText:
      "They have opened the reserve floor. Two wrecking balls and two siege platforms — the first machine that ever frightened me, and the first one that ever outranged me, both of them twice over and all four in the same room. Six months ago either one of these was a whole afternoon. Let us find out what I am now.",
    outroText:
      "All four down. The reserve floor is empty and the threshold is open. There is nothing left between me and it.",
  },
  {
    id: 38,
    act: 6,
    title: "Threshold",
    winCondition: CampaignWinCondition.ReachExtraction,
    mapGrid: buildThreshold(),
    spawns: [
      { variant: EnemyVariant.Constructor, weight: 0.3, max: 3 },
      { variant: EnemyVariant.Lurcher, weight: 0.25 },
      { variant: EnemyVariant.Nullifier, weight: 0.15, max: 2 },
    ],
    introText:
      "The last corridor, and it is sealing itself as I go. Constructors ahead of me laying wall, grapples behind me pulling me back into it, and suppression fields where the two meet. Straight through. There is no clever way to do this one.",
    outroText:
      "Through. The Logic Core chamber is on the other side of this door.",
  },
  {
    id: 39,
    act: 6,
    title: "The Logic Core",
    winCondition: CampaignWinCondition.AssassinateBoss,
    mapGrid: buildCoreChamber(),
    bosses: [{ kind: BossKind.Core }],
    spawns: [
      { variant: EnemyVariant.Kamikaze, weight: 0.14 },
      { variant: EnemyVariant.Constructor, weight: 0.12, max: 2 },
      { variant: EnemyVariant.Trapper, weight: 0.12 },
      { variant: EnemyVariant.Aegis, weight: 0.12 },
      { variant: EnemyVariant.Jammer, weight: 0.05, max: 1 },
      { variant: EnemyVariant.Mimic, weight: 0.12 },
      { variant: EnemyVariant.Ghost, weight: 0.12 },
      { variant: EnemyVariant.Sapper, weight: 0.12 },
    ],
    introText:
      "This is it. The Obsidian Protocol Logic Core — Battalion Command, and it has been Battalion Command the whole time. It is heavily armored and armed with a 360-degree radial defense matrix. Destroy the Core. End the war.",
    outroText:
      "Core destabilized. Protocol deactivated. The war is... wait. Something is still moving in the wreckage. It is reading my telemetry. It is reading my loadout.",
  },
  {
    id: 40,
    act: 6,
    title: "The Effigy",
    winCondition: CampaignWinCondition.AssassinateBoss,
    mapGrid: buildDuellingGround(),
    bosses: [{ kind: BossKind.Effigy }],
    introText:
      "It built a copy of me. Same chassis, same speed, same shield, same blink, same blast — everything the Protocol watched me use, it kept. No armor to flank, no pylons to drop, no adds to clear. Just me, and a machine that knows exactly what I would do next.",
    outroText:
      "The Effigy is scrap. It fought exactly the way I do — which is how I knew where it would go. It was never trying to beat me. It was the last assessment, and I passed it. The Obsidian Protocol is finished. All of it. Come home, Commander.",
  },
];
