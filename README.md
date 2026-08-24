# BattleTank2026

npm-workspaces monorepo for a Colyseus-authoritative, Phaser-rendered tank game.

```
packages/
  shared/   @battletank/shared   types, constants, protocol  (built with tsc -> dist/)
  server/   @battletank/server   Colyseus + Express game server
  client/   @battletank/client   Phaser + Vite browser client
```

## Setup

```bash
npm install
npm run build
```

## Development

`shared` is consumed by both packages through its **built** output (`dist/`), so keep
its watcher running while you work on cross-package types:

```bash
npm run watch:shared   # terminal 1 - tsc -b --watch on shared
npm run dev:server     # terminal 2 - tsx watch, http://localhost:2567
npm run dev:client     # terminal 3 - vite,      http://localhost:5173
```

## Scripts (root)

| Script | Description |
| --- | --- |
| `npm run build` | `tsc -b` across all three projects, in dependency order |
| `npm run typecheck` | Same as build, forced (no incremental cache) |
| `npm run clean` | Remove all build output and `.tsbuildinfo` files |
| `npm run build:shared` / `:server` / `:client` | Build a single workspace |
| `npm run dev:server` / `dev:client` / `watch:shared` | Watch modes |

## TypeScript layout

- Root `tsconfig.json` is both the **shared base config** (every package `extends` it)
  and a **solution file** referencing all three projects, so `tsc -b` builds them in order.
- `shared` and `server` use `NodeNext` resolution — relative imports need the `.js`
  extension (e.g. `./config.js`), which is standard for ESM-on-Node.
- `client` overrides resolution to `bundler` for Vite, and emits declarations only
  (to `node_modules/.tmp/types`) since Vite/Rolldown produces the real bundle.
- `experimentalDecorators` + `useDefineForClassFields: false` are set in the base config
  because `@colyseus/schema` v3 uses legacy decorators.

## Version pinning (important)

Colyseus server and client must agree on the `@colyseus/schema` **major**, because that
is the state-encoding format on the wire.

- `colyseus@0.17.x` (the current `latest` tag) requires `@colyseus/schema@^4`.
- `colyseus.js@0.16.22` is the newest published browser client and requires
  `@colyseus/schema@^3`. **No 0.17 browser client exists on any dist-tag.**

So this repo is pinned to the matched **0.16** line on both sides — schema `3.0.76`
resolves for server and client alike. Re-check this before bumping either package.

The root `package.json` also carries an `overrides` entry:

```json
"overrides": { "@colyseus/core": "0.16.24" }
```

`@colyseus/core@0.16.25` ships a broken published manifest — it declares
`"@colyseus/greeting-banner": "workspace:^"`, a pnpm-only protocol that npm cannot
resolve, which makes `npm install` fail with `EUNSUPPORTEDPROTOCOL`. The override holds
core at the last good release. Remove it once upstream republishes a fixed 0.16.x.

## State schema

Constants live in `packages/shared/src/constants.ts` (grid 60x33, 32px tiles, 20 Hz, plus
the `TileType`, `Direction` and `EntityType` enums). The Colyseus schema classes live in
`packages/server/src/schema/`:

| Class | Fields (wire type) |
| --- | --- |
| `Vector2` | x, y (float32) |
| `Entity` (abstract) | x, y (float32), width, height (uint16), type (uint8) |
| `Tank` extends `Entity` | ownerId (string), maxHealth + currentHealth (uint8), speed (float32), direction (uint8), isEnemy + isInvulnerable (boolean) |
| `Bullet` extends `Entity` | ownerId (string), damage (uint8), direction (uint8), speed (float32), isEnemy + piercesSteel (boolean) |
| `Boon` | x, y (float32), width, height (uint16), type (string) |
| `Player` | sessionId + name (string), color (uint32), tier, lives, respawnInSeconds (uint8), isSpectator + isConnected (boolean) |
| `GameState` | matchState + hostId (string), elapsedSeconds + enemiesQueued (uint16), players `{Player}`, tanks `[Tank]`, bullets `[Bullet]`, boons `[Boon]`, grid `[uint8]` |

`grid` is a flat, row-major array of exactly `GRID_LENGTH` (1980) `TileType` values; use
`tileIndex(x, y)` to address it. Flat beats nested here because Colyseus patches only the
indices that actually changed — a shell destroying one brick costs **9 bytes** on the
wire, against ~9.6 KB for a full state encode.

Every class takes a strictly-typed init object:

```ts
new Tank({ x: 96, y: 64, ownerId: id, maxHealth: 4, speed: 4, direction: Direction.Right, isEnemy: false })
```

This will not compile with a field missing or misspelled. `width` and `height` are
optional and default to one tile. `type` is *not* accepted from the init object — each
subclass constructor writes its own discriminator, so an entity cannot be mislabelled.

