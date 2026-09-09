/**
 * Drives a real campaign run to specific levels and checks the fixes.
 * Usage: node verify.mjs [ws://host:port]
 */
import { Client } from "colyseus.js";

const ENDPOINT = process.argv[2] ?? "ws://localhost:2567";
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitFor(room, predicate, label, timeoutMs = 8000) {
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
const room = await client.create("campaign_room", { name: "verify" });
for (const t of ["shield_changed","teleport_changed","blast_changed","ram_changed","decoy_changed",
                 "tank_destroyed","steel_hit","boss_bounce","mortar_warning","mine_detonated",
                 "grapple_hit","welcome","boon_collected","match_stats"]) {
  room.onMessage(t, () => {});
}

let offer = null;
room.onMessage("upgrade_offer", (msg) => { offer = msg; });

room.send("start_campaign");
await waitFor(room, (s) => s.phase === "intro", "intro");

/** Clears the current level and advances, exercising the upgrade gate. */
async function clearLevel({ gateCheck = false } = {}) {
  room.send("start_level");
  await waitFor(room, (s) => s.phase === "playing", "playing");
  offer = null;
  room.send("cheat_win");
  // A level whose objective summons a boss wave needs a second press: the
  // first meets the objective, the second clears what answered it.
  await sleep(500);
  if (room.state.phase === "playing") room.send("cheat_win");
  await waitFor(room, (s) => s.phase === "outro", "outro");
  await sleep(150);

  if (gateCheck) {
    const level = room.state.currentLevel;
    check("offer dealt at debrief", offer !== null && offer.ids.length > 0,
      offer ? `ids=${offer.ids.join(",")}` : "no offer");
    room.send("next_level");
    await sleep(400);
    check("level does not advance before a card is taken",
      room.state.currentLevel === level && room.state.phase === "outro",
      `level=${room.state.currentLevel} phase=${room.state.phase}`);
  }

  if (offer && offer.ids.length > 0) room.send("choose_upgrade", { id: offer.ids[0] });
  await sleep(200);
  room.send("next_level");
  await waitFor(room, (s) => s.phase === "intro" || s.phase === "campaign_complete", "next intro");
}

console.log("\nupgrade gate");
await clearLevel({ gateCheck: true });
check("advanced after taking a card", room.state.currentLevel === 2, `level=${room.state.currentLevel}`);

/** Runs to `target`, then plays it live for `observeMs` and reports the boss. */
async function runTo(target) {
  while (room.state.currentLevel < target) await clearLevel();
  room.send("start_level");
  await waitFor(room, (s) => s.phase === "playing", "playing");
}

const snapshot = () => [...room.state.tanks].filter((t) => t.isBoss)
  .map((t) => ({ v: t.variant, x: t.x, y: t.y, hp: t.currentHealth, weak: t.weakSide }));

console.log("\nlevel 12 — artillery");
await runTo(12);
await sleep(600);
let bosses = snapshot();
check("artillery has 32 hp", bosses[0]?.hp === 32, `hp=${bosses[0]?.hp}`);

console.log("\nlevel 15 — bastion weak side rotates");
room.send("cheat_win");
await sleep(400);
if (room.state.phase === "playing") room.send("cheat_win");
await waitFor(room, (s) => s.phase === "outro", "outro");
if (offer?.ids.length) room.send("choose_upgrade", { id: offer.ids[0] });
await sleep(200); room.send("next_level");
await waitFor(room, (s) => s.phase === "intro", "intro");
// runTo walks whatever distance the layout puts between the two bosses, which
// is what the hand-counted hop this replaced kept getting wrong.
await runTo(15);
const weakSeen = new Set();
for (let i = 0; i < 60; i++) { // ~9s
  const b = snapshot()[0];
  if (b) weakSeen.add(b.weak);
  await sleep(150);
}
check("bastion weak side cycles all four faces", weakSeen.size === 4, `seen=${[...weakSeen].sort().join(",")}`);
check("bastion has 28 hp", snapshot()[0]?.hp === 28, `hp=${snapshot()[0]?.hp}`);

console.log("\nlevel 34 — architect");
room.send("cheat_win");
await sleep(400);
if (room.state.phase === "playing") room.send("cheat_win");
await waitFor(room, (s) => s.phase === "outro", "outro");
if (offer?.ids.length) room.send("choose_upgrade", { id: offer.ids[0] });
await sleep(200); room.send("next_level");
await waitFor(room, (s) => s.phase === "intro", "intro");
await runTo(34);
await sleep(400);
check("architect has 46 hp", snapshot()[0]?.hp === 46, `hp=${snapshot()[0]?.hp}`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
await room.leave(true);
process.exit(failures === 0 ? 0 : 1);
