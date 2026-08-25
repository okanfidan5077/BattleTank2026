import Phaser from "phaser";
import { getStateCallbacks, type Room } from "colyseus.js";

import {
  BoonType,
  ClientMessage,
  Direction,
  GRID_HEIGHT,
  GRID_LENGTH,
  GRID_WIDTH,
  MatchStatus,
  MoveDirection,
  PLAYER_SHOOT_COOLDOWN_MS,
  PLAYER_TOP_BOUNDARY_Y,
  ServerMessage,
  TICK_MS,
  TILE_SIZE,
  TileType,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  isMatchOver,
  type BoonCollectedMessage,
  type MatchStatsMessage,
  type MatchStatsRow,
  type MoveMessage,
  type SteelHitMessage,
  type TankDestroyedMessage,
} from "@battletank/shared";

import { forgetSession, type BattleRoom } from "./network.js";
import { recordMatch } from "./progression.js";
import type { BattleStateView, BoonView, BulletView, PlayerView, TankView } from "./state.js";

/** Base resolution the scene is authored against; Phaser scales it to fit. */
export const BASE_WIDTH = 1920;
export const BASE_HEIGHT = 1080;

/** Textures generated at runtime in `preload()`. */
const TextureKey = {
  Empty: "tile-empty",
  Brick: "tile-brick",
  Steel: "tile-steel",
  Water: "tile-water",
  Eagle: "tile-eagle",
  TankPlayer: "tank-player",
  TankEnemy: "tank-enemy",
  Bullet: "bullet",
  BoonBomb: "boon-bomb",
  BoonStar: "boon-star",
  BoonStopwatch: "boon-stopwatch",
  BoonShovel: "boon-shovel",
  Shield: "shield",
  Particle: "particle",
} as const;

/**
 * Enemy colour by tier, keyed on maxHealth.
 *
 * The enemy hull is drawn in neutral white so these tints come out true; there
 * is no separate tier field on the wire.
 */
const ENEMY_TINT: Record<number, number> = {
  1: 0xe0483a,
  2: 0x9b59d0,
  3: 0x2e2e2e,
};

/**
 * Player hull tint by star tier, so an upgraded tank reads at a glance.
 *
 * Tier 1 is untinted (the neutral white hull); each tier up burns hotter —
 * yellow, orange, red — with tier 4 and beyond pinned at red.
 */
const PLAYER_TIER_TINT: Record<number, number> = {
  2: 0xffff00,
  3: 0xff8800,
  4: 0xff0000,
};

/** The tint for a player's star tier, or `null` for tier 1 (no tint). */
function playerTierTint(tier: number): number | null {
  if (tier <= 1) return null;
  return PLAYER_TIER_TINT[Math.min(4, tier)] ?? 0xff0000;
}

const BOON_TEXTURE: Record<BoonType, string> = {
  [BoonType.Bomb]: "boon-bomb",
  [BoonType.Star]: "boon-star",
  [BoonType.Stopwatch]: "boon-stopwatch",
  [BoonType.Shovel]: "boon-shovel",
};

/** Index of the eagle tile in the flat grid, for the HUD status readout. */
const EAGLE_TILE_INDEX = (GRID_HEIGHT - 1) * GRID_WIDTH + Math.floor(GRID_WIDTH / 2);

/** Height of the fixed HUD bar, in base-resolution pixels. */
const HUD_HEIGHT = 52;

const BULLET_SIZE = 8;

/**
 * How often a held movement key re-sends `move`, in ms.
 *
 * Matched to the server tick: sending every frame would emit ~60 messages a
 * second to drive a simulation that only steps 20 times a second.
 */
const MOVE_SEND_INTERVAL_MS = TICK_MS;

/** Client-side shoot throttle, from the shared contract so it cannot drift.
 *  The server enforces the same limit itself and remains the authority. */
const SHOOT_INTERVAL_MS = PLAYER_SHOOT_COOLDOWN_MS;

/** Sprites are drawn facing up, so rotation follows the facing directly. */
const ROTATION: Record<Direction, number> = {
  [Direction.Up]: 0,
  [Direction.Right]: Math.PI / 2,
  [Direction.Down]: Math.PI,
  [Direction.Left]: -Math.PI / 2,
};

/** Vertical anchor of the result overlay's footer control (button / label). */
const RESULT_FOOTER_Y = BASE_HEIGHT - 90;

/** Longest player name the scoreboard shows before eliding, in characters. */
const SCOREBOARD_NAME_WIDTH = 16;

/** Formats one fixed-width scoreboard line; monospace keeps the columns aligned. */
function scoreboardRow(rank: string, name: string, kills: string, shots: string): string {
  return rank.padEnd(3) + name.padEnd(SCOREBOARD_NAME_WIDTH + 2) + kills.padStart(6) + shots.padStart(8);
}

/** Trims a name to the scoreboard's column, marking the cut with an ellipsis. */
function truncateName(name: string): string {
  return name.length > SCOREBOARD_NAME_WIDTH
    ? `${name.slice(0, SCOREBOARD_NAME_WIDTH - 1)}…`
    : name;
}

export class GameScene extends Phaser.Scene {
  private room?: BattleRoom;

  /** One image per grid cell, indexed exactly like the server's 1D grid. */
  private tiles: Phaser.GameObjects.Image[] = [];

  /** Entity sprites, keyed by the replicated schema instance itself. */
  private tankSprites = new Map<TankView, Phaser.GameObjects.Image>();
  private bulletSprites = new Map<BulletView, Phaser.GameObjects.Image>();
  private boonSprites = new Map<BoonView, Phaser.GameObjects.Image>();

  private world!: Phaser.GameObjects.Container;
  private status!: Phaser.GameObjects.Text;

