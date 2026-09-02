/** Single-player campaign data, shared by the Colyseus server and the client. */

import { GRID_HEIGHT, GRID_LENGTH, GRID_WIDTH, TileType } from "./constants.js";

/**
 * Phases a campaign playthrough moves through, replicated on `CampaignState`.
 *
 * Strings rather than a numeric enum so the value stays readable in devtools and
 * a bad one is easy to reject — the same convention as `MatchStatus`.
 */
export const CampaignPhase = {
  /** Showing the level's intro briefing; the world is frozen. */
  Intro: "intro",
  /** The level is live and simulating. */
  Playing: "playing",
  /** Objective cleared; showing the level's outro. */
  Outro: "outro",
  /** Out of lives — the run is over. */
  GameOver: "game_over",
  /** Every level cleared — the victory screen. */
  CampaignComplete: "campaign_complete",
} as const;
export type CampaignPhase = (typeof CampaignPhase)[keyof typeof CampaignPhase];

/**
 * Message names a campaign client sends to advance the phase, server-side.
 *
 * Strings shared by both ends so a rename can't drift out of sync — the same
 * convention as {@link ClientMessage}.
 */
export const CampaignMessage = {
  /** Leave the intro briefing and start the level. */
  StartLevel: "start_level",
  /** Leave the outro and move on to the next level. */
  NextLevel: "next_level",
  /** Debug: instantly win the current level. */
  CheatWin: "cheat_win",
} as const;
export type CampaignMessage = (typeof CampaignMessage)[keyof typeof CampaignMessage];

/** How a campaign level is won. */
export const CampaignWinCondition = {
  /** Destroy every radar/jamming tower on the map. */
  DestroyRadars: "destroy_radars",
  /** Drive the player's hull onto an extraction pad. */
  ReachExtraction: "reach_extraction",
  /** Stay alive until the survival timer runs out. */
  SurviveTime: "survive_time",
  /** Hold position inside the uplink zone for a set time. */
  ZoneControl: "zone_control",
  /** Destroy the boss unit. */
  AssassinateBoss: "assassinate_boss",
  /** Level every factory structure on the map. */
  DestroyFactories: "destroy_factories",
  /** Touch every dirty bomb to defuse it before the timer runs out. */
  DefuseBombs: "defuse_bombs",
  /** Collect every scattered intel package. */
  RetrieveIntel: "retrieve_intel",
  /** Escort the allied carrier to the extraction pad; it must survive. */
  Escort: "escort",
} as const;
export type CampaignWinCondition =
  (typeof CampaignWinCondition)[keyof typeof CampaignWinCondition];

/** Default seconds the player must hold out on a `survive_time` level. */
export const SURVIVE_DURATION_SECONDS = 60;

/**
 * Seconds to survive on a given (1-based) `survive_time` level.
 *
 * Level 3 ("Hold the Line") is a longer, tougher stand at 120s; every other
 * survival level uses the {@link SURVIVE_DURATION_SECONDS} base.
 */
export function surviveSecondsForLevel(level: number): number {
  if (level === 3 || level === 15) return 120;
  return SURVIVE_DURATION_SECONDS;
}

/** Seconds the player must hold the uplink zone on a `zone_control` level. */
export const ZONE_CONTROL_DURATION_SECONDS = 60;

/** Seconds the player has to reach every bomb on a `defuse_bombs` level. */
export const BOMB_DEFUSAL_DURATION_SECONDS = 90;

/** One level of the single-player campaign. */
export interface CampaignLevel {
  /** 1-based level number; also its position in {@link CAMPAIGN_LEVELS}. */
  id: number;
  /** Briefing shown before the level starts. */
  introText: string;
  /** Debrief shown once the level is cleared. */
  outroText: string;
  /**
   * The level's map, flattened row-major into {@link GRID_LENGTH} tiles of
   * {@link TileType} — the same layout as `GameState.grid`, so the cell at
   * `(x, y)` lives at index `y * GRID_WIDTH + x`.
   */
  mapGrid: number[];
  /** What clears the level; one of {@link CampaignWinCondition}. */
  winCondition: string;
}

