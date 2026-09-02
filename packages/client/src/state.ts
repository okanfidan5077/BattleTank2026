import type { ArraySchema, MapSchema } from "@colyseus/schema";

import type {
  BoonType,
  CampaignPhase,
  Direction,
  EntityType,
  MatchStatus,
} from "@battletank/shared";

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
  /** Enemy flavour: "standard", "kamikaze" (red rushers), or "sweeper" (boss). */
  variant: string;
  /** True for a campaign boss — the client scales and tints it up. */
  isBoss: boolean;
  /** True for a Mimic still disguised as an item drop (gold, frozen facing). */
  isDisguised: boolean;
  /** True for a Ghost that is currently cloaked (near-invisible). */
  isCloaked: boolean;
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

/**
 * The battlefield collections both room modes replicate and render.
 *
 * Battle and campaign states share the same physics and the same renderer, so
 * the parts the client draws from — the map and every entity on it — live here
 * and both concrete views extend it.
 */
export interface WorldStateView {
  players: MapSchema<PlayerView>;
  tanks: ArraySchema<TankView>;
  bullets: ArraySchema<BulletView>;
  boons: ArraySchema<BoonView>;
  grid: ArraySchema<number>;
}

/**
 * Read-only view of the campaign room's replicated state.
 *
 * Mirrors `packages/server/src/schema/CampaignState.ts` (which extends the
 * battle `GameState`); keep the two in step.
 */
export interface CampaignStateView extends WorldStateView {
  /** 1-based index of the level being played. */
  currentLevel: number;
  lives: number;
  /** Where the playthrough is in its lifecycle. */
  phase: CampaignPhase;
  /** HUD objective line, e.g. "RADARS LEFT: 3" or "SURVIVE: 42s". */
  objectiveText: string;
  /** The objective's raw number (radars left, or seconds remaining). */
  objectiveValue: number;
}

export interface BattleStateView extends WorldStateView {
  matchState: MatchStatus;
  /** Session id of the player allowed to start the match. */
  hostId: string;
  /** Seconds since the match began. */
  elapsedSeconds: number;
  /** Seconds survived, frozen at the moment the match resolved. */
  finalTime: number;
  /** Enemies still waiting in the spawn queue. */
  enemiesQueued: number;
}
