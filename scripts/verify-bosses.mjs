/**
 * Fights two campaign bosses with a scripted bot and checks the fixes that
 * only show up once damage is actually going in.
 *
 * Usage: node scripts/verify-bosses.mjs [ws://host:port]
 */
import { Client } from "colyseus.js";

const ENDPOINT = process.argv[2] ?? "ws://localhost:2567";
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitFor(room, predicate, label, timeoutMs = 10000) {
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
const room = await client.create("campaign_room", { name: "bot" });
for (const t of ["shield_changed","teleport_changed","blast_changed","ram_changed","decoy_changed",
                 "tank_destroyed","steel_hit","boss_bounce","mortar_warning","mine_detonated",
                 "grapple_hit","welcome","boon_collected","match_stats"]) room.onMessage(t, () => {});

let offer = null;
room.onMessage("upgrade_offer", (m) => { offer = m; });

room.send("start_campaign");
await waitFor(room, (s) => s.phase === "intro", "intro");

async function advance() {
  room.send("start_level");
  await waitFor(room, (s) => s.phase === "playing", "playing");
  offer = null;
  room.send("cheat_win");
  // A level whose objective summons a boss wave needs a second press: the
  // first meets the objective, the second clears what answered it.
  await sleep(500);
  if (room.state.phase === "playing") room.send("cheat_win");
  await waitFor(room, (s) => s.phase === "outro", "outro");
  await sleep(180);
  if (offer?.ids.length) room.send("choose_upgrade", { id: offer.ids[0] });
  await sleep(180);
  room.send("next_level");
  await waitFor(room, (s) => s.phase === "intro" || s.phase === "campaign_complete", "intro");
}

async function runTo(target) {
  while (room.state.currentLevel < target) await advance();
  room.send("start_level");
  await waitFor(room, (s) => s.phase === "playing", "playing");
}

// The player's own hull, by session — not merely "something friendly": the
// carrier levels put allied trucks on the field that are also `isEnemy: false`.
const me = () => [...room.state.tanks].find((t) => t.ownerId === room.sessionId);
const bossBodies = () => [...room.state.tanks].filter((t) => t.isBoss);

/** Drives at the nearest boss and fires, sampling state each step. */
async function fight(ms, onSample) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const self = me();
    const target = bossBodies()[0];
    if (self && target) {
      const dx = target.x + target.width / 2 - (self.x + self.width / 2);
      const dy = target.y + target.height / 2 - (self.y + self.height / 2);
      // Close the larger axis first, so the bot ends up lined up on the other.
      const dir = Math.abs(dx) > Math.abs(dy)
        ? (dx > 0 ? "right" : "left")
        : (dy > 0 ? "down" : "up");
      room.send("move", { dir });
      room.send("shoot");
    }
    onSample?.();
    await sleep(60);
  }
}

console.log("\nlevel 12 — artillery relocates every 5 hp");
await runTo(12);
let jumps = 0;
let lastHp = null;
let lastPos = null;
let hpAtJump = [];
await fight(45000, () => {
  const b = bossBodies()[0];
  if (!b) return;
  if (lastPos !== null) {
    const moved = Math.hypot(b.x - lastPos.x, b.y - lastPos.y);
    // A walk is a few px per sample; a relocation is the width of the map.
    if (moved > 8 * 32) { jumps++; hpAtJump.push(b.currentHealth); }
  }
  lastPos = { x: b.x, y: b.y };
  lastHp = b.currentHealth;
});
console.log(`    boss hp now ${lastHp}, relocations seen: ${jumps} at hp ${hpAtJump.join(",")}`);
check("artillery relocated at least once under fire", jumps >= 1, `${jumps} jump(s)`);
check("relocations track damage taken", jumps >= Math.floor((25 - (lastHp ?? 25)) / 5),
  `damage=${25 - (lastHp ?? 25)} jumps=${jumps}`);

console.log("\nlevel 31 — hydra fragments stay mobile");
room.send("cheat_win");
await waitFor(room, (s) => s.phase === "outro", "outro");
if (offer?.ids.length) room.send("choose_upgrade", { id: offer.ids[0] });
await sleep(180); room.send("next_level");
await waitFor(room, (s) => s.phase === "intro", "intro");
await runTo(31);

let maxBodies = 0;
let alignedSplits = 0;
let misalignedSplits = 0;
const seenIds = new Set();
const lastSeen = new Map();     // ownerId -> {x, y, stillMs}
await fight(70000, () => {
  const bodies = bossBodies();
  maxBodies = Math.max(maxBodies, bodies.length);
  for (const b of bodies) {
    if (!seenIds.has(b.ownerId)) {
      seenIds.add(b.ownerId);
      // A fragment is born on the lattice or it can never turn again.
      if (b.x % 32 === 0 && b.y % 32 === 0) alignedSplits++;
      else misalignedSplits++;
    }
    const prev = lastSeen.get(b.ownerId);
    const still = prev && Math.abs(prev.x - b.x) < 1 && Math.abs(prev.y - b.y) < 1;
    lastSeen.set(b.ownerId, { x: b.x, y: b.y, stillMs: still ? prev.stillMs + 60 : 0 });
  }
});
const wedged = [...lastSeen.values()].filter((e) => e.stillMs > 6000);
console.log(`    bodies seen: ${seenIds.size} (peak ${maxBodies} at once)`);
check("hydra actually split", seenIds.size > 1, `${seenIds.size} bodies`);
check("every fragment spawned tile-aligned", misalignedSplits === 0,
  `aligned=${alignedSplits} misaligned=${misalignedSplits}`);
check("no fragment sat motionless for 6s", wedged.length === 0, `${wedged.length} wedged`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
await room.leave(true);
process.exit(failures === 0 ? 0 : 1);
