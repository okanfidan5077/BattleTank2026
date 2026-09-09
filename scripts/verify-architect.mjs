/**
 * Levels the Architect's pylons with a scripted bot, then checks that the
 * exposed boss does more than walk at the player.
 *
 * Usage: node scripts/verify-architect.mjs [ws://host:port]
 */
import { Client } from "colyseus.js";

const ENDPOINT = process.argv[2] ?? "ws://localhost:2567";
const TILE = 32, W = 60;
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
for (const t of ["shield_changed","teleport_changed","blast_changed","decoy_changed",
                 "tank_destroyed","steel_hit","boss_bounce","mortar_warning","mine_detonated",
                 "grapple_hit","welcome","boon_collected","match_stats"]) room.onMessage(t, () => {});

let rams = 0;
room.onMessage("ram_changed", (m) => { if (m.foreign && m.active) rams++; });
let lobs = 0;
room.onMessage("mortar_warning", () => { lobs++; });

let offer = null;
room.onMessage("upgrade_offer", (m) => { offer = m; });

room.send("start_campaign");
await waitFor(room, (s) => s.phase === "intro", "intro");

while (room.state.currentLevel < 34) {
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
  // Bank hull and reload so the bot survives long enough to clear four pylons.
  if (offer?.ids.length) {
    const want = ["hull", "life", "rate"].find((id) => offer.ids.includes(id)) ?? offer.ids[0];
    room.send("choose_upgrade", { id: want });
  }
  await sleep(180);
  room.send("next_level");
  await waitFor(room, (s) => s.phase === "intro", "intro");
}
room.send("start_level");
await waitFor(room, (s) => s.phase === "playing", "playing");
console.log(`    on level ${room.state.currentLevel}`);

// The player's own hull, by session — not merely "something friendly": the
// carrier levels put allied trucks on the field that are also `isEnemy: false`.
const me = () => [...room.state.tanks].find((t) => t.ownerId === room.sessionId);
const pylons = () => {
  const out = [];
  for (let i = 0; i < room.state.grid.length; i++) {
    if (room.state.grid[i] === 5) out.push({ x: (i % W) * TILE, y: Math.floor(i / W) * TILE });
  }
  return out;
};

console.log(`    pylons at start: ${pylons().length}`);

// Line up on a pylon's row or column, then shell it. The bot cannot path, so
// it also needs an escape hatch for the walls it will inevitably drive into.
const DIRS = ["up", "right", "down", "left"];
const deadline = Date.now() + 300000;
let stuckFor = 0;
let last = null;
let detour = null;
while (Date.now() < deadline && pylons().length > 0 && room.state.phase === "playing") {
  const self = me();
  if (self) {
    const cx = self.x + self.width / 2, cy = self.y + self.height / 2;

    if (last && Math.abs(last.x - self.x) < 1 && Math.abs(last.y - self.y) < 1) stuckFor += 60;
    else { stuckFor = 0; detour = null; }
    last = { x: self.x, y: self.y };

    let dir;
    if (stuckFor > 700) {
      // Wedged: commit to a random heading for a moment to get round whatever
      // is in the way, rather than grinding into it again every frame.
      detour ??= { dir: DIRS[Math.floor(Math.random() * 4)], until: Date.now() + 900 };
      if (Date.now() > detour.until) detour = null;
      dir = detour?.dir ?? DIRS[0];
    } else {
      const target = pylons().sort(
        (a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy),
      )[0];
      const dx = target.x + TILE / 2 - cx;
      const dy = target.y + TILE / 2 - cy;
      // Square up on whichever axis is nearly aligned; otherwise close the gap.
      dir = Math.abs(dx) < TILE / 2
        ? (dy > 0 ? "down" : "up")
        : Math.abs(dy) < TILE / 2
          ? (dx > 0 ? "right" : "left")
          : (Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up"));
    }

    room.send("move", { dir });
    room.send("shoot");
  }
  await sleep(60);
}
const left = pylons().length;
console.log(`    pylons left: ${left}, phase ${room.state.phase}`);
check("bot levelled every pylon", left === 0 && room.state.phase === "playing", `${left} left`);

if (left === 0 && room.state.phase === "playing") {
  const boss = () => [...room.state.tanks].find((t) => t.isBoss);
  check("architect is exposed with 46 hp", boss()?.currentHealth === 46, `hp=${boss()?.currentHealth}`);

  rams = 0; lobs = 0;
  const watchUntil = Date.now() + 25000;
  // Keep away from it so it has a reason to charge rather than just touch us.
  while (Date.now() < watchUntil && room.state.phase === "playing") {
    const self = me(), b = boss();
    if (self && b) {
      const dx = self.x - b.x, dy = self.y - b.y;
      room.send("move", { dir: Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up") });
    }
    await sleep(60);
  }
  console.log(`    in 25s exposed: ${rams} charge(s), ${lobs} lobbed shell(s)`);
  check("exposed architect charges", rams >= 2, `${rams} charges`);
  check("exposed architect keeps lobbing", lobs >= 6, `${lobs} shells`);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
await room.leave(true);
process.exit(failures === 0 ? 0 : 1);
