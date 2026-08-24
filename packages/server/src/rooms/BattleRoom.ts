import { Room, type Client } from "colyseus";
import { type ArraySchema } from "@colyseus/schema";

import {
  BoonType,
  ClientMessage,
  Direction,
  MOVE_DIRECTION_TO_FACING,
  ServerMessage,
  MatchStatus,
  MATCH_DURATION_MS,
  isMatchOver,
  ENEMY_SHOOT_COOLDOWN_MS,
  TICK_MS,
  TILE_SIZE,
  TileType,
  isMoveMessage,
  sanitizeDeviceId,
  sanitizePlayerColor,
  sanitizePlayerName,
  defaultPlayerColor,
  defaultPlayerName,
  type BoonCollectedMessage,
  type JoinOptions,
  type SteelHitMessage,
  type TankDestroyedMessage,
} from "@battletank/shared";

import {
  BOON_DROP_CHANCE,
  BULLET_DAMAGE,
  BULLET_SIZE,
  DIRECTION_VECTORS,
  rollEnemyTier,
  ENEMY_SPAWN_BATCH_MAX,
  ENEMY_SPAWN_BATCH_MIN,
  ENEMY_SPAWN_INTERVAL_TICKS,
  ENEMY_WAVE_BASE,
  ENEMY_WAVE_GROWTH,
  DIFFICULTY_STEP_MS,
  EnemyObjective,
  rollEnemyObjective,
  HUNTER_FIELD_REBUILD_TICKS,
  maxConcurrentEnemies,
  MAX_PLAYER_TIER,
  MAX_PLAYERS,
  MOVE_INTENT_TTL_TICKS,
  PLAYER_INVULNERABILITY_MS,
  PLAYER_RESPAWN_DELAY_MS,
  PLAYER_STARTING_LIVES,
  RECONNECT_WINDOW_SECONDS,
  SHOVEL_DURATION_TICKS,
  tierProfile,
  type TierProfile,
  ENEMY_PROFILE,
  volleyOffsets,
  STOPWATCH_FREEZE_TICKS,
  TANK_MAX_HEALTH,
  TANK_SIZE,
  TANK_SPEED,
} from "../gameplay.js";
import { Boon, Bullet, GameState, Player, Tank, tileIndex } from "../schema/index.js";
import { collectBoons } from "../systems/boons.js";
import { updateBullets } from "../systems/bullets.js";
import { updateEnemies } from "../systems/enemies.js";
import { isBlocked, moveTank, separateTanks } from "../systems/tanks.js";
import { FlowField } from "../world/FlowField.js";
import { SpawnQueue, type SpawnRequest } from "../world/SpawnQueue.js";
import {
  EAGLE_TILE_X,
  EAGLE_TILE_Y,
  ENEMY_SPAWN_TILES,
  SPAWN_TILES,
  createBattlefield,
} from "../world/battlefield.js";

/** Inclusive integer in [min, max]. */
function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

export class BattleRoom extends Room<GameState> {
  override maxClients = MAX_PLAYERS;

  /** Monotonic join counter, so spawn points rotate rather than stack up. */
  private joinCount = 0;

  /** Simulation tick counter; drives movement intents and duration timers. */
  private tick = 0;

  /**
   * Real elapsed match time, in milliseconds.
   *
   * Accumulated from the delta the simulation loop reports rather than counted
   * in ticks. A 50ms setInterval does not deliver 20Hz on every platform — this
   * Windows box delivers about 16Hz — so a tick count drifts badly against the
   * wall clock. Anything specified in seconds or milliseconds keys off this.
   */
  private elapsedMs = 0;

  /** sessionId -> tick at which the player's movement intent lapses. */
  private moveIntents = new Map<string, number>();

  /** ownerId -> elapsedMs at that tank's last shot. Players and enemies alike. */
  private lastShotAtMs = new Map<string, number>();

  /** Routes every cell toward the eagle; rebuilt only when a brick falls. */
  private readonly flowField = new FlowField();

  /** Routes every cell toward the nearest player; rebuilt on a short interval. */
  private readonly hunterField = new FlowField();

  /** ownerId -> what that enemy is trying to reach. */
  private objectives = new Map<string, EnemyObjective>();

  /** Difficulty steps already queued, so each minute is stocked once. */
  private minutesQueued = 0;

  private readonly spawnQueue = new SpawnQueue();

  private enemySequence = 0;

  /** sessionId -> which spawn point that player uses. */
  private playerSpawnIndex = new Map<string, number>();

  /** sessionId -> elapsedMs at which a destroyed player returns to the field. */
  private pendingRespawns = new Map<string, number>();

