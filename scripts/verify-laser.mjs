/**
 * Checks the cutting lance against its three rules:
 *   - it deals its damage to every hull in the line
 *   - it cuts at most LASER_BRICK_LIMIT brick tiles and is spent on the last
 *   - it does not scratch steel, and stops against it
 *
 * Usage: node scripts/verify-laser.mjs [ws://host:port]
 */
import { Client } from "colyseus.js";
import {
  GRID_WIDTH,
  LASER_BRICK_LIMIT,
  LASER_DAMAGE,
  LASER_UNLOCK_LEVEL,
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
const room = await client.create("campaign_room", { name: "lance" });
for (const t of ["shield_changed", "teleport_changed", "blast_changed", "ram_changed",
                 "decoy_changed", "tank_destroyed", "steel_hit", "boss_bounce",
                 "mortar_warning", "mine_detonated", "grapple_hit", "welcome",
                 "boon_collected", "match_stats", "strike_changed", "emp_changed",
                 "emp_fired"]) room.onMessage(t, () => {});

let offer = null;
room.onMessage("upgrade_offer", (m) => { offer = m; });
let laserCd = null;
room.onMessage("laser_changed", (m) => { laserCd = m.cooldownMs; });
const beams = [];
room.onMessage("laser_fired", (m) => beams.push(m));

room.send("start_campaign");
await waitFor(room, (s) => s.phase === "intro", "intro");

// The player's own hull, by session: friendly carriers are also `isEnemy: false`.
const me = () => [...room.state.tanks].find((t) => t.ownerId === room.sessionId);
const tileAt = (tx, ty) => room.state.grid[ty * GRID_WIDTH + tx];
const countTiles = (kind) => [...room.state.grid].filter((t) => t === kind).length;

/** Clears a level; a level whose objective summons a wave needs two presses. */
async function clear() {
  room.send("start_level");
  await waitFor(room, (s) => s.phase === "playing", "playing");
  offer = null;
  room.send("cheat_win");
  await sleep(500);
  if (room.state.phase === "playing") room.send("cheat_win");
  await waitFor(room, (s) => s.phase === "outro" || s.phase === "campaign_complete", "outro");
  await sleep(150);
  // Take the lance upgrade only where it would change the numbers under test.
  if (offer?.ids.length) {
    const pick = offer.ids.find((id) => id !== "laserup") ?? offer.ids[0];
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

console.log(`\nwalking to level ${LASER_UNLOCK_LEVEL} (lance unlock)`);
await play(LASER_UNLOCK_LEVEL);
await sleep(500);

// --------------------------------------------------------------- locked before
console.log("\nthe lance is not handed over early");
check("level is the unlock level", room.state.currentLevel === LASER_UNLOCK_LEVEL,
  `level=${room.state.currentLevel}`);

// ------------------------------------------------------------------ it fires
console.log("\nfiring");
beams.length = 0;
laserCd = null;
room.send("laser");
await sleep(400);
check("beam is broadcast", beams.length === 1, `${beams.length} beam(s)`);
check("lance goes on cooldown", (laserCd ?? 0) > 0, `cd=${laserCd}`);

const beforeCd = laserCd;
room.send("laser");
await sleep(300);
check("a second shot is refused while cooling", laserCd === beforeCd && beams.length === 1,
  `cd=${laserCd}, ${beams.length} beam(s)`);

// -------------------------------------------------------------------- damage
console.log("\ndamage");
await waitFor(room, () => (laserCd ?? 1) === 0, "lance ready", 30000);

let damaged = false;
for (let attempt = 0; attempt < 500 && !damaged; attempt++) {
  const self = me();
  const targets = [...room.state.tanks].filter((t) => t.isEnemy && !t.isBoss && !t.isCloaked);
  if (!self || targets.length === 0) { await sleep(80); continue; }

  // Line up on a target's row or column, then cut along it.
  const target = targets[0];
  const dx = target.x - self.x;
  const dy = target.y - self.y;
  const alignedX = Math.abs(dx) < TILE_SIZE * 0.6;
  const alignedY = Math.abs(dy) < TILE_SIZE * 0.6;

  if (alignedX || alignedY) {
    const dir = alignedX ? (dy > 0 ? "down" : "up") : (dx > 0 ? "right" : "left");
    room.send("move", { dir });
    await sleep(120);
    const hpBefore = target.currentHealth;
    const idBefore = target.ownerId;
    room.send("laser");
    await sleep(400);
    const after = [...room.state.tanks].find((t) => t.ownerId === idBefore);
    const dealt = after ? hpBefore - after.currentHealth : hpBefore;
    if (dealt > 0) {
      console.log(`    hp ${hpBefore} -> ${after ? after.currentHealth : "destroyed"}`);
      check("deals its full damage", dealt >= Math.min(LASER_DAMAGE, hpBefore),
        `dealt ${dealt}, expected ${Math.min(LASER_DAMAGE, hpBefore)}`);
      damaged = true;
    }
    await waitFor(room, () => (laserCd ?? 1) === 0, "lance ready", 30000);
  } else {
    room.send("move", {
      dir: Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up"),
    });
    await sleep(80);
  }
}
check("landed the beam on something", damaged);

// ------------------------------------------------------- brick budget & steel
// Level 29's labyrinth is the only map past the unlock with brick thicker than
// the lance's budget, which is what makes the cap testable at all: on a map
// whose walls are two tiles thick, "cuts three" and "cuts everything in front
// of it" look exactly the same.
console.log(`\ncutting (level ${LASER_UNLOCK_LEVEL + 1}, where the walls are thick enough to bind)`);
await clear();
await play(LASER_UNLOCK_LEVEL + 1);
await sleep(500);

const steelBefore = countTiles(2);
await waitFor(room, () => (laserCd ?? 0) === 0, "lance ready", 30000);

let fired = false;
for (let attempt = 0; attempt < 400 && !fired; attempt++) {
  const self = me();
  if (!self) { await sleep(80); continue; }

  // Look along each cardinal for a run of brick starting within a few tiles.
  const tx = Math.round(self.x / TILE_SIZE);
  const ty = Math.round(self.y / TILE_SIZE);
  const dirs = [["up", 0, -1], ["right", 1, 0], ["down", 0, 1], ["left", -1, 0]];

  for (const [name, dx, dy] of dirs) {
    let bricks = 0;
    let blockedFirst = false;
    for (let step = 1; step <= 10; step++) {
      const t = tileAt(tx + dx * step, ty + dy * step);
      if (t === undefined) break;
      if (t === 2 || t === 4 || t === 5 || t === 8) { blockedFirst = bricks === 0; break; }
      if (t === 1) bricks++;
    }
    // Want a run thicker than the budget, so the cap is actually exercised.
    if (bricks > LASER_BRICK_LIMIT && !blockedFirst) {
      room.send("move", { dir: name });
      await sleep(150);
      const brickBefore = countTiles(1);
      beams.length = 0;
      room.send("laser");
      await sleep(400);
      const cut = brickBefore - countTiles(1);
      console.log(`    facing ${name}: ${bricks} brick in line, cut ${cut}`);
      check("cuts exactly its budget through a thick wall", cut === LASER_BRICK_LIMIT,
        `cut ${cut}, budget ${LASER_BRICK_LIMIT}`);
      check("the wall is not opened all the way through", cut < bricks,
        `cut ${cut} of ${bricks}`);
      fired = true;
      break;
    }
  }

  if (!fired) {
    room.send("move", { dir: ["up", "right", "down", "left"][attempt % 4] });
    await sleep(80);
  }
}
check("found a wall thicker than the budget", fired);
check("steel is untouched", countTiles(2) === steelBefore,
  `${steelBefore} -> ${countTiles(2)}`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
await room.leave(true);
process.exit(failures === 0 ? 0 : 1);
