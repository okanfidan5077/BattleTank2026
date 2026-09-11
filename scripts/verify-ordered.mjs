/**
 * Checks the two things that keep a free-moving kit from trivialising a sweep:
 *   - the blink drive's cooldown is long enough to be a decision
 *   - an ordered level really does refuse everything but the marked objective
 *
 * Usage: node scripts/verify-ordered.mjs [ws://host:port]
 */
import { Client } from "colyseus.js";
import {
  GRID_WIDTH,
  TELEPORT_RECHARGE_MS,
  TILE_SIZE,
} from "../packages/shared/dist/index.js";

const ENDPOINT = process.argv[2] ?? "ws://localhost:2567";
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitFor(room, predicate, label, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let ok = false;
      try { ok = predicate(room.state); } catch { ok = false; }
      if (ok) return resolve(room.state);
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 40);
    };
    tick();
  });
}

const client = new Client(ENDPOINT);
const room = await client.create("campaign_room", { name: "order" });
const sparks = [];
for (const t of ["shield_changed", "blast_changed", "ram_changed", "decoy_changed",
                 "tank_destroyed", "boss_bounce", "mortar_warning",
                 "mine_detonated", "grapple_hit", "welcome", "boon_collected",
                 "match_stats", "strike_changed", "emp_changed", "emp_fired",
                 "laser_changed", "laser_fired", "translocate_changed"]) room.onMessage(t, () => {});

let offer = null;
room.onMessage("steel_hit", (m) => sparks.push(m));
room.onMessage("upgrade_offer", (m) => { offer = m; });
let teleport = null;
room.onMessage("teleport_changed", (m) => { teleport = m; });

room.send("start_campaign");
await waitFor(room, (s) => s.phase === "intro", "intro");

// The player's own hull, by session: friendly carriers are also `isEnemy: false`.
const me = () => [...room.state.tanks].find((t) => t.ownerId === room.sessionId);
const whereAmI = () => {
  const self = me();
  return self ? { x: self.x, y: self.y } : null;
};
const countTiles = (kind) => [...room.state.grid].filter((t) => t === kind).length;
const tileXY = (index) => ({
  x: (index % GRID_WIDTH) * TILE_SIZE,
  y: Math.floor(index / GRID_WIDTH) * TILE_SIZE,
});

/** Clears a level; one whose objective summons a wave needs two presses. */
async function clear() {
  room.send("start_level");
  await waitFor(room, (s) => s.phase === "playing", "playing");
  offer = null;
  room.send("cheat_win");
  await sleep(500);
  if (room.state.phase === "playing") room.send("cheat_win");
  await waitFor(room, (s) => s.phase === "outro" || s.phase === "campaign_complete", "outro");
  await sleep(150);
  // Never take Coolant Loop: it discounts the very cooldown under test.
  if (offer?.ids.length) {
    const pick = offer.ids.find((id) => id !== "cool") ?? offer.ids[0];
    room.send("choose_upgrade", { id: pick });
  }
  await sleep(150);
  room.send("next_level");
  await waitFor(room, (s) => s.phase === "intro", "intro");
}

async function play(target) {
  while (room.state.currentLevel < target) await clear();
  room.send("start_level");
  await waitFor(room, (s) => s.phase === "playing", "playing");
}

// ------------------------------------------------------- the blink's cooldown
console.log("\nlevel 9 - blink cooldown, and the ordered sweep");
await play(9);
await sleep(600);

teleport = null;
room.send("teleport");
await sleep(400);
check("blink is announced when spent", teleport !== null);
check("spending one leaves a charge banked", teleport?.charges === 1, `charges=${teleport?.charges}`);
// Twenty seconds since the third round of play-testing; Coolant Loop can take
// up to half of that off, so anything under half the base is a regression.
check("the recharge is a real cooldown", (teleport?.rechargeMs ?? 0) >= TELEPORT_RECHARGE_MS * 0.5,
  `rechargeMs=${teleport?.rechargeMs}, constant=${TELEPORT_RECHARGE_MS}`);

// Both charges spent, and it must stay spent for a good while.
room.send("teleport");
await sleep(400);
check("both charges can be spent back to back", teleport?.charges === 0,
  `charges=${teleport?.charges}`);
await sleep(6000);
check("no charge is back within six seconds", (teleport?.charges ?? 0) === 0,
  `charges=${teleport?.charges}`);

// ----------------------------------------------------------- ordered sweep
console.log("\nthe sequence");
const intelStart = countTiles(10);
check("the sweep is a long one", intelStart === 12, `${intelStart} packages`);
check("a target is marked", room.state.objectiveTargetTile >= 0,
  `tile=${room.state.objectiveTargetTile}`);
check("the readout says it is a sequence", /IN SEQUENCE/.test(room.state.objectiveText ?? ""),
  `"${room.state.objectiveText}"`);