### Two constraints worth knowing before editing these classes

**Apply init after `super()`, never via `super(init)`.** `Schema`'s constructor does
`Object.assign(this, arg)`, but TypeScript field initializers run *after* the `super()`
call — so anything passed through `super(init)` is silently overwritten by the defaults a
moment later. Every class here calls `super()` bare and assigns afterwards. The `default:`
option on `@type({ type, default })` is not an escape hatch either: it does not apply on
construction, and fields read back as `undefined`. Use a field initializer.

**`Encoder.BUFFER_SIZE` is raised to 64 KB** in `schema/GameState.ts`. A full encode of the
1980-cell grid is ~9.6 KB, which overflows Colyseus' 8 KB default — it logs
`buffer overflow` and truncates the state. Raise it further if the grid grows.

## Running the server

```bash
npm run build && npm run start:server
```

That serves Colyseus and Express together on **port 2567** (`PORT` overrides it), with the
`battle_room` room registered. Health check: `curl http://localhost:2567/health`.

For iteration, `npm run dev:server` runs the same entry point under `tsx watch`.

## BattleRoom

`packages/server/src/rooms/BattleRoom.ts`, registered as `battle_room` in
`packages/server/src/index.ts`. The simulation logic is kept out of the room class so it
can be exercised without a live server:

| File | Responsibility |
| --- | --- |
| `rooms/BattleRoom.ts` | Colyseus lifecycle — `onCreate`, `onJoin`, `onLeave`, the tick |
| `world/battlefield.ts` | Map generation, spawn points |
| `systems/bullets.ts` | Bullet movement + AABB collision against the grid |
| `systems/tanks.ts` | Tank movement + AABB collision against the grid |
| `systems/enemies.ts` | Enemy steering, raycast, fire decisions |
| `world/FlowField.ts` | Dijkstra routes toward the eagle, and toward players |
| `systems/boons.ts` | Power-up pickup detection |
| `world/SpawnQueue.ts` | Pending enemy wave |
| `gameplay.ts` | Speeds, sizes, health, direction vectors |

- **`onCreate`** builds the grid via `createBattlefield()` (see **Map generation** below),
  then starts the loop with `setSimulationInterval(..., TICK_MS)` (50 ms = 20 Hz).
- **`onJoin`** reads `{ name, color }` from the join options, sanitises them, and spawns a
  `Tank` on the bottom row at one of four spawn points, rotating by join order so two
  players never stack. **`onLeave`** holds the seat open for a reconnect rather than tearing
  down immediately — see **Reconnection** below.
- **The tick** advances each bullet by `speed` along its direction, then tests its AABB
  against every grid cell it overlaps. **Brick** is set to `Empty` and the bullet is
  destroyed; **Steel** destroys the bullet and stands; **Water** and **Empty** are flown
  over; leaving the field destroys the bullet. A bullet straddling a tile boundary clears
  both bricks, as in the original game.

`BULLET_SPEED` (12 px/tick) must stay below `TILE_SIZE` (32). Above it a bullet could jump
clean over a wall between two ticks and never register the overlap.

### Controls and input handling

Two client -> server messages, both defined in `@battletank/shared`:

| Message | Payload | Effect |
| --- | --- | --- |
| `move` | `{ dir: "up" \| "down" \| "left" \| "right" }` | Turns the tank and keeps it rolling |
| `shoot` | none | Spawns a bullet at the muzzle |

The client polls WASD and the arrow keys in `GameScene.update()` and re-sends `move` every
50 ms while a key is held; `shoot` is throttled to the shared player cooldown. Nothing moves locally —
the tank's position always comes back from the server.

**Movement is applied on the tick, not in the message handler.** A `move` message only
records an *intent* with a deadline (`MOVE_INTENT_TTL_TICKS`, 3 ticks); the simulation loop
advances the tank by `speed` each tick while that intent is live, and the tank halts once
the messages stop arriving. Moving the tank directly inside the handler would tie speed to
how fast a client emits packets — a client sending input at 200 Hz would travel ten times
faster than one at 20 Hz.

For the same reason the **500 ms shoot cooldown is enforced on the server**
(`SHOOT_COOLDOWN_TICKS`), alongside the original game's one-shell-in-flight rule. The
client-side throttle is only there to keep the socket quiet; it is not the authority. The
`move` payload is validated with `isMoveMessage()` before it touches any state, since
anything arriving over a socket is attacker-controlled.

Tank collision (`systems/tanks.ts`) treats **Brick, Steel, Water and the Eagle** as solid,
along with the field edges. Note this deliberately differs from the bullet rules: water
stops a tank but a shell flies straight over it. Movement is all-or-nothing per tick rather
than sliding up to the wall, matching the original game's tile-grid feel.