  /**
   * Pooled, scene-lived particle emitters — one for tank explosions, one for
   * steel sparks. Each event fires a burst via `explode()`; Phaser recycles the
   * particles internally and both emitters are torn down with the scene, so
   * there is no per-event allocation and nothing to leak.
   */
  private explosionEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;
  private sparkEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;

  /**
   * A private Web Audio context for the synthesized 8-bit blips.
   *
   * Own context rather than Phaser's sound manager (which `main.ts` disables
   * with `noAudio`): the beeps are generated from oscillators, so no asset files
   * or loaders are involved, and it is closed with the scene to free the handle.
   */
  private audioCtx?: AudioContext;

  /** Top HUD bar fields, refreshed from state each frame. */
  private hudTime!: Phaser.GameObjects.Text;
  private hudEnemies!: Phaser.GameObjects.Text;
  private hudEagle!: Phaser.GameObjects.Text;
  private hudPlayer!: Phaser.GameObjects.Text;

  /** Last string written to each HUD field, so we only re-render on change. */
  private hudCache = new Map<Phaser.GameObjects.Text, string>();

  /** Full-screen result overlay; built once the match resolves. */
  private overlay?: Phaser.GameObjects.Container;

  /**
   * The overlay's footer control — the Return to Lobby button for the host, or
   * the waiting label for everyone else. Held so it can be swapped in place when
   * the host changes while the overlay is up (e.g. the host disconnects and a
   * new one is promoted).
   */
  private overlayFooter?: Phaser.GameObjects.Text;

  /** Whether {@link overlayFooter} is the host's button rather than the label. */
  private overlayFooterIsButton = false;

  /** Post-match tallies, from the `MatchStats` message. */
  private matchStats?: MatchStatsRow[];

  /** The scoreboard table drawn onto the result overlay. */
  private scoreboard?: Phaser.GameObjects.Container;

  /**
   * Detachers for every room-level callback this scene registered.
   *
   * The room outlives the scene — it is reused for the next round after a reset
   * — so these must be torn down on shutdown. Left attached, a destroyed scene's
   * listeners would keep firing into freed sprites when the next match binds a
   * fresh scene to the same room. Only the top-level subscriptions are tracked;
   * per-entity `onChange` handlers are detached by Colyseus when their entity
   * leaves the collection, which the reset clears out before the scene dies.
   */
  private roomCleanups: Array<() => void> = [];

  /** Name labels above player tanks. */
  private labels = new Map<TankView, Phaser.GameObjects.Text>();

  /** Shield overlays for tanks currently in their respawn grace period. */
  private shields = new Map<TankView, Phaser.GameObjects.Image>();

  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd?: Record<"W" | "A" | "S" | "D", Phaser.Input.Keyboard.Key>;

  private lastMoveSentAt = 0;
  private lastShotAt = 0;

  /**
   * @param joinedRoom - an already-connected room, handed over by the lobby.
   *   The scene never joins on its own, so it always has state to render.
   */
  constructor(private readonly joinedRoom: BattleRoom) {
    super("GameScene");
  }

  // ------------------------------------------------------------------ preload

  preload(): void {
    this.makeTileTextures();
    this.makeEntityTextures();
  }

  /** Draws `key` with a throwaway Graphics object and bakes it into a texture. */
  private bakeTexture(
    key: string,
    width: number,
    height: number,
    draw: (graphics: Phaser.GameObjects.Graphics) => void,
  ): void {
    const graphics = this.add.graphics();
    draw(graphics);
    graphics.generateTexture(key, width, height);
    graphics.destroy();
  }

  private makeTileTextures(): void {
    const size = TILE_SIZE;

    this.bakeTexture(TextureKey.Empty, size, size, (g) => {
      g.fillStyle(0x14161a, 1).fillRect(0, 0, size, size);
    });

    this.bakeTexture(TextureKey.Brick, size, size, (g) => {
      g.fillStyle(0x8b4a2b, 1).fillRect(0, 0, size, size);
      // Mortar: three courses, offset every other row.
      g.fillStyle(0x5a2d18, 1);
      for (let y = 0; y < size; y += 8) {
        g.fillRect(0, y, size, 2);
        g.fillRect(((y / 8) % 2 === 0 ? 0 : 8) + 8, y, 2, 8);
        g.fillRect(((y / 8) % 2 === 0 ? 0 : 8) + 24, y, 2, 8);
      }
    });

    this.bakeTexture(TextureKey.Steel, size, size, (g) => {
      g.fillStyle(0x9aa3ad, 1).fillRect(0, 0, size, size);
      g.fillStyle(0xd6dde5, 1).fillRect(2, 2, size - 4, 4);
      g.fillStyle(0x646c75, 1).fillRect(2, size - 6, size - 4, 4);
      g.lineStyle(2, 0x4a5058, 1).strokeRect(1, 1, size - 2, size - 2);
    });

    this.bakeTexture(TextureKey.Water, size, size, (g) => {
      g.fillStyle(0x1f5f9e, 1).fillRect(0, 0, size, size);
      g.fillStyle(0x3d86cc, 1);
      g.fillRect(2, 8, 12, 3).fillRect(18, 20, 12, 3);
    });

    this.bakeTexture(TextureKey.Eagle, size, size, (g) => {
      g.fillStyle(0x2a2118, 1).fillRect(0, 0, size, size);
      g.fillStyle(0xf2c14e, 1);
      // Crude eagle: body, spread wings, tail.
      g.fillTriangle(size / 2, 4, 6, 20, size - 6, 20);
      g.fillRect(size / 2 - 3, 16, 6, 12);
      g.fillTriangle(size / 2 - 8, 28, size / 2 + 8, 28, size / 2, 20);
    });
  }

