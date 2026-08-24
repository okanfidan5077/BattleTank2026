import { Schema, type } from "@colyseus/schema";

import { EntityType, TILE_SIZE } from "@battletank/shared";

/** Initial values accepted by every {@link Entity} subclass. */
export interface EntityInit {
  /** World-space position of the entity's top-left corner, in pixels. */
  x: number;
  y: number;
  /** Axis-aligned bounding box, in pixels. Defaults to one tile. */
  width?: number;
  height?: number;
}

/**
 * Base class for everything that occupies space on the battlefield.
 *
 * `type` is a discriminator written by each subclass constructor; it is never
 * taken from the init object, so a caller cannot mislabel an entity.
 *
 * Subclasses must apply their init object *after* calling `super()` — see
 * {@link Tank} — because field initializers run during the super() call.
 *
 * @typeParam C - init object accepted by the concrete subclass.
 */
export abstract class Entity<C = EntityInit> extends Schema<C> {
  @type("float32") x: number = 0;
  @type("float32") y: number = 0;

  @type("uint16") width: number = TILE_SIZE;
  @type("uint16") height: number = TILE_SIZE;

  @type("uint8") type: EntityType = EntityType.Tank;
}
