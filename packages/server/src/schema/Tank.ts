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
  /** Enemy behaviour flavour, e.g. "kamikaze"; defaults to "standard". */
  variant?: string;
  /** True for a campaign boss unit; defaults to false. */
  isBoss?: boolean;
  /** True for a Mimic still disguised as an item drop; defaults to false. */
  isDisguised?: boolean;
  /** True for a Ghost that is currently cloaked (near-invisible); defaults to false. */
  isCloaked?: boolean;
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

  /**
   * Enemy behaviour flavour. "standard" for players and ordinary enemies;
   * "kamikaze" for the fast rushers; "sweeper" for the Level 5 boss.
   */
  @type("string") variant: string = "standard";

  /** True for a campaign boss unit — the client scales and tints it up. */
  @type("boolean") isBoss: boolean = false;

  /**
   * A Level 13 Mimic that is still masquerading as an item drop: it holds
   * still, never fires and ignores the flow field until it springs. The client
   * tints a disguised Mimic gold and freezes its facing to sell the disguise.
   */
  @type("boolean") isDisguised: boolean = false;

  /**
   * A Ghost miniboss that is cloaked — the client renders it nearly invisible.
   * When the Ghost fires, the server uncloaks it for a brief window.
   */
  @type("boolean") isCloaked: boolean = false;

  constructor(init?: TankInit) {
    super();
    if (init) Object.assign(this, init);
    // A tank arrives at full strength unless told otherwise.
    if (init && init.currentHealth === undefined) this.currentHealth = this.maxHealth;
    this.type = EntityType.Tank;
  }
}
