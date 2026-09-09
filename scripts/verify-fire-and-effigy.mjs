/**
 * Two checks that need a run in progress:
 *  1. a buffed-reload tank does not lose shots between client and server;
 *  2. the mirror boss keeps moving after it kills the player.
 *
 * Usage: node scripts/verify-fire-and-effigy.mjs [ws://host:port]
 */
import { Client } from "colyseus.js";
import { campaignShootCooldownMs } from "../packages/shared/dist/index.js";

const ENDPOINT = process.argv[2] ?? "ws://localhost:2567";
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitFor(room, predicate, label, timeoutMs = 12000) {
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
const owned = {};
room.onMessage("upgrade_offer", (m) => { offer = m; Object.assign(owned, m.owned); });

room.send("start_campaign");
await waitFor(room, (s) => s.phase === "intro", "intro");

/** Clears a level, preferring the reload upgrade so the tank ends up buffed. */
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
  if (offer?.ids.length) {
    room.send("choose_upgrade", { id: offer.ids.includes("rate") ? "rate" : offer.ids[0] });
  }
  await sleep(180);
  room.send("next_level");
  await waitFor(room, (s) => s.phase === "intro" || s.phase === "campaign_complete", "intro");
}

async function runTo(target) {
  while (room.state.currentLevel < target) await advance();
  room.send("start_level");
  await waitFor(room, (s) => s.phase === "playing", "playing");
}

const seat = () => room.state.players.get(room.sessionId);
// The player's own hull, by session — not merely "something friendly": the
// carrier levels put allied trucks on the field that are also `isEnemy: false`.
const me = () => [...room.state.tanks].find((t) => t.ownerId === room.sessionId);

console.log("\nbuffed reload — shots sent vs shells fired");
await runTo(20); // past the level-18 refit, with reload stacks banked
const stacks = owned.rate ?? 0;
const interval = campaignShootCooldownMs(room.state.currentLevel, stacks, false);
console.log(`    level ${room.state.currentLevel}, ${stacks} reload stack(s), interval ${interval.toFixed(0)}ms`);
console.log("    owned:", JSON.stringify(owned));
console.log("    field:", [...room.state.tanks].filter((t) => t.isEnemy).map((t) => t.variant).join(",") || "empty");

const before = seat()?.shotsFired ?? 0;
let sent = 0;
let deaths = 0;
let wasAlive = true;
// Fire exactly the way the client does: on its own clock, at its own interval.
// Only while the tank exists — a shot sent during a respawn is refused for a
// reason that has nothing to do with the reload, and would poison the count.
const started = Date.now();
let nextAt = started;
while (Date.now() - started < 25000 && room.state.phase === "playing") {
  const alive = Boolean(me());
  if (!alive && wasAlive) deaths++;
  if (alive && !wasAlive) nextAt = Date.now(); // fresh tank, fresh cadence
  wasAlive = alive;

  const now = Date.now();
  if (alive && now >= nextAt) {
    room.send("shoot");
    sent++;
    nextAt = now + interval;
  }
  await sleep(5);
}
await sleep(400);
const fired = (seat()?.shotsFired ?? 0) - before;
const lost = sent - fired;
console.log(`    sent ${sent}, server fired ${fired}, lost ${lost} (${deaths} death(s) skipped)`);
check("no shots swallowed at a buffed reload", lost === 0, `${lost} lost of ${sent}`);

console.log("\nlevel 40 — effigy keeps moving through a player death");
room.send("cheat_win");
await waitFor(room, (s) => s.phase === "outro", "outro");
if (offer?.ids.length) room.send("choose_upgrade", { id: offer.ids[0] });
await sleep(180); room.send("next_level");
await waitFor(room, (s) => s.phase === "intro", "intro");
await runTo(40);

// Stand still and let it come. Then watch the whole death/respawn window.
let died = false;
let stillMs = 0;
let worstStill = 0;
let last = null;
const deadline = Date.now() + 75000;
while (Date.now() < deadline) {
  const boss = [...room.state.tanks].find((t) => t.isBoss);
  if (!me()) died = true;
  if (boss) {
    if (last && Math.abs(last.x - boss.x) < 1 && Math.abs(last.y - boss.y) < 1) stillMs += 80;
    else stillMs = 0;
    // Only judge it once it has had a death to get wedged by.
    if (died) worstStill = Math.max(worstStill, stillMs);
    last = { x: boss.x, y: boss.y };
  }
  if (room.state.phase !== "playing") break;
  await sleep(80);
}
console.log(`    player died: ${died}; longest motionless stretch after the death: ${worstStill}ms`);
check("player died so the case was actually exercised", died);
check("effigy never froze for more than 4s after a death", worstStill <= 4000, `${worstStill}ms`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
await room.leave(true);
process.exit(failures === 0 ? 0 : 1);
