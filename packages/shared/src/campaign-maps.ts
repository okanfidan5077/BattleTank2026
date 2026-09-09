/**
 * Map builders for the single-player campaign.
 *
 * One function per battlefield, named for what the place *is* rather than for
 * the level it happens to sit on: levels get renumbered as the campaign grows,
 * and a map called `buildBombFlats` becomes a lie the first time that happens.
 * The composition helpers below are exported too, so new maps can be assembled
 * from the same vocabulary rather than by hand-placing every tile.
 */

import { GRID_HEIGHT, GRID_LENGTH, GRID_WIDTH, TileType } from "./constants.js";

export const at = (x: number, y: number): number => y * GRID_WIDTH + x;

/** A fresh empty grid walled in by a steel perimeter — the base of every level. */
export function steelBordered(): number[] {
  const grid = new Array<number>(GRID_LENGTH).fill(TileType.Empty);

  for (let x = 0; x < GRID_WIDTH; x++) {
    grid[at(x, 0)] = TileType.Steel;
    grid[at(x, GRID_HEIGHT - 1)] = TileType.Steel;
  }
  for (let y = 0; y < GRID_HEIGHT; y++) {
    grid[at(0, y)] = TileType.Steel;
    grid[at(GRID_WIDTH - 1, y)] = TileType.Steel;
  }

  return grid;
}

/** Fills a rectangle (inclusive) with `tile`, clamped to the interior. */
export function fillRect(grid: number[], x1: number, y1: number, x2: number, y2: number, tile: TileType): void {
  for (let y = Math.max(1, y1); y <= Math.min(GRID_HEIGHT - 2, y2); y++) {
    for (let x = Math.max(1, x1); x <= Math.min(GRID_WIDTH - 2, x2); x++) grid[at(x, y)] = tile;
  }
}

/** Drops isolated square brick clusters as cover in otherwise open ground. */
export function coverClusters(grid: number[], spots: ReadonlyArray<readonly [number, number]>, size = 3): void {
  for (const [x, y] of spots) fillRect(grid, x, y, x + size - 1, y + size - 1, TileType.Brick);
}

/** Drops isolated square steel pillars — indestructible hard cover. */
export function steelPillars(grid: number[], spots: ReadonlyArray<readonly [number, number]>, size = 2): void {
  for (const [x, y] of spots) fillRect(grid, x, y, x + size - 1, y + size - 1, TileType.Steel);
}

/** Packs the whole interior (inside the steel border) with brick. */
export function fillInterior(grid: number[]): void {
  for (let y = 1; y < GRID_HEIGHT - 1; y++) {
    for (let x = 1; x < GRID_WIDTH - 1; x++) grid[at(x, y)] = TileType.Brick;
  }
}

/** Carves a 1-tile Empty corridor along row `y`, clamped to the interior. */
export function carveRow(grid: number[], y: number): void {
  for (let x = 1; x <= GRID_WIDTH - 2; x++) grid[at(x, y)] = TileType.Empty;
}

/** Carves a 1-tile Empty corridor along column `x`, clamped to the interior. */
export function carveCol(grid: number[], x: number): void {
  for (let y = 1; y <= GRID_HEIGHT - 2; y++) grid[at(x, y)] = TileType.Empty;
}

/**
 * Level 1: an open field with a jamming tower in each corner. Scattered brick
 * clusters give a little cover, but the corners are reached across open ground.
 */
export function buildJammingField(): number[] {
  const grid = steelBordered();

  coverClusters(grid, [
    [11, 7],
    [46, 7],
    [11, 23],
    [46, 23],
    [20, 15],
    [39, 15],
    [27, 25],
    // Denser mid-field cover.
    [18, 5],
    [39, 5],
    [18, 25],
    [42, 25],
    [26, 10],
    [33, 20],
  ]);

  // Hard steel pillars breaking the open lanes, clear of the spawns and towers.
  steelPillars(grid, [
    [14, 12],
    [44, 12],
    [14, 19],
    [44, 19],
    [29, 15],
    [29, 6],
    [29, 24],
  ]);

  const towers: Array<[number, number]> = [
    [2, 2],
    [GRID_WIDTH - 3, 2],
    [2, GRID_HEIGHT - 3],
    [GRID_WIDTH - 3, GRID_HEIGHT - 3],
  ];
  for (const [x, y] of towers) grid[at(x, y)] = TileType.Radar;

  return grid;
}

/**
 * Level 2: a fortified depot approach — three barricade lines north to the pad.
 *
 * The original was seven full-width walls whose gaps alternated hard left and
 * hard right, which made the level a long, safe commute. The rewrite that
 * replaced it swung too far the other way: wide open gaps plus six-tile brick
 * panels meant a way through was always within a few squares of wherever the
 * player happened to be, so no barricade ever actually stopped anyone.
 *
 * Now the lines are steel — nothing can be shot through the middle of one — and
 * the only ways north are narrow two-tile brick passages hard against the left
 * and right walls. Crossing is a commitment: drive to an edge, spend the time
 * breaking through, and fight in a corridor instead of in the open. The middle
 * line keeps small open gaps rather than brick, because the flanking enemy
 * spawn tiles (columns 6 and 53) stand on it and a brick laid over one would
 * wall that spawn off for the whole level.
 */
export function buildDepotApproach(): number[] {
  const grid = steelBordered();

  // Extraction pad: a 6-wide band across the top centre, just inside the wall.
  fillRect(grid, GRID_WIDTH / 2 - 3, 1, GRID_WIDTH / 2 + 2, 2, TileType.ExtractionZone);

  // Three barricade lines, each solid steel except for the marked spans.
  //
  // `brick` spans are the shootable ones: two tiles wide, pinned to the far
  // left and far right of the map, so breaking through is a real detour and a
  // real delay. `gaps` are simply left open, and are used only on the middle
  // line, whose ends have to stay passable for the enemy spawn tiles on them.
  //
  // Enemies still reach the player through the brick passages: the flow field
  // treats brick as traversable-but-expensive and they shoot their way in, so
  // walling the middle of a line off never strands the swarm behind it.
  const lines: Array<{ y: number; gaps: Array<[number, number]>; brick: Array<[number, number]> }> = [
    { y: 24, gaps: [], brick: [[3, 4], [55, 56]] },
    { y: 16, gaps: [[5, 7], [52, 54]], brick: [] },
    { y: 8, gaps: [], brick: [[3, 4], [55, 56]] },
  ];

  for (const { y, gaps, brick } of lines) {
    for (let x = 1; x < GRID_WIDTH - 1; x++) {
      if (gaps.some(([from, to]) => x >= from && x <= to)) continue;
      const soft = brick.some(([from, to]) => x >= from && x <= to);
      grid[at(x, y)] = soft ? TileType.Brick : TileType.Steel;
    }
  }

  // Cover in the bays between the lines, so the fights happen somewhere rather
  // than in an empty lane, and neither side has a clean shot down the middle.
  coverClusters(grid, [
    [8, 27],
    [30, 27],
    [50, 27],
    [7, 19],
    [24, 19],
    [52, 19],
    [20, 11],
    [46, 11],
    [30, 4],
  ], 2);

  steelPillars(grid, [
    [20, 27],
    [40, 19],
    [10, 11],
    [34, 11],
  ], 2);

  return grid;
}

