/**
 * Walks the whole 40-level campaign, checking each level comes up, its
 * objective plumbing reports something sane, and its boss waves deploy — both
 * the ones present at the start and the ones that answer the objective.
 *
 * Usage: node scripts/verify-campaign40.mjs [ws://host:port]
 */
import { Client } from "colyseus.js";
import { CAMPAIGN_LEVELS, BossTiming } from "../packages/shared/dist/index.js";

const ENDPOINT = process.argv[2] ?? "ws://localhost:2567";
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  if (!ok) console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ""}`);
  return ok;
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
const room = await client.create("campaign_room", { name: "walk" });
for (const t of ["shield_changed","teleport_changed","blast_changed","ram_changed","decoy_changed",
                 "tank_destroyed","steel_hit","boss_bounce","mortar_warning","mine_detonated",
                 "grapple_hit","welcome","boon_collected","match_stats","strike_changed",
                 "emp_changed","emp_fired"]) room.onMessage(t, () => {});
let offer = null;
room.onMessage("upgrade_offer", (m) => { offer = m; });

room.send("start_campaign");
await waitFor(room, (s) => s.phase === "intro", "intro");

const bossesOnField = () => [...room.state.tanks].filter((t) => t.isBoss);
const kindsOnField = () => bossesOnField().map((t) => t.variant).sort();

console.log("walking all 40 levels\n");
for (const spec of CAMPAIGN_LEVELS) {
  room.send("start_level");
  await waitFor(room, (s) => s.phase === "playing", `level ${spec.id} playing`);
  await sleep(500);

  check(`L${spec.id} is the level we asked for`, room.state.currentLevel === spec.id,
    `got ${room.state.currentLevel}`);
  check(`L${spec.id} loaded a map`, [...room.state.grid].some((t) => t !== 0));
  check(`L${spec.id} spawned the player`, [...room.state.tanks].some((t) => !t.isEnemy));
  check(`L${spec.id} has an objective line`, (room.state.objectiveText ?? "").length > 0,
    `"${room.state.objectiveText}"`);

  // Bosses scheduled for the start must actually be standing.
  const wantStart = [];
  for (const b of spec.bosses ?? []) {
    if ((b.when ?? BossTiming.Start) !== BossTiming.Start) continue;
    for (let i = 0; i < (b.count ?? 1); i++) wantStart.push(b.kind);
  }
  // A Choir spawns its pair from one entry; a Hydra splits later, not now.
  const expectedStart = wantStart.flatMap((k) => (k === "choir" ? [k, k] : [k])).sort();
  const actual = kindsOnField();
  check(`L${spec.id} start bosses`, JSON.stringify(actual) === JSON.stringify(expectedStart),
    `want [${expectedStart}] got [${actual}]`);

  // Cheat-win drives the objective, which is also what triggers an objective wave.
  offer = null;
  room.send("cheat_win");

  const wantObjective = [];
  for (const b of spec.bosses ?? []) {
    if ((b.when ?? BossTiming.Start) !== BossTiming.Objective) continue;
    for (let i = 0; i < (b.count ?? 1); i++) wantObjective.push(b.kind);
  }

  if (wantObjective.length > 0) {
    // The level must NOT resolve — the wave has to be dealt with first.
    await sleep(700);
    const wave = kindsOnField();
    check(`L${spec.id} objective wave deployed`,
      JSON.stringify(wave) === JSON.stringify([...wantObjective].sort()),
      `want [${[...wantObjective].sort()}] got [${wave}]`);
    check(`L${spec.id} stays live until the wave is dead`, room.state.phase === "playing",
      `phase=${room.state.phase}`);
    check(`L${spec.id} readout names the wave`,
      /BOSS/.test(room.state.objectiveText ?? ""), `"${room.state.objectiveText}"`);

    // Clear the wave the only way the room offers from outside: win again.
    room.send("cheat_win");
  }

  await waitFor(room, (s) => s.phase === "outro" || s.phase === "campaign_complete",
    `level ${spec.id} outro`);
  await sleep(160);

  if (spec.id === CAMPAIGN_LEVELS.length) break;
  if (offer?.ids.length) room.send("choose_upgrade", { id: offer.ids[0] });
  await sleep(160);
  room.send("next_level");
  await waitFor(room, (s) => s.phase === "intro", `level ${spec.id + 1} intro`);
}

await sleep(300);
check("campaign completes", room.state.phase === "outro" || room.state.phase === "campaign_complete",
  `phase=${room.state.phase}`);

console.log(failures === 0 ? "\nALL 40 LEVELS PASS" : `\n${failures} FAILURE(S)`);
await room.leave(true);
process.exit(failures === 0 ? 0 : 1);