  /**
   * Device ids that have already run out of lives in this room.
   *
   * Per-room, so being eliminated here does not follow anyone into a new match.
   */
  private readonly deadPlayers = new Set<string>();

  /**
   * sessionId -> device id.
   *
   * The client's `userData` carries the same value, but a tank can be destroyed
   * while its owner is mid-reconnect, and Colyseus drops that client from
   * `this.clients` for the duration. This map still knows who they were.
   */
  private readonly deviceIdBySession = new Map<string, string>();

  /** sessionId -> elapsedMs at which respawn invulnerability lapses. */
  private invulnerableUntilMs = new Map<string, number>();

  /** Enemies are held still until this tick, courtesy of a stopwatch. */
  private enemiesFrozenUntilTick = 0;

  /** Tick at which a shovel's steel bunker reverts to brick, if one is active. */
  private shovelExpiresAtTick: number | null = null;

  override onCreate(): void {
    const state = new GameState();
    createBattlefield().forEach((tile, index) => {
      state.grid[index] = tile;
    });
    this.setState(state);

    this.flowField.rebuild(state.grid);

    this.onMessage(ClientMessage.Move, (client, payload: unknown) => {
      if (!this.isPlaying) return;
      // Straight off the socket: validate before touching any state.
      if (!isMoveMessage(payload)) return;
      this.requestMove(client.sessionId, MOVE_DIRECTION_TO_FACING[payload.dir]);
    });

    this.onMessage(ClientMessage.Shoot, (client) => {
      if (!this.isPlaying) return;
      this.playerShoot(client.sessionId);
    });

    this.onMessage(ClientMessage.StartGame, (client) => {
      this.startMatch(client.sessionId);
    });

    this.onMessage(ClientMessage.ResetMatch, (client) => {
      this.resetMatch(client.sessionId);
    });

    this.setSimulationInterval((deltaMs) => {
      this.update(deltaMs);
    }, TICK_MS);

    console.log(
      `[room ${this.roomId}] created — ${this.spawnQueue.size} enemies queued`,
    );
  }

  override onJoin(client: Client, options?: JoinOptions): void {
    // Join options are attacker-controlled: normalise before they reach state.
    const name = sanitizePlayerName(options?.name, defaultPlayerName(client.sessionId));
    const color = sanitizePlayerColor(options?.color, defaultPlayerColor(client.sessionId));
    const deviceId = sanitizeDeviceId(options?.deviceId);

    client.userData = { deviceId };
    if (deviceId) this.deviceIdBySession.set(client.sessionId, deviceId);

    // Already eliminated in this room: they come back to watch, not to play.
    const eliminated = deviceId !== null && this.deadPlayers.has(deviceId);

    this.state.players.set(
      client.sessionId,
      new Player({
        sessionId: client.sessionId,
        name,
        color,
        lives: eliminated ? 0 : PLAYER_STARTING_LIVES,
        tier: 1,
      }),
    );

    if (eliminated) {
      const record = this.state.players.get(client.sessionId);
      if (record) record.isSpectator = true;

      console.log(`[room ${this.roomId}] ${name} rejoined after elimination — spectating`);
      return;
    }

    const spawnIndex = this.joinCount % SPAWN_TILES.length;
    this.joinCount++;

    this.playerSpawnIndex.set(client.sessionId, spawnIndex);
    this.spawnPlayer(client.sessionId);

    // First one in runs the staging lobby. Checked against the state rather
    // than `clients.length`, which also counts spectators and reconnects.
    if (this.state.hostId === "") {
      this.state.hostId = client.sessionId;
      console.log(`[room ${this.roomId}] ${name} is the host`);
    }

    console.log(`[room ${this.roomId}] ${name} (${client.sessionId}) joined`);
  }

  /**
   * Leaves the staging lobby and starts the match.
   *
   * Only the host may do this, and only once — a second `startGame` after the
   * match is running would re-stock the wave queue.
   */
  private startMatch(sessionId: string): void {
    if (this.state.matchState !== MatchStatus.Lobby) return;

    if (sessionId !== this.state.hostId) {
      console.log(`[room ${this.roomId}] ${sessionId} tried to start; not the host`);
      return;
    }

    this.state.matchState = MatchStatus.Playing;
    this.fillSpawnQueue();

    console.log(
      `[room ${this.roomId}] match started by the host — ${this.spawnQueue.size} enemies queued`,
    );
  }

