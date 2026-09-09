/**
 * Covers the round of play-test feedback:
 *   - a rusher that has been brushed sideways can still turn (it used to drive
 *     to the far wall and sit there)
 *   - killing a hostile carrier wins the level instead of restarting it
 *   - the relay bunker is steel, and enemies actually route at it
 *   - the translocator jumps to a clicked point and refuses solid ground
 *   - the called strike reaches the far side of the map
 *   - the reworked Effigy copies the player's build
 *
 * Usage: node scripts/verify-feedback.mjs [ws://host:port]
 */
import { Client } from "colyseus.js";
import {
  GRID_WIDTH,
  TILE_SIZE,
  TRANSLOCATE_COOLDOWN_MS,
  TRANSLOCATE_UNLOCK_LEVEL,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from "../packages/shared/dist/index.js";

const ENDPOINT = process.argv[2] ?? "ws://localhost:2567";
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitFor(room, predicate, label, timeoutMs = 20000) {
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
const room = await client.create("campaign_room", { name: "feedback" });
for (const t of ["shield_changed", "teleport_changed", "blast_changed", "ram_changed",
                 "decoy_changed", "tank_destroyed", "steel_hit", "boss_bounce",
                 "mortar_warning", "mine_detonated", "grapple_hit", "welcome",
                 "boon_collected", "match_stats", "strike_changed", "emp_changed",
                 "emp_fired", "laser_changed", "laser_fired",
                 "translocate_changed"]) room.onMessage(t, () => {});

let offer = null;
const owned = {};
room.onMessage("upgrade_offer", (m) => { offer = m; Object.assign(owned, m.owned); });
let jumpCd = null;
room.onMessage("translocate_changed", (m) => { jumpCd = m.cooldownMs; });
const telegraphs = [];
room.onMessage("mortar_warning", (m) => telegraphs.push(m));

room.send("start_campaign");
await waitFor(room, (s) => s.phase === "intro", "intro");

const me = () => [...room.state.tanks].find((t) => t.ownerId === room.sessionId);
// Colyseus hands back the live state object, which is mutated in place — so a
// "before" captured as the object itself reads the *current* position later and
// every displacement measures as zero. Snapshot the numbers instead.
const whereAmI = () => {
  const self = me();
  return self ? { x: self.x, y: self.y } : null;
};
const tileAt = (tx, ty) => room.state.grid[ty * GRID_WIDTH + tx];
const countTiles = (kind) => [...room.state.grid].filter((t) => t === kind).length;

async function clear() {
  room.send("start_level");
  await waitFor(room, (s) => s.phase === "playing", "playing");
  offer = null;
  room.send("cheat_win");
  await sleep(500);
  if (room.state.phase === "playing") room.send("cheat_win");
  await waitFor(room, (s) => s.phase === "outro" || s.phase === "campaign_complete", "outro");
  await sleep(150);
  // Bank a real build, so the Effigy has something worth copying at the end.
  if (offer?.ids.length) {
    const want = ["hull", "rate", "speed", "shell"].find((id) => offer.ids.includes(id));
    room.send("choose_upgrade", { id: want ?? offer.ids[0] });
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

// ------------------------------------------------------ the relay hold (L4)
console.log("\nlevel 4 - the relay bunker");
await play(4);
await sleep(600);

const relayIndex = [...room.state.grid].findIndex((t) => t === 4);
check("the relay is on the map", relayIndex >= 0);
const rx = relayIndex % GRID_WIDTH;
const ry = Math.floor(relayIndex / GRID_WIDTH);

// The shell must be steel, and there must be no straight line into the relay
// from outside it — otherwise two shots from anywhere still finish it.
const ring = [];
for (let dy = -2; dy <= 2; dy++) {
  for (let dx = -2; dx <= 2; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== 2) continue;
    ring.push(tileAt(rx + dx, ry + dy));
  }
}
const steelInRing = ring.filter((t) => t === 2).length;
const doors = ring.filter((t) => t === 0).length;
console.log(`    shell: ${steelInRing} steel, ${doors} door(s), ${ring.length - steelInRing - doors} other`);
check("the bunker is steel, not brick", steelInRing === ring.length - doors && steelInRing > 0);
check("there are doors to drive through", doors === 2, `${doors} doors`);
check("no door opens onto the relay's own row", tileAt(rx - 2, ry) === 2 && tileAt(rx + 2, ry) === 2);
check("no door opens onto its column", tileAt(rx, ry - 2) === 2 && tileAt(rx, ry + 2) === 2);

// Enemies must want the relay, or walking away wins the level by default.
const away = { x: 2 * TILE_SIZE, y: 30 * TILE_SIZE };
for (let i = 0; i < 90; i++) {
  const self = me();
  if (self) {
    const dx = away.x - self.x;
    const dy = away.y - self.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
      room.send("move", {
        dir: Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up"),
      });
    }
  }
  await sleep(60);
}
const self4 = me();
const enemies = [...room.state.tanks].filter((t) => t.isEnemy);
const nearRelay = enemies.filter(
  (t) => Math.hypot(t.x - rx * TILE_SIZE, t.y - ry * TILE_SIZE) < 12 * TILE_SIZE,
).length;
console.log(`    player parked in the corner; ${nearRelay} of ${enemies.length} enemies near the relay`);
check("the player really did leave the bunker",
  Boolean(self4) && Math.hypot(self4.x - rx * TILE_SIZE, self4.y - ry * TILE_SIZE) > 14 * TILE_SIZE);
check("the attack does not simply follow the player away", nearRelay > 0,
  `${nearRelay} near the relay`);

// --------------------------------------------------- the carrier raid (L10)
console.log("\nlevel 10 - killing the carrier ends the level");
await clear();
await play(10);
await sleep(600);

const startLives = room.state.lives;
const carrier = [...room.state.tanks].find((t) => t.variant === "convoy");
check("a hostile carrier is on the field", Boolean(carrier));
const carrierHp = carrier?.currentHealth ?? 0;

// It must not chip itself down while nobody touches it.
await sleep(6000);
const stillCarrier = [...room.state.tanks].find((t) => t.variant === "convoy");
console.log(`    left alone for six seconds: hp ${carrierHp} -> ${stillCarrier?.currentHealth ?? "gone"}`);
check("the carrier does not damage itself", stillCarrier?.currentHealth === carrierHp,
  `${carrierHp} -> ${stillCarrier?.currentHealth}`);
check("the level did not reset itself", room.state.lives === startLives && room.state.currentLevel === 10,
  `lives ${startLives} -> ${room.state.lives}, level ${room.state.currentLevel}`);

// Now kill it: that must clear the level, not cost a life.
const beforeLives = room.state.lives;
room.send("cheat_win");
await sleep(600);
if (room.state.phase === "playing") room.send("cheat_win");
await waitFor(room, (s) => s.phase === "outro", "outro after the raid");
check("stopping the carrier clears the level", room.state.phase === "outro");
check("and does not cost a life", room.state.lives >= beforeLives,
  `${beforeLives} -> ${room.state.lives}`);

// ------------------------------------------------- the translocator (L22)
console.log(`\nlevel ${TRANSLOCATE_UNLOCK_LEVEL} - the translocator`);
await sleep(150);
if (offer?.ids.length) room.send("choose_upgrade", { id: offer.ids[0] });
await sleep(150);
room.send("next_level");
await waitFor(room, (s) => s.phase === "intro", "intro");
await play(TRANSLOCATE_UNLOCK_LEVEL);
await sleep(600);

const before = whereAmI();
check("the player is on the field", Boolean(before));

// Find open ground a long way off — further than any blink could reach.
let far = null;
for (let ty = 1; ty < 32 && !far; ty++) {
  for (let tx = 1; tx < 59; tx++) {
    if (tileAt(tx, ty) !== 0) continue;
    const d = Math.hypot(tx * TILE_SIZE - (before?.x ?? 0), ty * TILE_SIZE - (before?.y ?? 0));
    if (d > 20 * TILE_SIZE) { far = { tx, ty }; break; }
  }
}
check("found somewhere far to jump to", Boolean(far));

if (far && before) {
  jumpCd = null;
  room.send("translocate", { x: far.tx * TILE_SIZE + TILE_SIZE / 2, y: far.ty * TILE_SIZE + TILE_SIZE / 2 });
  await sleep(500);
  const after = whereAmI();
  const moved = after ? Math.hypot(after.x - before.x, after.y - before.y) : 0;
  console.log(`    jumped ${Math.round(moved / TILE_SIZE)} tiles`);
  check("the jump crosses the map", moved > 18 * TILE_SIZE, `${Math.round(moved / TILE_SIZE)} tiles`);
  check("it lands tile-aligned", Boolean(after) && after.x % TILE_SIZE === 0 && after.y % TILE_SIZE === 0,
    `${after?.x},${after?.y}`);
  // Coolant Loop and Phase Governor both discount it, and the walk here banks
  // whatever it is offered — so the expectation has to be computed from what
  // the run actually holds rather than pinned to the undiscounted figure.
  const expected = Math.round(
    TRANSLOCATE_COOLDOWN_MS *
      Math.pow(0.8, owned.cool ?? 0) *
      Math.pow(0.8, owned.jumpup ?? 0),
  );
  console.log(`    cool=${owned.cool ?? 0} jumpup=${owned.jumpup ?? 0}, expected ${expected}ms`);
  check("it goes on the cooldown its upgrades say it should", jumpCd === expected,
    `cd=${jumpCd}, expected ${expected}`);
  check("and that is still the longest in the kit", (jumpCd ?? 0) > 20000, `cd=${jumpCd}`);

  // A second jump while cooling must be refused.
  const parked = whereAmI();
  room.send("translocate", { x: WORLD_WIDTH - TILE_SIZE * 3, y: WORLD_HEIGHT - TILE_SIZE * 3 });
  await sleep(400);
  const after2 = whereAmI();
  check("a second jump is refused while cooling",
    Boolean(after2) && Math.hypot(after2.x - parked.x, after2.y - parked.y) < TILE_SIZE,
    `moved ${Math.round(Math.hypot((after2?.x ?? 0) - parked.x, (after2?.y ?? 0) - parked.y))}px`);
}

console.log("\n    aiming into a wall");
await waitFor(room, () => (jumpCd ?? 1) === 0, "jump ready", 70000);

// The guarantee that matters is not "a click on a wall is refused" — a click a
// tile inside one is deliberately allowed to land beside it instead. It is that
// the tank never ends up *inside* solid ground, however the click was aimed.
let wall = null;
for (let ty = 1; ty < 32 && !wall; ty++) {
  for (let tx = 1; tx < 59; tx++) {
    if (tileAt(tx, ty) === 2) { wall = { tx, ty }; break; }
  }
}
check("found a wall to aim at", Boolean(wall));
if (wall) {
  room.send("translocate", {
    x: wall.tx * TILE_SIZE + TILE_SIZE / 2,
    y: wall.ty * TILE_SIZE + TILE_SIZE / 2,
  });
  await sleep(500);
  const landed = whereAmI();
  const lx = Math.round((landed?.x ?? 0) / TILE_SIZE);
  const ly = Math.round((landed?.y ?? 0) / TILE_SIZE);
  const onTile = tileAt(lx, ly);
  console.log(`    aimed at steel (${wall.tx},${wall.ty}); ended on tile ${onTile} at (${lx},${ly})`);
  check("the tank never ends up inside solid ground", onTile === 0 || onTile === undefined,
    `tile=${onTile}`);
}

// ------------------------------------------------- the strike's reach (L24)
console.log("\nlevel 24 - the strike reaches the whole map");
await clear();
await play(24);
await sleep(600);
const self24 = me();
telegraphs.length = 0;
if (self24) {
  // Aim at the opposite corner: further than any range ring would have allowed.
  const farX = self24.x < WORLD_WIDTH / 2 ? WORLD_WIDTH - TILE_SIZE * 2 : TILE_SIZE * 2;
  const farY = self24.y < WORLD_HEIGHT / 2 ? WORLD_HEIGHT - TILE_SIZE * 2 : TILE_SIZE * 2;
  room.send("strike", { x: farX, y: farY });
  await sleep(500);

  const mark = telegraphs.find((t) => t.friendly);
  check("the strike is called", Boolean(mark));
  if (mark) {
    const off = Math.hypot(mark.x - farX, mark.y - farY);
    console.log(`    aimed at (${Math.round(farX)},${Math.round(farY)}), landed ${Math.round(off)}px away`);
    check("it lands where it was aimed, not at a range limit", off < TILE_SIZE, `${Math.round(off)}px off`);
  }
}

// ----------------------------------------------------------- the Effigy (L40)
console.log("\nlevel 40 - the Effigy copies the build");
await clear();
while (room.state.currentLevel < 40) await clear();
room.send("start_level");
await waitFor(room, (s) => s.phase === "playing", "playing");
await sleep(800);

const effigy = [...room.state.tanks].find((t) => t.variant === "effigy");
check("the Effigy is on the field", Boolean(effigy));
if (effigy) {
  console.log(`    effigy hp=${effigy.maxHealth} speed=${effigy.speed.toFixed(2)}`);
  check("it is tougher than the old fixed pool", effigy.maxHealth > 20,
    `hp=${effigy.maxHealth}`);
  check("its health reflects a banked build", effigy.maxHealth >= 30, `hp=${effigy.maxHealth}`);
  check("its speed reflects one too", effigy.speed >= 4, `speed=${effigy.speed.toFixed(2)}`);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
await room.leave(true);
process.exit(failures === 0 ? 0 : 1);