/**
 * Level 3: an open survival arena. Brick pillars break sightlines and two water
 * hazards flank the centre, but there is plenty of room to keep circling.
 */
export function buildSurvivalArena(): number[] {
  const grid = steelBordered();

  coverClusters(grid, [
    [10, 7],
    [47, 7],
    [10, 23],
    [47, 23],
    [28, 14],
    // Denser cover to break the arena into a proper maze of firing lanes.
    [19, 6],
    [38, 6],
    [19, 24],
    [38, 24],
    [3, 12],
    [53, 12],
  ]);

  // Hard steel bastions the swarm cannot blast through.
  steelPillars(grid, [
    [15, 12],
    [43, 12],
    [15, 19],
    [43, 19],
    [29, 4],
    [29, 27],
  ]);

  fillRect(grid, 20, 15, 24, 18, TileType.Water);
  fillRect(grid, 35, 15, 39, 18, TileType.Water);

  return grid;
}

/**
 * Level 4: an open arena around a fortified uplink. Only the zone is ringed with
 * brick cover — broken at the four cardinal points — with a little loose cover
 * elsewhere; the rest is open ground.
 */
export function buildUplinkYard(): number[] {
  const grid = steelBordered();

  const cx = Math.floor(GRID_WIDTH / 2); // 30
  const cy = Math.floor(GRID_HEIGHT / 2); // 16

  // Brick pocket around the zone, open at the four cardinal points.
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const onRing = Math.max(Math.abs(dx), Math.abs(dy)) === 2;
      const inGap = dx === 0 || dy === 0;
      if (onRing && !inGap) grid[at(cx + dx, cy + dy)] = TileType.Brick;
    }
  }

  // The 3x3 uplink zone at the centre.
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) grid[at(cx + dx, cy + dy)] = TileType.UplinkZone;
  }

  // Denser loose cover out in the open, plus hard steel pillars — but the four
  // approaches to the zone (its cardinal gaps) are left clear.
  coverClusters(grid, [
    [10, 8],
    [47, 8],
    [10, 24],
    [47, 24],
    [19, 6],
    [39, 6],
    [19, 26],
    [39, 26],
  ], 2);

  steelPillars(grid, [
    [14, 14],
    [44, 14],
    [14, 18],
    [44, 18],
    [7, 15],
    [51, 15],
  ]);

  return grid;
}

/**
 * Level 5: an open boss arena with a handful of brick clusters for cover — which
 * the Sweeper happily ploughs through as it barrels around.
 */
export function buildOpenArena(): number[] {
  const grid = steelBordered();

  coverClusters(grid, [
    [12, 9],
    [45, 9],
    [12, 22],
    [45, 22],
    [28, 15],
    // More brick for the Sweeper to plough through as it barrels around.
    [20, 5],
    [37, 5],
    [20, 26],
    [37, 26],
    [4, 12],
    [51, 12],
  ]);

  // A handful of steel pillars the Sweeper rebounds off, keeping its path wild.
  steelPillars(grid, [
    [16, 15],
    [42, 15],
    [29, 9],
    [29, 22],
  ]);

  return grid;
}

/**
 * Level 6 (Act 2): a factory complex with four hardened assembly vaults, one in
 * each far corner so the run is a long circuit rather than a short sweep.
 *
 * Each vault is a steel shell the player cannot shoot through (steel only yields
 * to a tier-4 shell), broken by a single brick-plugged doorway. Behind the
 * doorway sits a second brick plug in line with the factory, so every vault
 * costs a shot to breach, an advance, another shot, and then the kill — and the
 * doorways face different directions, so each one has to be driven around and
 * found. The Constructor minibosses wall the open ground in as the fight runs on.
 */
export function buildFactoryComplex(): number[] {
  const grid = steelBordered();

  // Corner placement, far from the player spawn at (30, 31) and far from each
  // other, so no two vaults can be serviced from the same approach.
  // `door` is the cardinal the single entrance faces.
  const vaults: Array<{ x: number; y: number; door: [number, number] }> = [
    { x: 8, y: 6, door: [0, 1] },    // top-left, entrance on its south face
    { x: 51, y: 6, door: [-1, 0] },  // top-right, entrance on its west face
    { x: 8, y: 26, door: [1, 0] },   // bottom-left, entrance on its east face
    { x: 51, y: 26, door: [0, -1] }, // bottom-right, entrance on its north face
  ];

  for (const { x: fx, y: fy, door } of vaults) {
    const [dxDoor, dyDoor] = door;

    // Steel shell two tiles out — impenetrable to anything below tier 4.
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== 2) continue;
        grid[at(fx + dx, fy + dy)] = TileType.Steel;
      }
    }

    // The one way in: a brick plug in the shell, and a second plug behind it.
    // Both sit on the door axis, so the breach is a straight line to the target.
    grid[at(fx + dxDoor * 2, fy + dyDoor * 2)] = TileType.Brick;
    grid[at(fx + dxDoor, fy + dyDoor)] = TileType.Brick;

    grid[at(fx, fy)] = TileType.Factory;
  }

  // Loose cover across the middle ground the circuit has to cross, clear of the
  // player spawn and of the vault doorways.
  for (const [x, y] of [
    [20, 12],
    [39, 12],
    [20, 21],
    [39, 21],
    [30, 8],
    [30, 25],
    [14, 17],
    [45, 17],
  ] as Array<[number, number]>) {
    fillRect(grid, x, y, x + 1, y + 1, TileType.Brick);
  }

  // Hard steel pillars mid-map, forcing detours between the corners.
  steelPillars(grid, [
    [25, 16],
    [34, 16],
    [30, 12],
    [30, 21],
  ]);

  return grid;
}

/**
 * Level 7 (Bomb Defusal): an open field with three dirty bombs at far-apart
 * corners and scattered brick cover. The player sprints a circuit to touch all
 * three before the timer expires — while Constructors wall the ground shut.
 */
export function buildBombFlats(): number[] {
  const grid = steelBordered();

  coverClusters(grid, [
    [14, 8],
    [45, 8],
    [14, 22],
    [45, 22],
    [28, 15],
    [20, 26],
    [39, 5],
    // Denser cover along the defusal circuit.
    [24, 8],
    [35, 22],
    [8, 12],
    [49, 12],
  ]);

  // Hard steel pillars, kept off the direct lanes to the three bombs.
  steelPillars(grid, [
    [19, 12],
    [39, 18],
    [30, 10],
    [30, 24],
  ]);

  // Four bombs at distant corners, one more than the circuit used to ask for.
  for (const [x, y] of [
    [6, 30],
    [53, 30],
    [16, 2],
    [46, 2],
  ] as Array<[number, number]>) {
    grid[at(x, y)] = TileType.Bomb;
  }

  return grid;
}

/**
 * Level 8 (Intel Retrieval): a wide-open grid with eight intel packages spread
 * across the corners and edges, plus a little loose cover. The player must sweep
 * the whole map to collect them all while dodging the Trappers' mines.
 */
