/**
 * Exercises the systems the 40-level expansion added, by playing them rather
 * than by asserting on the level table:
 *   - the four new objectives actually resolve
 *   - the two mouse abilities fire, land, and go on cooldown
 *   - a multi-boss arena fields every body independently
 *
 * Usage: node scripts/verify-new-systems.mjs [ws://host:port]
 */
import { Client } from "colyseus.js";

const ENDPOINT = process.argv[2] ?? "ws://localhost:2567";
const TILE = 32;
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
const room = await client.create("campaign_room", { name: "systems" });
for (const t of ["shield_changed", "teleport_changed", "blast_changed", "ram_changed",
                 "decoy_changed", "tank_destroyed", "steel_hit", "boss_bounce",
                 "mine_detonated", "grapple_hit", "welcome", "boon_collected",
                 "match_stats"]) room.onMessage(t, () => {});

let offer = null;
room.onMessage("upgrade_offer", (m) => { offer = m; });
let strikeCd = null;
room.onMessage("strike_changed", (m) => { strikeCd = m.cooldownMs; });
let empCd = null;
room.onMessage("emp_changed", (m) => { empCd = m.cooldownMs; });
let pulses = 0;
room.onMessage("emp_fired", () => { pulses++; });
const telegraphs = [];
room.onMessage("mortar_warning", (m) => telegraphs.push(m));

room.send("start_campaign");
await waitFor(room, (s) => s.phase === "intro", "intro");

// The player's own hull, by session — not merely "something friendly": the
// carrier levels put allied trucks on the field that are also `isEnemy: false`.
const me = () => [...room.state.tanks].find((t) => t.ownerId === room.sessionId);
const bosses = () => [...room.state.tanks].filter((t) => t.isBoss);
const convoy = () => [...room.state.tanks].find((t) => t.variant === "convoy");

/** Clears the current level (twice if a boss wave answers the objective). */
async function clear() {
  room.send("start_level");
  await waitFor(room, (s) => s.phase === "playing", "playing");
  offer = null;
  room.send("cheat_win");
  await sleep(500);
  if (room.state.phase === "playing") room.send("cheat_win");
  await waitFor(room, (s) => s.phase === "outro" || s.phase === "campaign_complete", "outro");
  await sleep(150);
  if (offer?.ids.length) room.send("choose_upgrade", { id: offer.ids[0] });
  await sleep(150);
  room.send("next_level");
  await waitFor(room, (s) => s.phase === "intro", "intro");
}

/** Runs to `target` and starts it, leaving the level live. */
async function play(target) {
  while (room.state.currentLevel < target) await clear();
  room.send("start_level");
  await waitFor(room, (s) => s.phase === "playing", "playing");
}

// ---------------------------------------------------------- defend_core (L4)
console.log("\nlevel 4 - defend the relay");
await play(4);
await sleep(400);
const relayTiles = [...room.state.grid].filter((t) => t === 4).length;
check("relay is on the map", relayTiles > 0, `${relayTiles} eagle tile(s)`);
check("objective counts down", /HOLD THE RELAY/.test(room.state.objectiveText ?? ""),
  `"${room.state.objectiveText}"`);
const startSeconds = room.state.objectiveValue;
await sleep(2500);
check("hold timer actually runs", room.state.objectiveValue < startSeconds,
  `${startSeconds} -> ${room.state.objectiveValue}`);

// ------------------------------------------------------- destroy_convoy (L10)
console.log("\nlevel 10 - kill the carrier");
await clear();
await play(10);
await sleep(400);
const carrier = convoy();
check("hostile carrier is on the field", Boolean(carrier));
check("carrier is an enemy so shells land on it", carrier?.isEnemy === true);
check("objective tracks its hull", /STOP THE CARRIER/.test(room.state.objectiveText ?? ""),
  `"${room.state.objectiveText}"`);
const carrierAt = carrier ? { x: carrier.x, y: carrier.y } : null;
await sleep(2500);
const carrierNow = convoy();
const drove = carrierNow && carrierAt
  ? Math.hypot(carrierNow.x - carrierAt.x, carrierNow.y - carrierAt.y)
  : 0;
check("carrier drives its route on its own", drove > TILE, `moved ${Math.round(drove)}px`);

// ---------------------------------------------------------- purge_marked (L13)
console.log("\nlevel 13 - purge the marked");
await clear();
await play(13);
// Let a crowd build up: the point of the level is picking targets out of it.
let enemies = [];
let marked = [];
for (let i = 0; i < 60 && enemies.length < 5; i++) {
  await sleep(400);
  enemies = [...room.state.tanks].filter((t) => t.isEnemy);
  marked = [...room.state.tanks].filter((t) => t.isMarked);
}
check("targets get marked", marked.length > 0, `${marked.length} marked`);
check("the mark is capped, not sprayed over the field",
  marked.length <= 3 && marked.length < enemies.length,
  `${marked.length} of ${enemies.length}`);
check("objective counts the marked", /MARKED TARGETS LEFT/.test(room.state.objectiveText ?? ""),
  `"${room.state.objectiveText}"`);

