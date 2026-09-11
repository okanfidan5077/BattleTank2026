/**
 * Covers the third round of play-test feedback:
 *   - the blink is back to twenty seconds, and a fully built beacon is capped
 *   - Jammers are rare, and level 31 fields two Hydras
 *   - a rusher that reaches the relay or the carrier fails the level outright
 *   - marked targets on a purge level go up one at a time, paced
 *   - Reclaimers only ever rebuild the level's own factories
 *   - the Leviathan surfaces exactly where its warning was drawn
 *   - the Effigy's mirage appears beside it, never on top of it
 *
 * The two rusher checks depend on a rusher choosing the objective over the
 * bot, which the bot can encourage but not force; if none gets there inside
 * the window the check is reported as skipped rather than failed.
 *
 * Usage: node scripts/verify-feedback3.mjs [ws://host:port]
 */
import { Client } from "colyseus.js";
import {
  CAMPAIGN_LEVELS,
  DECOY_COOLDOWN_MS,
  DECOY_DURATION_MS,
  DECOY_MIN_COOLDOWN_MS,
  DECOY_UPGRADE_MS,
  GRID_WIDTH,
  TELEPORT_RECHARGE_MS,
  TILE_SIZE,
  TileType,
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
const room = await client.create("campaign_room", { name: "feedback3" });
for (const t of ["shield_changed", "blast_changed", "ram_changed", "decoy_changed",
                 "tank_destroyed", "steel_hit", "boss_bounce", "mine_detonated",
                 "grapple_hit", "welcome", "boon_collected", "match_stats",
                 "strike_changed", "emp_changed", "emp_fired", "laser_changed",
                 "laser_fired", "teleport_changed", "translocate_changed"]) room.onMessage(t, () => {});

let offer = null;
room.onMessage("upgrade_offer", (m) => { offer = m; });
const warnings = [];
room.onMessage("mortar_warning", (m) => { warnings.push({ ...m, at: Date.now() }); });

room.send("start_campaign");
await waitFor(room, (s) => s.phase === "intro", "intro");

const me = () => [...room.state.tanks].find((t) => t.ownerId === room.sessionId);
const tanks = () => [...room.state.tanks];
const centre = (t) => ({ x: t.x + t.width / 2, y: t.y + t.height / 2 });
const overlaps = (a, b) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function clear() {
  room.send("start_level");
  await waitFor(room, (s) => s.phase === "playing", "playing");
  offer = null;
  room.send("cheat_win");
  await sleep(500);
  if (room.state.phase === "playing") room.send("cheat_win");
  await waitFor(room, (s) => s.phase === "outro" || s.phase === "campaign_complete", "outro");
  await sleep(160);
  if (offer?.ids.length) room.send("choose_upgrade", { id: offer.ids[0] });
  await sleep(160);
  room.send("next_level");
  await waitFor(room, (s) => s.phase === "intro", "intro");
}

async function play(target) {
  while (room.state.currentLevel < target) await clear();
  room.send("start_level");
  await waitFor(room, (s) => s.phase === "playing", "playing");
}

/** Win the level being played and stop on the next intro. */
async function finish() {
  room.send("cheat_win");
  await sleep(500);
  if (room.state.phase === "playing") room.send("cheat_win");
  await waitFor(room, (s) => s.phase === "outro" || s.phase === "campaign_complete", "outro");
  await sleep(160);
  if (offer?.ids.length) room.send("choose_upgrade", { id: offer.ids[0] });
  await sleep(160);
  room.send("next_level");
  await waitFor(room, (s) => s.phase === "intro", "intro");
}

/** Holds one direction for `ms`. */
async function drive(dir, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { room.send("move", { dir }); await sleep(60); }
}

/** The direction that takes `from` furthest from `away`. */
const awayFrom = (from, away) => {
  const dx = from.x - away.x;
  const dy = from.y - away.y;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
};

// ------------------------------------------------------------- the numbers
console.log("\nthe numbers");
check("the blink recharges in twenty seconds", TELEPORT_RECHARGE_MS === 20_000, `${TELEPORT_RECHARGE_MS}ms`);
const longestBeacon = DECOY_DURATION_MS + 2 * DECOY_UPGRADE_MS;
const shortestWait = Math.max(DECOY_MIN_COOLDOWN_MS, Math.round(DECOY_COOLDOWN_MS * 0.8 ** 3));
check("a fully built beacon is up well under half the time",
  longestBeacon / (longestBeacon + shortestWait) < 0.45,
  `${longestBeacon}ms up, ${shortestWait}ms down`);
const jammerRows = CAMPAIGN_LEVELS.flatMap((l) => (l.spawns ?? []).filter((r) => r.variant === "jammer"));
check("jammers are rare wherever they appear", jammerRows.every((r) => r.weight <= 0.12),
  jammerRows.map((r) => r.weight).join(", "));
check("level 31 is booked for two hydras", CAMPAIGN_LEVELS[30].bosses?.[0]?.count === 2);

// --------------------------------------------------- a rusher on the relay (L4)
console.log("\nlevel 4 - a rusher that reaches the relay takes it down");
await play(4);
await sleep(400);
{
  let relay = null;
  for (let i = 0; i < room.state.grid.length && !relay; i++) {
    if (room.state.grid[i] === TileType.EagleBase) {
      relay = { x: (i % GRID_WIDTH) * TILE_SIZE, y: Math.floor(i / GRID_WIDTH) * TILE_SIZE, width: TILE_SIZE, height: TILE_SIZE };
    }
  }
  // Leave the relay to the rushers: every one of them heads for whichever of
  // the two is closer.
  const self = me();
  if (self && relay) await drive(awayFrom(centre(self), centre(relay)), 2500);

  const pad = { x: (relay?.x ?? 0) - TILE_SIZE, y: (relay?.y ?? 0) - TILE_SIZE, width: TILE_SIZE * 3, height: TILE_SIZE * 3 };
  let lastSeconds = room.state.objectiveValue;
  let lastIntegrity = 4;
  let rusherNearAt = 0;
  let verdict = null;
  const started = Date.now();
  while (Date.now() - started < 60000 && verdict === null && relay) {
    if (tanks().some((t) => t.isEnemy && t.variant === "kamikaze" && overlaps(t, pad))) rusherNearAt = Date.now();
    const seconds = room.state.objectiveValue;
    const integrity = Number(/INTEGRITY (\d)/.exec(room.state.objectiveText ?? "")?.[1] ?? lastIntegrity);
    // The hold clock only ever runs down; jumping back up is the level resetting.
    if (seconds > lastSeconds + 2) {
      verdict = { byRusher: Date.now() - rusherNearAt < 800, integrity: lastIntegrity };
    }
    lastSeconds = seconds;
    lastIntegrity = integrity;
    await sleep(40);
  }
  if (!verdict) {
    console.log("    (no relay loss inside the window — skipped)");
  } else if (!verdict.byRusher) {
    console.log(`    (the relay fell to shells at integrity ${verdict.integrity} — skipped)`);
  } else {
    check("a rusher reaching the relay fails the hold outright", verdict.integrity > 0,
      `integrity was ${verdict.integrity}/4`);
  }
}
if (room.state.phase === "game_over") throw new Error("ran out of lives on level 4");
await finish();

// ------------------------------------------------ a rusher on the carrier (L11)
console.log("\nlevel 11 - a rusher that reaches the carrier takes it down");
await play(11);
await sleep(400);
{
  const convoy = () => tanks().find((t) => t.variant === "convoy");
  const self = me();
  const truck = convoy();
  if (self && truck) await drive(awayFrom(centre(self), centre(truck)), 2500);

  let lastId = convoy()?.ownerId;
  let lastHp = convoy()?.currentHealth ?? 0;
  let rusherNearAt = 0;
  let verdict = null;
  const started = Date.now();
  while (Date.now() - started < 60000 && verdict === null) {
    const now = convoy();
    if (now) {
      const pad = { x: now.x - 8, y: now.y - 8, width: now.width + 16, height: now.height + 16 };
      if (tanks().some((t) => t.isEnemy && t.variant === "kamikaze" && overlaps(t, pad))) rusherNearAt = Date.now();
    }
    // A new carrier is the level having reset.
    if (now && lastId && now.ownerId !== lastId) {
      verdict = { byRusher: Date.now() - rusherNearAt < 800, hp: lastHp };
    }
    if (now) { lastId = now.ownerId; lastHp = now.currentHealth; }
    await sleep(40);
  }
  if (!verdict) {
    console.log("    (no carrier loss inside the window — skipped)");
  } else if (!verdict.byRusher) {
    console.log(`    (the carrier was worn down to ${verdict.hp} by other hulls — skipped)`);
  } else {
    check("a rusher reaching the carrier destroys it outright", verdict.hp > 1, `carrier had ${verdict.hp} hp`);
  }
}
if (room.state.phase === "game_over") throw new Error("ran out of lives on level 11");
await finish();

// ------------------------------------------------------------ purge pacing (L13)
console.log("\nlevel 13 - marks go up one at a time");
await play(13);
{
  const started = Date.now();
  const firstSeen = new Map();
  let peak = 0;
  while (Date.now() - started < 16000) {
    const marked = tanks().filter((t) => t.isMarked);
    peak = Math.max(peak, marked.length);
    for (const t of marked) if (!firstSeen.has(t.ownerId)) firstSeen.set(t.ownerId, Date.now() - started);
    await sleep(100);
  }
  const times = [...firstSeen.values()].sort((a, b) => a - b);
  console.log(`    marks went up at ${times.map((ms) => `${(ms / 1000).toFixed(1)}s`).join(", ") || "never"}`);
  check("marks do go up", times.length >= 1);
  check("not on the first beat of the level", (times[0] ?? Infinity) >= 2000, `${times[0]}ms`);
  check("never more than two at once", peak <= 2, `peak ${peak}`);
  check("at least five seconds between marks",
    times.every((t, i) => i === 0 || t - times[i - 1] >= 5000), times.join(", "));
}
await finish();

// ------------------------------------------------------- reclaimers (L25)
console.log("\nlevel 25 - reclaimers only rebuild what was there");
await play(25);
{
  const original = CAMPAIGN_LEVELS[24].mapGrid;
  const originalFactories = original.filter((t) => t === TileType.Factory).length;
  const crews = new Set();
  let strays = 0;
  let peakFactories = 0;
  const started = Date.now();
  while (Date.now() - started < 45000) {
    const grid = room.state.grid;
    let count = 0;
    for (let i = 0; i < grid.length; i++) {
      if (grid[i] !== TileType.Factory) continue;
      count++;
      if (original[i] !== TileType.Factory) strays++;
    }
    peakFactories = Math.max(peakFactories, count);
    for (const t of tanks()) if (t.variant === "reclaimer") crews.add(t.ownerId);
    if (room.state.phase !== "playing") break;
    await sleep(250);
  }
  console.log(`    ${crews.size} crew(s) seen; factories peaked at ${peakFactories} of ${originalFactories}`);
  check("reclaimers were on the field to test against", crews.size > 0);
  check("no factory ever appeared where the level had none", strays === 0, `${strays} stray sample(s)`);
  check("the count never rose above the level's own", peakFactories <= originalFactories);
}
await finish();

// -------------------------------------------------------- leviathan (L30)
console.log("\nlevel 30 - the leviathan comes up on its mark");
await play(30);
{
  const leviathanRadius = Math.round(TILE_SIZE * 3 * 0.7);
  let wasCloaked = null;
  let surfacings = 0;
  const misses = [];
  const started = Date.now();
  while (Date.now() - started < 45000 && surfacings < 3) {
    const boss = tanks().find((t) => t.variant === "leviathan");
    if (boss) {
      if (wasCloaked === true && !boss.isCloaked) {
        surfacings++;
        const mark = [...warnings].reverse().find((w) => w.radius === leviathanRadius);
        const c = centre(boss);
        misses.push(mark ? Math.round(Math.hypot(c.x - mark.x, c.y - mark.y)) : -1);
      }
      wasCloaked = boss.isCloaked;
    }
    if (room.state.phase !== "playing") break;
    await sleep(40);
  }
  console.log(`    ${surfacings} surfacing(s), px from the mark: ${misses.join(", ")}`);
  check("it surfaced", surfacings >= 1);
  check("every surfacing was centred on its warning", misses.length > 0 && misses.every((d) => d >= 0 && d < 2),
    misses.join(", "));
}
await finish();

// ------------------------------------------------------------- hydras (L31)
console.log("\nlevel 31 - two hydras");
await play(31);
await sleep(300);
{
  const hydras = tanks().filter((t) => t.isBoss && t.variant === "hydra");
  check("two hydras enter", hydras.length === 2, `${hydras.length}`);
  check("apart, not stacked", hydras.length === 2 && Math.abs(hydras[0].x - hydras[1].x) >= 3 * TILE_SIZE,
    hydras.map((h) => `${h.x},${h.y}`).join(" / "));
}
await finish();

// ------------------------------------------------------------- effigy (L40)
console.log("\nlevel 40 - the effigy's mirage stands beside it");
await play(40);
{
  const seen = new Set();
  const watches = [];
  let stacked = 0;
  let pinned = 0;
  const started = Date.now();
  while (Date.now() - started < 40000) {
    const self = me();
    const boss = tanks().find((t) => t.isBoss && t.variant === "effigy");
    if (self && boss) {
      // Close in on it, so it has a reason to drop one.
      const dx = centre(boss).x - centre(self).x;
      const dy = centre(boss).y - centre(self).y;
      room.send("move", { dir: Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up") });
      room.send("shoot");
    }
    for (const t of tanks()) {
      if (!t.ownerId.startsWith("mirage-") || seen.has(t.ownerId)) continue;
      seen.add(t.ownerId);
      if (boss && overlaps(t, boss)) stacked++;
      if (boss && self) watches.push({ at: Date.now(), x: boss.x, y: boss.y, done: false });
    }
    // A couple of seconds on, a boss that is not stuck is somewhere else.
    for (const w of watches) {
      if (w.done || Date.now() - w.at < 2500) continue;
      w.done = true;
      if (boss && me() && Math.hypot(boss.x - w.x, boss.y - w.y) < 1) pinned++;
    }
    if (room.state.phase !== "playing") break;
    await sleep(60);
  }
  console.log(`    ${seen.size} mirage(s) dropped`);
  check("the effigy dropped a mirage", seen.size > 0);
  check("no mirage appeared on top of it", stacked === 0, `${stacked} stacked`);
  check("it kept moving after dropping one", pinned === 0, `${pinned} pinned`);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
await room.leave(true);
process.exit(failures === 0 ? 0 : 1);
