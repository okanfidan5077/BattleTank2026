import { Schema, type } from "@colyseus/schema";

import type { Vector2 as Vector2Like } from "@battletank/shared";

/** Initial values accepted by {@link Vector2}. */
export interface Vector2Init {
  x: number;
  y: number;
}

/**
 * A replicated 2D point, in world units (pixels).
 *
 * Implements the plain `Vector2` shape from `@battletank/shared`, so shared
 * math helpers accept it directly.
 */
export class Vector2 extends Schema<Vector2Init> implements Vector2Like {
  @type("float32") x: number = 0;
  @type("float32") y: number = 0;

  constructor(init?: Vector2Init) {
    // Field initializers above run during super(), so they would clobber
    // anything Schema's own constructor assigned. Apply `init` afterwards.
    super();
    if (init) Object.assign(this, init);
  }
}