export function buildIntelSprawl(): number[] {
  const grid = steelBordered();

  // Twelve packages: the four corners, the midpoint of every edge, and four
  // more set in from them. Deliberately spread as widely as the map allows —
  // the level is a sweep, and with a sequence imposed on it the distance
  // between one package and the next is the whole difficulty.
  for (const [x, y] of [
    [3, 2],
    [56, 2],
    [3, 30],
    [56, 30],
    // Deliberately not (30, 2): that tile is an enemy release point, so a
    // package on it is permanently contested by a stream of fresh hulls. It
    // barely mattered while the sweep could be done in any order — you simply
    // came back to it — but with a sequence imposed, a package nobody can reach
    // is a level that cannot be finished.
    [30, 5],
    [30, 30],
    [3, 16],
    [56, 16],
    [16, 2],
    [43, 30],
    [16, 30],
    [43, 2],
  ] as Array<[number, number]>) {
    grid[at(x, y)] = TileType.Intel;
  }

  // Denser cover through the middle, plus hard steel bastions — the map edges
  // where the intel sits are left open so every package stays reachable.
  coverClusters(grid, [
    [16, 10],
    [43, 10],
    [16, 22],
    [43, 22],
    [28, 16],
    [24, 7],
    [34, 25],
    [10, 16],
    [49, 16],
  ], 2);

  steelPillars(grid, [
    [21, 14],
    [37, 14],
    [21, 18],
    [37, 18],
    [29, 11],
    [29, 21],
  ]);

  return grid;
}

/**
 * Level 9 (Escort): a vertical run to the extraction pad at the top centre. The
 * carrier's lane (column 30) is blocked by a stack of full-width brick walls the
 * player has to bulldoze open; the walls carry offset side gaps so the player can
 * still weave, but column 30 is always sealed until they blast it.
 */
export function buildEscortCanyon(): number[] {
  const grid = steelBordered();

  // Extraction pad: a band across the top centre.
  fillRect(grid, GRID_WIDTH / 2 - 3, 1, GRID_WIDTH / 2 + 2, 2, TileType.ExtractionZone);

  // Two-tile-tall brick walls across the whole width, with an offset gap on
  // alternating sides — never at the carrier's column (30), which the player
  // must bulldoze open. Denser now: more bands, closer together. Every wall is
  // brick (destructible) so the carrier's lane can always be cleared; steel is
  // added only as isolated pillars well clear of column 30.
  const walls: Array<{ y: number; gap: [number, number] }> = [
    { y: 27, gap: [2, 5] },
    { y: 23, gap: [54, 57] },
    { y: 19, gap: [2, 5] },
    { y: 15, gap: [54, 57] },
    { y: 11, gap: [2, 5] },
    { y: 7, gap: [54, 57] },
  ];
  for (const { y, gap } of walls) {
    for (let x = 1; x < GRID_WIDTH - 1; x++) {
      if (x >= gap[0] && x <= gap[1]) continue;
      grid[at(x, y)] = TileType.Brick;
      grid[at(x, y + 1)] = TileType.Brick;
    }
  }

  // Isolated steel pillars in the open bands — kept off column 30 so they never
  // seal the carrier's lane.
  steelPillars(grid, [
    [12, 13],
    [47, 21],
    [12, 25],
    [47, 9],
  ], 2);

  return grid;
}

/**
 * Level 10 (Artillery Boss): a strict serpentine climb toward a mobile Artillery
 * that skulks around the top gallery, fleeing the player and hiding behind cover
 * while it rains mortars. Full-width walls — indestructible steel up top, brick
 * lower down — each leave a single offset gap, so there is no straight shot up
 * from the spawn: the steel bands seal the player's line of sight to the boss and
 * force them to weave the whole maze to get an angle.
 */
export function buildSerpentineGallery(): number[] {
  const grid = steelBordered();

  // Steel cover in the Artillery's top gallery for it to weave behind — kept
  // clear of the boss's spawn (top centre) and the enemy spawn tiles.
  steelPillars(grid, [
    [12, 2],
    [20, 3],
    [39, 3],
    [47, 2],
  ]);

  // Two banks of cover rather than a seven-wall serpentine.
  //
  // The old layout sealed the boss behind full-width steel with gaps at the far
  // edges, so a boss that flees at half the player's speed could be chased the
  // length of the map for minutes without ever being cornered. These bands are
  // gapped in the middle as well as at the sides: they still break the line of
  // fire and give the artillery somewhere to hide, but the player can always
  // cut across and get an angle on it.
  const bands: Array<{ y: number; gaps: Array<[number, number]>; tile: TileType }> = [
    { y: 9, gaps: [[8, 12], [27, 33], [47, 51]], tile: TileType.Steel },
    { y: 18, gaps: [[4, 8], [22, 27], [38, 43], [54, 56]], tile: TileType.Brick },
    { y: 25, gaps: [[10, 15], [28, 32], [45, 50]], tile: TileType.Brick },
  ];
  for (const { y, gaps, tile } of bands) {
    for (let x = 1; x < GRID_WIDTH - 1; x++) {
      if (gaps.some(([from, to]) => x >= from && x <= to)) continue;
      grid[at(x, y)] = tile;
    }
  }

  // Loose cover in the open bays, to break the mortar's line on the player the
  // same way the bands break the player's line on the boss.
  coverClusters(grid, [
    [16, 12],
    [42, 12],
    [9, 21],
    [30, 21],
    [49, 21],
    [20, 28],
    [38, 28],
  ], 2);

  return grid;
}

/**
 * Level 11 (Act 3): a synthetic-steel labyrinth. Full-width, indestructible
 * steel walls with offset gaps force a tight serpentine climb to the extraction
 * pad, and coolant pools segment the open bands — the player has no choice but
 * to thread the chokepoints.
 */
export function buildCoolantLabyrinth(): number[] {
  const grid = steelBordered();

  // Extraction pad across the top centre.
  fillRect(grid, GRID_WIDTH / 2 - 3, 1, GRID_WIDTH / 2 + 2, 2, TileType.ExtractionZone);

  // Steel barrier walls with an offset gap each — the only way through. Denser
  // now: six bands, closer together, for a longer serpentine climb.
  const walls: Array<{ y: number; gap: [number, number] }> = [
    { y: 27, gap: [6, 10] },
    { y: 23, gap: [49, 53] },
    { y: 19, gap: [6, 10] },
    { y: 15, gap: [49, 53] },
    { y: 11, gap: [6, 10] },
    { y: 7, gap: [49, 53] },
  ];
  for (const { y, gap } of walls) {
    for (let x = 1; x < GRID_WIDTH - 1; x++) {
      if (x >= gap[0] && x <= gap[1]) continue;
      grid[at(x, y)] = TileType.Steel;
    }
  }

  // Coolant pools spread through the bands — impassable to tanks, but shells
  // cross them. Each is only two rows tall so a clear crossing row always
  // remains within its 3-row band, and all are kept off the chokepoint gaps.
  fillRect(grid, 27, 24, 32, 25, TileType.Water);
  fillRect(grid, 15, 12, 19, 13, TileType.Water);
  fillRect(grid, 40, 16, 44, 17, TileType.Water);
  fillRect(grid, 22, 8, 26, 9, TileType.Water);
  fillRect(grid, 33, 20, 37, 21, TileType.Water);

  return grid;
}

/**
 * Level 12 (Act 3): a wide-open arena carved into bands by coolant rivers.
 * Movement is funnelled across narrow land bridges, but shells fly over the
 * water freely, so fights happen across the basins as the player survives and
 * hunts the Jammers.
 */