  /**
   * Hands the host role to someone else.
   *
   * Without this, a host who leaves before pressing Start would strand everyone
   * else in a lobby nobody can begin.
   */
  private reassignHost(leavingSessionId: string): void {
    if (this.state.hostId !== leavingSessionId) return;

    for (const [sessionId, player] of this.state.players) {
      if (sessionId === leavingSessionId || player.isSpectator) continue;

      this.state.hostId = sessionId;
      console.log(`[room ${this.roomId}] host moved to ${player.name}`);
      return;
    }

    this.state.hostId = "";
  }

  /**
   * Handles a client dropping out.
   *
   * Colyseus has no separate `onDrop` hook — `allowReconnection` is documented
   * as only valid inside `onLeave`, so the wait lives here. An unconsented drop
   * (refresh, tab close, flaky network) holds the seat open for
   * `RECONNECT_WINDOW_SECONDS`; a consented `room.leave()` is treated as final
   * and tears down immediately.
   *
   * Holding the record is the whole point: it is what stops a player refreshing
   * away a lost life or a dropped star tier.
   */
  override async onLeave(client: Client, consented?: boolean): Promise<void> {
    const player = this.state.players.get(client.sessionId);

    if (consented) {
      this.removePlayer(client.sessionId, "left");
      return;
    }

    // Their tank stays on the field, flagged so others can see they are away.
    if (player) player.isConnected = false;
    this.moveIntents.delete(client.sessionId);

    console.log(
      `[room ${this.roomId}] ${client.sessionId} dropped — holding seat for ${RECONNECT_WINDOW_SECONDS}s`,
    );

    try {
      await this.allowReconnection(client, RECONNECT_WINDOW_SECONDS);

      // They made it back on the same session: everything they had is intact.
      const returning = this.state.players.get(client.sessionId);
      if (returning) returning.isConnected = true;

      console.log(`[room ${this.roomId}] ${client.sessionId} reconnected`);
    } catch {
      this.removePlayer(client.sessionId, "did not come back");
    }
  }

  /** Tears down everything belonging to a player who is gone for good. */
  private removePlayer(sessionId: string, reason: string): void {
    this.removeOwned(this.state.tanks, sessionId);
    this.removeOwned(this.state.bullets, sessionId);

    this.moveIntents.delete(sessionId);
    this.lastShotAtMs.delete(sessionId);
    this.playerSpawnIndex.delete(sessionId);
    this.pendingRespawns.delete(sessionId);
    this.invulnerableUntilMs.delete(sessionId);
    // deadPlayers is deliberately not cleared here — that is the whole point.
    this.deviceIdBySession.delete(sessionId);
    this.state.players.delete(sessionId);
    this.reassignHost(sessionId);

    console.log(`[room ${this.roomId}] ${sessionId} ${reason} — removed`);
  }

  /**
   * Puts a player's tank on its spawn point, if that ground is free.
   *
   * A returning tank is invulnerable for a moment so it cannot be shot the
   * instant it materialises on a contested pad.
   */
  private spawnPlayer(sessionId: string): boolean {
    const spawn = SPAWN_TILES[(this.playerSpawnIndex.get(sessionId) ?? 0) % SPAWN_TILES.length]!;
    const x = spawn.x * TILE_SIZE;
    const y = spawn.y * TILE_SIZE;

    if (!this.isSpawnClear(x, y)) return false;

    this.state.tanks.push(
      new Tank({
        x,
        y,
        width: TANK_SIZE,
        height: TANK_SIZE,
        ownerId: sessionId,
        maxHealth: TANK_MAX_HEALTH,
        speed: TANK_SPEED,
        direction: Direction.Up,
        isEnemy: false,
        isInvulnerable: true,
      }),
    );

    this.invulnerableUntilMs.set(sessionId, this.elapsedMs + PLAYER_INVULNERABILITY_MS);

    const player = this.state.players.get(sessionId);
    if (player) player.respawnInSeconds = 0;

    return true;
  }

  /** Drops the shield once the grace period is up. */
  private expireInvulnerability(): void {
    for (const [sessionId, until] of this.invulnerableUntilMs) {
      if (this.elapsedMs < until) continue;

      const tank = this.findTank(sessionId);
      if (tank) tank.isInvulnerable = false;
      this.invulnerableUntilMs.delete(sessionId);
    }
  }

  // ---------------------------------------------------------------- simulation

  /** True once the match has resolved; the simulation stops dead. */
  private get isOver(): boolean {
    return isMatchOver(this.state.matchState);
  }

  /** Only a running match simulates or accepts input. */
  private get isPlaying(): boolean {
    return this.state.matchState === MatchStatus.Playing;
  }

