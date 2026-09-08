/** Types shared by the Colyseus server and the Phaser client. */

import { Direction } from "./constants.js";

/** Message names sent client -> server. */
export const ClientMessage = {
  Move: "move",
  Shoot: "shoot",
  /** Host-only: leave the staging lobby and begin the match. */
  StartGame: "startGame",
  /** Host-only: after a match resolves, return the room to the staging lobby. */
  ResetMatch: "resetMatch",
} as const;
export type ClientMessage = (typeof ClientMessage)[keyof typeof ClientMessage];

/** Message names sent server -> client. */
export const ServerMessage = {
  Welcome: "welcome",
  BoonCollected: "boon_collected",
  /** A tank was destroyed in combat — drives the explosion and camera shake. */
  TankDestroyed: "tank_destroyed",
  /** A shell struck steel — drives the spark effect at the impact point. */
  SteelHit: "steel_hit",
  /** Final per-player figures, sent once the match resolves. */
  MatchStats: "match_stats",
  /** The campaign boss rebounded off a wall — drives a heavy camera shake. */
  BossBounce: "boss_bounce",
  /** An artillery mortar is inbound — drives the telegraph circle before impact. */
  MortarWarning: "mortar_warning",
  /** The player's deflector shield was raised, dropped, or came off cooldown. */
  ShieldChanged: "shield_changed",
  /** The player blinked, or a blink charge finished recharging. */
  TeleportChanged: "teleport_changed",
  /** A mine went off under the player — drives the blast effect. */
  MineDetonated: "mine_detonated",
  /** The player's close-in blast fired, or came off cooldown. */
  BlastChanged: "blast_changed",
  /** The ram surge started, ended, or came off cooldown. */
  RamChanged: "ram_changed",
  /** A decoy beacon was dropped, expired, or the ability came off cooldown. */
  DecoyChanged: "decoy_changed",
  /** A Lurcher's grapple connected — drives the tether effect and the yank. */
  GrappleHit: "grapple_hit",
  /** The upgrade cards this player may pick from after a level. */
  UpgradeOffer: "upgrade_offer",
} as const;
export type ServerMessage = (typeof ServerMessage)[keyof typeof ServerMessage];

/** One player's line on the post-match scoreboard. */
export interface MatchStatsRow {
  /** Session id, so the client can pick out its own row. */
  sessionId: string;
  name: string;
  /** Tank colour, for the row swatch. */
  color: number;
  /** Enemy tanks this player landed the killing blow on. */
  kills: number;
  /** Times this player fired. */
  shots: number;
}

/**
 * Broadcast when the match resolves: a snapshot of every player's tally.
 *
 * Sent as a message rather than read off replicated state so the scoreboard is
 * a fixed post-match record — unaffected by anyone leaving the finished room.
 * Unsorted; the client orders it.
 */
export interface MatchStatsMessage {
  rows: MatchStatsRow[];
}

/**
 * Broadcast when a tank is destroyed by weapons fire.
 *
 * Only combat kills are announced — not tanks removed by a leaving player, a
 * bomb boon, or a match reset — so the client can shake and explode without
 * having to guess why a tank left the replicated state.
 */
export interface TankDestroyedMessage {
  /** Impact point, in world units: the destroyed tank's centre. */
  x: number;
  y: number;
  /** A player tank rather than an enemy — drives the heavier camera shake. */
  isEnemy: boolean;
  /** The 3-HP heavy enemy tier — drives the medium camera shake. */
  heavy: boolean;
}

/** Broadcast when a shell is stopped (or cut through) a steel tile. */
export interface SteelHitMessage {
  /** Impact point, in world units. */
  x: number;
  y: number;
}

/** Broadcast when the campaign boss bounces off a wall — for a camera shake. */
export interface BossBounceMessage {
  /** The boss's centre at the moment of impact, in world units. */
  x: number;
  y: number;
  /**
   * A much gentler shake than a wall bounce. Set when the Juggernaut crushes a
   * block — that happens often as it grinds through the maze, so it must barely
   * register rather than jolt the camera the way the Sweeper's rebounds do.
   */
  subtle?: boolean;
}

/** Broadcast when an artillery mortar is launched at a target, before it lands. */
export interface MortarWarningMessage {
  /** Impact centre, in world units. */
  x: number;
  y: number;
  /** Milliseconds until detonation — how long to show the telegraph. */
  delay: number;
  /**
   * Blast radius in world units. Omitted for the artillery boss's own mortars,
   * which keep the original 1.5-tile telegraph; Sapper lobs pass a tighter one
   * so the two threats stay tellable apart at a glance.
   */
  radius?: number;
}

/** Broadcast when the player's deflector shield changes state. */
export interface ShieldChangedMessage {
  /** True when the shield has just gone up, false when it dropped. */
  active: boolean;
  /** How long the shield will hold, in ms. Present when `active`. */
  durationMs?: number;
  /** How long until it can be raised again, in ms. Present when it dropped. */
  cooldownMs?: number;
  /** True on the message announcing the cooldown has finished. */
  ready?: boolean;
}

/** Broadcast when a mine detonates under the player. */
export interface MineDetonatedMessage {
  /** Blast centre, in world units. */
  x: number;
  y: number;
  /**
   * True when a raised shield soaked the blast and the player walked away.
   * The client plays a cooler, smaller burst for these.
   */
  absorbed: boolean;
}

