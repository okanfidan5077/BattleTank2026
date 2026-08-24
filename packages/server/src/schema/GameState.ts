import { ArraySchema, Encoder, MapSchema, Schema, type } from "@colyseus/schema";

import { GRID_HEIGHT, GRID_LENGTH, GRID_WIDTH, MatchStatus, TileType } from "@battletank/shared";

import { Boon } from "./Boon.js";
import { Player } from "./Player.js";
import { Bullet } from "./Bullet.js";
import { Tank } from "./Tank.js";

//
// A full encode of this state is dominated by the 1980-cell grid and runs to
// roughly 10 KB, which overflows Colyseus' 8 KB default encode buffer (it logs
// "buffer overflow" and truncates). Raise it before any room starts encoding.
//
Encoder.BUFFER_SIZE = 64 * 1024;

/** Replicated root state of a battle room. */
export class GameState extends Schema {
  /** Where the match is in its lifecycle. Starts in the staging lobby. */
  @type("string") matchState: MatchStatus = MatchStatus.Lobby;

  /** Session id of the player who may start the match. */
  @type("string") hostId: string = "";

  /** Seconds since the room was created; drives difficulty scaling. */
  @type("uint16") elapsedSeconds = 0;

  /**
   * Elapsed seconds frozen at the moment the match resolved.
   *
   * `elapsedSeconds` stops advancing once the simulation halts, but this pins
   * the final figure explicitly so the game-over screen can show how long the
   * run lasted. Zero until the match ends, and reset to zero on {@link ResetMatch}.
   */
  @type("uint16") finalTime = 0;

  /** Enemies still waiting in the spawn queue, for the HUD and victory check. */
  @type("uint16") enemiesQueued = 0;

  /** Connected players, keyed by sessionId. Outlives their tanks. */
  @type({ map: Player }) players = new MapSchema<Player>();

  @type([Tank]) tanks = new ArraySchema<Tank>();

  @type([Bullet]) bullets = new ArraySchema<Bullet>();

  /** Power-ups currently lying on the field. */
  @type([Boon]) boons = new ArraySchema<Boon>();

  /**
   * The map, flattened row-major into a single array of {@link TileType} values.
   *
   * Always exactly {@link GRID_LENGTH} (`GRID_WIDTH * GRID_HEIGHT`) entries;
   * the cell at tile coordinates `(x, y)` lives at index `y * GRID_WIDTH + x`.
   *
   * A flat array is used because Colyseus patches only the indices that
   * actually changed — which is what happens when a shell chews through a
   * brick wall.
   */
  @type(["uint8"]) grid = new ArraySchema<number>(
    ...new Array<number>(GRID_LENGTH).fill(TileType.Empty),
  );
}

/** Row-major index of tile `(x, y)` within {@link GameState.grid}. */
export function tileIndex(x: number, y: number): number {
  return y * GRID_WIDTH + x;
}

/** True when `(x, y)` is inside the battlefield bounds. */
export function isInsideGrid(x: number, y: number): boolean {
  return x >= 0 && x < GRID_WIDTH && y >= 0 && y < GRID_HEIGHT;
}