  /** One simulation step. */
  private update(deltaMs: number): void {
    // Nothing ticks outside a running match. In the staging lobby that means
    // no clock, no spawns, no movement and no shells, so a room can sit open
    // indefinitely while players gather; after it resolves, everything stops.
    if (!this.isPlaying) return;

    this.tick++;
    this.elapsedMs += deltaMs;

    this.advanceClock();
    this.releaseEnemies();
    this.respawnPlayers();
    this.expireInvulnerability();
    this.moveTanks();
    this.refreshHunterField();

    // A stopwatch holds every enemy still: no steering, no shooting.
    if (this.tick >= this.enemiesFrozenUntilTick) {
      updateEnemies(this.state, {
        fieldFor: (tank) => this.fieldFor(tank),
        canShoot: (tank) => this.readyToShoot(tank, ENEMY_SHOOT_COOLDOWN_MS),
        shoot: (tank) => this.fire(tank),
      });
    }

    const outcome = updateBullets(this.state);

    // Rebuild the routes only when the map actually changed. Tier 4 shells cut
    // steel, which opens routes the field treated as permanent walls.
    if (outcome.bricksDestroyed + outcome.steelDestroyed > 0) {
      this.flowField.rebuild(this.state.grid);
    }

    // Spark effects for shells that struck steel this tick.
    for (const spark of outcome.steelHits) {
      this.broadcast(ServerMessage.SteelHit, { x: spark.x, y: spark.y } satisfies SteelHitMessage);
    }

    for (const wreck of outcome.destroyedTanks) {
      this.onTankDestroyed(wreck);
    }

    collectBoons(this.state, (boon, player) => this.applyBoon(boon, player));
    this.expireShovel();

    if (outcome.eagleDestroyed) {
      this.endMatch(MatchStatus.GameOver, "the eagle was destroyed");
      return;
    }

    this.checkMatchEnd();

    // Movement already refuses to overlap; this only catches hulls that ended
    // up intersecting some other way.
    separateTanks(this.state);
  }