## Running the client

```bash
npm run dev:client
```

Vite serves the game at **http://localhost:5173**. The server must be running too — in a
second terminal:

```bash
npm run build && npm run start:server
```

**WASD** or the **arrow keys** to move, **SPACE** to shoot.

## Client rendering

`packages/client/src/GameScene.ts` is a single Phaser scene, mounted at a 1920x1080 base
resolution in `main.ts` (`Scale.FIT` + `CENTER_BOTH`, so it letterboxes into any window).
The 60x33 field is 1920x1056, so the scene centres it in a container with a 12px vertical
offset.

- **`preload()`** generates all eight textures at runtime with `this.add.graphics()` +
  `generateTexture()` — no image assets: empty (dark), brick (brown, with mortar courses),
  steel (grey, bevelled), water (blue), eagle (gold), player tank (green), enemy tank
  (red), bullet (white). Tanks are drawn facing **up**, so the sprite's rotation follows
  `Direction` directly.
- **`create()`** builds 1980 tile images up front — one per grid cell, at the same index as
  the server's 1D array — then joins the room. Only a tile's *texture* changes afterwards,
  never its position, so a destroyed brick is a single `setTexture` call.
- **State binding** uses `getStateCallbacks(room)`: `grid.onChange` repaints one cell,
  `tanks.onAdd`/`onRemove` create and destroy sprites (with a per-instance `onChange` for
  position and facing), and `bullets` follow the same pattern.

Sprites are keyed off the replicated schema instance itself in a `Map`, so an entity's
sprite is found without any id bookkeeping.

### Note on the state types

`packages/client/src/state.ts` declares plain interfaces mirroring the server schema. The
schema *classes* live in `@battletank/server` and must not be pulled into the browser
bundle; at runtime colyseus.js rebuilds state from the reflection handshake, so these types
only describe what arrives. **They can drift from the server** — if you add a field to
`packages/server/src/schema/`, add it here too. Moving the schema classes into
`packages/shared` would remove the duplication entirely.

## Map generation

`createBattlefield(seed?)` in `world/battlefield.ts`. Pass a seed for a reproducible map;
omit it for a random one per room.

The map is tiled with **6x6 modules**: a 3x3 wall block in one corner, and a 3-tile
corridor along the other two edges. This lattice is the whole trick — every block is an
island ringed by corridor, so the corridor network is a connected grid *no matter what a
block contains*. That is what makes it safe to scatter steel freely: steel can never seal
off a region, because it only ever sits inside a corridor-ringed block.

```
 3 .....................###...######...###.....................
 6 ##....###.........###...SS........SS...###.........###....##
 9 .........###...###........................###...###.........
12 ###.........SS....##....###......###....##....SS.........###
32 .............................#E#............................
```

- **Symmetry.** Only the left half is painted; it is then mirrored about the vertical axis.
  The axis runs *between* columns 29 and 30, so the eagle's own bunker (centred on column
  30) is the one thing that cannot be mirrored — the ground around it is cleared about both
  column 30 and its mirror so the approach stays symmetrical.
- **Corridors** are a uniform 3 tiles wide. Partial block shapes leave 1-wide alcoves off
  the corridors, but never a 1-wide through-route.
- **Top 3 rows** are wiped clear as the enemy spawn zone, as is a 3-tile radius around every
  player spawn and around the bunker.
- **Gates** — brick plugs across a corridor crossing — add the winding routes. They are
  always brick, never steel, so they can be shot away and the flow field can still route
  through them.
- Wall coverage runs ~14–29% (median 21%). The structural ceiling is ~25% before gates,
  since blocks are 3x3 within a 6x6 module.

### Enemy steering is snapped to the tile grid

`steer()` only changes an enemy's direction when it is aligned to the tile grid. This is
load-bearing, not cosmetic. A tank is a full tile wide, so one caught mid-tile straddles two
rows (or columns); turning there asks it to move broadside through both, and if either is
walled it jams **permanently** — the field keeps requesting the same blocked direction and
the tank never re-aligns to reconsider. Before this fix, enemies from one of the three
spawns wedged partway across the map on every seed tested.

## Enemy AI

| File | Responsibility |
| --- | --- |
| `world/FlowField.ts` | Routes every cell toward the eagle |
| `world/SpawnQueue.ts` | FIFO of enemies waiting to enter |
| `systems/enemies.ts` | Steering, forward raycast, fire decisions |

### Flow field

A Dijkstra field over the 1980-cell grid, rebuilt **only when a brick is destroyed** —
`updateBullets()` returns how many bricks it cleared, and the room rebuilds only on a
non-zero count. Every reachable cell stores one `Direction` step toward the eagle;
`directionAt(x, y)` returns `null` for cells sealed off by steel, where enemies hold
position rather than wander.