/** Broadcast when the player's blast fires, or when it comes off cooldown. */
export interface BlastChangedMessage {
  /** ms until it can be fired again; 0 when ready. */
  cooldownMs: number;
  /**
   * Somebody else's ability, not the receiving player's.
   *
   * The campaign's mirror boss fires the player's own kit back at them and
   * reuses these messages to draw it, so the client has to be told which ones
   * describe its own cooldowns and which are only there to be rendered. Without
   * it, a boss ability announces itself as the player's and resets their HUD.
   */
  foreign?: boolean;
  /** Blast centre, in world units — present only on an actual detonation. */
  x?: number;
  y?: number;
  /** Blast kill radius, in world units. Present alongside the centre. */
  radius?: number;
  /**
   * The smaller radius within which terrain actually broke, in world units.
   * Drawn as an inner ring so the two areas are tellable apart.
   */
  brickRadius?: number;
}

/** Broadcast when the ram surge fires, ends, or comes off cooldown. */
export interface RamChangedMessage {
  /** True while the surge is running. */
  active: boolean;
  /** ms until it can be fired again; 0 when ready. */
  cooldownMs: number;
  /** Somebody else's surge — see {@link BlastChangedMessage.foreign}. */
  foreign?: boolean;
}

/** Broadcast when a decoy beacon is dropped, expires, or comes off cooldown. */
export interface DecoyChangedMessage {
  /** ms until another beacon can be dropped; 0 when ready. */
  cooldownMs: number;
  /** Beacon position in world units, present while one is standing. */
  x?: number;
  y?: number;
  /** ms the beacon will hold attention for. Present alongside the position. */
  durationMs?: number;
}

/** Broadcast when a Lurcher's grapple lands on the player. */
export interface GrappleHitMessage {
  /** The Lurcher's muzzle, in world units. */
  fromX: number;
  fromY: number;
  /** Where the player was yanked to, in world units. */
  toX: number;
  toY: number;
}

/** Sent to one player with the upgrades they may choose between levels. */
export interface UpgradeOfferMessage {
  /** Upgrade ids on offer, or empty once the choice has been spent. */
  ids: string[];
  /** What the player already owns, as id -> stacks, for the card subtitles. */
  owned: Record<string, number>;
}

/** Broadcast when the player blinks, or when a blink charge returns. */
export interface TeleportChangedMessage {
  /** Charges banked after this change. */
  charges: number;
  /** Somebody else's blink — see {@link BlastChangedMessage.foreign}. */
  foreign?: boolean;
  /** ms until the next charge returns; 0 when the bank is full. */
  rechargeMs: number;
  /** The jump itself, in world units — present only on an actual blink. */
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
}

/** Lifecycle of a match, replicated on GameState.matchState. */
export const MatchStatus = {
  /** Staging: players are gathering and the world is frozen. */
  Lobby: "LOBBY",
  Playing: "PLAYING",
  /** The eagle fell, or every player ran out of lives. */
  GameOver: "GAME_OVER",
  /** Survived the full match, or cleared every queued wave. */
  Victory: "VICTORY",
} as const;
export type MatchStatus = (typeof MatchStatus)[keyof typeof MatchStatus];

/** True once the match has resolved and the simulation has stopped. */
export function isMatchOver(status: MatchStatus): boolean {
  return status === MatchStatus.GameOver || status === MatchStatus.Victory;
}

/** Power-ups dropped by destroyed enemies. */
export const BoonType = {
  /** Destroys every enemy currently on the field. */
  Bomb: "bomb",
  /** Permanently speeds up the collecting player's shells. */
  Star: "star",
  /** Freezes every enemy for a few seconds. */
  Stopwatch: "stopwatch",
  /** Turns the eagle's brick bunker to steel for a while. */
  Shovel: "shovel",
} as const;
export type BoonType = (typeof BoonType)[keyof typeof BoonType];

/** Payload broadcast when a player picks a boon up. */
export interface BoonCollectedMessage {
  type: BoonType;
  /** Session id of the player who took it. */
  playerId: string;
  /** Where it was collected, in world units, for spawning an effect. */
  x: number;
  y: number;
}

/**
 * Direction names used on the wire.
 *
 * Deliberately strings rather than the numeric {@link Direction}: the payload
 * stays readable in devtools, and a bad value is easy to reject.
 */
export const MoveDirection = {
  Up: "up",
  Right: "right",
  Down: "down",
  Left: "left",
} as const;
export type MoveDirection = (typeof MoveDirection)[keyof typeof MoveDirection];

/** Payload of a {@link ClientMessage.Move} message. */
export interface MoveMessage {
  dir: MoveDirection;
}

/** Wire direction name -> replicated facing. */
export const MOVE_DIRECTION_TO_FACING: Record<MoveDirection, Direction> = {
  [MoveDirection.Up]: Direction.Up,
  [MoveDirection.Right]: Direction.Right,
  [MoveDirection.Down]: Direction.Down,
  [MoveDirection.Left]: Direction.Left,
};

/**
 * Narrows an untrusted client payload to a {@link MoveMessage}.
 *
 * Anything arriving over the socket is attacker-controlled, so the server must
 * validate rather than trust the declared type.
 */
export function isMoveMessage(value: unknown): value is MoveMessage {
  if (typeof value !== "object" || value === null) return false;

  const dir: unknown = (value as { dir?: unknown }).dir;
  return (
    dir === MoveDirection.Up ||
    dir === MoveDirection.Right ||
    dir === MoveDirection.Down ||
    dir === MoveDirection.Left
  );
}

export interface Vector2 {
  x: number;
  y: number;
}
