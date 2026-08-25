import { GRID_HEIGHT, GRID_LENGTH, GRID_WIDTH, TileType } from "@battletank/shared";

import { isInsideGrid, tileIndex } from "../schema/index.js";

/** Tile coordinates of the eagle: bottom row, horizontal centre. */
export const EAGLE_TILE_X = Math.floor(GRID_WIDTH / 2);
export const EAGLE_TILE_Y = GRID_HEIGHT - 1;

/**
 * The eagle's bunker: its in-bounds neighbouring tiles.
 *
 * These are the brick tiles `createBattlefield` rings the eagle with. Because
 * the eagle sits on the bottom row, the three cells "below" it fall off the map
 * and are excluded — so this is the row above plus the two flanks, five tiles in
 * all. Filtering through {@link isInsideGrid} keeps every entry a real cell.
 */
export const EAGLE_BUNKER_TILES: readonly Readonly<{ x: number; y: number }>[] = (() => {
  const tiles: { x: number; y: number }[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;

      const x = EAGLE_TILE_X + dx;
      const y = EAGLE_TILE_Y + dy;
      if (isInsideGrid(x, y)) tiles.push({ x, y });
    }
  }
  return tiles;
})();

/** Mirrors a column about the map's vertical axis. */
const mirrorX = (x: number): number => GRID_WIDTH - 1 - x;

/**
 * Tile coordinates where players spawn, in join order — one per player, up to
 * the ten a full room holds.
 *
 * Given as mirrored pairs so the ground cleared around them stays symmetrical.
 * (The axis runs between columns 29 and 30, so these are not centred on the
 * eagle's own column.) They march outward from the centre in steps of four
 * columns along the bottom row, straddling — but never touching — the eagle's
 * bunker in the middle. `createBattlefield` clears {@link SPAWN_CLEAR_RADIUS}
 * around every one of these, so none can ever open inside a wall.
 */
export const SPAWN_TILES: readonly Readonly<{ x: number; y: number }>[] = [
  { x: 22, y: GRID_HEIGHT - 1 },
  { x: mirrorX(22), y: GRID_HEIGHT - 1 },
  { x: 18, y: GRID_HEIGHT - 1 },
  { x: mirrorX(18), y: GRID_HEIGHT - 1 },
  { x: 14, y: GRID_HEIGHT - 1 },
  { x: mirrorX(14), y: GRID_HEIGHT - 1 },
  { x: 10, y: GRID_HEIGHT - 1 },
  { x: mirrorX(10), y: GRID_HEIGHT - 1 },
  { x: 6, y: GRID_HEIGHT - 1 },
  { x: mirrorX(6), y: GRID_HEIGHT - 1 },
];

/** Tile coordinates where enemies enter the map, along the top edge. */
export const ENEMY_SPAWN_TILES: readonly Readonly<{ x: number; y: number }>[] = [
  { x: 1, y: 0 },
  { x: Math.floor(GRID_WIDTH / 2), y: 0 },
  { x: GRID_WIDTH - 2, y: 0 },
];

//
// Layout lattice
// --------------
// The map is tiled with 6x6 modules: a 3x3 wall block in one corner, and a
// 3-tile corridor along the other two edges. Because every block is an island
// ringed by corridor, the corridor network is a fully connected grid no matter
// what a block contains — which is what lets steel be placed freely without
// ever sealing a region off.
//
const MODULE_SIZE = 6;
const BLOCK_SIZE = 3;

/** Guaranteed width of every through-corridor, in tiles. */
export const CORRIDOR_WIDTH = MODULE_SIZE - BLOCK_SIZE;

/** Rows kept clear at the top of the map for the enemy spawn zone. */
export const TOP_SAFE_ROWS = 3;

/** Chebyshev radius kept clear around each player spawn. */
export const SPAWN_CLEAR_RADIUS = 3;

/** Chebyshev radius cleared around the eagle before its bunker is drawn. */
export const EAGLE_CLEAR_RADIUS = 3;

/** Share of wall blocks built from steel rather than brick. */
const STEEL_SHARE = 0.28;

/** Chance a corridor crossing is plugged with a brick gate. */
const GATE_CHANCE = 0.3;

/**
 * 3x3 block shapes. `#` is wall, `.` is open.
 *
 * Every shape's open cells touch the surrounding corridor — no shape encloses
 * a pocket, which would strand an unreachable tile inside a steel block.
 */
const BLOCK_SHAPES: readonly (readonly string[])[] = [
  ["###", "###", "###"],
  ["###", "###", "###"],
  ["##.", "##.", "..."],
  ["###", "###", "..."],
  ["##.", "##.", "##."],
  ["...", "###", "..."],
];

