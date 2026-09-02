/** Constants shared by the Colyseus server and the Phaser client. */

/** Bumped whenever the client/server message contract changes. */
export const PROTOCOL_VERSION = 1;

/** Room identifier registered on the server and joined by the client. */
export const BATTLE_ROOM = "battle_room";

/** Room identifier for the single-player campaign. */
export const CAMPAIGN_ROOM = "campaign_room";

/** Authoritative simulation rate, in ticks per second. */
export const TICK_RATE = 20;

/** Length of a single simulation step, in milliseconds. */
export const TICK_MS = 1000 / TICK_RATE;

/**
 * Minimum gap between a player’s shots, in milliseconds.
 *
 * Lives in shared because the client throttles its own input to match; the
 * server still enforces it independently and remains the authority.
 */
export const PLAYER_SHOOT_COOLDOWN_MS = 400;

/** Minimum gap between enemy shots, in milliseconds. Still slower than players. */
export const ENEMY_SHOOT_COOLDOWN_MS = 840;

/** A match is won by surviving this long. */
export const MATCH_DURATION_MS = 10 * 60 * 1000;

/** Battlefield size, in tiles. */
export const GRID_WIDTH = 60;
export const GRID_HEIGHT = 33;

/** Number of cells in the flattened (1D) map grid. */
export const GRID_LENGTH = GRID_WIDTH * GRID_HEIGHT;

/** Edge length of one tile, in world units (pixels). */
export const TILE_SIZE = 32;

/** Battlefield size, in world units (pixels). */
export const WORLD_WIDTH = GRID_WIDTH * TILE_SIZE;
export const WORLD_HEIGHT = GRID_HEIGHT * TILE_SIZE;

/**
 * Top rows reserved for the enemy spawn lane, off-limits to player tanks.
 *
 * Enemies still enter along row 0 and drive down; player hulls may not cross
 * above {@link PLAYER_TOP_BOUNDARY_Y}, which stops them from spawn-camping the
 * enemy queue. Player *shells* are unaffected — only the tank body is fenced
 * out. The server enforces this; the client draws a hazard marker at the same
 * line so both agree on exactly where the wall is.
 */
export const PLAYER_TOP_BOUNDARY_ROWS = 2;
export const PLAYER_TOP_BOUNDARY_Y = PLAYER_TOP_BOUNDARY_ROWS * TILE_SIZE;

/**
 * Contents of a single map cell.
 *
 * Values are encoded as `uint8` in `GameState.grid`, so they must stay within
 * 0-255 and must never be renumbered without bumping {@link PROTOCOL_VERSION}.
 */
export enum TileType {
  Empty = 0,
  Brick = 1,
  Steel = 2,
  Water = 3,
  EagleBase = 4,
  /**
   * Campaign jamming tower. Behaves like {@link TileType.Brick}: solid to tanks
   * and destructible by any shell. Given a fresh value rather than reusing 4 so
   * the existing {@link EagleBase} encoding — and {@link PROTOCOL_VERSION} — is
   * left untouched. Only the campaign generates these; battle maps never do.
   */
  Radar = 5,
  /**
   * Campaign extraction pad. Passable ground with no physics — tanks drive over
   * it and shells fly across it — but the server watches for the player's hull
   * overlapping one to resolve a `reach_extraction` objective.
   */
  ExtractionZone = 6,
  /**
   * Campaign uplink zone. Passable like {@link ExtractionZone}, but the server
   * counts how long the player's hull holds inside it for a `zone_control`
   * objective rather than resolving on first touch.
   */
  UplinkZone = 7,
  /**
   * Campaign factory structure. Behaves like {@link TileType.Brick} — solid to
   * tanks and destructible by any shell — but is the objective of a
   * `destroy_factories` level and the anchor enemies spawn around.
   */
  Factory = 8,
  /**
   * Campaign dirty bomb. Passable ground with no physics, like
   * {@link ExtractionZone} — the server defuses it (turns it Empty) when the
   * player's hull touches it, for a `defuse_bombs` level.
   */
  Bomb = 9,
  /**
   * Campaign intel package. Passable; the server collects it (turns it Empty)
   * when the player's hull touches it, for a `retrieve_intel` level.
   */
  Intel = 10,
  /**
   * Campaign mine, dropped by Trapper enemies. Passable, but touching it kills
   * the player and clears the tile.
   */
  Mine = 11,
}

/**
 * Facing of a tank or a bullet.
 *
 * Ordered clockwise from up, so `(direction + 1) % 4` rotates right.
 */
export enum Direction {
  Up = 0,
  Right = 1,
  Down = 2,
  Left = 3,
}

/** Discriminator carried by every entity, so clients can branch on kind. */
export enum EntityType {
  Tank = 0,
  Bullet = 1,
}