export function buildCoolantBasins(): number[] {
  const grid = steelBordered();

  // Two full-width coolant rivers with offset land bridges, splitting the arena
  // into three connected bands.
  const rivers: Array<{ rows: [number, number]; bridges: Array<[number, number]> }> = [
    { rows: [11, 12], bridges: [[8, 11], [48, 51]] },
    { rows: [21, 22], bridges: [[26, 31]] },
  ];
  for (const { rows, bridges } of rivers) {
    for (let x = 1; x < GRID_WIDTH - 1; x++) {
      if (bridges.some(([a, b]) => x >= a && x <= b)) continue;
      grid[at(x, rows[0])] = TileType.Water;
      grid[at(x, rows[1])] = TileType.Water;
    }
  }

  // Brick and steel cover breaking up the three open bands, kept off the land
  // bridges and the spawns so movement is still funnelled but harder-fought.
  coverClusters(grid, [
    [14, 5],
    [43, 5],
    [22, 16],
    [37, 16],
    [14, 26],
    [43, 26],
  ], 2);

  // Centre-north is left open: the Bastion enters there, and a two-tile hull
  // that spawns half inside a pillar cannot move at all.
  steelPillars(grid, [
    [10, 17],
    [49, 17],
    [29, 27],
  ]);

  // Its entry band, cleared explicitly so it always has room to turn.
  fillRect(grid, 27, 4, 33, 9, TileType.Empty);

  return grid;
}

/**
 * Level 13 (Seek & Destroy): a scattered field of six radar towers, each sunk
 * in its own broken brick pocket, with loose cover strewn between them. The
 * player sweeps the map to level all six — but a quarter of the "item drops"
 * littering the ground are disguised Mimics waiting to spring.
 */
export function buildRadarScatter(): number[] {
  const grid = steelBordered();

  // Eight radar towers, each nested in a broken brick pocket (open at the four
  // cardinal points) so the player must push into cover to line up each shot.
  const towers: Array<[number, number]> = [
    [10, 7],
    [30, 9],
    [49, 7],
    [12, 25],
    [34, 25],
    [50, 24],
    // The two mid-field towers sit clear of the cover clusters laid down
    // below — this builder draws the towers first, so a cluster over one would
    // quietly delete it and the level would ask for a mast that is not there.
    [16, 16],
    [45, 16],
  ];
  for (const [rx, ry] of towers) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const onRing = Math.max(Math.abs(dx), Math.abs(dy)) === 2;
        const inGap = dx === 0 || dy === 0;
        if (onRing && !inGap) grid[at(rx + dx, ry + dy)] = TileType.Brick;
      }
    }
    grid[at(rx, ry)] = TileType.Radar;
  }

  // Denser cover in the open lanes between the pockets, plus hard steel pillars
  // — kept clear of the radars' firing approaches and the spawns.
  coverClusters(grid, [
    [20, 16],
    [39, 16],
    [28, 3],
    [20, 5],
    [39, 5],
    [20, 27],
    [39, 27],
    [6, 13],
    [53, 13],
  ], 2);

  steelPillars(grid, [
    [24, 12],
    [35, 12],
    [24, 19],
    [35, 19],
    [29, 16],
  ]);

  return grid;
}

/**
 * Level 14 (Bomb Defusal): a massive, incredibly dense brick maze — the whole
 * interior packed solid and cut only by a sparse corridor lattice — hiding three
 * dirty bombs in far-apart pockets. A Juggernaut siege unit ploughs through the
 * walls as it hunts, tearing the maze open behind it while the timer runs down.
 */
export function buildBunkerMaze(): number[] {
  const grid = steelBordered();
  fillInterior(grid);

  // Carve a sparse corridor lattice through the solid brick — just enough to
  // thread, so the fill still reads as a dense maze rather than a room.
  for (const y of [2, 9, 16, 23, 30]) carveRow(grid, y);
  for (const x of [4, 13, 22, 30, 38, 47, 55]) carveCol(grid, x);

  // A clear chamber at top centre for the Juggernaut to drop into, and one at
  // bottom centre around the player's spawn pad.
  fillRect(grid, 27, 2, 32, 5, TileType.Empty);
  fillRect(grid, 27, 29, 32, 31, TileType.Empty);

  // Four dirty bombs sunk into far-apart pockets of the maze.
  for (const [x, y] of [
    [4, 2],
    [55, 16],
    [13, 30],
    [46, 30],
  ] as Array<[number, number]>) {
    grid[at(x, y)] = TileType.Bomb;
  }

  return grid;
}

/**
 * Level 15 (Miniboss Gauntlet): a completely open steel-bordered box with zero
 * internal cover. A pure dodging arena — the player survives 120 seconds while
 * every miniboss type in the game rains down.
 */
export function buildEmptyBox(): number[] {
  return steelBordered();
}

/**
 * Level 16 (Security Relays): a dense, symmetrical labyrinth containing four
 * radar relay towers hidden in the corners. Ghost stealth units haunt the dark.
 */
export function buildRelayLabyrinth(): number[] {
  const grid = steelBordered();
  fillInterior(grid);

  // Carve wide 2-tile corridors so navigation is comfortable in the dark.
  for (const y of [2, 3, 8, 9, 16, 17, 24, 25, 29, 30]) carveRow(grid, y);
  for (const x of [2, 3, 10, 11, 20, 21, 30, 31, 39, 40, 49, 50, 57]) carveCol(grid, x);

  // Open up four small chambers in the corners to house the relay towers.
  fillRect(grid, 3, 3, 8, 6, TileType.Empty);
  fillRect(grid, 51, 3, 56, 6, TileType.Empty);
  fillRect(grid, 3, 26, 8, 29, TileType.Empty);
  fillRect(grid, 51, 26, 56, 29, TileType.Empty);

  // A clear chamber at bottom centre around the player's spawn pad.
  fillRect(grid, 27, 28, 33, 31, TileType.Empty);

  // Four radar relay towers, one in each corner chamber.
  grid[at(5, 4)] = TileType.Radar;
  grid[at(54, 4)] = TileType.Radar;
  grid[at(5, 28)] = TileType.Radar;
  grid[at(54, 28)] = TileType.Radar;

  // Steel pillars along the corridors to break long firing lanes.
  steelPillars(grid, [
    [14, 15],
    [44, 15],
    [29, 5],
    [29, 27],
    [14, 7],
    [44, 7],
    [14, 23],
    [44, 23],
  ]);

  return grid;
}

/**
 * Level 17 (The Upload): a symmetrical arena with a 3x3 uplink zone in the
 * exact centre, flanked by four protective steel pillars. Loose brick cover
 * breaks the open ground, but the approaches to the zone are wide open.
 */
export function buildUplinkChamber(): number[] {
  const grid = steelBordered();

  const cx = Math.floor(GRID_WIDTH / 2);  // 30
  const cy = Math.floor(GRID_HEIGHT / 2); // 16

  // 3x3 Uplink Zone at centre.
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) grid[at(cx + dx, cy + dy)] = TileType.UplinkZone;
  }

  // Four steel pillars protecting the zone — the player can duck behind them.
  steelPillars(grid, [
    [cx - 4, cy - 1],
    [cx + 3, cy - 1],
    [cx - 1, cy - 4],
    [cx - 1, cy + 3],
  ]);

  // Brick cover at each quadrant for something to hide behind on approach.
  coverClusters(grid, [
    [10, 6],
    [47, 6],
    [10, 24],
    [47, 24],
    [20, 10],
    [38, 10],
    [20, 22],
    [38, 22],
  ], 2);

  // Hard steel bastions at the four far corners — indestructible reference points.
  steelPillars(grid, [
    [4, 4],
    [54, 4],
    [4, 27],
    [54, 27],
  ]);

  return grid;
}