/** Small deterministic PRNG, so a seed always yields the same map. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clearArea(grid: number[], cx: number, cy: number, radius: number): void {
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (isInsideGrid(x, y)) grid[tileIndex(x, y)] = TileType.Empty;
    }
  }
}

/** Paints the maze into the left half only; the caller mirrors it. */
function paintLeftHalf(grid: number[], random: () => number): void {
  const halfWidth = GRID_WIDTH / 2;

  for (let blockY = 0; blockY * MODULE_SIZE < GRID_HEIGHT; blockY++) {
    for (let blockX = 0; blockX * MODULE_SIZE < halfWidth; blockX++) {
      const originX = blockX * MODULE_SIZE;
      const originY = blockY * MODULE_SIZE;

      const shape = BLOCK_SHAPES[Math.floor(random() * BLOCK_SHAPES.length)]!;
      const material = random() < STEEL_SHARE ? TileType.Steel : TileType.Brick;

      for (let dy = 0; dy < BLOCK_SIZE; dy++) {
        for (let dx = 0; dx < BLOCK_SIZE; dx++) {
          if (shape[dy]![dx] !== "#") continue;

          const x = originX + dx;
          const y = originY + dy;
          if (x >= halfWidth || !isInsideGrid(x, y)) continue;

          grid[tileIndex(x, y)] = material;
        }
      }

      // Plug the crossing beyond this block with brick, never steel: brick is
      // shootable and the flow field can still route through it, so a gate can
      // never strand anyone.
      if (random() < GATE_CHANCE) {
        for (let dy = 0; dy < CORRIDOR_WIDTH; dy++) {
          for (let dx = 0; dx < CORRIDOR_WIDTH; dx++) {
            const x = originX + BLOCK_SIZE + dx;
            const y = originY + BLOCK_SIZE + dy;
            if (x >= halfWidth || !isInsideGrid(x, y)) continue;

            grid[tileIndex(x, y)] = TileType.Brick;
          }
        }
      }
    }
  }
}

/**
 * Builds a fresh battlefield.
 *
 * A left-right symmetrical maze of brick and steel, with the top rows left open
 * as the enemy spawn zone, clear ground around every player spawn, and the
 * eagle in its brick bunker at the bottom centre. Steel only ever appears
 * inside corridor-ringed blocks, so it can never seal off part of the map.
 *
 * @param seed - fixed seed for a reproducible map; random when omitted.
 * @returns the grid, row-major, ready to copy into `GameState.grid`.
 */
export function createBattlefield(seed?: number): number[] {
  const grid = new Array<number>(GRID_LENGTH).fill(TileType.Empty);
  const random = mulberry32(seed ?? (Math.random() * 0xffffffff) >>> 0);

  paintLeftHalf(grid, random);

  // Mirror about the vertical axis for a symmetrical arena.
  for (let y = 0; y < GRID_HEIGHT; y++) {
    for (let x = 0; x < GRID_WIDTH / 2; x++) {
      grid[tileIndex(GRID_WIDTH - 1 - x, y)] = grid[tileIndex(x, y)]!;
    }
  }

  // Enemy spawn zone across the top.
  for (let y = 0; y < TOP_SAFE_ROWS; y++) {
    for (let x = 0; x < GRID_WIDTH; x++) {
      grid[tileIndex(x, y)] = TileType.Empty;
    }
  }

  // Breathing room around every player spawn.
  for (const spawn of SPAWN_TILES) {
    clearArea(grid, spawn.x, spawn.y, SPAWN_CLEAR_RADIUS);
  }

  // Open ground around the bunker so it can actually be approached. Cleared
  // about the eagle *and* its mirror column, so the approach stays symmetrical
  // even though the eagle itself sits one side of the axis.
  clearArea(grid, EAGLE_TILE_X, EAGLE_TILE_Y, EAGLE_CLEAR_RADIUS);
  clearArea(grid, mirrorX(EAGLE_TILE_X), EAGLE_TILE_Y, EAGLE_CLEAR_RADIUS);

  // ...then the bunker itself, drawn last so nothing can overwrite it.
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;

      const x = EAGLE_TILE_X + dx;
      const y = EAGLE_TILE_Y + dy;
      if (!isInsideGrid(x, y)) continue;

      grid[tileIndex(x, y)] = TileType.Brick;
    }
  }

  grid[tileIndex(EAGLE_TILE_X, EAGLE_TILE_Y)] = TileType.EagleBase;

  return grid;
}
