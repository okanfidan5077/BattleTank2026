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
} as const;
export type ServerMessage = (typeof ServerMessage)[keyof typeof ServerMessage];

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