/**
 * Level 18 (The Fragments): an open arena for the Hydra.
 *
 * Deliberately sparse. The largest Hydra tier is three tiles across and its
 * fragments end up spread all over the field, so the map has to be traversable
 * by a wide hull and open enough to keep seven bodies in view. Cover is small,
 * free-standing and well spaced — enough to break a firing line, never enough
 * to form a corridor something big can wedge in.
 *
 * (This replaced a water-moat layout built for the level's old intel objective,
 * whose two-tile lanes the three-tile boss could not physically enter.)
 */
export function buildLatticeArena(): number[] {
  const grid = steelBordered();

  // Small free-standing brick clusters, ringed around the arena. Every gap
  // between them is at least four tiles, so nothing can bottleneck.
  coverClusters(grid, [
    [11, 7],
    [48, 7],
    [7, 16],
    [52, 16],
    [11, 25],
    [30, 27],
    [48, 25],
  ], 2);

  // A few steel anchors to break sightlines across the middle, spaced so the
  // centre stays crossable in every direction.
  steelPillars(grid, [
    [20, 12],
    [39, 12],
    [20, 20],
    [39, 20],
  ], 2);

  // Keep the middle and the spawn approach completely clear: the boss enters
  // from the north and has to be able to reach the player, and the player has
  // to be able to back away from seven fragments at once.
  fillRect(grid, 26, 14, 33, 18, TileType.Empty);
  fillRect(grid, 26, 28, 33, 31, TileType.Empty);

  // The boss's own entry band at centre-north. Cleared explicitly rather than
  // left to luck: a three-tile hull that spawns inside cover cannot move at
  // all, which is exactly how the previous layout stranded it.
  fillRect(grid, 26, 3, 34, 9, TileType.Empty);

  return grid;
}

/**
 * Level 19 (The Final Breach): a vertical corridor from the bottom spawn up to
 * the extraction pad at the top. Alternating steel and brick walls with offset
 * gaps create a tight serpentine climb — Constructors wall the path shut while
 * Kamikazes rush the narrows.
 */
export function buildBreachCorridor(): number[] {
  const grid = steelBordered();

  // Extraction pad: a narrow band across the top centre.
  fillRect(grid, GRID_WIDTH / 2 - 3, 1, GRID_WIDTH / 2 + 2, 2, TileType.ExtractionZone);

  // Tight serpentine: alternating steel and brick walls with narrow offset gaps.
  // Steel walls are indestructible — the player must use the gap. Brick walls
  // can be blasted but are tight enough that Constructors re-seal them fast.
  const walls: Array<{ y: number; gap: [number, number]; tile: TileType }> = [
    { y: 5,  gap: [4, 7],   tile: TileType.Steel },
    { y: 8,  gap: [52, 55], tile: TileType.Brick },
    { y: 11, gap: [4, 7],   tile: TileType.Steel },
    { y: 14, gap: [52, 55], tile: TileType.Brick },
    { y: 17, gap: [4, 7],   tile: TileType.Steel },
    { y: 20, gap: [52, 55], tile: TileType.Brick },
    { y: 23, gap: [4, 7],   tile: TileType.Steel },
    { y: 26, gap: [52, 55], tile: TileType.Brick },
    { y: 29, gap: [27, 33], tile: TileType.Brick },
  ];
  for (const { y, gap, tile } of walls) {
    for (let x = 1; x < GRID_WIDTH - 1; x++) {
      if (x >= gap[0] && x <= gap[1]) continue;
      grid[at(x, y)] = tile;
    }
  }

  return grid;
}

/**
 * Level 20 (The Architect): a deliberately bare arena that the boss spends the
 * fight making smaller.
 *
 * The four Radar tiles are its pylons, set wide apart and close to the border so
 * the player must commit to the outer ring — exactly the ground the contracting
 * walls take first. Cover is sparse and central on purpose: the encounter's
 * tension is open space running out, and a maze would both hide the contraction
 * and wedge the three-tile hull.
 */
export function buildArchitectChamber(): number[] {
  const grid = steelBordered();

  // The pylons. Reachable, but far apart and near the edge — the player has to
  // spend the room they are about to lose.
  for (const [x, y] of [
    [8, 6],
    [51, 6],
    [8, 26],
    [51, 26],
  ] as Array<[number, number]>) {
    grid[at(x, y)] = TileType.Radar;
  }

  // A little brick cover beside each pylon: something to break line of fire
  // without walling the approach off.
  for (const [x, y] of [
    [11, 8],
    [48, 8],
    [11, 24],
    [48, 24],
  ] as Array<[number, number]>) {
    fillRect(grid, x, y, x + 1, y + 1, TileType.Brick);
  }

  // Two central steel pillars, clear of the Architect's own footprint at centre.
  steelPillars(grid, [
    [22, 16],
    [36, 16],
  ], 2);

  return grid;
}

/**
 * Level 21 (The Logic Core): a massive, wide-open arena for the final boss.
 * Four symmetrical steel pillars provide desperate cover against the Core's
 * 360-degree radial fire.
 */
export function buildCoreChamber(): number[] {
  const grid = steelBordered();

  // Four symmetrical steel pillars — the only cover in the arena.
  steelPillars(grid, [
    [15, 10],
    [43, 10],
    [15, 22],
    [43, 22],
  ], 3);

  return grid;
}

/**
 * Level 22 (The Effigy): a duelling ground.
 *
 * Symmetric, mostly open, with scattered pillars to break line of fire and give
 * both duellists something to blink around. Deliberately even-handed — the
 * fight is meant to read as a mirror match, so neither side gets better ground.
 */
export function buildDuellingGround(): number[] {
  const grid = steelBordered();

  // A ring of steel pillars, evenly spaced — cover that favours nobody.
  steelPillars(grid, [
    [18, 9],
    [40, 9],
    [18, 23],
    [40, 23],
    [29, 16],
  ], 2);

  // Brick outriggers, destructible, so the arena opens up as the duel runs on.
  // Kept off the north-south centre line: the Effigy enters from the top and
  // must not be walled in on the way down.
  for (const [x, y] of [
    [12, 16],
    [46, 16],
    [29, 11],
    [29, 21],
  ] as Array<[number, number]>) {
    fillRect(grid, x, y, x + 1, y + 1, TileType.Brick);
  }

  // The Effigy's entry band, cleared explicitly so it always has room to turn.
  fillRect(grid, 26, 3, 33, 8, TileType.Empty);

  return grid;
}

// ---------------------------------------------------------------------------
// Objective-tile helpers
//
// The maps above each hand-place their radars, bombs and pads inline, which was
// fine for twenty-two of them. Past that it is the same four lines of loop over
// and over, so the placements below say what they are instead.
// ---------------------------------------------------------------------------

/** Drops `tile` on each of `spots`. */
export function placeTiles(
  grid: number[],
  spots: ReadonlyArray<readonly [number, number]>,
  tile: TileType,
): void {
  for (const [x, y] of spots) {
    if (x < 1 || y < 1 || x > GRID_WIDTH - 2 || y > GRID_HEIGHT - 2) continue;
    grid[at(x, y)] = tile;
  }
}

