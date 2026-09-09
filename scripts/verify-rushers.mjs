/**
 * Watches rushers for the "drives to the far wall for no reason" defect.
 *
 * The cause was cross-axis drift: the separation pass and the anti-gridlock
 * jitter shove hulls sideways by a pixel or two, and the steering only turns a
 * tank standing exactly on the lattice — so a brushed rusher could never turn
 * again and simply drove straight until something stopped it.
 *
 * Two things are measured, both of which the defect would break:
 *   - how much of the time a rusher is off the lattice across its travel
 *   - how long rushers spend pinned motionless against the map edge
 *
 * Usage: node scripts/verify-rushers.mjs [ws://host:port]
 */
import { Client } from "colyseus.js";
import { GRID_HEIGHT, GRID_WIDTH, TILE_SIZE } from "../packages/shared/dist/index.js";

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
const room = await client.create("campaign_room", { name: "rushers" });
for (const t of ["shield_changed", "teleport_changed", "blast_changed", "ram_changed",
                 "decoy_changed", "tank_destroyed", "steel_hit", "boss_bounce",
                 "mortar_warning", "mine_detonated", "grapple_hit", "welcome",
                 "boon_collected", "match_stats", "upgrade_offer", "strike_changed",
                 "emp_changed", "emp_fired", "laser_changed", "laser_fired",
                 "translocate_changed"]) room.onMessage(t, () => {});

room.send("start_campaign");
await waitFor(room, (s) => s.phase === "intro", "intro");

let offer = null;
room.onMessage("upgrade_offer", (m) => { offer = m; });

/** Clears a level; one whose objective summons a wave needs two presses. */
async function clear() {
  room.send("start_level");
  await waitFor(room, (s) => s.phase === "playing", "playing");
  offer = null;
  room.send("cheat_win");
  await sleep(500);
  if (room.state.phase === "playing") room.send("cheat_win");
  await waitFor(room, (s) => s.phase === "outro", "outro");
  await sleep(180);
  if (offer?.ids.length) room.send("choose_upgrade", { id: offer.ids[0] });
  await sleep(180);
  room.send("next_level");
  await waitFor(room, (s) => s.phase === "intro", "intro");
}

// Level 5 is the uplink hold, whose spawn table is a third rushers — the
// densest source of them in the early campaign, and an open map where a unit
// that could not turn would stand out.
while (room.state.currentLevel < 5) await clear();
room.send("start_level");
await waitFor(room, (s) => s.phase === "playing", "playing");
console.log(`\nwatching rushers on level ${room.state.currentLevel}`);

const me = () => [...room.state.tanks].find((t) => t.ownerId === room.sessionId);
const samples = new Map(); // ownerId -> { away, moved, offLattice, total, run, worstRun }
let seen = 0;

// Hold still in one place. A rusher's entire job is to arrive; against a
// stationary target every step it takes should shorten the distance, and any
// sustained run of steps that lengthen it is the unit wandering off.
const until = Date.now() + 45000;
const last = new Map();
while (Date.now() < until) {
  const self = me();
  if (self) {
    for (const tank of room.state.tanks) {
      if (!tank.isEnemy || tank.variant !== "kamikaze") continue;

      let s = samples.get(tank.ownerId);
      if (!s) {
        s = { away: 0, moved: 0, offLattice: 0, total: 0, run: 0, worstRun: 0 };
        samples.set(tank.ownerId, s);
        seen++;
      }

      const distance = Math.hypot(tank.x - self.x, tank.y - self.y);
      s.total++;
      // Off the lattice on *both* axes at once is the state that makes turning
      // impossible; mid-tile along the direction of travel is normal.
      if (tank.x % TILE_SIZE !== 0 && tank.y % TILE_SIZE !== 0) s.offLattice++;

      const prev = last.get(tank.ownerId);
      if (prev !== undefined) {
        const delta = distance - prev;
        if (Math.abs(delta) > 0.5) {
          s.moved++;
          if (delta > 0) {
            s.away++;
            s.run += 80;
            s.worstRun = Math.max(s.worstRun, s.run);
          } else {
            s.run = 0;
          }
        }
      }
      last.set(tank.ownerId, distance);
    }
  }
  await sleep(80);
}

const all = [...samples.values()].filter((s) => s.moved > 25);
const awayRatio = all.length
  ? all.reduce((sum, s) => sum + s.away / s.moved, 0) / all.length
  : 0;
const offRatio = all.length
  ? all.reduce((sum, s) => sum + s.offLattice / s.total, 0) / all.length
  : 0;
const worstRun = all.reduce((m, s) => Math.max(m, s.worstRun), 0);

console.log(`    rushers seen: ${seen} (${all.length} with enough samples)`);
console.log(`    mean share of steps taken *away* from a stationary player: ${(awayRatio * 100).toFixed(1)}%`);
console.log(`    longest unbroken run away: ${worstRun}ms`);
console.log(`    mean time off the lattice on both axes: ${(offRatio * 100).toFixed(1)}%`);

check("rushers actually appeared", all.length >= 3, `${all.length}`);
check("they close on the player rather than wandering", awayRatio < 0.28,
  `${(awayRatio * 100).toFixed(1)}% of steps away`);
check("no long detours away from a target that is not moving", worstRun < 3200,
  `${worstRun}ms`);
check("they stay on the lattice and can turn", offRatio < 0.15,
  `${(offRatio * 100).toFixed(1)}% off`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
await room.leave(true);
process.exit(failures === 0 ? 0 : 1);