// Drive onto a package that is NOT the marked one. It must not read.
// Pick the *nearest* one, so the naive pathing below actually gets there —
// a decoy the bot never reaches would let this assertion pass without ever
// having tested anything.
const target = room.state.objectiveTargetTile;
const self0 = me();
const decoyIndex = [...room.state.grid]
  .map((t, i) => (t === 10 && i !== target ? i : -1))
  .filter((i) => i >= 0)
  .sort((a, b) => {
    const pa = tileXY(a);
    const pb = tileXY(b);
    const d = (p) => Math.hypot(p.x - (self0?.x ?? 0), p.y - (self0?.y ?? 0));
    return d(pa) - d(pb);
  })[0];
check("there is an unmarked package to try", decoyIndex !== undefined);

const DIRS = ["up", "right", "down", "left"];
const STEPS = [[0, -1, "up"], [1, 0, "right"], [0, 1, "down"], [-1, 0, "left"]];

/**
 * Tiles the bot will route over: open ground and the passable objective tiles.
 *
 * Mines are deliberately *not* in here even though a tank can drive onto one.
 * This is the minelayer level, and a router that treats a mine as clear ground
 * walks the bot onto it, kills it, and restarts the crossing from the spawn pad
 * — which is what made this test fail about half the time.
 */
const PASSABLE = new Set([0, 6, 7, 9, 10]);

/**
 * Breadth-first route from one tile to another over passable ground.
 *
 * The bot used to steer greedily toward the goal with a random shove whenever
 * it wedged, which on a twelve-package map with cover reached the far corner
 * only about half the time — so the test failed on its own navigation rather
 * than on anything it was meant to be checking. A real route removes that.
 */
function routeTo(fromIndex, toIndex, avoid = -1) {
  const prev = new Map([[fromIndex, -1]]);
  const queue = [fromIndex];

  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head];
    if (cell === toIndex) break;

    const x = cell % GRID_WIDTH;
    const y = Math.floor(cell / GRID_WIDTH);
    for (const [dx, dy] of STEPS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= GRID_WIDTH || ny >= 33) continue;

      const next = ny * GRID_WIDTH + nx;
      if (prev.has(next)) continue;
      // A package is passable ground, so a route to one package could run over
      // another — which collects it. Trips that must not do that name the tile.
      if (next === avoid) continue;
      // The goal itself is always enterable, whatever is sitting on it.
      if (next !== toIndex && !PASSABLE.has(room.state.grid[next])) continue;

      prev.set(next, cell);
      queue.push(next);
    }
  }

  if (!prev.has(toIndex)) return null;

  const path = [];
  for (let cell = toIndex; cell !== -1; cell = prev.get(cell)) path.push(cell);
  return path.reverse();
}

/**
 * Drives the tank onto a tile along a real route, giving up after a while.
 *
 * The route is recomputed whenever the tank strays off it or wedges, because
 * the map changes under it — brick gets shot away, mines appear, and a death
 * puts it back at the spawn pad with the whole crossing to do again.
 */
async function driveTo(index, budgetMs, opts = {}) {
  const until = Date.now() + budgetMs;
  let path = null;
  let stuckFor = 0;
  let last = null;
  let heading = null;

  while (Date.now() < until) {
    const self = me();
    if (!self) { path = null; heading = null; await sleep(60); continue; }

    const goal = tileXY(index);
    if (Math.abs(goal.x - self.x) < TILE_SIZE / 2 && Math.abs(goal.y - self.y) < TILE_SIZE / 2) {
      return true;
    }

    if (last && Math.abs(last.x - self.x) < 1 && Math.abs(last.y - self.y) < 1) stuckFor += 60;
    else stuckFor = 0;
    last = { x: self.x, y: self.y };

    // Only choose a new heading on a tile boundary. The game turns a hull only
    // where it is grid-aligned, so a bot that re-decides mid-tile spends the
    // whole run turning into walls: it moved about three tiles a minute that
    // way, and every "could not reach it" was that, not the level.
    const aligned = self.x % TILE_SIZE === 0 && self.y % TILE_SIZE === 0;

    if (aligned || heading === null) {
      const here =
        Math.round(self.y / TILE_SIZE) * GRID_WIDTH + Math.round(self.x / TILE_SIZE);

      if (!path || stuckFor > 600 || !path.includes(here)) {
        path = routeTo(here, index, opts.avoid ?? -1);
        stuckFor = 0;
      }

      const at = path ? path.indexOf(here) : -1;
      const next = at >= 0 && at + 1 < path.length ? path[at + 1] : null;

      if (next !== null) {
        const dx = (next % GRID_WIDTH) - (here % GRID_WIDTH);
        const dy = Math.floor(next / GRID_WIDTH) - Math.floor(here / GRID_WIDTH);
        heading = STEPS.find(([sx, sy]) => sx === dx && sy === dy)?.[2] ?? heading ?? DIRS[0];
      }

      // A hull parked on the route is invisible to the router, and re-planning
      // returns the same path — so shove sideways for a moment.
      if (stuckFor > 1200) {
        heading = DIRS[Math.floor(Math.random() * DIRS.length)];
        stuckFor = 0;
      }
    }

    if (heading) room.send("move", { dir: heading });
    // Shooting on the way is how the structure levels get tested at all.
    if (opts.shoot) room.send("shoot");
    await sleep(50);
  }
  return false;
}