/**
 * Lays an extraction pad as a band, clamped inside the wall.
 *
 * Deliberately several tiles wide: a one-tile pad on a map with any traffic on
 * it is a level lost to a hull the player could not get past, rather than to
 * anything they did.
 */
export function placeExtraction(grid: number[], x1: number, y1: number, x2: number, y2: number): void {
  fillRect(grid, x1, y1, x2, y2, TileType.ExtractionZone);
}

/** Lays the standard 3x3 uplink zone centred on `(cx, cy)`. */
export function placeUplink(grid: number[], cx: number, cy: number): void {
  fillRect(grid, cx - 1, cy - 1, cx + 1, cy + 1, TileType.UplinkZone);
}

/**
 * Plants the allied relay a `defend_core` level is fought over, in its bunker.
 *
 * A steel shell rather than a brick one. Brick made the hold nearly unwinnable:
 * any enemy that wandered into line needed two shots from wherever it happened
 * to be standing — one to open the wall, one to finish the relay — so the level
 * was decided by whether a stray tank happened to face the right way, and no
 * amount of defending changed that.
 *
 * Steel cannot be shot through at all, so the only way at the relay is *in*,
 * through one of two doors. The doors are deliberately offset from the relay's
 * own row and column, so there is no line from outside the shell to the thing
 * in the middle of it: an attacker has to drive through a gap the player can
 * stand in front of. That is what turns the level into a defence rather than a
 * dice roll.
 */
export function placeRelay(grid: number[], cx: number, cy: number): void {
  // The shell: a 5x5 ring of steel.
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== 2) continue;
      grid[at(cx + dx, cy + dy)] = TileType.Steel;
    }
  }

  // Two doors, on opposite faces and offset one tile off centre each — so
  // neither of them opens a firing line onto the relay.
  grid[at(cx - 1, cy - 2)] = TileType.Empty;
  grid[at(cx + 1, cy + 2)] = TileType.Empty;

  // Clear the floor inside, then plant the relay in the middle of it.
  fillRect(grid, cx - 1, cy - 1, cx + 1, cy + 1, TileType.Empty);
  grid[at(cx, cy)] = TileType.EagleBase;
}

/**
 * Cuts a full-width wall of `tile` across row `y`, leaving `gaps` open.
 *
 * The workhorse of the corridor maps: a serpentine climb is this called three
 * or four times with the gaps walked from one side to the other.
 */
export function wallRow(
  grid: number[],
  y: number,
  tile: TileType,
  gaps: ReadonlyArray<readonly [number, number]>,
): void {
  for (let x = 1; x < GRID_WIDTH - 1; x++) {
    if (gaps.some(([from, to]) => x >= from && x <= to)) continue;
    grid[at(x, y)] = tile;
  }
}

/** The vertical counterpart of {@link wallRow}. */
export function wallCol(
  grid: number[],
  x: number,
  tile: TileType,
  gaps: ReadonlyArray<readonly [number, number]>,
): void {
  for (let y = 1; y < GRID_HEIGHT - 1; y++) {
    if (gaps.some(([from, to]) => y >= from && y <= to)) continue;
    grid[at(x, y)] = tile;
  }
}

// ---------------------------------------------------------------------------
// Act 1
// ---------------------------------------------------------------------------

/**
 * "Dead Channel": a relay station the player has to hold rather than reach.
 *
 * The relay sits dead centre in a brick bunker with four short baffles around
 * it. The baffles are the whole design: they stop a rusher taking a straight
 * run at the relay from any of the four approaches, so the player can cover all
 * of them from the middle instead of having to be in four places at once.
 */
export function buildRelayStation(): number[] {
  const grid = steelBordered();

  const cx = Math.floor(GRID_WIDTH / 2);
  const cy = Math.floor(GRID_HEIGHT / 2);
  placeRelay(grid, cx, cy);

  // Baffles: short steel walls offset from each approach, so every lane into
  // the relay bends at least once.
  steelPillars(grid, [
    [cx - 7, cy - 5],
    [cx + 5, cy - 5],
    [cx - 7, cy + 4],
    [cx + 5, cy + 4],
  ], 3);

  coverClusters(grid, [
    [8, 6], [46, 6], [8, 24], [46, 24],
    [20, 4], [37, 4], [20, 27], [37, 27],
    [4, 15], [52, 15],
  ], 2);

  return grid;
}

// ---------------------------------------------------------------------------
// Act 2
// ---------------------------------------------------------------------------

/**
 * "Running Interference": a long east-west road with cover either side.
 *
 * Built for the reverse escort. The enemy carrier runs the open lane along the
 * middle, and the player has to get shells into it from the flanks while the
 * escort shoots back — so the map gives them approach cover on both sides and
 * nothing at all in the lane itself, which stays a clean firing line.
 */
export function buildConvoyRoad(): number[] {
  const grid = steelBordered();

  const lane = Math.floor(GRID_HEIGHT / 2);

  // Verges: dense cover above and below the lane, none in it.
  coverClusters(grid, [
    [8, lane - 6], [18, lane - 7], [30, lane - 6], [42, lane - 7], [50, lane - 6],
    [8, lane + 4], [18, lane + 5], [30, lane + 4], [42, lane + 5], [50, lane + 4],
  ], 3);

  steelPillars(grid, [
    [13, lane - 4], [25, lane - 4], [37, lane - 4], [48, lane - 4],
    [13, lane + 3], [25, lane + 3], [37, lane + 3], [48, lane + 3],
  ], 2);

  // The carrier's own lane, cleared explicitly — it drives itself and must
  // never be walled in by the cover above.
  fillRect(grid, 1, lane - 1, GRID_WIDTH - 2, lane + 1, TileType.Empty);

  // Its exit. Reaching this is the loss condition, so it is drawn as a pad.
  placeExtraction(grid, 1, lane - 1, 2, lane + 1);

  return grid;
}

/**
 * "Scrapline": a wrecking yard of identical hulks.
 *
 * Deliberately busy and repetitive — long rows of the same brick shape — so
 * that picking a marked unit out of the traffic is a reading problem rather
 * than a shooting one.
 */
export function buildScrapline(): number[] {
  const grid = steelBordered();

  for (let row = 0; row < 4; row++) {
    const y = 5 + row * 7;
    for (let col = 0; col < 7; col++) {
      const x = 5 + col * 8;
      fillRect(grid, x, y, x + 2, y + 1, TileType.Brick);
    }
  }

  steelPillars(grid, [
    [15, 9], [43, 9], [15, 23], [43, 23], [29, 16],
  ], 2);

  return grid;
}

// ---------------------------------------------------------------------------
// Act 3
// ---------------------------------------------------------------------------

/**
 * "Breakwater": a relay behind a sea wall, with the ground broken by coolant.
 *
 * The water is what makes this one different from the earlier relay hold: it
 * cuts the arena into approaches that cannot be crossed, so the player commits
 * to a side and has to actually run round when the pressure moves.
 */
