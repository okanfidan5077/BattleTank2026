import type { ArraySchema, MapSchema } from "@colyseus/schema";

import type { BoonType, Direction, EntityType, MatchStatus } from "@battletank/shared";

/**
 * Read-only view of the server's replicated state.
 *
 * The Colyseus schema *classes* live in `@battletank/server`, which the browser
 * bundle must not import. At runtime colyseus.js rebuilds the state from the
 * reflection handshake, so these interfaces exist purely to type what comes
 * back. They must mirror `packages/server/src/schema/` — if a field is added
 * there, add it here too.
 */

export interface EntityView {
  x: number;
  y: number;
  width: number;
  height: number;
  type: EntityType;
}

export interface TankView extends EntityView {
  ownerId: string;
  maxHealth: number;
  currentHealth: number;
  speed: number;
  direction: Direction;
  isEnemy: boolean;
  /** Respawn grace period; the client flashes a shield while true. */
  isInvulnerable: boolean;
}

export interface BulletView extends EntityView {
  ownerId: string;
  damage: number;
  direction: Direction;
  speed: number;
  isEnemy: boolean;
  piercesSteel: boolean;
}

export interface BoonView {
  x: number;
  y: number;
  width: number;
  height: number;
  type: BoonType;
}

/** A connected player, outliving their tank. */
export interface PlayerView {
  sessionId: string;
  name: string;
  /** 24-bit hex colour used to tint this player tank. */
  color: number;
  /** False while the server is holding their seat open for a reconnect. */
  isConnected: boolean;
  tier: number;
  lives: number;
  isSpectator: boolean;
  respawnInSeconds: number;
  /** Enemy tanks this player landed the killing blow on. */
  enemiesDestroyed: number;
  /** Times this player has fired. */
  shotsFired: number;
}

export interface BattleStateView {
  matchState: MatchStatus;
  /** Session id of the player allowed to start the match. */
  hostId: string;
  /** Seconds since the match began. */
  elapsedSeconds: number;
  /** Seconds survived, frozen at the moment the match resolved. */
  finalTime: number;
  /** Enemies still waiting in the spawn queue. */
  enemiesQueued: number;
  players: MapSchema<PlayerView>;
  tanks: ArraySchema<TankView>;
  bullets: ArraySchema<BulletView>;
  boons: ArraySchema<BoonView>;
  grid: ArraySchema<number>;
}