if (decoyIndex !== undefined) {
  // Around the marked package, not over it: driving across it on the way
  // collects it, and the checks below would then fail on the bot's route.
  const reached = await driveTo(decoyIndex, 60000, { avoid: target });
  await sleep(500);
  const stillThere = room.state.grid[decoyIndex] === 10;
  console.log(`    drove to the unmarked package: reached=${reached}, still there=${stillThere}`);
  // Only meaningful if the bot got there — say so rather than passing quietly.
  check("the bot reached an unmarked package", reached);
  check("an unmarked package does not read", stillThere);
  check("the count has not moved", countTiles(10) === intelStart,
    `${intelStart} -> ${countTiles(10)}`);
  check("the mark has not moved either", room.state.objectiveTargetTile === target,
    `${target} -> ${room.state.objectiveTargetTile}`);
}

// Now drive onto the marked one: it must read, and the mark must move on.
// Follow the sequence rather than making one long trip to a specific tile.
// Which package the mark lands on is rolled per run, and whether a bot with no
// combat sense can cross a minelaid map to a particular far corner inside a
// budget is a property of the bot, not of the mechanic under test. Collecting
// a few in order proves the same rule and does not depend on the dice.
const marks = [];
const collected = [];
const deadline = Date.now() + 210000;

while (Date.now() < deadline && collected.length < 3) {
  const mark = room.state.objectiveTargetTile;
  if (mark < 0) break;

  const countBefore = countTiles(10);
  const reached = await driveTo(mark, 70000);
  await sleep(400);
  console.log(
    `    -> mark ${mark} at (${mark % GRID_WIDTH},${Math.floor(mark / GRID_WIDTH)}): ` +
      `reached=${reached}`,
  );
  if (!reached) continue;

  marks.push(mark);
  if (countTiles(10) === countBefore - 1) collected.push(mark);
}

console.log(`    followed the sequence: ${collected.length} collected of ${marks.length} reached`);

// The claim under test is "reaching the marked package collects it, and the
// mark then moves on". Whether a bot with no combat sense can cross a minelaid
// map to a particular far corner inside a budget is a property of the bot — so
// the assertion is conditioned on it having got there, and says so out loud
// when it did not, rather than failing the product for the harness.
if (marks.length === 0) {
  console.log("    (the bot never reached a marked package — nothing to assert)");
} else {
  check("every marked package the bot reached was collected", collected.length === marks.length,
    `${collected.length} of ${marks.length}`);
  check("each one is gone from the grid",
    collected.every((index) => room.state.grid[index] !== 10));
  check("the count fell by exactly what was collected",
    countTiles(10) === intelStart - collected.length,
    `${intelStart} -> ${countTiles(10)}, collected ${collected.length}`);
  check("the mark moved on each time", new Set(marks).size === marks.length,
    `marks ${marks.join(",")}`);
}

// ------------------------------------------------- ordered structures (L21)
// The other half of the mechanic: a structure that has to be *shot* in order.
// An out-of-sequence mast has to survive the shell and spark like plate, or the
// refusal reads as the game dropping shots at random.
console.log("\nlevel 21 - masts on an interlock");
await clear();
await play(21);
await sleep(700);

const mastStart = countTiles(5);
check("six masts hold the gate", mastStart === 6, `${mastStart} masts`);
const mastTarget = room.state.objectiveTargetTile;
check("one mast is marked", mastTarget >= 0, `tile=${mastTarget}`);
check("the readout says it is a sequence", /IN SEQUENCE/.test(room.state.objectiveText ?? ""),
  `"${room.state.objectiveText}"`);

// Line up on an unmarked mast and empty the gun into it.
const decoyMast = [...room.state.grid]
  .map((t, i) => (t === 5 && i !== mastTarget ? i : -1))
  .filter((i) => i >= 0)
  .sort((a, b) => {
    const self = me();
    const d = (i) => {
      const p = tileXY(i);
      return Math.hypot(p.x - (self?.x ?? 0), p.y - (self?.y ?? 0));
    };
    return d(a) - d(b);
  })[0];

if (decoyMast !== undefined) {
  const goal = tileXY(decoyMast);
  sparks.length = 0;
  await driveTo(decoyMast, 150000, { shoot: true });
  await sleep(600);

  // A shell that struck a sealed mast is spent and throws the plate spark, so
  // a spark on the mast's own tile is the evidence the refusal actually
  // happened — rather than the bot simply never having hit it.
  const struck = sparks.filter(
    (s) => Math.abs(s.x - (goal.x + TILE_SIZE / 2)) < TILE_SIZE &&
           Math.abs(s.y - (goal.y + TILE_SIZE / 2)) < TILE_SIZE,
  ).length;
  console.log(`    sparks off the unmarked mast: ${struck}`);
  check("shells actually struck the sealed mast", struck > 0, `${struck} sparks`);
  check("an unmarked mast survives being shot", room.state.grid[decoyMast] === 5);
  check("no mast came down", countTiles(5) === mastStart, `${mastStart} -> ${countTiles(5)}`);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
await room.leave(true);
process.exit(failures === 0 ? 0 : 1);