export function buildBreakwater(): number[] {
  const grid = steelBordered();

  const cx = Math.floor(GRID_WIDTH / 2);
  const cy = Math.floor(GRID_HEIGHT / 2);
  placeRelay(grid, cx, cy);

  // Two long coolant channels either side of the relay, with a gap at each end.
  fillRect(grid, 12, 6, 14, 26, TileType.Water);
  fillRect(grid, 45, 6, 47, 26, TileType.Water);
  fillRect(grid, 12, 15, 14, 17, TileType.Empty);
  fillRect(grid, 45, 15, 47, 17, TileType.Empty);

  // The sea wall: a steel arc north of the relay, where the pressure comes from.
  wallRow(grid, cy - 6, TileType.Steel, [[20, 24], [36, 40]]);

  coverClusters(grid, [
    [20, 24], [36, 24], [6, 10], [52, 10], [6, 22], [52, 22],
  ], 3);

  return grid;
}

/**
 * "Pressure Line": a long climb the payload only makes while escorted.
 *
 * Full-width brick bands with offset gaps, so the breaker's route bends back
 * and forth across the map. The gaps are wide enough for the payload's hull and
 * placed off the centre line, which is what stops the level being a straight
 * walk up column 30 with the player parked on top of the payload.
 */
export function buildPressureLine(): number[] {
  const grid = steelBordered();

  placeExtraction(grid, 26, 1, 33, 2);

  const bands: Array<[number, ReadonlyArray<readonly [number, number]>]> = [
    [26, [[8, 12]]],
    [21, [[44, 48]]],
    [16, [[14, 18]]],
    [11, [[40, 44]]],
    [6, [[24, 28]]],
  ];
  for (const [y, gaps] of bands) wallRow(grid, y, TileType.Brick, gaps);

  coverClusters(grid, [
    [20, 28], [40, 23], [24, 18], [30, 13], [12, 8],
  ], 2);

  steelPillars(grid, [
    [34, 28], [10, 23], [46, 18], [18, 13], [44, 8],
  ], 2);

  return grid;
}

// ---------------------------------------------------------------------------
// Act 4 — The Archive
// ---------------------------------------------------------------------------

/**
 * "The Archive Gate": four relay masts behind a colonnade of steel.
 *
 * Long straight sightlines down the colonnade, which is the point: this is the
 * level Sentinels arrive on, and a Sentinel is only a threat where it can see
 * a long way.
 */
export function buildArchiveGate(): number[] {
  const grid = steelBordered();

  // Colonnade: paired steel columns down the length of the hall.
  for (let col = 0; col < 6; col++) {
    const x = 8 + col * 9;
    steelPillars(grid, [[x, 8], [x, 21]], 2);
  }

  // Six masts, not four: the gate's interlock is a sequence, and four steps is
  // barely one lap of the hall.
  placeTiles(
    grid,
    [[4, 4], [55, 4], [4, 28], [55, 28], [4, 16], [55, 16]],
    TileType.Radar,
  );

  coverClusters(grid, [
    [12, 4], [45, 4], [12, 27], [45, 27], [29, 15],
  ], 2);

  return grid;
}

/**
 * "Cold Storage": a dense vault grid with narrow aisles.
 *
 * Close quarters on purpose. This is where the Burrower and the Leech turn up,
 * and both of them want a map where the player cannot simply see them coming
 * and back away in a straight line.
 */
export function buildColdStorage(): number[] {
  const grid = steelBordered();

  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 9; col++) {
      const x = 3 + col * 6;
      const y = 3 + row * 6;
      fillRect(grid, x, y, x + 3, y + 3, row % 2 === 0 ? TileType.Steel : TileType.Brick);
    }
  }

  // Two clear cross-aisles, so nowhere on the map is more than a short run from
  // a lane that actually goes somewhere.
  carveRow(grid, 16);
  carveCol(grid, 30);

  return grid;
}

/**
 * "Our Own Dead": a field of wrecked battalion armour.
 *
 * Scattered, irregular cover with no symmetry to learn — the level is about
 * telling one silhouette from another, so the terrain deliberately refuses to
 * give the player a clean firing position to do it from.
 */
export function buildBoneyard(): number[] {
  const grid = steelBordered();

  coverClusters(grid, [
    [5, 5], [11, 9], [7, 18], [14, 25], [21, 6], [19, 15], [26, 22],
    [33, 5], [31, 12], [38, 19], [35, 27], [44, 8], [47, 16], [42, 24],
    [52, 5], [50, 21], [54, 27], [24, 29],
  ], 2);

  steelPillars(grid, [
    [16, 12], [28, 9], [40, 13], [23, 19], [46, 26], [9, 22],
  ], 2);

  return grid;
}

/**
 * "The Choir": a long hall with a pillar down the middle.
 *
 * The pillar is the encounter. The twins must be finished within seconds of
 * each other, and a hall split down the centre means the player cannot hold
 * both in the same firing line — they have to break contact and cross.
 */
export function buildChoirHall(): number[] {
  const grid = steelBordered();

  fillRect(grid, 29, 8, 30, 24, TileType.Steel);

  coverClusters(grid, [
    [12, 8], [46, 8], [12, 22], [46, 22], [20, 15], [38, 15],
  ], 3);

  steelPillars(grid, [
    [8, 15], [50, 15], [29, 4], [29, 27],
  ], 2);

  return grid;
}

/**
 * "Requisition": four assembly vaults with open ground between them.
 *
 * Simpler than the Act 2 factory complex on purpose — the difficulty here is
 * the Reclaimer, which rebuilds what the player has already levelled, so the
 * map must not also make each structure slow to reach.
 */
export function buildRequisitionYard(): number[] {
  const grid = steelBordered();

  const vaults: Array<[number, number]> = [[10, 8], [47, 8], [10, 24], [47, 24]];
  for (const [fx, fy] of vaults) {
    fillRect(grid, fx - 2, fy - 2, fx + 2, fy + 2, TileType.Brick);
    fillRect(grid, fx - 1, fy - 1, fx + 1, fy + 1, TileType.Empty);
    grid[at(fx, fy)] = TileType.Factory;
  }

  steelPillars(grid, [
    [22, 10], [36, 10], [22, 21], [36, 21], [29, 16],
  ], 2);

  coverClusters(grid, [
    [29, 5], [29, 26], [4, 16], [54, 16],
  ], 2);

  return grid;
}

/**
 * "Signal Discipline": an uplink in the open, ringed by hard cover at range.
 *
 * The zone itself is exposed and the cover is all a few tiles out, which is
 * exactly the shape a Nullifier wants: standing on the objective means standing
 * where the player's kit can be switched off, and the ring is where they have
 * to go to deal with it.
 */
export function buildSignalYard(): number[] {
  const grid = steelBordered();

  const cx = Math.floor(GRID_WIDTH / 2);
  const cy = Math.floor(GRID_HEIGHT / 2);
  placeUplink(grid, cx, cy);

  steelPillars(grid, [
    [cx - 9, cy - 6], [cx + 7, cy - 6], [cx - 9, cy + 4], [cx + 7, cy + 4],
    [cx - 1, cy - 9], [cx - 1, cy + 7],
  ], 2);

  coverClusters(grid, [
    [8, 6], [46, 6], [8, 24], [46, 24], [29, 2], [29, 29],
  ], 3);

  return grid;
}

/**
 * "The Foundry": a production floor with four intakes in the corners.
 *
 * The intakes are radar masts as far as the map is concerned; the boss is
 * sealed while any of them stand. Wide lanes between them, because the fight is
 * a circuit under fire rather than a brawl in one corner.
 */
