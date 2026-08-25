import { Schema, type } from "@colyseus/schema";

import { DEFAULT_PLAYER_COLOR } from "@battletank/shared";

import { PLAYER_STARTING_LIVES } from "../gameplay.js";

/** Initial values accepted by {@link Player}. */
export interface PlayerInit {
  sessionId: string;
  name?: string;
  color?: number;
  lives?: number;
  tier?: number;
}

/**
 * A connected player's persistent record.
 *
 * Deliberately separate from the {@link Tank} entity: a tank is removed from the
 * state the moment it is destroyed, so lives and star tier would vanish with it.
 * This survives death, holds the respawn countdown, and is what marks someone a
 * spectator once they run out.
 */
export class Player extends Schema<PlayerInit> {
  @type("string") sessionId: string = "";

  /** Display name, already sanitised by the server. */
  @type("string") name: string = "";

  /** 24-bit hex colour used to tint this player’s tank. */
  @type("uint32") color: number = DEFAULT_PLAYER_COLOR;

  /** False while we are holding their seat open for a reconnect. */
  @type("boolean") isConnected: boolean = true;

  /** Star tier, 1..{@link MAX_PLAYER_TIER}. Each star boon advances it. */
  @type("uint8") tier: number = 1;

  @type("uint8") lives: number = PLAYER_STARTING_LIVES;

  /** Out of lives: no longer respawns, watches the rest of the match. */
  @type("boolean") isSpectator: boolean = false;

  /** Seconds until this player returns; 0 when they are already on the field. */
  @type("uint8") respawnInSeconds: number = 0;

  /** Enemy tanks this player landed the killing blow on, for the scoreboard. */
  @type("uint16") enemiesDestroyed: number = 0;

  /** Times this player has fired, for the scoreboard. */
  @type("uint16") shotsFired: number = 0;

  constructor(init?: PlayerInit) {
    // Field initializers run during super(), so init is applied afterwards.
    super();
    if (init) Object.assign(this, init);
  }
}
