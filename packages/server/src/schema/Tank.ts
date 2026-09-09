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
  /** True while the player's deflector shield is up; defaults to false. */
  isShielded?: boolean;
  /** The Bastion's currently unarmoured face; defaults to Up. */
  weakSide?: Direction;
  /** A live target on a purge level; defaults to false. */
  isMarked?: boolean;
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

  /**
   * The player's deflector shield is raised: shells, mines and blasts are turned
   * away. Deliberately *not* proof against a boss hull — see
   * `CampaignRoom.resolveSweeperContact`. The client rings a shielded tank.
   */
  @type("boolean") isShielded: boolean = false;

  /**
   * The one face of the Bastion that shells can get through, as a cardinal.
   *
   * Deliberately its own field rather than something derived from
   * {@link direction}: the Bastion keeps its gun pointed at the player, so an
   * armour scheme tied to facing put the weak face wherever the player was not
   * — which is the version that could not be beaten. This turns on its own
   * timer instead, and the client draws it so the opening is visible.
   *
   * Meaningless for every other tank.
   */
  @type("uint8") weakSide: Direction = Direction.Up;

  /**
   * A live target on a `purge_marked` level.
   *
   * Replicated because the whole level is the player being able to tell one
   * identical hull from another: the mark has to be on screen, and the server
   * is the only thing that knows which hulls carry it.
   */
  @type("boolean") isMarked: boolean = false;

  constructor(init?: TankInit) {
    super();
    if (init) Object.assign(this, init);
    // A tank arrives at full strength unless told otherwise.
    if (init && init.currentHealth === undefined) this.currentHealth = this.maxHealth;
    this.type = EntityType.Tank;
  }
}