**Brick is traversable at a cost of 8, not impassable.** This is a deliberate deviation
from the brief, and the feature does not work without it: `createBattlefield()` walls the
eagle in brick on all five of its in-bounds sides, so with brick impassable a search from
the eagle reaches **zero** cells — the field would be empty and no enemy would ever move.
A high finite cost makes the field prefer open ground and fall back to routing through a
wall the enemy can shoot away, which is exactly what the 25% brick rule below is for. Set
`FLOW_FIELD_BRICK_COST` to `Infinity` for literal "brick is a wall" behaviour.

Steel and **water** are the true walls. Water is impassable here even though the brief only
named brick and steel, because `isSolidForTanks()` already blocks tanks on water — a field
that routed through it would march enemies into a puddle and jam them. (No map currently
places water, so this is future-proofing.)

### Spawn queue

`onCreate` queues a wave of 50–100 enemies. The loop drains it once a second
(`ENEMY_SPAWN_INTERVAL_TICKS`), releasing 1–2 at a time at three spawn points along the top
row. A blocked spawn point re-queues the request instead of dropping it.

`MAX_CONCURRENT_ENEMIES` (6) caps how many are alive at once. Not in the brief, but the
queue holds up to 100 and nothing kills enemies yet, so without a cap the map ends up
carpeted in tanks. Raise it once bullet-vs-tank combat exists.

### Per-tick enemy behaviour

1. Read the flow field cell under the tank's centre, turn to face it, and step.
2. If the cooldown has elapsed, cast a ray forward (12 tiles). A **player** or the **eagle**
   means fire; a **brick** means fire with 25% probability; **steel** stops the ray and is
   never a reason to shoot. Water does not block the ray, since shells fly over it.

The 25% roll happens **after** the cooldown check, not on every tick. Rolling per tick would
give an enemy facing a wall ~98% odds across a 14-tick cooldown — effectively always firing.
Gating first makes it a genuine one-in-four decision per opportunity.

Enemies fire at 75% of the player's rate: `ENEMY_SHOOT_COOLDOWN_TICKS` is 14 ticks (700 ms)
against the player's 10 (500 ms). Both go through the same `readyToShoot()`/`fire()` pair, so
enemies inherit the one-shell-in-flight rule too.

## Collision and combat

### Tanks do not overlap

Enforced in `moveTank()` by **refusing the move**, not by shoving hulls apart afterwards.
That choice is load-bearing: a positional shove would knock tanks off the tile grid, and
enemy steering depends on tanks staying aligned — an enemy stranded mid-tile jams against
the first wall it meets (the exact bug fixed in the previous round). Every pairing is
covered: player/player, enemy/enemy, player/enemy.

`separateTanks()` runs at the end of each tick as a safety net for overlaps that movement
blocking cannot prevent — two tanks placed on the same ground, say. It pushes the pair
apart along the **axis of least penetration**, but only into space that is genuinely free;
a shove that would bury a tank in a wall or a third tank is abandoned rather than forced.

A blocked tank simply waits, so enemies queue in corridors rather than merging. Verified
that this does not strand them: they still reach the bunker with collision enabled.

### Bullets damage tanks

`Bullet` now carries an **`isEnemy`** flag, copied from the firing tank. It lives on the
shell rather than being looked up from the owner, because the owner may already be
destroyed when the shell lands.

- Enemy shells damage players; player shells damage enemies.
- **No friendly fire** in either direction. This also means a tank can never be hit by its
  own shot as it leaves the muzzle.
- `BULLET_DAMAGE` is 25 against `TANK_MAX_HEALTH` 100, so four hits destroy a tank.
- Shells are tested against **tanks before terrain**, so a tank standing flush against a
  wall still takes the hit instead of the wall soaking it.

`updateBullets()` returns `{ bricksDestroyed, destroyedTanks }`; the room rebuilds the flow
field on the former and clears cooldown/intent bookkeeping on the latter.

### Player respawn

Destroyed players return to their spawn point after `PLAYER_RESPAWN_DELAY_TICKS` (3 s) at
full health; a blocked pad just retries next tick. Not in the brief, but a player takes four
hits with up to six enemies shooting, so without it the game ends permanently a few seconds
in. Enemies are not respawned — the wave queue already supplies more.

## Enemy tiers

`Tank` carries **`maxHealth`** and **`currentHealth`**; `currentHealth` defaults to
`maxHealth` when a tank is built. Damage is **1 per shell**, so health is literally a hit
count — the tiers are specified in hit points, and a 0-100 pool would not express "1 HP".
A player has 4.

