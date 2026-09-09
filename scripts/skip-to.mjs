/**
 * Opens a campaign room, fast-forwards to a level and holds it open, printing
 * the room code so a browser can join and look at it.
 *
 * Usage: node scripts/skip-to.mjs <level> [ws://host:port]
 */
import { Client } from "colyseus.js";

const TARGET = Number(process.argv[2] ?? 12);
const ENDPOINT = process.argv[3] ?? "ws://localhost:2567";
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
const room = await client.create("campaign_room", { name: "host" });
for (const t of ["shield_changed","teleport_changed","blast_changed","ram_changed","decoy_changed",
                 "tank_destroyed","steel_hit","boss_bounce","mortar_warning","mine_detonated",
                 "grapple_hit","welcome","boon_collected","match_stats",
                 "strike_changed","emp_changed","emp_fired","laser_changed","laser_fired"]) room.onMessage(t, () => {});
let offer = null;
room.onMessage("upgrade_offer", (m) => { offer = m; });

room.send("start_campaign");
await waitFor(room, (s) => s.phase === "intro", "intro");

while (room.state.currentLevel < TARGET) {
  room.send("start_level");
  await waitFor(room, (s) => s.phase === "playing", "playing");
  offer = null;
  room.send("cheat_win");
  // A level whose objective summons a boss wave takes two presses: the first
  // meets the objective, the second clears what turned up to answer it.
  await sleep(500);
  if (room.state.phase === "playing") room.send("cheat_win");
  await waitFor(room, (s) => s.phase === "outro", "outro");
  await sleep(180);
  if (offer?.ids.length) room.send("choose_upgrade", { id: offer.ids[0] });
  await sleep(180);
  room.send("next_level");
  await waitFor(room, (s) => s.phase === "intro", "intro");
}

console.log(`ROOM ${room.roomId} parked at level ${room.state.currentLevel} (intro)`);
setInterval(() => {}, 1 << 30);
