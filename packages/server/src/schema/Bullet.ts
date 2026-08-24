import { type } from "@colyseus/schema";

import { Direction, EntityType } from "@battletank/shared";

import { Entity, type EntityInit } from "./Entity.js";

/** Initial values accepted by {@link Bullet}. */
export interface BulletInit extends EntityInit {
  /** Session id of the tank that fired this bullet. */
  ownerId: string;
  damage: number;
  direction: Direction;
  /** Travel speed, in pixels per tick. */
  speed: number;
  /** Copied from the firing tank, so a shell knows which side it is on. */
  isEnemy: boolean;
  /** Set for tier 4 players; defaults to false. */
  piercesSteel?: boolean;
}

/** A projectile in flight. */
export class Bullet extends Entity<BulletInit> {
  @type("string") ownerId: string = "";

  @type("uint8") damage: number = 0;

  @type("uint8") direction: Direction = Direction.Up;

  @type("float32") speed: number = 0;

  /**
   * Whose side fired this shell.
   *
   * Carried on the bullet rather than looked up from the owner tank, because
   * the owner may already be destroyed when the shell lands.
   */
  @type("boolean") isEnemy: boolean = false;

  /** Tier 4 shells cut through steel instead of stopping at it. */
  @type("boolean") piercesSteel: boolean = false;

  constructor(init?: BulletInit) {
    super();
    if (init) Object.assign(this, init);
    this.type = EntityType.Bullet;
  }
}