| Tier | Share | HP | Speed | Colour |
| --- | --- | --- | --- | --- |
| Normal | 70% | 1 | 4 | red |
| Armored | 20% | 2 | 3 | purple |
| Heavy | 10% | 3 | 2 | near-black |

`rollEnemyTier()` in `gameplay.ts` samples the table. The client tints by **`maxHealth`**,
so there is no separate tier field on the wire; the enemy hull texture is drawn in neutral
white precisely so `setTint` yields the true colour rather than a muddy blend with red.

**Tier speeds forced a movement fix.** Enemy steering may only turn a grid-aligned tank, so
a speed that does not divide `TILE_SIZE` (32) would sail past every boundary and never be
allowed to turn again. `moveTank` now clamps each step to the next tile boundary, which
makes any speed safe — that is what lets speeds 3 and 2 exist at all.

## Boons

`Boon` (x, y, width, height, `type`) lives in `GameState.boons`. `type` is replicated as a
string — `"bomb" | "star" | "stopwatch" | "shovel"` — so the payload stays readable and the
client can branch on it directly; there are only ever a handful on the map.

A destroyed enemy drops one with **10% probability** at its exact coordinates.
`systems/boons.ts` runs the pickup pass: only **player** tanks collect (an enemy driving
over one leaves it), and the boon is removed from the state before the effect runs so an
effect may freely add or remove entities.

| Boon | Effect |
| --- | --- |
| `bomb` | Destroys every enemy on the field. They do not roll for drops — one bomb would cascade into a pile of power-ups. |
| `star` | Permanently speeds up that player's shells (+4/tick, capped at `MAX_BULLET_SPEED`). |
| `stopwatch` | Freezes enemies for 8 s — no steering, no shooting. The wave queue keeps releasing, as in the original. |
| `shovel` | Turns the eagle's brick ring to steel for 15 s, then reverts. Bricks already blasted open stay open. |

Every pickup broadcasts `ServerMessage.BoonCollected` (`{ type, playerId, x, y }`); the
client floats the boon's name at the spot and logs it.

`MAX_BULLET_SPEED` is 24, below `TILE_SIZE`. A star must never push a shell past a tile per
tick or it would jump clean over walls — the same invariant `BULLET_SPEED` documents.

### The shovel forced a flow-field fallback

Sealing the eagle in steel makes it strictly unreachable, which would leave the field empty
and every enemy on the map standing still. `FlowField.rebuild()` now detects an unpopulated
result and re-runs the search seeded from the passable ring around the bunker, weighted by
distance. Enemies converge on the bunker's outside and wait for the steel to lapse instead
of freezing map-wide.

## Match pacing

### The clock is wall-time, not ticks

`GameState.elapsedSeconds` is replicated (the client shows `mm:ss` top right) and comes from
`BattleRoom.elapsedMs`, which **accumulates the delta the simulation loop reports** rather
than counting ticks.

This matters more than it sounds. `setInterval(50)` does not deliver 20 Hz everywhere — on
the Windows box this was built on, a bare `setInterval(50)` delivers **16.1 ticks/s**, and
measurement confirmed that is platform timer granularity, not simulation cost (identical
with and without the per-tick work; a full flow-field rebuild is only 3.1 ms). A
tick-counted clock therefore ran ~20% slow: 57 s displayed after 68 s of real time.
Anything specified in seconds or milliseconds now keys off `elapsedMs`.

**Fire cooldowns are enforced in milliseconds** for the same reason — a tick-counted 400 ms
would really be ~500 ms wherever the loop under-delivers. Player **400 ms**, enemy
**1200 ms** (3× slower), both defined in `@battletank/shared` so the client's input throttle
cannot drift from the server rule. The server remains the authority.

Note the rest of the simulation is still tick-driven, so on a platform that ticks slowly,
tanks and shells move proportionally slower in real time. That is inherent to a fixed-step
simulation and was not in scope to change.

### Difficulty scaling

Each minute stocks the queue with `50 + 10 × (minute − 1)`: minute 1 queues 50, minute 2
adds 60, minute 3 adds 70. Stocking is driven off `elapsedMs`, so the boundary lands on the
real minute.

Concurrency scales alongside it — see **Difficulty now scales concurrency too** below — so
later minutes bring both a longer wave and more enemies on the field at once.

### AI objectives

On spawn, `rollEnemyObjective()` assigns **60% eagle / 40% hunt the nearest player**.

Eagle-seekers follow the usual flow field. Hunters follow a second field built by
`FlowField.rebuildToward()` — a **multi-source Dijkstra seeded from every living player**,
recomputed every 10 ticks. Because multi-source Dijkstra gives each cell the cost to the
*cheapest* source, "target the closest player" falls out of the field itself: no per-enemy
distance checks, and it re-targets automatically as players move. With no players alive the
hunter field is empty and hunters fall back to marching on the eagle.