  private makeEntityTextures(): void {
    const size = TILE_SIZE;

    const tank = (body: number, trim: number) => (g: Phaser.GameObjects.Graphics) => {
      // Treads down each side.
      g.fillStyle(trim, 1);
      g.fillRect(1, 3, 7, size - 6).fillRect(size - 8, 3, 7, size - 6);
      // Hull.
      g.fillStyle(body, 1).fillRect(7, 6, size - 14, size - 10);
      // Barrel, pointing up.
      g.fillRect(size / 2 - 2, 0, 4, 12);
      // Turret.
      g.fillStyle(trim, 1).fillCircle(size / 2, size / 2 + 2, 5);
    };

    // Both hulls are neutral so setTint yields the true colour: players get
    // their chosen colour, enemies their tier colour.
    this.bakeTexture(TextureKey.TankPlayer, size, size, tank(0xffffff, 0xb4b4b4));
    // Neutral so setTint yields the true tier colour rather than a red blend.
    this.bakeTexture(TextureKey.TankEnemy, size, size, tank(0xffffff, 0xb4b4b4));

    this.bakeTexture(TextureKey.Bullet, BULLET_SIZE, BULLET_SIZE, (g) => {
      g.fillStyle(0xffffff, 1).fillCircle(BULLET_SIZE / 2, BULLET_SIZE / 2, BULLET_SIZE / 2);
    });

    // Respawn shield: a bright ring that sits over the hull while flashing.
    this.bakeTexture(TextureKey.Shield, size + 8, size + 8, (g) => {
      g.lineStyle(3, 0x7fd7ff, 1).strokeCircle((size + 8) / 2, (size + 8) / 2, size / 2 + 1);
      g.lineStyle(1, 0xffffff, 0.9).strokeCircle((size + 8) / 2, (size + 8) / 2, size / 2 - 3);
    });

    // A soft white dot the explosion and spark emitters tint and scale down.
    this.bakeTexture(TextureKey.Particle, 12, 12, (g) => {
      g.fillStyle(0xffffff, 0.35).fillCircle(6, 6, 6);
      g.fillStyle(0xffffff, 1).fillCircle(6, 6, 3);
    });

    this.makeBoonTextures();
  }

  /** Power-up pickups: a bright plate with a simple glyph on it. */
  private makeBoonTextures(): void {
    const size = TILE_SIZE;

    const plate = (g: Phaser.GameObjects.Graphics, fill: number) => {
      g.fillStyle(0xf7f3e8, 1).fillRect(0, 0, size, size);
      g.lineStyle(2, 0x2a2118, 1).strokeRect(1, 1, size - 2, size - 2);
      g.fillStyle(fill, 1);
    };

    this.bakeTexture(TextureKey.BoonBomb, size, size, (g) => {
      plate(g, 0x1e1e1e);
      g.fillCircle(size / 2, size / 2 + 3, 9);
      g.fillRect(size / 2 - 1, 6, 3, 6);
      g.fillStyle(0xe0483a, 1).fillCircle(size / 2 + 3, 6, 3);
    });

    this.bakeTexture(TextureKey.BoonStar, size, size, (g) => {
      plate(g, 0xf2c14e);
      // Two overlaid triangles make a passable star.
      g.fillTriangle(size / 2, 5, 6, 24, size - 6, 24);
      g.fillTriangle(size / 2, 27, 6, 11, size - 6, 11);
    });

    this.bakeTexture(TextureKey.BoonStopwatch, size, size, (g) => {
      plate(g, 0x3d86cc);
      g.fillCircle(size / 2, size / 2 + 2, 10);
      g.fillStyle(0xf7f3e8, 1).fillCircle(size / 2, size / 2 + 2, 7);
      g.fillStyle(0x1e1e1e, 1).fillRect(size / 2 - 1, size / 2 - 3, 2, 7);
      g.fillRect(size / 2 - 4, 4, 8, 3);
    });

    this.bakeTexture(TextureKey.BoonShovel, size, size, (g) => {
      plate(g, 0x8b4a2b);
      g.fillRect(size / 2 - 2, 5, 4, 14);
      g.fillStyle(0x9aa3ad, 1);
      g.fillTriangle(size / 2 - 8, 18, size / 2 + 8, 18, size / 2, 28);
    });
  }

  // ------------------------------------------------------------------- create

