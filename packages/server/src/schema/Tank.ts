import { type } from "@colyseus/schema";

import { Direction, EntityType } from "@battletank/shared";

import { Entity, type EntityInit } from "./Entity.js";

/** Initial values accepted by {@link Tank}. */
export interface TankInit extends EntityInit {
  /** Session id of the controlling client, or the AI id for enemy tanks. */
  ownerId: string;
  /** Hit points this tank starts with, and its ceiling. */
  maxHealth: number;
  /** Hit points remaining; defaults to maxHealth when omitted. */
  currentHealth?: number;
  /** Movement speed, in pixels per tick. */
  speed: number;
  direction: Direction;
  isEnemy: boolean;
  /** Respawn grace; defaults to false. */
  isInvulnerable?: boolean;
}

/** A player- or AI-controlled tank. */
export class Tank extends Entity<TankInit> {
  @type("string") ownerId: string = "";

  @type("uint8") maxHealth: number = 1;

  @type("uint8") currentHealth: number = 1;

  @type("float32") speed: number = 0;

  @type("uint8") direction: Direction = Direction.Up;

  @type("boolean") isEnemy: boolean = false;

  /** Respawn grace period: shells pass harmlessly through while true. */
  @type("boolean") isInvulnerable: boolean = false;

  constructor(init?: TankInit) {
    super();
    if (init) Object.assign(this, init);
    // A tank arrives at full strength unless told otherwise.
    if (init && init.currentHealth === undefined) this.currentHealth = this.maxHealth;
    this.type = EntityType.Tank;
  }
}