### Bullet interception

`updateBullets()` now runs in phases: move every shell, then cancel opposing pairs, then
resolve survivors against tanks and terrain. Moving everything first means interception is
judged on the positions shells actually share this tick rather than on whichever happened to
be processed first, and resolving it before damage means **an interception always beats a
hit** — two shells that meet destroy each other and neither deals damage. Same-side shells
pass straight through. The count comes back as `bulletsIntercepted`.

## Players, lives and star tiers

### The `Player` record is separate from the tank

`GameState.players` is a `MapSchema<Player>` keyed by sessionId, holding `tier`, `lives`,
`isSpectator` and `respawnInSeconds`. It is deliberately **not** part of `Tank`: a tank is
removed from the state the instant it is destroyed, so lives and tier stored there would
vanish with the wreck. The `Player` record outlives the tank; the tank remains the on-field
entity.

### Star progression

Each star boon advances the collector one tier, capped at 4. Upgrades are cumulative.

| Tier | Cooldown | Shell speed | Volley | Cuts steel |
| --- | --- | --- | --- | --- |
| 1 | 400 ms | 12 | 1 | no |
| 2 | 300 ms | 15.6 (+30%) | 1 | no |
| 3 | 300 ms | 15.6 | 2 parallel | no |
| 4 | 300 ms | 15.6 | 2 parallel | **yes** |

Tier 3+ fires two shells offset perpendicular to the direction of travel, so they run
parallel instead of stacking. Every tier's speed stays below `TILE_SIZE`, or a shell could
jump a wall between ticks.

Two knock-on changes this forced:

- **The one-shell-in-flight rule now applies to enemies only.** Players are paced purely by
  cooldown — keeping the old rule would have cancelled out tier 3, whose entire point is
  putting two shells up at once.
- **Steel destruction rebuilds the flow field.** `updateBullets()` reports `steelDestroyed`
  alongside `bricksDestroyed`, and the room rebuilds on either, because a tier 4 shell opens
  routes the field had treated as permanent walls.

**Tier resets to 1 on death**, as in the original game.

### Death, respawn and spectating

0 HP decrements `lives`. With lives remaining, the player is booked back in after
`PLAYER_RESPAWN_DELAY_MS` (5 s) and returns with `PLAYER_INVULNERABILITY_MS` (3 s) of grace
— `Tank.isInvulnerable` is replicated, shells pass straight through it, and the client draws
a flashing shield ring over the hull. `respawnInSeconds` drives the HUD countdown. At zero
lives the player is marked `isSpectator` and stops respawning.

The client HUD (top right, under the clock) shows `lives N · tier N ★★` and switches to
`SPECTATOR — out of lives`.

### Difficulty now scales concurrency too

`maxConcurrentEnemies(minute)` returns `6 + 2 × (minute − 1)`, capped at 16. Combined with
the growing queue, later minutes are genuinely harder rather than merely longer — the cap
was previously the reason queue growth alone did not raise pressure.

## Match resolution

`GameState.matchState` is replicated as one of `LOBBY` / `PLAYING` / `GAME_OVER` /
`VICTORY`. A room opens in `LOBBY` and only reaches `PLAYING` when the host starts it —
see **Staging lobby** below.

| Outcome | Condition |
| --- | --- |
| **Defeat** | The eagle tile is hit — by *any* shell, including a player's own — or every player has run out of lives |
| **Victory** | Survived `MATCH_DURATION_MS` (10 minutes), or the spawn queue emptied and the last enemy died |

The eagle is now destructible: `updateBullets()` clears the tile and reports `eagleDestroyed`,
which the room turns into an immediate `GAME_OVER`. The standing conditions are re-checked
once per tick in `checkMatchEnd()`, and only while the match is `PLAYING`.

**A resolved match freezes hard.** `update()` returns immediately once the status is
terminal — no clock, no spawns, no movement, no shells — and the `move`/`shoot` handlers
reject input server-side rather than trusting the client to stop sending it.

**The room locks on resolution.** Without `this.lock()`, `joinOrCreate` would keep handing
new clients the finished room, so a player pressing Restart would land straight back on the
game-over screen. Locking makes the next join create a fresh room, which is exactly what
the client's Restart does (it reloads the page).

## Staging lobby

A room opens in **`LOBBY`** and stays there until the host presses Start. This exists
because a solo-created room used to destroy itself: with nobody defending, enemies razed
the eagle in well under a minute, so inviting a friend was a race against the clock that you
usually lost.

- `GameState.hostId` is the first player to join. `onJoin` claims it when `hostId` is empty
  — checked against the state rather than `clients.length`, which also counts spectators and
  reconnecting clients.