  create(): void {
    // The 60x33 field is 1920x1056 and the HUD bar takes the top 52px, so the
    // battlefield is scaled to fit what is left rather than hidden behind it.
    const fit = (BASE_HEIGHT - HUD_HEIGHT) / WORLD_HEIGHT;
    this.world = this.add
      .container((BASE_WIDTH - WORLD_WIDTH * fit) / 2, HUD_HEIGHT)
      .setScale(fit);

    this.buildTileGrid();

    this.buildBoundaryMarker();

    this.buildHud();

    this.buildEffects();

    const keyboard = this.input.keyboard;
    if (keyboard) {
      this.cursors = keyboard.createCursorKeys();
      this.wasd = keyboard.addKeys("W,A,S,D") as Record<
        "W" | "A" | "S" | "D",
        Phaser.Input.Keyboard.Key
      >;
      // Stop the browser scrolling the page while playing.
      keyboard.addCapture(["UP", "DOWN", "LEFT", "RIGHT", "SPACE"]);
    }

    this.initAudio();

    this.attach();

    // The room survives this scene; detach everything we bound to it when the
    // scene is destroyed, so the next match's scene starts from a clean slate.
    // `game.destroy()` emits DESTROY on each scene (not SHUTDOWN — the scene is
    // never merely stopped here), so that is the event to hang teardown on.
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.teardown());
  }

  /** Detaches every room callback registered by this scene. */
  private teardown(): void {
    for (const detach of this.roomCleanups) detach();
    this.roomCleanups = [];

    // Release the audio handle; browsers cap how many contexts can be open.
    void this.audioCtx?.close().catch(() => {});
    this.audioCtx = undefined;
  }

  // ---------------------------------------------------------------------- HUD

  /** Builds the fixed top bar. Screen space, so it never scrolls with the map. */
  private buildHud(): void {
    const barHeight = HUD_HEIGHT;

    this.add.rectangle(0, 0, BASE_WIDTH, barHeight, 0x0b0d10, 0.85).setOrigin(0, 0).setDepth(10);
    this.add.rectangle(0, barHeight, BASE_WIDTH, 2, 0x2a3038, 1).setOrigin(0, 0).setDepth(10);

    const field = (x: number, size: string, colour: string) =>
      this.add
        .text(x, 12, "", { fontFamily: "monospace", fontSize: size, color: colour })
        .setDepth(11);

    this.hudTime = field(24, "26px", "#f2c14e");
    this.hudEnemies = field(300, "26px", "#e0483a");
    this.hudEagle = field(660, "26px", "#8fa1b3");
    this.hudPlayer = field(1020, "26px", "#4caf50");

    this.status = this.add
      .text(BASE_WIDTH - 24, 16, "connecting...", {
        fontFamily: "monospace",
        fontSize: "18px",
        color: "#5c6b7a",
      })
      .setOrigin(1, 0)
      .setDepth(11);
  }

  /** Writes a HUD field only when its text actually changed. */
  private setField(field: Phaser.GameObjects.Text, text: string, colour?: string): void {
    if (this.hudCache.get(field) === text) return;

    this.hudCache.set(field, text);
    field.setText(text);
    if (colour) field.setColor(colour);
  }

  /** Pulls the whole bar from state. Cheap enough to run every frame. */
  private refreshHud(): void {
    const state = this.room?.state;

    // `room.state` exists the moment joinOrCreate resolves, but its collections
    // are only built when the first patch decodes — a frame or two later. Until
    // then `tanks`, `grid` and `players` are undefined, so wait for them rather
    // than reading through them.
    if (!state?.tanks || !state.grid || !state.players) return;

    const seconds = state.elapsedSeconds;
    const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
    const ss = String(seconds % 60).padStart(2, "0");
    this.setField(this.hudTime, `TIME ${mm}:${ss}`);

    const alive = state.tanks.filter((tank) => tank.isEnemy).length;
    this.setField(this.hudEnemies, `ENEMIES ${alive}  (${state.enemiesQueued} queued)`);

    const eagleAlive = state.grid.at(EAGLE_TILE_INDEX) === TileType.EagleBase;
    this.setField(
      this.hudEagle,
      `EAGLE ${eagleAlive ? "SECURE" : "DESTROYED"}`,
      eagleAlive ? "#8fa1b3" : "#e0483a",
    );

    const player = state.players.get(this.room!.sessionId);
    if (!player) {
      this.setField(this.hudPlayer, "");
      return;
    }

    if (player.isSpectator) {
      this.setField(this.hudPlayer, "SPECTATOR", "#e0483a");
      return;
    }

    const stars = "*".repeat(Math.max(0, player.tier - 1));
    const waiting = player.respawnInSeconds > 0 ? `  RESPAWN ${player.respawnInSeconds}` : "";
    this.setField(
      this.hudPlayer,
      `LIVES ${player.lives}   TIER ${player.tier}${stars}${waiting}`,
      player.respawnInSeconds > 0 ? "#f2c14e" : "#4caf50",
    );
  }

  // -------------------------------------------------------------- effects

  /** Creates the pooled explosion and spark emitters once, at scene start. */
  private buildEffects(): void {
    // Emitters live at screen (base-resolution) space rather than inside the
    // battlefield container, so their bursts are placed with `worldToScene`.
    // Depth 8 sits them above the tanks (in the depth-0 world container) but
    // below the HUD (depth 10+).
    this.explosionEmitter = this.add
      .particles(0, 0, TextureKey.Particle, {
        speed: { min: 120, max: 340 },
        angle: { min: 0, max: 360 },
        scale: { start: 0.9, end: 0 },
        alpha: { start: 1, end: 0 },
        lifespan: { min: 300, max: 620 },
        blendMode: Phaser.BlendModes.ADD,
        tint: [0xffe08a, 0xffa23a, 0xe0483a],
        emitting: false,
      })
      .setDepth(8);

    this.sparkEmitter = this.add
      .particles(0, 0, TextureKey.Particle, {
        speed: { min: 60, max: 220 },
        angle: { min: 0, max: 360 },
        scale: { start: 0.5, end: 0 },
        alpha: { start: 1, end: 0 },
        lifespan: { min: 150, max: 320 },
        blendMode: Phaser.BlendModes.ADD,
        tint: [0xffffff, 0xbfe4ff, 0x8fa1b3],
        emitting: false,
      })
      .setDepth(8);
  }

  /**
   * Converts a server world-space point to the scene's base-resolution space.
   *
   * The battlefield is drawn inside `this.world`, a scaled, offset container.
   * The effect emitters live at scene root, so a burst placed at an entity's
   * server coordinates has to be run through the same offset and scale.
   */
  private worldToScene(x: number, y: number): { x: number; y: number } {
    return {
      x: this.world.x + x * this.world.scaleX,
      y: this.world.y + y * this.world.scaleY,
    };
  }

  /** Explodes a tank and shakes the camera to match what was destroyed. */
  private spawnTankExplosion(message: TankDestroyedMessage): void {
    const at = this.worldToScene(message.x, message.y);
    this.explosionEmitter.explode(24, at.x, at.y);
    this.soundDestroyed();

    if (!message.isEnemy) {
      // A player went down: the heavy shake.
      this.cameras.main.shake(300, 0.02);
    } else if (message.heavy) {
      // A 3-HP heavy enemy: the medium shake.
      this.cameras.main.shake(150, 0.01);
    }
  }

  /** Small spark burst where a shell struck steel. */
  private spawnSteelSpark(message: SteelHitMessage): void {
    const at = this.worldToScene(message.x, message.y);
    this.sparkEmitter.explode(8, at.x, at.y);
  }

  // ---------------------------------------------------------------- audio

  /** Opens the Web Audio context, resuming it past the browser's autoplay gate. */
  private initAudio(): void {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    try {
      this.audioCtx = new Ctor();
      // The match starts on a click, so the gesture requirement is met — but
      // resume anyway in case the context still came up suspended.
      if (this.audioCtx.state === "suspended") void this.audioCtx.resume();
    } catch {
      // No audio available (blocked, unsupported): the game runs on regardless.
      this.audioCtx = undefined;
    }
  }

  /**
   * Plays one short oscillator note.
   *
   * A tiny attack-then-decay gain envelope keeps notes from clicking, and an
   * optional `endHz` glides the pitch for effects like the descending explosion.
   * Silently does nothing when audio is unavailable.
   */
  private tone(options: {
    type: OscillatorType;
    startHz: number;
    /** Glides to this pitch across the note when set (e.g. the death wail). */
    endHz?: number;
    /** Seconds. */
    duration: number;
    /** Seconds from now, for sequencing an arpeggio. */
    delay?: number;
    volume?: number;
  }): void {
    const ctx = this.audioCtx;
    if (!ctx || ctx.state === "closed") return;
    if (ctx.state === "suspended") void ctx.resume();

    const start = ctx.currentTime + (options.delay ?? 0);
    const end = start + options.duration;
    const volume = options.volume ?? 0.14;

    const osc = ctx.createOscillator();
    osc.type = options.type;
    osc.frequency.setValueAtTime(options.startHz, start);
    if (options.endHz !== undefined) {
      // Exponential ramps cannot touch zero, hence the floor.
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, options.endHz), end);
    }

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(end + 0.02);
  }

  /** Short high square blip when the local player fires. */
  private soundFire(): void {
    this.tone({ type: "square", startHz: 400, duration: 0.1, volume: 0.1 });
  }

  /** Descending sawtooth wail when a tank is destroyed. */
  private soundDestroyed(): void {
    this.tone({ type: "sawtooth", startHz: 100, endHz: 50, duration: 0.3, volume: 0.18 });
  }

  /** Fast three-note ascending arpeggio when a boon is collected. */
  private soundBoon(): void {
    const arpeggio = [523, 659, 784]; // C5, E5, G5
    arpeggio.forEach((hz, index) => {
      this.tone({ type: "square", startHz: hz, duration: 0.08, delay: index * 0.06, volume: 0.11 });
    });
  }

  // ------------------------------------------------------------ match result

  /**
   * Draws the end-of-match overlay.
   *
   * The host gets a Return to Lobby control that resets the match server-side;
   * everyone else is told to wait. When the reset lands, `matchState` flips back
   * to `LOBBY` and `main.ts` tears this scene down and restores the staging DOM —
   * so this overlay is torn down with the game rather than dismissed here.
   */
  private showResult(status: MatchStatus): void {
    if (this.overlay) return;

    const won = status === MatchStatus.Victory;
    const seconds = this.room?.state.finalTime ?? 0;

    const backdrop = this.add
      .rectangle(0, 0, BASE_WIDTH, BASE_HEIGHT, won ? 0x14401f : 0x5c0f0f, 0.82)
      .setOrigin(0, 0);

    const heading = this.add
      .text(BASE_WIDTH / 2, 150, won ? "VICTORY" : "GAME OVER", {
        fontFamily: "monospace",
        fontSize: "88px",
        color: won ? "#8ef2a4" : "#ff6b5a",
      })
      .setOrigin(0.5, 0);

    const detail = this.add
      .text(
        BASE_WIDTH / 2,
        250,
        won
          ? `Victory! Survived for ${seconds} seconds.`
          : `Game Over! Survived for ${seconds} seconds.`,
        { fontFamily: "monospace", fontSize: "28px", color: "#f7f3e8" },
      )
      .setOrigin(0.5, 0);

    this.overlayFooterIsButton = this.isHost();
    this.overlayFooter = this.overlayFooterIsButton ? this.buildReturnButton() : this.buildWaitingLabel();

    this.overlay = this.add
      .container(0, 0, [backdrop, heading, detail, this.overlayFooter])
      .setDepth(100);

    // Draw the scoreboard if the stats have already arrived; otherwise the
    // MatchStats handler draws it the moment they do.
    this.renderScoreboard();
  }

  /**
   * Draws (or redraws) the post-match scoreboard onto the result overlay.
   *
   * Ordered by kills, then by fewest shots, then by name. The local player's row
   * is picked out in gold. A no-op until both the overlay exists and the stats
   * have arrived — the two can land in either order.
   */
  private renderScoreboard(): void {
    if (!this.overlay || !this.matchStats) return;

    this.scoreboard?.destroy();

    const rows = [...this.matchStats].sort(
      (a, b) => b.kills - a.kills || a.shots - b.shots || a.name.localeCompare(b.name),
    );

    const startY = 340;
    const rowHeight = 36;
    const mySession = this.room?.sessionId;
    const children: Phaser.GameObjects.GameObject[] = [];

    children.push(
      this.add
        .text(BASE_WIDTH / 2, startY, scoreboardRow("#", "PLAYER", "KILLS", "SHOTS"), {
          fontFamily: "monospace",
          fontSize: "26px",
          color: "#8fa1b3",
        })
        .setOrigin(0.5, 0),
    );

    if (rows.length === 0) {
      children.push(
        this.add
          .text(BASE_WIDTH / 2, startY + 50, "(no players)", {
            fontFamily: "monospace",
            fontSize: "26px",
            color: "#5c6b7a",
          })
          .setOrigin(0.5, 0),
      );
    }

    rows.forEach((row, index) => {
      const mine = row.sessionId === mySession;
      children.push(
        this.add
          .text(
            BASE_WIDTH / 2,
            startY + 50 + index * rowHeight,
            scoreboardRow(`${index + 1}`, truncateName(row.name), `${row.kills}`, `${row.shots}`),
            { fontFamily: "monospace", fontSize: "26px", color: mine ? "#f2c14e" : "#f7f3e8" },
          )
          .setOrigin(0.5, 0),
      );
    });

    this.scoreboard = this.add.container(0, 0, children);
    this.overlay.add(this.scoreboard);
  }

  /**
   * Rebuilds the overlay footer to match the current host.
   *
   * Driven by the `hostId` listener: if the host drops after the match ends, the
   * server promotes a new one, and that client must gain the Return to Lobby
   * button on the spot rather than being stranded on a dead overlay. A no-op
   * while the overlay is not up (`hostId` also changes during normal play), or
   * when the footer already matches who we are now.
   */
  private syncOverlayHostControl(): void {
    if (!this.overlay || !this.overlayFooter) return;
    if (this.overlayFooterIsButton === this.isHost()) return;

    this.tweens.killTweensOf(this.overlayFooter);
    this.overlayFooter.destroy();

    this.overlayFooterIsButton = this.isHost();
    this.overlayFooter = this.overlayFooterIsButton ? this.buildReturnButton() : this.buildWaitingLabel();
    this.overlay.add(this.overlayFooter);
  }

  /** True when this client is the room host — the only one who may reset. */
  private isHost(): boolean {
    return this.room?.sessionId === this.room?.state.hostId;
  }

  /** Host-only control that asks the server to reset the match to the lobby. */
  private buildReturnButton(): Phaser.GameObjects.Text {
    const button = this.add
      .text(BASE_WIDTH / 2, RESULT_FOOTER_Y, "[ RETURN TO LOBBY ]", {
        fontFamily: "monospace",
        fontSize: "40px",
        color: "#f2c14e",
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    button.on("pointerover", () => button.setColor("#ffffff"));
    button.on("pointerout", () => button.setColor("#f2c14e"));
    button.on("pointerdown", () => this.returnToLobby(button));
    this.input.keyboard?.once("keydown-ENTER", () => this.returnToLobby(button));

    this.tweens.add({ targets: button, alpha: 0.4, duration: 700, yoyo: true, repeat: -1 });

    return button;
  }

  /** What everyone who is not the host sees while they wait for the reset. */
  private buildWaitingLabel(): Phaser.GameObjects.Text {
    return this.add
      .text(BASE_WIDTH / 2, RESULT_FOOTER_Y, "waiting for the host to return to the lobby...", {
        fontFamily: "monospace",
        fontSize: "28px",
        color: "#8fa1b3",
      })
      .setOrigin(0.5);
  }

  /**
   * Sends the reset request and locks the control so it cannot fire twice.
   *
   * The scene is not torn down here — the server flips `matchState` back to
   * `LOBBY`, and `main.ts` (which owns the Phaser instance) destroys the game
   * and restores the staging DOM in response.
   */
  private returnToLobby(button: Phaser.GameObjects.Text): void {
    if (!this.isHost()) return;

    this.tweens.killTweensOf(button);
    button.disableInteractive().setAlpha(1).setColor("#8fa1b3").setText("returning to lobby...");

    this.room?.send(ClientMessage.ResetMatch);
  }

  // -------------------------------------------------------------------- input

  /**
   * Polls the keyboard every frame and forwards intent to the server.
   *
   * Nothing moves locally: the tank's position comes back over the wire, so the
   * server stays the single authority on where anything is.
   */
  override update(time: number): void {
    if (!this.room) return;

    this.refreshHud();
    this.followLabels();

    // Only a running match accepts input: the staging lobby and a finished
    // match are both frozen. The server ignores it either way.
    if (this.room.state.matchState !== MatchStatus.Playing) return;

    const direction = this.readDirection();
    if (direction !== null && time - this.lastMoveSentAt >= MOVE_SEND_INTERVAL_MS) {
      this.room.send(ClientMessage.Move, { dir: direction } satisfies MoveMessage);
      this.lastMoveSentAt = time;
    }

    if (this.isShootDown() && time - this.lastShotAt >= SHOOT_INTERVAL_MS) {
      this.room.send(ClientMessage.Shoot);
      this.soundFire();
      this.lastShotAt = time;
    }
  }

  /** WASD or the arrow keys. When several are held, the first listed wins. */
  private readDirection(): MoveDirection | null {
    if (this.cursors?.up.isDown || this.wasd?.W.isDown) return MoveDirection.Up;
    if (this.cursors?.down.isDown || this.wasd?.S.isDown) return MoveDirection.Down;
    if (this.cursors?.left.isDown || this.wasd?.A.isDown) return MoveDirection.Left;
    if (this.cursors?.right.isDown || this.wasd?.D.isDown) return MoveDirection.Right;
    return null;
  }

  private isShootDown(): boolean {
    return this.cursors?.space.isDown === true;
  }

  /** Creates one image per cell up front; only its texture changes later. */
  private buildTileGrid(): void {
    for (let index = 0; index < GRID_LENGTH; index++) {
      const tileX = index % GRID_WIDTH;
      const tileY = Math.floor(index / GRID_WIDTH);

      const image = this.add
        .image(tileX * TILE_SIZE, tileY * TILE_SIZE, TextureKey.Empty)
        .setOrigin(0, 0);

      this.world.add(image);
      this.tiles[index] = image;
    }
  }

  /**
   * Marks the top rows players may not enter (the enemy spawn lane).
   *
   * Drawn into the world container in world units, so it lines up exactly with
   * the server's `PLAYER_TOP_BOUNDARY_Y` fence and scales with the battlefield.
   * Added right after the tiles, so tanks and shells still render on top of it —
   * enemies driving down through the zone stay clearly visible.
   */
  private buildBoundaryMarker(): void {
    // A faint red wash over rows 0–1.
    const zone = this.add
      .rectangle(0, 0, WORLD_WIDTH, PLAYER_TOP_BOUNDARY_Y, 0xe0483a, 0.12)
      .setOrigin(0, 0)
      .setDepth(1);
    this.world.add(zone);

    // Alternating hazard dashes right on the boundary line.
    const dash = TILE_SIZE;
    for (let x = 0; x < WORLD_WIDTH; x += dash * 2) {
      const stripe = this.add
        .rectangle(x, PLAYER_TOP_BOUNDARY_Y - 2, dash, 4, 0xf2c14e, 0.9)
        .setOrigin(0, 0)
        .setDepth(1);
      this.world.add(stripe);
    }
  }

  /** Attaches to the room the lobby already joined. */
  private attach(): void {
    const room = this.joinedRoom;
    this.room = room;

    this.bindState(room);
    this.status.setText(`${room.roomId}  ·  WASD / arrows to move  ·  SPACE to shoot`);

    const onError = (code: number, message?: string) => {
      this.status.setText(`connection error ${code}: ${message ?? ""}`).setColor("#e0483a");
      console.error("[client] room error", code, message);
    };
    room.onError(onError);
    this.roomCleanups.push(() => room.onError.remove(onError));
  }

  // -------------------------------------------------------------- state binding

  private bindState(room: BattleRoom): void {
    const $ = getStateCallbacks(room);

    // The match result drives the overlay. The token is deliberately kept: the
    // room lives on to be reset back to the lobby, so a refresh should resume
    // into it rather than opening a fresh lobby.
    this.roomCleanups.push(
      $(room.state).listen("matchState", (status: MatchStatus) => {
        if (!isMatchOver(status)) return;
        this.showResult(status);
      }),
    );

    // The host can change mid-overlay: if the original host drops after the
    // match ends, the server promotes someone else, who then needs the reset
    // control. Fires immediately with the current host too — harmless, since the
    // overlay does not exist yet at bind time.
    this.roomCleanups.push(
      $(room.state).listen("hostId", () => this.syncOverlayHostControl()),
    );

    // Repaint the whole map once the first snapshot lands, then keep it in
    // sync cell by cell — a destroyed brick only ever touches one index.
    room.onStateChange.once(() => {
      room.state.grid.forEach((tile, index) => this.paintTile(index, tile));
    });
    this.roomCleanups.push($(room.state).grid.onChange((tile, index) => this.paintTile(index, tile)));

    this.roomCleanups.push($(room.state).tanks.onAdd((tank) => {
      const sprite = this.spawnSprite(tank.isEnemy ? TextureKey.TankEnemy : TextureKey.TankPlayer);

      // Tier colour: red normal, purple armoured, near-black heavy.
      if (tank.isEnemy) sprite.setTint(ENEMY_TINT[tank.maxHealth] ?? ENEMY_TINT[1]!);

      this.tankSprites.set(tank, sprite);
      this.placeEntity(sprite, tank);
      this.syncShield(tank, sprite);

      if (!tank.isEnemy) {
        const owner = room.state.players.get(tank.ownerId);
        if (owner) this.syncPlayerVisuals(owner);
      }

      $(tank).onChange(() => {
        this.placeEntity(sprite, tank);
        this.syncShield(tank, sprite);
      });
    }));

    this.roomCleanups.push($(room.state).tanks.onRemove((tank) => {
      this.tankSprites.get(tank)?.destroy();
      this.tankSprites.delete(tank);
      this.shields.get(tank)?.destroy();
      this.shields.delete(tank);
      this.labels.get(tank)?.destroy();
      this.labels.delete(tank);
    }));

    // Identity lives on the player record, so watch that for name/colour.
    this.roomCleanups.push($(room.state).players.onAdd((player: PlayerView) => {
      this.syncPlayerVisuals(player);
      this.forgetIfEliminated(player);

      $(player).onChange(() => {
        this.syncPlayerVisuals(player);
        this.forgetIfEliminated(player);
      });
    }));

    this.roomCleanups.push($(room.state).bullets.onAdd((bullet) => {
      const sprite = this.spawnSprite(TextureKey.Bullet);
      this.bulletSprites.set(bullet, sprite);
      this.placeEntity(sprite, bullet);

      $(bullet).onChange(() => this.placeEntity(sprite, bullet));
    }));

    this.roomCleanups.push($(room.state).bullets.onRemove((bullet) => {
      this.bulletSprites.get(bullet)?.destroy();
      this.bulletSprites.delete(bullet);
    }));

    this.roomCleanups.push($(room.state).boons.onAdd((boon) => {
      const sprite = this.spawnSprite(BOON_TEXTURE[boon.type] ?? TextureKey.BoonStar);
      sprite.setPosition(boon.x + boon.width / 2, boon.y + boon.height / 2);
      // Gentle pulse so a pickup reads as collectable rather than scenery.
      this.tweens.add({ targets: sprite, scale: 1.15, duration: 500, yoyo: true, repeat: -1 });
      this.boonSprites.set(boon, sprite);
    }));

    this.roomCleanups.push($(room.state).boons.onRemove((boon) => {
      this.boonSprites.get(boon)?.destroy();
      this.boonSprites.delete(boon);
    }));

    this.roomCleanups.push(
      room.onMessage(ServerMessage.BoonCollected, (message: BoonCollectedMessage) => {
        this.announceBoon(message);
      }),
    );

    this.roomCleanups.push(
      room.onMessage(ServerMessage.TankDestroyed, (message: TankDestroyedMessage) => {
        this.spawnTankExplosion(message);
      }),
    );

    this.roomCleanups.push(
      room.onMessage(ServerMessage.SteelHit, (message: SteelHitMessage) => {
        this.spawnSteelSpark(message);
      }),
    );

    this.roomCleanups.push(
      room.onMessage(ServerMessage.MatchStats, (message: MatchStatsMessage) => {
        // May arrive before or after the overlay is built — store, then draw if
        // the overlay is already up.
        this.matchStats = message.rows;
        this.renderScoreboard();
        this.recordProgression(message.rows);
      }),
    );
  }

  /**
   * Folds this match into the browser's lifetime record.
   *
   * `MatchStats` is broadcast exactly once when the match resolves, and the
   * scene is torn down on return to the lobby, so this runs once per match — no
   * risk of double-counting the kills. `finalTime` is the match's length, shared
   * by everyone; the kills are pulled from this client's own row.
   */
  private recordProgression(rows: MatchStatsRow[]): void {
    const mine = rows.find((row) => row.sessionId === this.room?.sessionId);
    if (!mine) return;

    recordMatch(this.room?.state.finalTime ?? 0, mine.kills);
  }

  /** Brief on-screen flash where a power-up was taken. */
  private announceBoon(message: BoonCollectedMessage): void {
    const mine = message.playerId === this.room?.sessionId;

    this.soundBoon();

    const label = this.add
      .text(message.x, message.y, message.type.toUpperCase(), {
        fontFamily: "monospace",
        fontSize: "24px",
        color: mine ? "#f2c14e" : "#8fa1b3",
      })
      .setOrigin(0.5)
      .setDepth(20);
    this.world.add(label);

    this.tweens.add({
      targets: label,
      y: message.y - 48,
      alpha: 0,
      duration: 1200,
      onComplete: () => label.destroy(),
    });

    console.log(`[client] boon collected: ${message.type} by ${mine ? "us" : message.playerId}`);
  }

  /**
   * Applies a player's identity to their tank: colour and floating name.
   *
   * Driven from the `players` map rather than from the tank, because the record
   * outlives the tank and is what carries the name and colour.
   */
  private syncPlayerVisuals(player: PlayerView): void {
    for (const [tank, sprite] of this.tankSprites) {
      if (tank.isEnemy || tank.ownerId !== player.sessionId) continue;

      // Hull colour now signals the star tier rather than player identity —
      // names above the tanks still tell players apart.
      const tint = playerTierTint(player.tier);
      if (tint === null) sprite.clearTint();
      else sprite.setTint(tint);

      const label = this.labels.get(tank) ?? this.createLabel(tank);
      const away = player.isConnected ? "" : " (away)";

      label.setText(`${player.name}${away}`);
      label.setColor(player.isConnected ? "#f7f3e8" : "#8fa1b3");
      label.setPosition(sprite.x, sprite.y - TILE_SIZE);
    }
  }

  /**
   * Drops the reconnection token once we are out of the match.
   *
   * Holding a seat is only worth it while there is something to come back to.
   * Out of lives means spectating, and resuming that on a fresh page load would
   * strand the player watching a match they cannot rejoin.
   */
  private forgetIfEliminated(player: PlayerView): void {
    if (player.sessionId !== this.room?.sessionId) return;
    if (player.lives > 0 && !player.isSpectator) return;

    forgetSession();
  }

  private createLabel(tank: TankView): Phaser.GameObjects.Text {
    const label = this.add
      .text(0, 0, "", { fontFamily: "monospace", fontSize: "16px", color: "#f7f3e8" })
      .setOrigin(0.5, 1)
      .setDepth(7);

    this.world.add(label);
    this.labels.set(tank, label);
    return label;
  }

  /**
   * Pins every name label above its tank.
   *
   * Run per frame rather than off state patches: patches land at 20Hz, so a
   * label driven by them visibly lags its tank between updates. The label is
   * bottom-centre anchored, so this sits it squarely above the hull.
   */
  private followLabels(): void {
    for (const [tank, label] of this.labels) {
      const sprite = this.tankSprites.get(tank);
      if (!sprite) continue;

      label.setPosition(sprite.x, sprite.y - TILE_SIZE);
    }
  }

  /** Adds or removes the flashing shield that marks respawn invulnerability. */
  private syncShield(tank: TankView, sprite: Phaser.GameObjects.Image): void {
    const existing = this.shields.get(tank);

    if (!tank.isInvulnerable) {
      if (existing) {
        this.tweens.killTweensOf(existing);
        existing.destroy();
        this.shields.delete(tank);
      }
      return;
    }

    if (existing) {
      existing.setPosition(sprite.x, sprite.y);
      return;
    }

    const shield = this.add.image(sprite.x, sprite.y, TextureKey.Shield).setDepth(6);
    this.world.add(shield);
    this.shields.set(tank, shield);

    // Flash, so it reads as temporary rather than as part of the tank.
    this.tweens.add({ targets: shield, alpha: 0.15, duration: 180, yoyo: true, repeat: -1 });
  }

  private spawnSprite(texture: string): Phaser.GameObjects.Image {
    const sprite = this.add.image(0, 0, texture).setDepth(5);
    this.world.add(sprite);
    return sprite;
  }

  /** Server positions are top-left; Phaser images are centred on their origin. */
  private placeEntity(
    sprite: Phaser.GameObjects.Image,
    entity: { x: number; y: number; width: number; height: number; direction: Direction },
  ): void {
    sprite.setPosition(entity.x + entity.width / 2, entity.y + entity.height / 2);
    sprite.setRotation(ROTATION[entity.direction]);
  }

  private paintTile(index: number, tile: number): void {
    this.tiles[index]?.setTexture(this.textureForTile(tile));
  }

  private textureForTile(tile: number): string {
    switch (tile) {
      case TileType.Brick:
        return TextureKey.Brick;
      case TileType.Steel:
        return TextureKey.Steel;
      case TileType.Water:
        return TextureKey.Water;
      case TileType.EagleBase:
        return TextureKey.Eagle;
      default:
        return TextureKey.Empty;
    }
  }
}
