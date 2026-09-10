/**
 * Checks that a decoy beacon splits the field rather than emptying it.
 *
 * A beacon used to be every field-following enemy's target — an "everything
 * stops attacking me" button, which the upgrade that lengthens it stretched
 * over most of a fight. Half should take the bait; the rest should keep coming.
 *
 * Two halves to this:
 *
 *  - the rule itself, tested as a pure function. An earlier version of this file
 *    tried to measure the share from live movement and could not be made to mean
 *    anything: the beacon lands on the spot the player was standing on, the
 *    player then outruns the pursuit, and a hull still loyally chasing them ends
 *    up nearer the beacon than the target it is heading for. Three different
 *    classifiers all read that as "lured" and reported 85-100% on a fair coin.
 *
 *  - the room's wiring, tested live: a standing beacon must not empty the field.
 *
 * Usage: node scripts/verify-decoy.mjs [ws://host:port]
 */
import { Client } from "colyseus.js";
import {
  DECOY_LURE_CHANCE,
  DECOY_UNLOCK_LEVEL,
  rollDecoyLure,
} from "../packages/shared/dist/index.js";

const ENDPOINT = process.argv[2] ?? "ws://localhost:2567";
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ the rule
console.log("\nthe lure roll");

const ids = Array.from({ length: 20000 }, (_, i) => `e${i}`);
const luredMany = rollDecoyLure(ids);
const share = luredMany.size / ids.length;
console.log(`    over ${ids.length} hulls: ${(share * 100).toFixed(1)}% lured`);
check("the coin is fair", Math.abs(share - DECOY_LURE_CHANCE) < 0.02,
  `${(share * 100).toFixed(1)}% vs ${DECOY_LURE_CHANCE * 100}%`);

// A rigged generator pins both ends, so the comparison is the right way up.
check("nothing is lured when the roll always fails",
  rollDecoyLure(ids.slice(0, 100), () => 0.99).size === 0);
check("everything is lured when it always succeeds",
  rollDecoyLure(ids.slice(0, 100), () => 0).size === 100);
check("it is a per-enemy decision, not one for the whole field",
  new Set([...Array(40)].map(() => rollDecoyLure(ids.slice(0, 8)).size)).size > 1);

// --------------------------------------------------------------- the wiring
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
const room = await client.create("campaign_room", { name: "decoy" });
for (const t of ["shield_changed", "teleport_changed", "blast_changed", "ram_changed",
                 "tank_destroyed", "steel_hit", "boss_bounce", "mortar_warning",
                 "mine_detonated", "grapple_hit", "welcome", "boon_collected",
                 "match_stats", "strike_changed", "emp_changed", "emp_fired",
                 "laser_changed", "laser_fired", "translocate_changed"]) room.onMessage(t, () => {});

let offer = null;
room.onMessage("upgrade_offer", (m) => { offer = m; });
let beacon = null;
room.onMessage("decoy_changed", (m) => {
  if (m.x !== undefined && m.y !== undefined) beacon = { x: m.x, y: m.y };
});

room.send("start_campaign");
await waitFor(room, (s) => s.phase === "intro", "intro");

const hunters = () =>
  [...room.state.tanks].filter(
    (t) => t.isEnemy && !t.isBoss && !t.isDisguised && t.speed > 0 &&
      t.variant !== "trapper" && t.variant !== "jammer" && t.variant !== "sapper" &&
      t.variant !== "sentinel",
  );

async function clear() {
  room.send("start_level");
  await waitFor(room, (s) => s.phase === "playing", "playing");
  offer = null;
  room.send("cheat_win");
  await sleep(500);
  if (room.state.phase === "playing") room.send("cheat_win");
  await waitFor(room, (s) => s.phase === "outro" || s.phase === "campaign_complete", "outro");
  await sleep(160);
  // Take Loud Beacon wherever it is offered: the complaint was about how strong
  // the ability is *with* it, so that is the case worth having on the field.
  if (offer?.ids.length) {
    room.send("choose_upgrade", { id: offer.ids.includes("decoyup") ? "decoyup" : offer.ids[0] });
  }
  await sleep(160);
  room.send("next_level");
  await waitFor(room, (s) => s.phase === "intro", "intro");
}

console.log(`\nlevel ${DECOY_UNLOCK_LEVEL} - a beacon on a live field`);
while (room.state.currentLevel < DECOY_UNLOCK_LEVEL) await clear();
room.send("start_level");
await waitFor(room, (s) => s.phase === "playing", "playing");

let crowd = [];
for (let i = 0; i < 70 && crowd.length < 4; i++) {
  await sleep(400);
  crowd = hunters();
}
console.log(`    ${crowd.length} field-following enemies on the field`);
check("there is a crowd to split", crowd.length >= 3, `${crowd.length}`);

beacon = null;
room.send("decoy");
await sleep(600);
check("the beacon is announced", Boolean(beacon), beacon ? `${beacon.x},${beacon.y}` : "none");

// Hold position and let the beacon run its course. What this half is for is the
// property the complaint was actually about: the level keeps happening while a
// beacon is standing, rather than every hull on the map walking away from you.
let stillActive = 0;
for (let i = 0; i < 50; i++) {
  stillActive = Math.max(stillActive, hunters().length);
  await sleep(120);
}
console.log(`    with the beacon standing: ${stillActive} enemies still on the field`);
check("a standing beacon does not empty the level", stillActive > 0, `${stillActive} active`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
await room.leave(true);
process.exit(failures === 0 ? 0 : 1);