- **The simulation is gated on `matchState === PLAYING`.** `update()` returns immediately
  otherwise, so in `LOBBY` there is no clock, no spawns, no movement and no shells. The
  `move` and `shoot` handlers reject input for the same reason. A room can sit open
  indefinitely.
- The **first wave is stocked on start**, not at room creation, so `enemiesQueued` reads 0
  while staging.
- `startGame` is host-only and one-shot; a second one is ignored rather than re-stocking the
  queue.
- If the host leaves before starting, `reassignHost()` hands the role to another player —
  otherwise everyone would be stuck in a lobby nobody can begin.

The client shows a staging panel with the room code, a live roster (colour swatch, name,
`host` / `you` tags) and a Start button that only the host sees. The roster is driven by
`players.onAdd` / `onRemove` plus a per-player `onChange`, so someone arriving mid-staging
appears without a refresh.

**Phaser is not booted during staging.** `runStaging()` returns a promise that settles when
`matchState` leaves `LOBBY`, and `boot()` awaits it before constructing the game:

```ts
await runStaging(room);   // panel is up; no canvas, no textures
startGame(room);          // Phaser boots with a room that is already playing
```

Only the host clicks anything — every other client boots off the same `matchState` listener.
A room that is already under way (a late join, or a resumed session) settles the promise
immediately, so those clients go straight into the game without the panel ever appearing.

**Do not read `room.state` when the panel is constructed.** `runStaging()` runs the moment
the join resolves, which is before the first patch decodes — an early `matchState !== LOBBY`
check read `undefined` and silently skipped the whole panel. Visibility is driven by the
`matchState` listener instead, which fires with the real value once state arrives and again
whenever it changes.

## Client HUD

A fixed bar across the top 52px, in screen space so it never scrolls with the map:

```
TIME 01:23     ENEMIES 6  (44 queued)     EAGLE SECURE     LIVES 3   TIER 2*
```

Eagle status is read straight from the replicated grid, not from a separate flag. Each
field is only re-rendered when its string actually changes, so refreshing every frame costs
nothing.

The battlefield is 1920x1056 and the bar takes the top 52px, which does not leave room for
both. Rather than hiding the enemy spawn rows behind the bar, the world container is scaled
to `(1080 − 52) / 1056` and anchored beneath it, so the whole map stays visible.

On `GAME_OVER` the scene drops a full-screen red overlay with a pulsing `[ RESTART ]` that
responds to click or Enter; `VICTORY` shows the same treatment in green. Input freezes on
the client too, though the server is the one that actually enforces it.

## Lobby and matchmaking

`index.html` carries a plain DOM overlay — name input, **Create Room**, room code input,
**Join Room**, and a share panel revealed on connect. `src/lobby.ts` wires it, `main.ts`
orchestrates.

**Phaser does not boot until a room is joined.** `main.ts` awaits the lobby, then constructs
`new GameScene(room)` with an already-connected room. The scene no longer joins anything
itself, so it never renders an empty world while it waits.

```
boot()
  └─ tryResume()          refresh? resume the held seat, skip the lobby
       └─ runLobby()      otherwise: create or join
            └─ startGame(room)
```

- **Create Room** calls `client.create(BATTLE_ROOM, { name, color })`.
- **Join Room** calls `client.joinById(code, { name, color })`.
- `?room=XYZ` pre-fills the code input and points the player at Join.
- The code field also accepts a **pasted invite link**, since people paste the whole URL as
  often as the bare code.

The share panel shows `…/?room=<roomId>`. Note colyseus.js exposes **`roomId`**, not `id`.

### Colours

`PLAYER_COLORS` is exactly blue, cyan, yellow, orange, pink and lime, picked at random per
join. Red, purple and near-black are reserved for the enemy tiers; gold, silver and brown
read as the eagle, steel and brick — a player wearing any of them would be misread as an
enemy or as scenery.

### Joining a finished room

A resolved match locks its room, so `joinById` on a stale link fails and the lobby reports
*"That room is full or already finished."* That is the intended outcome of the lock, not a
bug — the link is a one-match invite.

## Player identity

`Player` carries `name`, `color` (24-bit hex) and `isConnected` alongside lives and tier.
The client passes `{ name, color }` as join options; `packages/shared/src/identity.ts`
normalises them **server-side** before they reach the state, because join options are
attacker-controlled:

- Names are stripped of control characters, zero-width marks and bidi overrides — a
  zero-width name would render as nothing and a bidi override would scramble the labels
  around it. Whitespace runs collapse, length clamps to 16, and an empty result falls back.
- Colours must be a finite integer in `0x000000..0xFFFFFF`; anything else falls back to a
  **per-session** palette pick rather than one shared default, so a room full of bad
  requests does not come out all the same colour.

