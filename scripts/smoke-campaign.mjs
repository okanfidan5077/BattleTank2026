/**
 * End-to-end smoke test for the campaign room.
 *
 * Drives a real client through the whole opening flow against a real server —
 * join, staging, start, first level — and asserts the world actually came up.
 * Written after a release where everything compiled and the level rendered
 * empty: `tsc` cannot tell you the map never loaded.
 *
 * Usage: node scripts/smoke-campaign.mjs [ws://host:port]
 */
import { Client } from "colyseus.js";

const ENDPOINT = process.argv[2] ?? "ws://localhost:2567";
const CAMPAIGN_ROOM = "campaign_room";

let failures = 0;

function check(label, condition, detail = "") {
  const ok = Boolean(condition);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  return ok;
}

/** Waits for `predicate(state)` to hold, polling the decoded state. */
function waitFor(room, predicate, label, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let ok = false;
      try {
        ok = predicate(room.state);
      } catch {
        ok = false;
      }
      if (ok) return resolve(room.state);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`timed out waiting for ${label}`));
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Counts tiles that are not Empty (0) — i.e. whether a map actually loaded. */
function solidTiles(grid) {
  let count = 0;
  for (let i = 0; i < grid.length; i++) if (grid.at(i) !== 0) count++;
  return count;
}

function playerTanks(state) {
  const tanks = [];
  for (let i = 0; i < state.tanks.length; i++) {
    const tank = state.tanks.at(i);
    if (!tank.isEnemy && tank.variant !== "convoy") tanks.push(tank);
  }
  return tanks;
}

async function main() {
  console.log(`\ncampaign smoke test → ${ENDPOINT}\n`);

  const client = new Client(ENDPOINT);

  // --- solo: join, stage, start, play -------------------------------------
  console.log("solo run");
  const host = await client.create(CAMPAIGN_ROOM, { name: "Host" });
  await waitFor(host, (s) => s?.players !== undefined, "state to decode");

  check("room joined", Boolean(host.roomId), host.roomId);
  check("starts in staging", host.state.phase === "staging", `phase=${host.state.phase}`);
  check("host assigned", host.state.hostId === host.sessionId);
  check("seat in roster", host.state.players.size === 1);

  host.send("start_campaign");
  await waitFor(host, (s) => s.phase === "intro", "intro phase");
  check("start leaves staging", host.state.phase === "intro");

  host.send("start_level");
  await waitFor(host, (s) => s.phase === "playing", "playing phase");
  check("level begins", host.state.phase === "playing");

  // The failure that prompted this test: the level ran but nothing was in it.
  await waitFor(host, (s) => solidTiles(s.grid) > 0, "map to load").catch(() => {});
  check("map loaded", solidTiles(host.state.grid) > 0, `${solidTiles(host.state.grid)} solid tiles`);

  await waitFor(host, (s) => playerTanks(s).length >= 1, "player tank").catch(() => {});
  const mine = playerTanks(host.state);
  check("player tank spawned", mine.length === 1, `${mine.length} player tank(s)`);
  check("tank has health", mine[0]?.currentHealth > 0, `hp=${mine[0]?.currentHealth}`);
  check(
    "tank is grid-aligned",
    mine[0] && mine[0].x % 32 === 0 && mine[0].y % 32 === 0,
    `x=${mine[0]?.x} y=${mine[0]?.y}`,
  );

  // Enemies should start arriving on their own.
  await sleep(4200);
  let enemies = 0;
  for (let i = 0; i < host.state.tanks.length; i++) {
    if (host.state.tanks.at(i).isEnemy) enemies++;
  }
  check("enemies spawning", enemies > 0, `${enemies} on field`);

  // Movement is server-authoritative: ask, then confirm the tank actually moved.
  const before = { x: mine[0].x, y: mine[0].y };
  for (let i = 0; i < 10; i++) {
    host.send("move", { dir: "up" });
    await sleep(60);
  }
  const after = playerTanks(host.state)[0];
  check(
    "player can move",
    after && (after.x !== before.x || after.y !== before.y),
    `${before.x},${before.y} → ${after?.x},${after?.y}`,
  );

  // --- co-op: a second seat joins a live run ------------------------------
  console.log("\nco-op join");
  const guest = await client.joinById(host.roomId, { name: "Guest" });
  await waitFor(guest, (s) => s?.players !== undefined, "guest state");
  await waitFor(host, (s) => s.players.size === 2, "guest in roster").catch(() => {});

  check("guest joined", host.state.players.size === 2, `${host.state.players.size} seats`);
  check("guest is not host", guest.state.hostId !== guest.sessionId);

  await waitFor(host, (s) => playerTanks(s).length === 2, "guest tank").catch(() => {});
  check(
    "late joiner spawns into live level",
    playerTanks(host.state).length === 2,
    `${playerTanks(host.state).length} player tanks`,
  );

  const positions = playerTanks(host.state).map((t) => `${t.x},${t.y}`);
  check("seats spawn apart", new Set(positions).size === positions.length, positions.join(" / "));

  await guest.leave();
  await sleep(400);
  check("guest removal cleans up", host.state.players.size === 1);

  await host.leave();

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\nSMOKE TEST ERROR: ${error.message}\n`);
  process.exit(1);
});