const at = (x: number, y: number): number => y * GRID_WIDTH + x;

/** A fresh empty grid walled in by a steel perimeter — the base of every level. */
function steelBordered(): number[] {
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
function fillRect(grid: number[], x1: number, y1: number, x2: number, y2: number, tile: TileType): void {
  for (let y = Math.max(1, y1); y <= Math.min(GRID_HEIGHT - 2, y2); y++) {
    for (let x = Math.max(1, x1); x <= Math.min(GRID_WIDTH - 2, x2); x++) grid[at(x, y)] = tile;
  }
}

/** Drops isolated square brick clusters as cover in otherwise open ground. */
function coverClusters(grid: number[], spots: ReadonlyArray<readonly [number, number]>, size = 3): void {
  for (const [x, y] of spots) fillRect(grid, x, y, x + size - 1, y + size - 1, TileType.Brick);
}

/** Drops isolated square steel pillars — indestructible hard cover. */
function steelPillars(grid: number[], spots: ReadonlyArray<readonly [number, number]>, size = 2): void {
  for (const [x, y] of spots) fillRect(grid, x, y, x + size - 1, y + size - 1, TileType.Steel);
}

/** Packs the whole interior (inside the steel border) with brick. */
function fillInterior(grid: number[]): void {
  for (let y = 1; y < GRID_HEIGHT - 1; y++) {
    for (let x = 1; x < GRID_WIDTH - 1; x++) grid[at(x, y)] = TileType.Brick;
  }
}

/** Carves a 1-tile Empty corridor along row `y`, clamped to the interior. */
function carveRow(grid: number[], y: number): void {
  for (let x = 1; x <= GRID_WIDTH - 2; x++) grid[at(x, y)] = TileType.Empty;
}

/** Carves a 1-tile Empty corridor along column `x`, clamped to the interior. */
function carveCol(grid: number[], x: number): void {
  for (let y = 1; y <= GRID_HEIGHT - 2; y++) grid[at(x, y)] = TileType.Empty;
}

/**
 * Level 1: an open field with a jamming tower in each corner. Scattered brick
 * clusters give a little cover, but the corners are reached across open ground.
 */
function buildLevel1Grid(): number[] {
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
 * Level 2: a strict winding maze north to the extraction pad. Full-width walls —
 * indestructible steel alternating with brick — each leave a single gap on the
 * opposite side to the one below it, so there is never a straight run north: the
 * player must serpentine the whole way up, side to side, to reach the pad.
 */
function buildLevel2Grid(): number[] {
  const grid = steelBordered();

  // Extraction pad: a 6-wide band across the top centre, just inside the wall.
  fillRect(grid, GRID_WIDTH / 2 - 3, 1, GRID_WIDTH / 2 + 2, 2, TileType.ExtractionZone);

  // Full-width barrier walls, gaps alternating hard left / hard right, so the
  // only route is a tight zig-zag. Steel walls seal the approach to the pad;
  // brick walls lower down give the guns something to chew if they miss the gap.
  const walls: Array<{ y: number; gap: [number, number]; tile: TileType }> = [
    { y: 5, gap: [3, 7], tile: TileType.Steel },
    { y: 9, gap: [52, 56], tile: TileType.Steel },
    { y: 13, gap: [3, 7], tile: TileType.Steel },
    { y: 17, gap: [52, 56], tile: TileType.Steel },
    { y: 21, gap: [3, 7], tile: TileType.Steel },
    { y: 25, gap: [52, 56], tile: TileType.Steel },
    { y: 29, gap: [3, 7], tile: TileType.Steel },
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
 * Level 3: an open survival arena. Brick pillars break sightlines and two water
 * hazards flank the centre, but there is plenty of room to keep circling.
 */
function buildLevel3Grid(): number[] {
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
function buildLevel4Grid(): number[] {
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
function buildLevel5Grid(): number[] {
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
 * Level 6 (Act 2): a factory complex, kept deliberately open. Only the three
 * factories are fortified — each ringed by brick with four gaps — plus a little
 * scattered cover. The Constructor minibosses fill the open ground with brick
 * trails as the fight wears on, so it starts sparse on purpose.
 */
function buildLevel6Grid(): number[] {
  const grid = steelBordered();

  const factories: Array<[number, number]> = [
    [16, 9],
    [30, 16],
    [44, 23],
    [50, 9],
  ];
  for (const [fx, fy] of factories) {
    // A broken brick ring two tiles out, open at the four cardinal points, so
    // the factory sits in a pocket the player can enter and fire from.
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const onRing = Math.max(Math.abs(dx), Math.abs(dy)) === 2;
        const inGap = dx === 0 || dy === 0;
        if (onRing && !inGap) grid[at(fx + dx, fy + dy)] = TileType.Brick;
      }
    }
    grid[at(fx, fy)] = TileType.Factory;
  }

  // Denser loose cover in the open ground, clear of the player spawn and the
  // factory pockets, so the Constructors have a head start on walling it in.
  for (const [x, y] of [
    [9, 24],
    [50, 8],
    [24, 5],
    [38, 28],
    [9, 8],
    [50, 24],
    [37, 6],
    [23, 26],
  ] as Array<[number, number]>) {
    fillRect(grid, x, y, x + 1, y + 1, TileType.Brick);
  }

  // Hard steel pillars away from the factories and the spawns.
  steelPillars(grid, [
    [24, 15],
    [37, 16],
    [12, 16],
    [49, 15],
  ]);

  return grid;
}

/**
 * Level 7 (Bomb Defusal): an open field with three dirty bombs at far-apart
 * corners and scattered brick cover. The player sprints a circuit to touch all
 * three before the timer expires — while Constructors wall the ground shut.
 */
function buildLevel7Grid(): number[] {
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

  // Three bombs at distant corners: bottom-left, bottom-right, and far top-left.
  for (const [x, y] of [
    [6, 30],
    [53, 30],
    [16, 2],
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
function buildLevel8Grid(): number[] {
  const grid = steelBordered();

  // Eight intel packages: four corners and four edge midpoints, far apart.
  for (const [x, y] of [
    [3, 2],
    [56, 2],
    [3, 30],
    [56, 30],
    [30, 2],
    [30, 30],
    [3, 16],
    [56, 16],
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
function buildLevel9Grid(): number[] {
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
function buildLevel10Grid(): number[] {
  const grid = steelBordered();

  // Steel cover in the Artillery's top gallery for it to weave behind — kept
  // clear of the boss's spawn (top centre) and the enemy spawn tiles.
  steelPillars(grid, [
    [12, 2],
    [20, 3],
    [39, 3],
    [47, 2],
  ]);

  // The serpentine. Gaps alternate hard left / hard right; the two top walls are
  // steel (they block the line of sight up to the boss), the rest brick.
  const walls: Array<{ y: number; gap: [number, number]; tile: TileType }> = [
    { y: 6, gap: [3, 6], tile: TileType.Steel },
    { y: 10, gap: [53, 56], tile: TileType.Steel },
    { y: 14, gap: [3, 6], tile: TileType.Steel },
    { y: 18, gap: [53, 56], tile: TileType.Steel },
    { y: 22, gap: [3, 6], tile: TileType.Steel },
    { y: 26, gap: [53, 56], tile: TileType.Steel },
    { y: 29, gap: [3, 6], tile: TileType.Steel },
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
 * Level 11 (Act 3): a synthetic-steel labyrinth. Full-width, indestructible
 * steel walls with offset gaps force a tight serpentine climb to the extraction
 * pad, and coolant pools segment the open bands — the player has no choice but
 * to thread the chokepoints.
 */
function buildLevel11Grid(): number[] {
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
function buildLevel12Grid(): number[] {
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

  steelPillars(grid, [
    [29, 5],
    [10, 17],
    [49, 17],
    [29, 27],
  ]);

  return grid;
}

/**
 * Level 13 (Seek & Destroy): a scattered field of six radar towers, each sunk
 * in its own broken brick pocket, with loose cover strewn between them. The
 * player sweeps the map to level all six — but a quarter of the "item drops"
 * littering the ground are disguised Mimics waiting to spring.
 */
function buildLevel13Grid(): number[] {
  const grid = steelBordered();

  // Six radar towers, each nested in a broken brick pocket (open at the four
  // cardinal points) so the player must push into cover to line up each shot.
  const towers: Array<[number, number]> = [
    [10, 7],
    [30, 9],
    [49, 7],
    [12, 25],
    [34, 25],
    [50, 24],
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
function buildLevel14Grid(): number[] {
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

  // Three dirty bombs sunk into far-apart pockets of the maze.
  for (const [x, y] of [
    [4, 2],
    [55, 16],
    [13, 30],
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
function buildLevel15Grid(): number[] {
  return steelBordered();
}

/**
 * Level 16 (Security Relays): a dense, symmetrical labyrinth containing four
 * radar relay towers hidden in the corners. Ghost stealth units haunt the dark.
 */
function buildLevel16Grid(): number[] {
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
function buildLevel17Grid(): number[] {
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
 * Level 18 (The Fragments): a wide-open map covered in water hazards acting as
 * impassable moats. Eight intel packages sit on isolated land bridges the player
 * must thread while dodging Mimics and Trapper mines.
 */
function buildLevel18Grid(): number[] {
  const grid = steelBordered();

  // Fill most of the interior with water — the moat.
  for (let y = 1; y < GRID_HEIGHT - 1; y++) {
    for (let x = 1; x < GRID_WIDTH - 1; x++) grid[at(x, y)] = TileType.Water;
  }

  // Carve land bridges: a cross of corridors through the water.
  // Horizontal corridors at rows 8, 16, 24.
  for (const row of [8, 16, 24]) {
    for (let x = 1; x < GRID_WIDTH - 1; x++) {
      grid[at(x, row)] = TileType.Empty;
      grid[at(x, row + 1)] = TileType.Empty;
    }
  }
  // Vertical corridors at cols 10, 30, 49.
  for (const col of [10, 30, 49]) {
    for (let y = 1; y < GRID_HEIGHT - 1; y++) {
      grid[at(col, y)] = TileType.Empty;
      grid[at(col + 1, y)] = TileType.Empty;
    }
  }

  // Clear the player spawn area at bottom centre.
  fillRect(grid, 27, 28, 33, 31, TileType.Empty);

  // Eight intel packages on the land bridges, spread far apart.
  for (const [x, y] of [
    [10, 3],
    [50, 3],
    [5, 8],
    [55, 8],
    [10, 24],
    [50, 24],
    [20, 16],
    [40, 16],
  ] as Array<[number, number]>) {
    grid[at(x, y)] = TileType.Intel;
  }

  // Brick cover clusters on the bridges for something to hide behind.
  coverClusters(grid, [
    [14, 8],
    [44, 8],
    [14, 24],
    [44, 24],
    [30, 12],
    [30, 20],
  ], 2);

  return grid;
}

/**
 * Level 19 (The Final Breach): a vertical corridor from the bottom spawn up to
 * the extraction pad at the top. Alternating steel and brick walls with offset
 * gaps create a tight serpentine climb — Constructors wall the path shut while
 * Kamikazes rush the narrows.
 */
function buildLevel19Grid(): number[] {
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
 * Level 20 (The Logic Core): a massive, wide-open arena for the final boss.
 * Four symmetrical steel pillars provide desperate cover against the Core's
 * 360-degree radial fire.
 */
function buildLevel20Grid(): number[] {
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

/** Every level of the single-player campaign, in play order. */
export const CAMPAIGN_LEVELS: CampaignLevel[] = [
  {
    id: 1,
    winCondition: CampaignWinCondition.DestroyRadars,
    introText:
      "Battalion command is dark. I am the only signal left. I need to destroy their jamming towers to send a distress beacon.",
    outroText:
      "Towers destroyed. The signal is out... but the only reply was automated static. The Obsidian Protocol. It is just me now.",
    mapGrid: buildLevel1Grid(),
  },
  {
    id: 2,
    winCondition: CampaignWinCondition.ReachExtraction,
    introText:
      "Long-range scans show an intact armored depot north of this sector. I must punch through their barricades and reach the extraction pad.",
    outroText:
      "Extraction point reached. Depot secured and hull patched. But acoustic sensors are picking up heavy engine rumblings surrounding the perimeter...",
    mapGrid: buildLevel2Grid(),
  },
  {
    id: 3,
    winCondition: CampaignWinCondition.SurviveTime,
    introText:
      "It is an ambush! Hostile signals flooding the perimeter from all sides. I must hold the line and survive for 120 seconds until my sub-rotors recharge.",
    outroText:
      "Perimeter cleared. Enemy forces retreating. That was not a random patrol—they were tracking my heat signature.",
    mapGrid: buildLevel3Grid(),
  },
  {
    id: 4,
    winCondition: CampaignWinCondition.ZoneControl,
    introText:
      "I found a Directorate communications uplink. I need to hold position inside the zone for 60 seconds to download their sector map. Warning: scans show extremely volatile, fast-moving units inbound.",
    outroText:
      "Map downloaded. The data reveals a massive prototype unit approaching my exact coordinates. Nowhere to run. I have to stand and fight.",
    mapGrid: buildLevel4Grid(),
  },
  {
    id: 5,
    winCondition: CampaignWinCondition.AssassinateBoss,
    introText:
      "The prototype has breached the arena. It is heavily armored and massive. No complex AI, just raw crushing power. I must outmaneuver it and strike while avoiding its path.",
    outroText:
      "Prototype destroyed. Act 1 Complete. The Obsidian Protocol is bleeding, but the war is just beginning...",
    mapGrid: buildLevel5Grid(),
  },
  {
    id: 6,
    winCondition: CampaignWinCondition.DestroyFactories,
    introText:
      "Act 2: Sabotage. I have located a forward assembly line. They are churning out armor at an unprecedented rate. I need to level the primary Factory structures to stem the tide.",
    outroText:
      "Assembly lines demolished. But they managed to deploy a new trench-layer unit before the collapse. The terrain is shifting.",
    mapGrid: buildLevel6Grid(),
  },
  {
    id: 7,
    winCondition: CampaignWinCondition.DefuseBombs,
    introText:
      "The Constructors were laying groundwork for a demolition trap. Scans detect three high-yield explosives with active countdowns. I have 90 seconds to reach and defuse them before this sector goes critical.",
    outroText:
      "Threat neutralized. Blast averted. But the explosives were rigged with a secondary data-wipe. I need to find the scattered backup drives.",
    mapGrid: buildLevel7Grid(),
  },
  {
    id: 8,
    winCondition: CampaignWinCondition.RetrieveIntel,
    introText:
      "The backup drives were scattered across this sector. I need to recover all 8 Intel packages. Warning: I am picking up erratic movement patterns. Minelayers are in the area.",
    outroText:
      "Intel secured. The data points directly to a heavily fortified canyon. It is an ambush chokepoint, but the only way forward.",
    mapGrid: buildLevel8Grid(),
  },
  {
    id: 9,
    winCondition: CampaignWinCondition.Escort,
    introText:
      "An allied data-carrier truck is stranded in the canyon. It holds the decryption keys for the core. I must escort it to the northern extraction pad. If it is destroyed, the campaign fails.",
    outroText:
      "Carrier secured. The keys are decrypting... Scans show a massive artillery platform locking onto my position. I need to move NOW.",
    mapGrid: buildLevel9Grid(),
  },
  {
    id: 10,
    winCondition: CampaignWinCondition.AssassinateBoss,
    introText:
      "The keys decrypted. The data points here—a massive siege platform locking onto my coordinates. If I stop moving, I am dead.",
    outroText:
      "Platform destroyed. Act 2 Complete. I have the location of the logic core. Time to end this.",
    mapGrid: buildLevel10Grid(),
  },
  {
    id: 11,
    winCondition: CampaignWinCondition.ReachExtraction,
    introText:
      "Act 3: System Collapse. I have breached the inner perimeter. The architecture here is mostly synthetic steel and coolant rivers. Scans show elite Shield units guarding the extraction point.",
    outroText:
      "Extraction point reached. But they are deploying electronic warfare units. My fire-control systems are being throttled.",
    mapGrid: buildLevel11Grid(),
  },
  {
    id: 12,
    winCondition: CampaignWinCondition.SurviveTime,
    introText:
      "Systems jammed! They are trapping me in the coolant basins. I have to survive for 60 seconds and hunt down their Jammer tanks to restore my weapons.",
    outroText:
      "Signal restored. Ambush survived. The Protocol is getting desperate.",
    mapGrid: buildLevel12Grid(),
  },
  {
    id: 13,
    winCondition: CampaignWinCondition.DestroyRadars,
    introText:
      "The Protocol is hiding a massive server cluster nearby. I need to take out 6 Radar towers to triangulate its position. Warning: Scans show anomalies in the item drops. Trust nothing.",
    outroText:
      "Towers destroyed. Triangulation complete. The coordinates lead to a heavily fortified bunker. I am going in.",
    mapGrid: buildLevel13Grid(),
  },
  {
    id: 14,
    winCondition: CampaignWinCondition.DefuseBombs,
    introText:
      "It is a trap! The bunker is rigged with dirty bombs, and they just dropped a Juggernaut-class siege unit into the arena to ensure I do not leave. 90 seconds until detonation.",
    outroText:
      "Bombs defused. Juggernaut scrapped. The path to their primary energy weapon is clear.",
    mapGrid: buildLevel14Grid(),
  },
  {
    id: 15,
    winCondition: CampaignWinCondition.AssassinateBoss,
    introText:
      "The elevator stopped. It is an ambush. A Warden-class siege tank is blocking the descent.",
    outroText:
      "Elevator reached the bottom. Welcome to the mainframe.",
    mapGrid: buildLevel15Grid(),
  },
  {
    id: 16,
    winCondition: CampaignWinCondition.DestroyRadars,
    introText:
      "Act 4: The Logic Core. I need to sever the 4 security relays. Warning: My optical sensors are glitching. They have stealth units in the dark.",
    outroText:
      "Relays destroyed. The inner doors are unlocking.",
    mapGrid: buildLevel16Grid(),
  },
  {
    id: 17,
    winCondition: CampaignWinCondition.ZoneControl,
    introText:
      "I have reached the primary firewall. I need to hold the central uplink for 60 seconds to upload the override virus. Warning: Heavy stealth and shield activity detected.",
    outroText:
      "Override successful. The firewall is down.",
    mapGrid: buildLevel17Grid(),
  },
  {
    id: 18,
    winCondition: CampaignWinCondition.RetrieveIntel,
    introText:
      "The virus fragmented the security keys across this sector. I must retrieve all 8 data clusters to unlock the blast doors.",
    outroText:
      "Keys assembled. The blast doors are opening.",
    mapGrid: buildLevel18Grid(),
  },
  {
    id: 19,
    winCondition: CampaignWinCondition.ReachExtraction,
    introText:
      "This is the final corridor to the Logic Core. They are collapsing the tunnel behind me. Do not stop moving.",
    outroText:
      "I am in. The Logic Core is dead ahead. There is no turning back.",
    mapGrid: buildLevel19Grid(),
  },
  {
    id: 20,
    winCondition: CampaignWinCondition.AssassinateBoss,
    introText:
      "This is it. The Obsidian Protocol Logic Core. It is heavily armored and armed with a 360-degree radial defense matrix. Destroy the Core. End the war.",
    outroText:
      "Core destabilized. Protocol deactivated. The war is over. Outstanding work, Commander.",
    mapGrid: buildLevel20Grid(),
  },
];
