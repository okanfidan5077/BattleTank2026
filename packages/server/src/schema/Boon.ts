import { Schema, type } from "@colyseus/schema";

import { BoonType, TILE_SIZE } from "@battletank/shared";

/** Initial values accepted by {@link Boon}. */
export interface BoonInit {
  /** World-space position of the pickup's top-left corner, in pixels. */
  x: number;
  y: number;
  type: BoonType;
  /** Pickup box, in pixels. Defaults to one tile. */
  width?: number;
  height?: number;
}

/**
 * A power-up lying on the battlefield, waiting to be driven over.
 *
 * `type` is replicated as a string rather than a numeric enum so the payload
 * stays readable on the wire and the client can branch on it directly. There
 * are only ever a handful of these on the map, so the extra bytes are free.
 */
export class Boon extends Schema<BoonInit> {
  @type("float32") x: number = 0;
  @type("float32") y: number = 0;

  @type("uint16") width: number = TILE_SIZE;
  @type("uint16") height: number = TILE_SIZE;

  @type("string") type: BoonType = BoonType.Bomb;

  constructor(init?: BoonInit) {
    // Field initializers run during super(), so init is applied afterwards.
    super();
    if (init) Object.assign(this, init);
  }
}