  /**
   * Drives every player tank whose movement intent is still live.
   *
   * Position is advanced here, on the tick — never inside the message handler.
   * If a `move` message moved the tank directly, a client sending input at
   * 200Hz would travel ten times faster than one sending at 20Hz.
   */
  private moveTanks(): void {
    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      const expiresAtTick = this.moveIntents.get(tank.ownerId);

      if (expiresAtTick === undefined) continue;

      if (this.tick >= expiresAtTick) {
        this.moveIntents.delete(tank.ownerId);
        continue;
      }

      moveTank(this.state, tank);
    }
  }

  /**
   * Clears the bookkeeping for a destroyed tank, and books a player's return.
   *
   * Enemies are not rescheduled — the wave queue supplies the next one.
   */
  private onTankDestroyed(tank: Tank): void {
    // Announce the kill for the client's explosion and camera shake. Reached
    // only for weapons-fire deaths — a leaving player, a bomb boon, or a reset
    // remove tanks by other paths and deliberately stay silent here.
    const destroyed: TankDestroyedMessage = {
      x: tank.x + tank.width / 2,
      y: tank.y + tank.height / 2,
      isEnemy: tank.isEnemy,
      heavy: tank.isEnemy && tank.maxHealth === 3,
    };
    this.broadcast(ServerMessage.TankDestroyed, destroyed);

    this.lastShotAtMs.delete(tank.ownerId);
    this.moveIntents.delete(tank.ownerId);

    if (tank.isEnemy) {
      this.objectives.delete(tank.ownerId);
      this.maybeDropBoon(tank);
      return;
    }

    this.invulnerableUntilMs.delete(tank.ownerId);

    const player = this.state.players.get(tank.ownerId);
    if (!player) return;

    player.lives = Math.max(0, player.lives - 1);

    if (player.lives === 0) {
      // Out of lives: they watch the rest of the match, and stay out even if
      // they close the tab and follow the invite link back in.
      player.isSpectator = true;
      player.respawnInSeconds = 0;

      const deviceId = this.deviceIdBySession.get(tank.ownerId);
      if (deviceId) this.deadPlayers.add(deviceId);
      console.log(`[room ${this.roomId}] ${tank.ownerId} is out of lives — spectating`);
      return;
    }

    // The star tier is lost with the tank, as in the original game.
    player.tier = 1;
    player.respawnInSeconds = Math.ceil(PLAYER_RESPAWN_DELAY_MS / 1000);
    this.pendingRespawns.set(tank.ownerId, this.elapsedMs + PLAYER_RESPAWN_DELAY_MS);
  }

  /** One destroyed enemy in ten leaves a power-up exactly where it fell. */
  private maybeDropBoon(wreck: Tank): void {
    if (Math.random() >= BOON_DROP_CHANCE) return;

    const kinds = Object.values(BoonType);
    const type = kinds[Math.floor(Math.random() * kinds.length)]!;

    this.state.boons.push(new Boon({ x: wreck.x, y: wreck.y, type }));
  }

  // -------------------------------------------------------------------- boons

  /** Applies a collected power-up and tells every client about it. */
  private applyBoon(boon: Boon, player: Tank): void {
    switch (boon.type) {
      case BoonType.Bomb:
        this.destroyAllEnemies();
        break;

      case BoonType.Star: {
        // Each star advances the collector one tier, up to the ceiling.
        const record = this.state.players.get(player.ownerId);
        if (record) record.tier = Math.min(MAX_PLAYER_TIER, record.tier + 1);
        break;
      }

      case BoonType.Stopwatch:
        this.enemiesFrozenUntilTick = this.tick + STOPWATCH_FREEZE_TICKS;
        break;

      case BoonType.Shovel:
        this.fortifyBunker();
        break;
    }

    const payload: BoonCollectedMessage = {
      type: boon.type,
      playerId: player.ownerId,
      x: boon.x,
      y: boon.y,
    };
    this.broadcast(ServerMessage.BoonCollected, payload);
  }

  /**
   * Wipes the field of enemies.
   *
   * Deliberately silent: these do not roll for drops, or one bomb could cascade
   * into a pile of fresh power-ups.
   */
  private destroyAllEnemies(): void {
    for (let i = this.state.tanks.length - 1; i >= 0; i--) {
      const tank = this.state.tanks.at(i);
      if (!tank.isEnemy) continue;

      this.lastShotAtMs.delete(tank.ownerId);
      this.objectives.delete(tank.ownerId);
      this.state.tanks.splice(i, 1);
    }
  }

  /** Turns the eagle's brick ring to steel until {@link shovelExpiresAtTick}. */
  private fortifyBunker(): void {
    for (const index of this.bunkerRingIndices()) {
      this.state.grid[index] = TileType.Steel;
    }

    this.shovelExpiresAtTick = this.tick + SHOVEL_DURATION_TICKS;
    this.flowField.rebuild(this.state.grid);
  }

  /** Puts the bunker back to brick once the shovel lapses. */
  private expireShovel(): void {
    if (this.shovelExpiresAtTick === null || this.tick < this.shovelExpiresAtTick) return;

    for (const index of this.bunkerRingIndices()) {
      // Only revert what is still steel: bricks blasted open stay open.
      if (this.state.grid.at(index) === TileType.Steel) {
        this.state.grid[index] = TileType.Brick;
      }
    }

    this.shovelExpiresAtTick = null;
    this.flowField.rebuild(this.state.grid);
  }

  private bunkerRingIndices(): number[] {
    const indices: number[] = [];

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;

        const x = EAGLE_TILE_X + dx;
        const y = EAGLE_TILE_Y + dy;
        if (x < 0 || y < 0) continue;

        indices.push(tileIndex(x, y));
      }
    }

    return indices;
  }

  /** Returns players to the field once their delay is up and the pad is free. */
  private respawnPlayers(): void {
    for (const [sessionId, dueAtMs] of this.pendingRespawns) {
      if (this.elapsedMs < dueAtMs) {
        // Keep the countdown fresh for the HUD.
        const waiting = this.state.players.get(sessionId);
        if (waiting) waiting.respawnInSeconds = Math.ceil((dueAtMs - this.elapsedMs) / 1000);
        continue;
      }

      // A blocked pad just means waiting another tick.
      if (this.spawnPlayer(sessionId)) {
        this.pendingRespawns.delete(sessionId);
      }
    }
  }

  // ------------------------------------------------------------ match clock

  /**
   * Advances the replicated match clock and stocks each new minute's wave.
   *
   * `elapsedSeconds` is only written when it actually changes, so it does not
   * dirty the state on every one of the twenty ticks inside a second.
   */
  // ------------------------------------------------------------ match result

  /**
   * Evaluates the remaining win and loss conditions once per tick.
   *
   * The eagle is handled separately, at the moment the shell lands. Everything
   * here is a standing condition rather than an event.
   */
  private checkMatchEnd(): void {
    // Only a match in progress can resolve.
    if (this.state.matchState !== MatchStatus.Playing) return;

    // Victory: outlasted the match clock.
    if (this.elapsedMs >= MATCH_DURATION_MS) {
      this.endMatch(MatchStatus.Victory, "survived the full match");
      return;
    }

    // Victory: every queued wave released and every enemy on the field killed.
    if (this.spawnQueue.isEmpty && this.countEnemies() === 0) {
      this.endMatch(MatchStatus.Victory, "cleared every wave");
      return;
    }

    // Defeat: every player has run out of lives. Only meaningful once someone
    // has actually joined — an empty room is waiting, not losing.
    if (this.state.players.size > 0 && this.allPlayersOut()) {
      this.endMatch(MatchStatus.GameOver, "all players out of lives");
    }
  }

  private allPlayersOut(): boolean {
    for (const [, player] of this.state.players) {
      if (!player.isSpectator) return false;
    }
    return true;
  }

  /**
   * Freezes the match and locks the room.
   *
   * Locking matters: without it `joinOrCreate` would keep handing new clients
   * this finished room, so a player hitting Restart would land straight back in
   * the game-over screen.
   */
  private endMatch(status: MatchStatus, reason: string): void {
    if (this.isOver) return;

    // Pin the run's length before the state flips: the simulation stops ticking
    // the instant it is no longer Playing, so elapsedSeconds freezes here. Copied
    // into finalTime so the game-over screen has an explicit figure to show.
    this.state.finalTime = this.state.elapsedSeconds;
    this.state.matchState = status;
    this.lock();

    console.log(`[room ${this.roomId}] ${status} — ${reason}`);
  }

  /**
   * Tears a resolved match back down to the staging lobby for another round.
   *
   * Host-only, and only once the match has actually finished — a running game
   * cannot be yanked out from under the other players. Everything the previous
   * match left on the field (shells, boons, tanks, the chewed-up map, the queue)
   * is cleared, every player is restored to a full three lives at tier 1 on their
   * spawn pad, and the per-room elimination record is wiped so nobody stays a
   * spectator into the new round. The room is unlocked so fresh players can join
   * the lobby again, and the reset is flushed to every client at once.
   */
  private resetMatch(sessionId: string): void {
    if (sessionId !== this.state.hostId) {
      console.log(`[room ${this.roomId}] ${sessionId} tried to reset; not the host`);
      return;
    }

    // Only a finished match resets. Mid-game this would be a way for the host to
    // wipe everyone else's progress on a whim.
    if (!this.isOver) {
      console.log(`[room ${this.roomId}] ${sessionId} tried to reset a live match — ignored`);
      return;
    }

    // 1. Sweep the field: pending waves, shells, boons and every tank.
    this.spawnQueue.clear();
    this.state.bullets.splice(0);
    this.state.boons.splice(0);
    this.state.tanks.splice(0);

    // 2. Rebuild the map — eagle bunker and walls back to a fresh arena.
    const fresh = createBattlefield();
    for (let i = 0; i < fresh.length; i++) {
      this.state.grid[i] = fresh[i]!;
    }
    this.flowField.rebuild(this.state.grid);

    // 3. Wipe the clock and all per-tank bookkeeping. elapsedMs is zeroed before
    //    anyone respawns so their invulnerability window is measured from zero.
    this.elapsedMs = 0;
    this.minutesQueued = 0;
    this.enemiesFrozenUntilTick = 0;
    this.shovelExpiresAtTick = null;
    this.moveIntents.clear();
    this.lastShotAtMs.clear();
    this.pendingRespawns.clear();
    this.invulnerableUntilMs.clear();
    this.objectives.clear();

    // 4. Eliminations don't carry into the next round.
    this.deadPlayers.clear();

    // 5. Restore every player and put their tank back on a spawn pad. Spawn
    //    indices are reassigned round-robin so returning spectators — who may
    //    never have had one — are spread across the pads rather than stacked.
    let seat = 0;
    for (const [id, player] of this.state.players) {
      player.lives = PLAYER_STARTING_LIVES;
      player.tier = 1;
      player.isSpectator = false;
      player.respawnInSeconds = 0;

      this.playerSpawnIndex.set(id, seat % SPAWN_TILES.length);
      this.spawnPlayer(id);
      seat++;
    }

    // 6. Reset the replicated scalars and drop back into the staging lobby.
    this.state.elapsedSeconds = 0;
    this.state.finalTime = 0;
    this.state.enemiesQueued = 0;
    this.state.matchState = MatchStatus.Lobby;

    // 7. The room was locked when the match ended; reopen it and push the whole
    //    reset to every client in one patch rather than waiting for the tick.
    void this.unlock();
    this.broadcastPatch();

    console.log(`[room ${this.roomId}] reset to lobby by the host`);
  }

  /** 1-based minute of the match; drives both wave size and concurrency. */
  private get currentMinute(): number {
    return Math.floor(this.elapsedMs / DIFFICULTY_STEP_MS) + 1;
  }

  private advanceClock(): void {
    const seconds = Math.floor(this.elapsedMs / 1000);
    if (this.state.elapsedSeconds !== seconds) {
      this.state.elapsedSeconds = seconds;
    }

    if (this.state.enemiesQueued !== this.spawnQueue.size) {
      this.state.enemiesQueued = this.spawnQueue.size;
    }

    const minutesElapsed = this.currentMinute;
    while (this.minutesQueued < minutesElapsed) {
      this.queueWaveForMinute(this.minutesQueued + 1);
    }
  }

  // -------------------------------------------------------------- enemy waves

  private fillSpawnQueue(): void {
    this.queueWaveForMinute(1);
  }

  /**
   * Stocks the queue for a given minute: 50 for the first, +10 for each after.
   *
   * Note this lengthens the wave rather than raising moment-to-moment pressure —
   * `MAX_CONCURRENT_ENEMIES` still caps how many can be on the field at once, so
   * a deeper queue mostly means the assault keeps coming for longer.
   */
  private queueWaveForMinute(minute: number): void {
    const size = ENEMY_WAVE_BASE + ENEMY_WAVE_GROWTH * (minute - 1);

    for (let i = 0; i < size; i++) {
      this.spawnQueue.push({ spawnPointIndex: i % ENEMY_SPAWN_TILES.length });
    }

    this.minutesQueued = minute;
    this.state.enemiesQueued = this.spawnQueue.size;

    console.log(
      `[room ${this.roomId}] minute ${minute}: queued ${size} enemies (${this.spawnQueue.size} pending)`,
    );
  }

  /** Releases a trickle of enemies once a second, up to the live cap. */
  private releaseEnemies(): void {
    if (this.tick % ENEMY_SPAWN_INTERVAL_TICKS !== 0) return;
    if (this.spawnQueue.isEmpty) return;

    const headroom = maxConcurrentEnemies(this.currentMinute) - this.countEnemies();
    if (headroom <= 0) return;

    const batch = Math.min(headroom, randomInt(ENEMY_SPAWN_BATCH_MIN, ENEMY_SPAWN_BATCH_MAX));

    for (const request of this.spawnQueue.take(batch)) {
      if (!this.spawnEnemy(request)) {
        // Spawn point occupied — try again on the next pass.
        this.spawnQueue.requeue(request);
      }
    }
  }

  private spawnEnemy(request: SpawnRequest): boolean {
    const tile = ENEMY_SPAWN_TILES[request.spawnPointIndex % ENEMY_SPAWN_TILES.length]!;
    const x = tile.x * TILE_SIZE;
    const y = tile.y * TILE_SIZE;

    if (!this.isSpawnClear(x, y)) return false;

    const tier = rollEnemyTier();
    const ownerId = `enemy-${this.enemySequence++}`;

    // 60% march on the eagle, 40% hunt whoever is nearest.
    this.objectives.set(ownerId, rollEnemyObjective());

    this.state.tanks.push(
      new Tank({
        x,
        y,
        width: TANK_SIZE,
        height: TANK_SIZE,
        ownerId,
        maxHealth: tier.health,
        speed: tier.speed,
        direction: Direction.Down,
        isEnemy: true,
      }),
    );

    return true;
  }

  // ----------------------------------------------------------- AI objectives

  /**
   * Recomputes the hunter field on a short interval.
   *
   * Multi-source Dijkstra from every living player means each cell points at
   * whichever player is cheapest to reach, so "target the closest player" falls
   * out of the field itself — no per-enemy distance checks, and the answer
   * updates as players move.
   */
  private refreshHunterField(): void {
    if (this.tick % HUNTER_FIELD_REBUILD_TICKS !== 0) return;

    const targets: { x: number; y: number }[] = [];
    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);
      if (tank.isEnemy) continue;

      targets.push({
        x: Math.floor((tank.x + tank.width / 2) / TILE_SIZE),
        y: Math.floor((tank.y + tank.height / 2) / TILE_SIZE),
      });
    }

    this.hunterField.rebuildToward(this.state.grid, targets);
  }

  /** Which route an enemy follows, falling back to the eagle when alone. */
  private fieldFor(tank: Tank): FlowField {
    if (this.objectives.get(tank.ownerId) !== EnemyObjective.Player) {
      return this.flowField;
    }

    // With no players alive the hunter field is empty; march on the eagle.
    return this.hunterField.isPopulated ? this.hunterField : this.flowField;
  }

  /** A spawn point is clear when no wall and no other tank occupies it. */
  private isSpawnClear(x: number, y: number): boolean {
    if (isBlocked(this.state, x, y, TANK_SIZE, TANK_SIZE)) return false;

    for (let i = 0; i < this.state.tanks.length; i++) {
      const tank = this.state.tanks.at(i);

      if (
        x < tank.x + tank.width &&
        x + TANK_SIZE > tank.x &&
        y < tank.y + tank.height &&
        y + TANK_SIZE > tank.y
      ) {
        return false;
      }
    }

    return true;
  }

  private countEnemies(): number {
    let count = 0;
    for (let i = 0; i < this.state.tanks.length; i++) {
      if (this.state.tanks.at(i).isEnemy) count++;
    }
    return count;
  }

  // -------------------------------------------------------------------- input

  /** Turns the tank and keeps it rolling for the next few ticks. */
  private requestMove(ownerId: string, direction: Direction): void {
    const tank = this.findTank(ownerId);
    if (!tank) return;

    // Turning is instant; the step itself happens on the next tick.
    tank.direction = direction;
    this.moveIntents.set(ownerId, this.tick + MOVE_INTENT_TTL_TICKS);
  }

  private playerShoot(ownerId: string): void {
    const tank = this.findTank(ownerId);
    if (!tank) return;

    // Tier 2 and up reload faster, so the limit comes from the profile.
    if (!this.readyToShoot(tank, this.profileFor(tank).cooldownMs)) return;

    this.fire(tank);
  }

  /**
   * Whether a tank may fire right now.
   *
   * Two independent limits: the cooldown, and the original game's rule that a
   * tank may only have one shell in the air at a time.
   */
  private readyToShoot(tank: Tank, cooldownMs: number): boolean {
    const lastShot = this.lastShotAtMs.get(tank.ownerId);
    if (lastShot !== undefined && this.elapsedMs - lastShot < cooldownMs) return false;

    // Enemies may only keep one shell in the air. Players are paced by the
    // cooldown alone — the one-shell rule would otherwise cancel out tier 3,
    // whose whole point is putting two shells up at once.
    if (tank.isEnemy) {
      return !this.state.bullets.some((bullet) => bullet.ownerId === tank.ownerId);
    }

    return true;
  }

  /** The combat profile a tank currently fights with. */
  private profileFor(tank: Tank): TierProfile {
    if (tank.isEnemy) return ENEMY_PROFILE;
    return tierProfile(this.state.players.get(tank.ownerId)?.tier ?? 1);
  }

  /**
   * Fires a volley from the tank's muzzle and starts its cooldown.
   *
   * Tier 3 and above fire two shells side by side, offset perpendicular to the
   * direction of travel so they run parallel rather than stacking.
   */
  private fire(tank: Tank): void {
    this.lastShotAtMs.set(tank.ownerId, this.elapsedMs);

    const profile = this.profileFor(tank);
    const heading = DIRECTION_VECTORS[tank.direction];
    // Perpendicular to the heading, for spreading a volley sideways.
    const across = { x: -heading.y, y: heading.x };

    for (const offset of volleyOffsets(profile.volley)) {
      this.state.bullets.push(
        new Bullet({
          // Centre the shell on the tank, push it out to the muzzle, then shift
          // it sideways into its place in the volley.
          x: tank.x + (tank.width - BULLET_SIZE) / 2 + heading.x * (tank.width / 2) + across.x * offset,
          y: tank.y + (tank.height - BULLET_SIZE) / 2 + heading.y * (tank.height / 2) + across.y * offset,
          width: BULLET_SIZE,
          height: BULLET_SIZE,
          ownerId: tank.ownerId,
          damage: BULLET_DAMAGE,
          direction: tank.direction,
          speed: profile.bulletSpeed,
          isEnemy: tank.isEnemy,
          piercesSteel: profile.piercesSteel,
        }),
      );
    }
  }

  // ------------------------------------------------------------------ helpers

  private findTank(ownerId: string): Tank | undefined {
    return this.state.tanks.find((tank) => tank.ownerId === ownerId);
  }

  /** Drops every entry belonging to `ownerId`, back to front. */
  private removeOwned<T extends { ownerId: string }>(entities: ArraySchema<T>, ownerId: string): void {
    for (let i = entities.length - 1; i >= 0; i--) {
      if (entities.at(i).ownerId === ownerId) {
        entities.splice(i, 1);
      }
    }
  }
}