export function buildFoundryFloor(): number[] {
  const grid = steelBordered();

  placeTiles(grid, [[6, 6], [53, 6], [6, 26], [53, 26]], TileType.Radar);

  // Casings around each intake, open on the side facing the middle, so every
  // one has to be approached from the floor rather than sniped from the wall.
  const casings: Array<[number, number, number, number]> = [
    [4, 4, 8, 8], [51, 4, 55, 8], [4, 24, 8, 28], [51, 24, 55, 28],
  ];
  for (const [x1, y1, x2, y2] of casings) {
    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        const onEdge = x === x1 || x === x2 || y === y1 || y === y2;
        if (onEdge && grid[at(x, y)] === TileType.Empty) grid[at(x, y)] = TileType.Brick;
      }
    }
  }

  steelPillars(grid, [[18, 12], [40, 12], [18, 19], [40, 19]], 3);

  return grid;
}

// ---------------------------------------------------------------------------
// Act 5
// ---------------------------------------------------------------------------

/**
 * "Deep Water": islands in a coolant flood.
 *
 * The Leviathan submerges and surfaces underneath the player, so the map is
 * built to take away the easy answer of simply driving in a straight line
 * forever: the ground is broken into platforms, and every escape is a choice
 * about which bridge to take.
 */
export function buildDeepWater(): number[] {
  const grid = steelBordered();

  fillRect(grid, 1, 1, GRID_WIDTH - 2, GRID_HEIGHT - 2, TileType.Water);

  // Platforms.
  const islands: Array<[number, number, number, number]> = [
    [4, 4, 16, 12], [22, 3, 37, 10], [43, 4, 55, 12],
    [3, 20, 15, 29], [23, 22, 36, 29], [44, 20, 56, 29],
    [24, 13, 35, 19],
  ];
  for (const [x1, y1, x2, y2] of islands) fillRect(grid, x1, y1, x2, y2, TileType.Empty);

  // Bridges between them, one tile wide — deliberately a commitment.
  fillRect(grid, 17, 7, 21, 8, TileType.Empty);
  fillRect(grid, 38, 7, 42, 8, TileType.Empty);
  fillRect(grid, 16, 24, 22, 25, TileType.Empty);
  fillRect(grid, 37, 24, 43, 25, TileType.Empty);
  fillRect(grid, 29, 11, 30, 12, TileType.Empty);
  fillRect(grid, 29, 20, 30, 21, TileType.Empty);
  fillRect(grid, 8, 13, 9, 19, TileType.Empty);
  fillRect(grid, 50, 13, 51, 19, TileType.Empty);

  coverClusters(grid, [[10, 6], [47, 6], [10, 23], [47, 23]], 2);

  return grid;
}

/**
 * "Two Rivers": a wide crossing with the road running north to south.
 *
 * The enemy carrier runs for the top of the map here rather than the side, and
 * the two coolant rivers mean the player's shots have to be taken from the
 * bridges — which is also where the boss wave will find them.
 */
export function buildTwoRivers(): number[] {
  const grid = steelBordered();

  fillRect(grid, 1, 10, GRID_WIDTH - 2, 12, TileType.Water);
  fillRect(grid, 1, 20, GRID_WIDTH - 2, 22, TileType.Water);

  // Four crossings on each river, offset from one another.
  for (const x of [9, 24, 38, 52]) fillRect(grid, x, 10, x + 2, 12, TileType.Empty);
  for (const x of [16, 30, 45] as const) fillRect(grid, x, 20, x + 2, 22, TileType.Empty);

  // The carrier's lane, kept clear all the way to its pad at the top.
  fillRect(grid, 29, 1, 31, GRID_HEIGHT - 2, TileType.Empty);
  placeExtraction(grid, 28, 1, 32, 2);

  coverClusters(grid, [
    [12, 5], [45, 5], [12, 15], [45, 15], [12, 26], [45, 26], [21, 26], [36, 5],
  ], 2);

  return grid;
}

// ---------------------------------------------------------------------------
// Act 6 — The Core
// ---------------------------------------------------------------------------

/**
 * "Antechamber": a bare hall with pillars, sized for two siege guns at once.
 *
 * Almost empty by design. The wave that arrives here is two Artillery pieces,
 * and artillery is only interesting where cover is scarce enough that closing
 * on one means being in the open for the other.
 */
export function buildAntechamber(): number[] {
  const grid = steelBordered();

  steelPillars(grid, [
    [14, 8], [44, 8], [14, 22], [44, 22], [29, 15],
  ], 3);

  coverClusters(grid, [[24, 4], [34, 27], [5, 15], [53, 15]], 2);

  return grid;
}

/**
 * "Last Light": the final relay, in a bunker at the bottom of the map.
 *
 * The relay is behind the player's own spawn rather than in the middle, so for
 * once holding the objective means fighting forward and keeping the field at
 * arm's length instead of orbiting a point.
 */
export function buildLastLight(): number[] {
  const grid = steelBordered();

  placeRelay(grid, 30, 28);

  // A short wall either side of the bunker, funnelling the approach.
  fillRect(grid, 22, 25, 26, 26, TileType.Steel);
  fillRect(grid, 34, 25, 38, 26, TileType.Steel);

  wallRow(grid, 18, TileType.Brick, [[6, 10], [27, 33], [50, 54]]);

  coverClusters(grid, [
    [10, 8], [46, 8], [20, 12], [38, 12], [8, 22], [48, 22],
  ], 3);

  steelPillars(grid, [[29, 8], [16, 4], [42, 4]], 2);

  return grid;
}

/**
 * "The Gauntlet": an open field with room for four heavy hulls at once.
 *
 * Everything the campaign has left is thrown in here together — two wrecking
 * balls and two siege guns — so the map gives almost nothing back except a few
 * pillars to break a firing line and enough space that the Sweepers have room
 * to build up speed and be read.
 */
export function buildGauntletArena(): number[] {
  const grid = steelBordered();

  steelPillars(grid, [
    [12, 7], [46, 7], [12, 23], [46, 23], [29, 15],
  ], 2);

  coverClusters(grid, [
    [20, 10], [38, 10], [20, 21], [38, 21], [29, 4], [29, 27],
  ], 3);

  return grid;
}

/**
 * "Threshold": the last corridor, collapsing behind the player.
 *
 * A tight serpentine climb of alternating steel and brick with offset gaps, so
 * the run is a series of committed turns — the shape the Act 3 breach corridor
 * used, tightened, and with the Constructors on this level resealing it behind.
 */
export function buildThreshold(): number[] {
  const grid = steelBordered();

  placeExtraction(grid, 27, 1, 32, 2);

  const bands: Array<[number, TileType, ReadonlyArray<readonly [number, number]>]> = [
    [28, TileType.Steel, [[4, 7]]],
    [24, TileType.Brick, [[50, 54]]],
    [20, TileType.Steel, [[10, 13]]],
    [16, TileType.Brick, [[44, 48]]],
    [12, TileType.Steel, [[16, 19]]],
    [8, TileType.Brick, [[38, 42]]],
    [5, TileType.Steel, [[27, 32]]],
  ];
  for (const [y, tile, gaps] of bands) wallRow(grid, y, tile, gaps);

  coverClusters(grid, [[20, 26], [30, 22], [24, 18], [20, 14], [30, 10]], 2);

  return grid;
}
