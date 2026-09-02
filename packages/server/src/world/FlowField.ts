import { GRID_HEIGHT, GRID_LENGTH, GRID_WIDTH, TileType, type Direction } from "@battletank/shared";

import { FLOW_FIELD_BRICK_COST } from "../gameplay.js";
import { isInsideGrid, tileIndex } from "../schema/index.js";

/** How far outside a sealed bunker the fallback search seeds from. */
const APPROACH_RADIUS = 3;

/** Marks a cell from which the eagle cannot be reached at all. */
export const NO_DIRECTION = -1;

/** Neighbour offsets, in {@link Direction} order (Up, Right, Down, Left). */
const NEIGHBOURS: readonly (readonly [dx: number, dy: number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/**
 * Cost of stepping *into* a tile.
 *
 * Steel and water are walls a tank can never cross. Brick is deliberately
 * traversable but expensive: `createBattlefield()` walls the eagle in on every
 * side, so treating brick as impassable would leave the eagle unreachable and
 * the entire field undefined. A high finite cost makes the field prefer open
 * ground, and fall back to routing through a wall the enemy can shoot away.
 *
 * Set {@link FLOW_FIELD_BRICK_COST} to `Infinity` for strict "brick is a wall"
 * behaviour — but see the note above about the eagle's own wall.
 */
function entryCost(tile: number): number {
  switch (tile) {
    case TileType.Steel:
    case TileType.Water:
    // A radar tower is a solid obstacle enemies must route around, not shoot
    // through — only the player's shells clear it.
    case TileType.Radar:
      return Infinity;
    case TileType.Brick:
    // A factory is a solid, shootable structure like brick — routable but dear.
    case TileType.Factory:
      return FLOW_FIELD_BRICK_COST;
    default:
      return 1;
  }
}

/** Minimal binary min-heap over (cell, cost) pairs. */
class MinHeap {
  private readonly cells: number[] = [];
  private readonly costs: number[] = [];

  get size(): number {
    return this.cells.length;
  }

  push(cell: number, cost: number): void {
    this.cells.push(cell);
    this.costs.push(cost);

    let i = this.cells.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.costs[parent]! <= this.costs[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.cells[0]!;
    const lastCell = this.cells.pop()!;
    const lastCost = this.costs.pop()!;

    if (this.cells.length > 0) {
      this.cells[0] = lastCell;
      this.costs[0] = lastCost;

      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;

        if (left < this.cells.length && this.costs[left]! < this.costs[smallest]!) smallest = left;
        if (right < this.cells.length && this.costs[right]! < this.costs[smallest]!) smallest = right;
        if (smallest === i) break;

        this.swap(i, smallest);
        i = smallest;
      }
    }

    return top;
  }

  private swap(a: number, b: number): void {
    [this.cells[a], this.cells[b]] = [this.cells[b]!, this.cells[a]!];
    [this.costs[a], this.costs[b]] = [this.costs[b]!, this.costs[a]!];
  }
}

/**
 * A vector field over the battlefield, every cell pointing one step along the
 * cheapest route to the eagle.
 *
 * Built with Dijkstra rather than plain BFS because tiles have different costs
 * (see {@link entryCost}). Rebuilding is O(n log n) over 1980 cells — cheap, but
 * it still only runs when the map actually changes, i.e. when a brick is shot
 * away.
 */
export class FlowField {
  /** {@link Direction} to follow from each cell, or {@link NO_DIRECTION}. */
  private readonly directions = new Int8Array(GRID_LENGTH).fill(NO_DIRECTION);

  /** Cost of the cheapest route from each cell to the eagle. */
  private readonly costs = new Float64Array(GRID_LENGTH).fill(Infinity);

  private goal = -1;

  /** Recomputes the field from the current map. */
  rebuild(grid: { at(index: number): number }): void {
    this.goal = -1;

    // The eagle is the goal; find it rather than assuming where it sits.
    for (let index = 0; index < GRID_LENGTH; index++) {
      if (grid.at(index) === TileType.EagleBase) {
        this.goal = index;
        break;
      }
    }
    if (this.goal < 0) {
      this.directions.fill(NO_DIRECTION);
      this.costs.fill(Infinity);
      return;
    }

    this.search(grid, [[this.goal, 0]]);

    // A shovel can wall the eagle in steel, which makes it strictly
    // unreachable and would leave every enemy standing still across the whole
    // map. Fall back to converging on the bunker's outside instead.
    if (!this.isPopulated) {
      this.search(grid, this.approachSeeds(grid));
    }
  }

  /**
   * Recomputes the field to converge on a set of moving targets instead of the
   * eagle — used to hunt players.
   *
   * Multi-source Dijkstra means every cell ends up pointing at whichever source
   * is *cheapest to reach*, so a hunter automatically chases the nearest player
   * without anyone computing distances per enemy.
   */
  rebuildToward(
    grid: { at(index: number): number },
    targets: readonly Readonly<{ x: number; y: number }>[],
  ): void {
    this.goal = -1;

    const seeds: [number, number][] = [];
    for (const target of targets) {
      if (!isInsideGrid(target.x, target.y)) continue;
      seeds.push([tileIndex(target.x, target.y), 0]);
    }

    if (seeds.length === 0) {
      this.directions.fill(NO_DIRECTION);
      this.costs.fill(Infinity);
      return;
    }

    this.search(grid, seeds);
  }

  /** Seeds just outside a sealed bunker, weighted by distance to the eagle. */
  private approachSeeds(grid: { at(index: number): number }): [number, number][] {
    const goalX = this.goal % GRID_WIDTH;
    const goalY = Math.floor(this.goal / GRID_WIDTH);
    const seeds: [number, number][] = [];

    for (let dy = -APPROACH_RADIUS; dy <= APPROACH_RADIUS; dy++) {
      for (let dx = -APPROACH_RADIUS; dx <= APPROACH_RADIUS; dx++) {
        const x = goalX + dx;
        const y = goalY + dy;
        if (!isInsideGrid(x, y)) continue;

        const cell = tileIndex(x, y);
        if (!Number.isFinite(entryCost(grid.at(cell)))) continue;

        seeds.push([cell, Math.max(Math.abs(dx), Math.abs(dy))]);
      }
    }

    return seeds;
  }

  /** Dijkstra outward from every seed, then derive per-cell directions. */
  private search(grid: { at(index: number): number }, seeds: [number, number][]): void {
    this.directions.fill(NO_DIRECTION);
    this.costs.fill(Infinity);

    const frontier = new MinHeap();
    for (const [cell, cost] of seeds) {
      this.costs[cell] = cost;
      frontier.push(cell, cost);
    }

    while (frontier.size > 0) {
      const cell = frontier.pop();
      const cellCost = this.costs[cell]!;

      const x = cell % GRID_WIDTH;
      const y = Math.floor(cell / GRID_WIDTH);

      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx;
        const ny = y + dy;
        if (!isInsideGrid(nx, ny)) continue;

        const neighbour = tileIndex(nx, ny);
        const step = entryCost(grid.at(neighbour));
        if (!Number.isFinite(step)) continue;

        const candidate = cellCost + step;
        if (candidate < this.costs[neighbour]!) {
          this.costs[neighbour] = candidate;
          frontier.push(neighbour, candidate);
        }
      }
    }

    this.assignDirections(grid);
  }

  /** Points every reachable cell at its cheapest neighbour. */
  private assignDirections(grid: { at(index: number): number }): void {
    for (let cell = 0; cell < GRID_LENGTH; cell++) {
      if (cell === this.goal || !Number.isFinite(this.costs[cell]!)) continue;

      const x = cell % GRID_WIDTH;
      const y = Math.floor(cell / GRID_WIDTH);

      let best = NO_DIRECTION;
      let bestCost = this.costs[cell]!;

      for (let direction = 0; direction < NEIGHBOURS.length; direction++) {
        const [dx, dy] = NEIGHBOURS[direction]!;
        const nx = x + dx;
        const ny = y + dy;
        if (!isInsideGrid(nx, ny)) continue;

        const neighbour = tileIndex(nx, ny);
        if (!Number.isFinite(entryCost(grid.at(neighbour)))) continue;

        if (this.costs[neighbour]! < bestCost) {
          bestCost = this.costs[neighbour]!;
          best = direction;
        }
      }

      this.directions[cell] = best;
    }
  }

  /** Direction to follow from tile `(x, y)`, or `null` where none exists. */
  directionAt(x: number, y: number): Direction | null {
    if (!isInsideGrid(x, y)) return null;

    const direction = this.directions[tileIndex(x, y)]!;
    return direction === NO_DIRECTION ? null : (direction as Direction);
  }

  /** Route cost from tile `(x, y)` to the eagle; `Infinity` when unreachable. */
  costAt(x: number, y: number): number {
    if (!isInsideGrid(x, y)) return Infinity;
    return this.costs[tileIndex(x, y)]!;
  }

  /** True when at least one cell outside the goal has a direction. */
  get isPopulated(): boolean {
    return this.directions.some((direction) => direction !== NO_DIRECTION);
  }
}

/** Total number of cells, exported for tests. */
export const FLOW_FIELD_SIZE = GRID_WIDTH * GRID_HEIGHT;