The name comes from the lobby input (remembered between visits); the colour is drawn at
random from the allowed palette on every join.

Both tank hulls are drawn neutral white so `setTint` gives the true colour: players get
theirs, enemies get their tier's. Each player tank carries a Phaser `Text` label anchored
bottom-centre and repositioned by `followLabels()` **every frame**, not off state patches —
patches land at 20 Hz, so a label driven by them visibly lags its tank between updates.
Labels dim to `(away)` while someone is reconnecting.

## Reconnection (the refresh exploit)

Refreshing used to be a free reset: `onLeave` deleted the `Player` record, and the reload's
`joinOrCreate` handed out a fresh one with 3 lives and tier 1. A player about to lose their
last life could simply reload.

**Server.** There is no `onDrop` hook in Colyseus — `allowReconnection` is documented as
valid only inside `onLeave`, so the wait lives there:

- A **consented** leave (`room.leave()`) is final and tears down immediately.
- An **unconsented** drop marks the player `isConnected = false`, leaves their tank on the
  field, and awaits `allowReconnection(client, RECONNECT_WINDOW_SECONDS)` (30 s). If they
  return, nothing is lost. If it rejects, `removePlayer()` runs the same teardown the old
  `onLeave` did.

**Client.** `allowReconnection` on its own does *not* fix a refresh: a reload calls
`joinOrCreate` and takes a brand new seat, leaving the held one to expire. So
`network.ts` stores `room.reconnectionToken` in **`sessionStorage`** and offers it back via
`client.reconnect()` on boot, falling back to `joinOrCreate` if it is expired or claimed.

`sessionStorage` is deliberate: it survives a refresh of *that tab* and nothing else. A
second tab is a genuinely new player, and a closed tab should not resurrect a seat later.

### When the token is dropped

A held seat is only worth resuming while there is something to come back to, so
`forgetSession()` runs on every path where there is not:

| Trigger | Why |
| --- | --- |
| **Restart** on the overlay | Otherwise the reload resumes the finished match and lands right back on the game-over screen |
| **Match resolves** (`GAME_OVER` / `VICTORY`) | A later reload would rejoin a dead match instead of opening the lobby |
| **Our lives hit 0 / spectator** | Resuming would strand the player watching a match they cannot rejoin |
| **Consented `room.leave()`** | A deliberate exit is final |

The elimination check is scoped to *our own* session — another player running out of lives
must not clear our token.

### Staying eliminated (device id)

Dropping the token at 0 lives would otherwise let an eliminated player follow the invite
link back in as a brand new player with 3 lives. A persistent id closes that:

- The client keeps `battle_city_device_id` in **`localStorage`** (a UUID, generated on first
  use) and sends it in the join options. `localStorage` rather than `sessionStorage` is the
  whole point — it has to outlive the tab, which is exactly how someone would try to sneak
  back in.
- The room holds `deadPlayers: Set<string>`. When a player's lives hit 0, their device id
  goes in.
- `onJoin` checks the set first: a match means no tank is spawned and the record is created
  with `lives: 0, isSpectator: true`.

Two details that matter. The set is **per room**, so elimination does not follow anyone
into a new match — losing here should not bar you from the next game. And the room keeps a
`deviceIdBySession` map alongside `client.userData`, because a tank can be destroyed while
its owner is mid-reconnect, and Colyseus drops that client from `this.clients` for the
duration — `userData` alone would miss the elimination.

**This is self-asserted identity, not authentication.** `sanitizeDeviceId` bounds it to
8–64 characters of `[A-Za-z0-9._-]` so it cannot be used to grow the set with junk keys, but
anyone willing to clear storage or edit the payload gets a fresh id. It stops the casual
rejoin; it is not a security control. Real enforcement needs server-side identity.

## Not implemented yet

- **Score.** No scoring or per-kill tally.
- **Enemies shooting players is opportunistic.** Enemies only fire along their facing (as
  specified), and they steer toward the eagle, so they shoot a player only when one happens
  to stand in their path rather than actively hunting.

### A note on `npm audit`

`npm audit` reports 13 advisories (1 high, 10 moderate, 2 low). Every one of them comes
from the pinned Colyseus 0.16 tree — `nanoid` inside `@colyseus/core`, and the
`grant` / `jwk-to-pem` / `elliptic` / `uuid` chain pulled in by `@colyseus/auth`, which
npm auto-installs because `colyseus@0.16.x` declares its optional integrations as
**required** peers with no `peerDependenciesMeta`.

Do **not** run `npm audit fix --force` here: it resolves the advisories by upgrading to
`colyseus@0.17`, which breaks wire compatibility with the client (see above). None of the
affected packages (`@colyseus/auth`, the redis driver/presence, the uWebSockets transport)
are imported by this project — they are inert peer installs.