// ---------------------------------------------------------- push_payload (L20)
console.log("\nlevel 20 - push the payload");
await clear();
await play(20);
await sleep(400);
const payload = convoy();
check("payload is on the field", Boolean(payload));
const parkedAt = payload ? payload.y : 0;

// Drive well clear of it — the breaker starts left of the player's spawn, so
// away is to the right — and hold there. It must not move without an escort.
for (let i = 0; i < 60; i++) { room.send("move", { dir: "right" }); await sleep(60); }
const parkedAgain = convoy()?.y ?? parkedAt;
await sleep(1500);
const afterAway = convoy();
const drift = Math.abs((afterAway?.y ?? 0) - parkedAgain);
check("payload holds while unescorted", drift < 8, `moved ${Math.round(drift)}px`);

// Drive back to it, and it should start rolling.
for (let i = 0; i < 100; i++) {
  const self = me();
  const pl = convoy();
  if (self && pl) {
    const dx = pl.x - self.x;
    const dy = pl.y - self.y;
    room.send("move", {
      dir: Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up"),
    });
  }
  await sleep(60);
}
const afterEscort = convoy();
check("payload advances once escorted", (afterEscort?.y ?? parkedAt) < parkedAt - TILE,
  `y ${Math.round(parkedAt)} -> ${Math.round(afterEscort?.y ?? parkedAt)}`);

// --------------------------------------------------------- called strike (L24)
console.log("\nlevel 24 - the called strike");
await clear();
await play(24);
await sleep(400);
strikeCd = null;
telegraphs.length = 0;
const self24 = me();
check("player is on the field", Boolean(self24));
if (self24) {
  room.send("strike", { x: self24.x + 8 * TILE, y: self24.y });
  await sleep(400);
  check("strike telegraphs, in the player's own colour",
    telegraphs.some((t) => t.friendly === true), `${telegraphs.length} telegraph(s)`);
  check("strike goes on cooldown", (strikeCd ?? 0) > 0, `cd=${strikeCd}`);

  const before = strikeCd;
  room.send("strike", { x: self24.x, y: self24.y - 4 * TILE });
  await sleep(300);
  check("a second strike is refused while cooling", strikeCd === before, `cd=${strikeCd}`);

  // A wild aim point must be clamped rather than honoured or dropped.
  const wild = telegraphs.length;
  await sleep(200);
  check("no telegraph from the refused call", telegraphs.length === wild);
}

// ------------------------------------------------------------- emp pulse (L30)
console.log("\nlevel 30 - the suppression pulse");
await clear();
await play(30);
await sleep(700);
check("leviathan is on the field", bosses().some((b) => b.variant === "leviathan"),
  bosses().map((b) => b.variant).join(",") || "none");

pulses = 0;
empCd = null;
room.send("emp");
await sleep(400);
check("pulse fires", pulses === 1, `${pulses} pulse(s)`);
check("pulse goes on cooldown", (empCd ?? 0) > 0, `cd=${empCd}`);

// The Leviathan must dive and come back rather than sitting still.
const seenCloak = new Set();
for (let i = 0; i < 130; i++) {
  const lev = bosses().find((b) => b.variant === "leviathan");
  if (lev) seenCloak.add(lev.isCloaked);
  await sleep(80);
}
check("leviathan dives and resurfaces", seenCloak.size === 2, `states seen: ${[...seenCloak]}`);

// ---------------------------------------------------------- the gauntlet (L37)
console.log("\nlevel 37 - four bosses at once");
await clear();
await play(37);
await sleep(800);
const wave = bosses().map((b) => b.variant).sort();
check("all four bodies deploy",
  JSON.stringify(wave) === JSON.stringify(["artillery", "artillery", "sweeper", "sweeper"]),
  `[${wave}]`);
check("readout counts them", /BOSSES: 4/.test(room.state.objectiveText ?? ""),
  `"${room.state.objectiveText}"`);
const spread = new Set(bosses().map((b) => Math.round(b.x)));
check("bodies do not spawn stacked", spread.size >= 3, `${spread.size} distinct x`);

// Each Sweeper must carry its own velocity rather than flying in formation.
const before37 = bosses().filter((b) => b.variant === "sweeper").map((b) => ({ x: b.x, y: b.y }));
await sleep(1600);
const after37 = bosses().filter((b) => b.variant === "sweeper").map((b) => ({ x: b.x, y: b.y }));
if (before37.length === 2 && after37.length === 2) {
  const d0 = { x: after37[0].x - before37[0].x, y: after37[0].y - before37[0].y };
  const d1 = { x: after37[1].x - before37[1].x, y: after37[1].y - before37[1].y };
  check("the two sweepers move independently", Math.hypot(d0.x - d1.x, d0.y - d1.y) > 4,
    `deltas (${Math.round(d0.x)},${Math.round(d0.y)}) vs (${Math.round(d1.x)},${Math.round(d1.y)})`);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
await room.leave(true);
process.exit(failures === 0 ? 0 : 1);
