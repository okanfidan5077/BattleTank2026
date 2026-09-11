import Phaser from "phaser";
import { getStateCallbacks, type Room } from "colyseus.js";

import {
  BoonType,
  CAMPAIGN_LEVELS,
  CAMPAIGN_ROOM,
  findUpgrade,
  CampaignMessage,
  CampaignPhase,
  ClientMessage,
  Direction,
  GRID_HEIGHT,
  GRID_LENGTH,
  GRID_WIDTH,
  MatchStatus,
  MoveDirection,
  PLAYER_SHOOT_COOLDOWN_MS,
  campaignShootCooldownMs,
  PLAYER_TOP_BOUNDARY_Y,
  BLAST_UNLOCK_LEVEL,
  DECOY_UNLOCK_LEVEL,
  NULLIFIER_RADIUS_TILES,
  RAM_UNLOCK_LEVEL,
  STRIKE_UNLOCK_LEVEL,
  EMP_UNLOCK_LEVEL,
  LASER_UNLOCK_LEVEL,
  TRANSLOCATE_UNLOCK_LEVEL,
  SHIELD_UNLOCK_LEVEL,
  TELEPORT_MAX_CHARGES,
  TELEPORT_UNLOCK_LEVEL,
  ServerMessage,
  TICK_MS,
  TILE_SIZE,
  TileType,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  isMatchOver,
  type BoonCollectedMessage,
  type BossBounceMessage,
  type MatchStatsMessage,
  type BlastChangedMessage,
  type DecoyChangedMessage,
  type GrappleHitMessage,
  type RamChangedMessage,
  type MineDetonatedMessage,
  type MortarWarningMessage,
  type ShieldChangedMessage,
  type AimedMessage,
  type EmpChangedMessage,
  type EmpFiredMessage,
  type LaserChangedMessage,
  type LaserFiredMessage,
  type StrikeChangedMessage,
  type TranslocateChangedMessage,
  type UpgradeOfferMessage,
  type TeleportChangedMessage,
  type MatchStatsRow,
  type MoveMessage,
  type SteelHitMessage,
  type TankDestroyedMessage,
} from "@battletank/shared";

import {
  forgetSession,
  leaveRoomAndReload,
  type BattleRoom,
  type CampaignRoom,
  type GameRoom,
} from "./network.js";
import { recordMatch } from "./progression.js";
import type {
  BattleStateView,
  BoonView,
  BulletView,
  PlayerView,
  TankView,
  WorldStateView,
} from "./state.js";

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
  Radar: "tile-radar",
  Extraction: "tile-extraction",
  Uplink: "tile-uplink",
  Factory: "tile-factory",
  Bomb: "tile-bomb",
  Intel: "tile-intel",
  Mine: "tile-mine",
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

/**
 * Left edges of the four top-bar fields, in base-resolution px.
 *
 * Minimums rather than fixed positions: a field wider than its column pushes
 * the ones after it along — see {@link GameScene.reflowHud}.
 */
const HUD_COLUMNS = [24, 300, 660, 1020] as const;

/** Least clear space between two top-bar fields, in px. */
const HUD_FIELD_GAP = 48;

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

/** Milliseconds between revealed characters in the campaign typewriter. */
const CAMPAIGN_TYPE_SPEED_MS = 28;

export class GameScene extends Phaser.Scene {
  private room?: BattleRoom;

  /** Set instead of {@link room} when this scene is driving a campaign. */
  private campaignRoom?: CampaignRoom;

  /** Full-screen DOM briefing overlay, built lazily for campaign runs. */
  private campaignOverlay?: HTMLDivElement;
  private campaignHeadingEl?: HTMLDivElement;
  private campaignTextEl?: HTMLDivElement;
  private campaignPromptEl?: HTMLDivElement;

  /** Row of between-level upgrade cards inside the briefing overlay. */
  private campaignCardsEl?: HTMLDivElement;

  /** Armed 1/2/3 hotkeys for the current upgrade hand, if any. */
  private upgradeKeyHandler?: (event: KeyboardEvent) => void;

  /**
   * Upgrade stacks this player owns, mirrored from the server's offers.
   *
   * The client needs them for the two readouts that are computed rather than
   * pushed: its own reload (Autoloader) and the blink ceiling (Phase
   * Capacitor). Refreshed with every offer, including the empty one that
   * follows a pick.
   */
  private ownedUpgrades: Record<string, number> = {};

  /** The id taken from the current hand, so the row can show what was picked. */
  private pickedUpgradeId: string | null = null;

  /**
   * True while this seat has been dealt upgrade cards it has not taken one of.
   *
   * The server refuses to advance the level until every hand is spent, so the
   * debrief must not offer a "press SPACE" it would ignore — arming it anyway
   * would eat the keypress and leave the player on a screen nothing answers.
   */
  private awaitingUpgradePick = false;

  /** Pending typewriter tick, so a phase change can cancel a half-typed line. */
  private typewriterTimer?: number;

  /** The armed one-shot Spacebar handler for the current briefing, if any. */
  private campaignAdvance?: () => void;

  /** DOM bestiary sidebar, built once for campaign runs. */
  private bestiaryEl?: HTMLDivElement;

  /** Toggle button for the bestiary sidebar. */
  private bestiaryToggleEl?: HTMLDivElement;

  /** In-game menu button to return to lobby. */
  private menuBtnEl?: HTMLButtonElement;

  /** Deflector-shield status readout, shown from SHIELD_UNLOCK_LEVEL on. */
  private shieldHudEl?: HTMLDivElement;

  /** Interval driving the shield HUD's countdown text. */
  private shieldHudTimer?: number;

  /** Ring drawn around the player's tank while the shield is up. */
  private shieldAura?: Phaser.GameObjects.Arc;

  /** Blink-charge readout, shown from TELEPORT_UNLOCK_LEVEL on. */
  private teleportHudEl?: HTMLDivElement;

  /** Blink charges banked, mirrored from the server for the readout. */
  private teleportCharges = TELEPORT_MAX_CHARGES;

  /** Wall-clock ms at which the next blink charge returns; 0 when full. */
  private teleportReadyAt = 0;

  /** Blast readout, shown from BLAST_UNLOCK_LEVEL on. */
  private blastHudEl?: HTMLDivElement;

  /** Wall-clock ms at which the blast comes off cooldown; 0 when ready. */
  private blastReadyAt = 0;

  /** Ram and decoy readouts, shown from their unlock levels on. */
  private ramHudEl?: HTMLDivElement;
  private decoyHudEl?: HTMLDivElement;
  private strikeHudEl?: HTMLDivElement;
  private empHudEl?: HTMLDivElement;
  private laserHudEl?: HTMLDivElement;
  private jumpHudEl?: HTMLDivElement;

  /** The wrapping bar every ability readout is laid out in. */
  private abilityBarEl?: HTMLDivElement;

  /** Wall-clock ms at which the called strike is available again; 0 when ready. */
  private strikeReadyAt = 0;

  /** Wall-clock ms at which the suppression pulse is available again. */
  private empReadyAt = 0;

  /** Wall-clock ms at which the cutting lance is available again; 0 when ready. */
  private laserReadyAt = 0;

  /** Wall-clock ms at which the translocator is available again; 0 when ready. */
  private jumpReadyAt = 0;

  /** Wall-clock ms at which each comes off cooldown; 0 when ready. */
  private ramReadyAt = 0;
  private decoyReadyAt = 0;

  /** Timer for the upgrade-notification fade-out. */
  private upgradeNotifyTimer?: number;

  /** One image per grid cell, indexed exactly like the server's 1D grid. */
  private tiles: Phaser.GameObjects.Image[] = [];

  /** Looping alpha tweens on pulsing objective tiles (extraction, bomb), by index. */
  private pulseTiles = new Map<number, Phaser.Tweens.Tween>();

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

  /** Set once the scene is torn down; every room callback checks it and bails. */
  private destroyed = false;

  /** Name labels above player tanks. */
  private labels = new Map<TankView, Phaser.GameObjects.Text>();

  /** Shield overlays for tanks currently in their respawn grace period. */
  private shields = new Map<TankView, Phaser.GameObjects.Image>();

  /** Cyan aura circles drawn around Aegis miniboss tanks. */
  private aegisAuras = new Map<TankView, Phaser.GameObjects.Graphics>();

  /** Purge-level target rings, keyed by the hull they follow. */
  private markers = new Map<TankView, Phaser.GameObjects.Graphics>();

  /** The bracket drawn on the next objective, on an ordered level. */
  private objectiveMarker?: Phaser.GameObjects.Graphics;

  /** Armour/weak-point markers drawn over each Bastion. */
  private bastionPlates = new Map<TankView, Phaser.GameObjects.Graphics>();

  /**
   * Last seen health per tank, so a drop can be spotted.
   *
   * The wire carries the new value, not the delta, so the only way to know a
   * hit landed is to remember what it was a moment ago.
   */
  private lastHealth = new Map<TankView, number>();

  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd?: Record<"W" | "A" | "S" | "D", Phaser.Input.Keyboard.Key>;

  private lastMoveSentAt = 0;
  private lastShotAt = 0;

  /**
   * @param joinedRoom - an already-connected room, handed over by the lobby.
   *   The scene never joins on its own, so it always has state to render.
   */
  constructor(private readonly joinedRoom: GameRoom) {
    super("GameScene");
  }

  /** True when the lobby handed this scene a campaign room rather than a battle. */
  private get isCampaign(): boolean {
    return this.joinedRoom.name === CAMPAIGN_ROOM;
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

    // Radar / jamming tower: the campaign objective. Distinct cyan so it reads as
    // "shoot this" at a glance — a dish on a mast over a dark plinth.
    this.bakeTexture(TextureKey.Radar, size, size, (g) => {
      g.fillStyle(0x0a2230, 1).fillRect(0, 0, size, size);
      g.lineStyle(2, 0x00ffff, 1).strokeRect(1, 1, size - 2, size - 2);
      // Mast.
      g.fillStyle(0x00ffff, 1).fillRect(size / 2 - 1, 10, 2, size - 14);
      // Dish.
      g.fillCircle(size / 2, 10, 6);
      g.fillStyle(0x0a2230, 1).fillCircle(size / 2, 11, 3);
      // Base.
      g.fillStyle(0x00ffff, 1).fillRect(size / 2 - 6, size - 6, 12, 3);
    });

    // Extraction pad: the campaign objective for `reach_extraction`. Bright green
    // with an upward chevron; the tiles also pulse (see `paintTile`).
    this.bakeTexture(TextureKey.Extraction, size, size, (g) => {
      g.fillStyle(0x0a3010, 1).fillRect(0, 0, size, size);
      g.fillStyle(0x00ff00, 1).fillRect(0, 0, size, size);
      g.fillStyle(0x0a3010, 1).fillRect(3, 3, size - 6, size - 6);
      // Upward chevron pointing "this way out".
      g.fillStyle(0x00ff00, 1);
      g.fillTriangle(size / 2, 8, size / 2 - 8, 18, size / 2 + 8, 18);
      g.fillTriangle(size / 2, 16, size / 2 - 8, 26, size / 2 + 8, 26);
    });

    // Uplink zone: translucent blue wash over the dark ground, so the hold area
    // reads as a marked zone the player stands inside rather than solid terrain.
    this.bakeTexture(TextureKey.Uplink, size, size, (g) => {
      g.fillStyle(0x14161a, 1).fillRect(0, 0, size, size);
      g.fillStyle(0x0000ff, 0.3).fillRect(0, 0, size, size);
      g.lineStyle(1, 0x3355ff, 0.6).strokeRect(1, 1, size - 2, size - 2);
    });

    // Factory: a vivid orange industrial block (the Level 6 objective), with a
    // dark bolted frame and vents so it stands out as a "shoot me" structure.
    this.bakeTexture(TextureKey.Factory, size, size, (g) => {
      g.fillStyle(0xffa500, 1).fillRect(0, 0, size, size);
      g.lineStyle(2, 0x5a3a00, 1).strokeRect(1, 1, size - 2, size - 2);
      g.fillStyle(0x5a3a00, 1);
      // Two dark vents / hazard stripes.
      g.fillRect(6, 8, size - 12, 4);
      g.fillRect(6, size - 12, size - 12, 4);
      // Corner bolts.
      g.fillCircle(5, 5, 2).fillCircle(size - 5, 5, 2).fillCircle(5, size - 5, 2).fillCircle(size - 5, size - 5, 2);
    });

    // Dirty bomb: bright magenta pad with a dark bomb-and-fuse glyph (it also
    // pulses via the tile-pulse tween, so it reads as an active countdown).
    this.bakeTexture(TextureKey.Bomb, size, size, (g) => {
      g.fillStyle(0xff00ff, 1).fillRect(0, 0, size, size);
      g.lineStyle(2, 0x3a0033, 1).strokeRect(1, 1, size - 2, size - 2);
      g.fillStyle(0x1a0018, 1).fillCircle(size / 2, size / 2 + 3, 8);
      // Fuse.
      g.fillRect(size / 2 - 1, 5, 3, 6);
      g.fillStyle(0xffe08a, 1).fillCircle(size / 2 + 2, 5, 2);
    });

    // Intel package: a gold pad with a document glyph (pulses like the bomb).
    this.bakeTexture(TextureKey.Intel, size, size, (g) => {
      g.fillStyle(0x2a2410, 1).fillRect(0, 0, size, size);
      g.fillStyle(0xffd700, 1).fillRect(6, 5, size - 12, size - 10);
      g.fillStyle(0x2a2410, 1);
      g.fillRect(9, 9, size - 18, 2).fillRect(9, 14, size - 18, 2).fillRect(9, 19, size - 18, 2);
    });

    // Mine: a vivid red hazard square with a skull-and-crossbones glyph, filling
    // the whole tile — and it pulses (see `paintTile`) — so it reads instantly
    // as a lethal trap rather than scenery.
    this.bakeTexture(TextureKey.Mine, size, size, (g) => {
      g.fillStyle(0xff1a1a, 1).fillRect(0, 0, size, size);
      g.lineStyle(2, 0x300000, 1).strokeRect(1, 1, size - 2, size - 2);
      // Crossed bones behind the skull.
      g.lineStyle(4, 0x1a0000, 1);
      g.lineBetween(7, 7, size - 7, size - 7);
      g.lineBetween(size - 7, 7, 7, size - 7);
      // Skull: dark head with red eye sockets and a small jaw.
      g.fillStyle(0x1a0000, 1).fillCircle(size / 2, size / 2 - 1, 7);
      g.fillStyle(0xff1a1a, 1).fillCircle(size / 2 - 3, size / 2 - 2, 2);
      g.fillCircle(size / 2 + 3, size / 2 - 2, 2);
      g.fillStyle(0x1a0000, 1).fillRect(size / 2 - 3, size / 2 + 5, 6, 3);
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

    // The anti-camp "red zone" is a multiplayer-only concept — no place in the
    // single-player campaign, which disables the fence server-side too.
    if (this.joinedRoom.name !== CAMPAIGN_ROOM) {
      this.buildBoundaryMarker();
    }

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

    if (this.isCampaign) {
      this.attachCampaign(this.joinedRoom as CampaignRoom);
    } else {
      this.attach();
    }

    this.buildMenuButton();

    // Re-apply the campaign phase once the scene is genuinely up.
    //
    // Colyseus `listen` fires immediately with the current value. Before the
    // staging screen existed, Phaser booted the instant the room was joined and
    // the state had not decoded yet, so that first call arrived asynchronously —
    // safely after create(). Now the room is fully decoded while the party
    // gathers, so it lands *inside* create(), where `sys.isActive()` is still
    // false and `onCampaignPhase` drops it as though the scene were dead. The
    // briefing then never appeared, nothing ever sent `start_level`, and the
    // level sat empty. Re-syncing here is idempotent and cheap.
    if (this.isCampaign) {
      this.events.once(Phaser.Scenes.Events.CREATE, () => {
        const phase = this.campaignRoom?.state?.phase;
        if (phase) this.onCampaignPhase(phase);
      });
    }

    // The room outlives this scene, so every listener bound to it must come off
    // the moment the scene stops or is destroyed — otherwise a late network
    // packet fires a callback that touches freed Phaser objects and crashes.
    // `game.destroy()` emits DESTROY; a plain stop emits SHUTDOWN. Hook both so
    // teardown runs whichever way the scene ends; it is idempotent.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.teardown());
  }

  /** Detaches every room callback registered by this scene. Safe to call twice. */
  private teardown(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    // Explicitly unbind every Colyseus state listener this scene registered, so
    // packets that arrive after teardown find nothing to run.
    for (const detach of this.roomCleanups) detach();
    this.roomCleanups = [];

    // Tear down the campaign briefing: stop the typewriter, drop the armed
    // keypress, and remove the DOM overlay (it lives on document.body, outside
    // Phaser, so the scene's own teardown will not reclaim it).
    window.clearTimeout(this.typewriterTimer);
    this.typewriterTimer = undefined;
    this.disarmCampaignAdvance();
    this.campaignOverlay?.remove();
    this.campaignOverlay = undefined;
    this.campaignHeadingEl = undefined;
    this.campaignTextEl = undefined;
    this.campaignPromptEl = undefined;
    this.campaignCardsEl = undefined;
    if (this.upgradeKeyHandler) {
      window.removeEventListener("keydown", this.upgradeKeyHandler);
      this.upgradeKeyHandler = undefined;
    }

    window.clearTimeout(this.upgradeNotifyTimer);
    this.upgradeNotifyTimer = undefined;
    document.querySelector(".upgrade-notification")?.remove();
    this.bestiaryEl?.remove();
    this.bestiaryEl = undefined;
    this.bestiaryToggleEl?.remove();
    this.bestiaryToggleEl = undefined;
    this.menuBtnEl?.remove();
    this.menuBtnEl = undefined;
    window.clearInterval(this.shieldHudTimer);
    this.shieldHudTimer = undefined;
    this.shieldHudEl?.remove();
    this.shieldHudEl = undefined;
    this.teleportHudEl?.remove();
    this.teleportHudEl = undefined;
    this.blastHudEl?.remove();
    this.blastHudEl = undefined;
    this.ramHudEl?.remove();
    this.ramHudEl = undefined;
    this.decoyHudEl?.remove();
    this.decoyHudEl = undefined;
    this.strikeHudEl?.remove();
    this.strikeHudEl = undefined;
    this.empHudEl?.remove();
    this.empHudEl = undefined;
    this.laserHudEl?.remove();
    this.laserHudEl = undefined;
    this.jumpHudEl?.remove();
    this.jumpHudEl = undefined;
    this.abilityBarEl?.remove();
    this.abilityBarEl = undefined;

    // Release the audio handle; browsers cap how many contexts can be open.
    void this.audioCtx?.close().catch(() => {});
    this.audioCtx = undefined;
  }

  /** True once {@link teardown} has run — every callback bails on this. */
  private get isDead(): boolean {
    return this.destroyed || !this.sys || !this.sys.isActive();
  }

  /**
   * A Phaser object that is still safe to touch: present, active, and still
   * attached to a scene. A destroyed object has `active === false` and a null
   * `scene`, so mutating it would throw — callbacks check this first.
   */
  private isLive(obj: Phaser.GameObjects.GameObject | undefined | null): boolean {
    return !!obj && obj.active && !!obj.scene;
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

    this.hudTime = field(HUD_COLUMNS[0], "26px", "#f2c14e");
    this.hudEnemies = field(HUD_COLUMNS[1], "26px", "#e0483a");
    this.hudEagle = field(HUD_COLUMNS[2], "26px", "#8fa1b3");
    this.hudPlayer = field(HUD_COLUMNS[3], "26px", "#4caf50");

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

  /**
   * Lays the four top-bar fields out left to right by their measured widths.
   *
   * Fixed columns were fine while every readout was a few words. The relay
   * hold's "HOLD THE RELAY: 90s - INTEGRITY 4/4" is wider than its column, and
   * ran straight over the lives and hull pips beside it. Each field now starts
   * at its column or just clear of the one before it, whichever is further.
   */
  private reflowHud(): void {
    const fields = [this.hudTime, this.hudEnemies, this.hudEagle, this.hudPlayer];
    let nextFree = 0;
    fields.forEach((field, i) => {
      const x = Math.max(HUD_COLUMNS[i]!, nextFree);
      if (field.x !== x) field.setX(x);
      nextFree = x + (field.text ? field.width + HUD_FIELD_GAP : 0);
    });
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

    const me = this.findLocalTank();
    const hp = me?.currentHealth ?? 0;
    const maxHp = me?.maxHealth ?? 0;
    const pips = maxHp > 0 ? `  ${"█".repeat(hp)}${"░".repeat(Math.max(0, maxHp - hp))}` : "";

    const hurt = maxHp > 0 && hp <= maxHp / 2;
    this.setField(
      this.hudPlayer,
      `LIVES ${player.lives}   TIER ${player.tier}${stars}${pips}${waiting}`,
      player.respawnInSeconds > 0 ? "#f2c14e" : hurt ? "#f2c14e" : "#4caf50",
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

  /**
   * A pointer position in the server's world coordinates.
   *
   * The inverse of {@link worldToScene}. Phaser reports the pointer in scene
   * space, which is the 1920x1080 authored canvas after the FIT scale has been
   * undone for us — so only the battlefield container's own offset and scale
   * have to be taken back out.
   */
  private sceneToWorld(x: number, y: number): { x: number; y: number } {
    return {
      x: (x - this.world.x) / this.world.scaleX,
      y: (y - this.world.y) / this.world.scaleY,
    };
  }

  /**
   * Binds the two abilities that are aimed rather than pointed.
   *
   * Left click blinks toward the cursor, right click calls a strike down on it.
   * Both are the same abilities the keyboard already has — the mouse only
   * changes where they go, and the blink still costs a charge either way.
   *
   * The context menu is suppressed on the canvas only, so right-clicking the
   * page furniture around it still behaves like a web page.
   */
  private bindPointerAbilities(room: CampaignRoom): void {
    const canvas = this.game.canvas;

    const suppressMenu = (event: MouseEvent) => event.preventDefault();
    canvas.addEventListener("contextmenu", suppressMenu);
    this.roomCleanups.push(() => canvas.removeEventListener("contextmenu", suppressMenu));

    const onDown = (pointer: Phaser.Input.Pointer) => {
      if (this.isDead) return;
      if (room.state?.phase !== CampaignPhase.Playing) return;

      const aim = this.sceneToWorld(pointer.worldX, pointer.worldY);
      if (pointer.rightButtonDown()) {
        room.send(CampaignMessage.Strike, aim satisfies AimedMessage);
      } else if (pointer.leftButtonDown()) {
        room.send(CampaignMessage.Translocate, aim satisfies AimedMessage);
      }
    };

    this.input.on("pointerdown", onDown);
    this.roomCleanups.push(() => this.input.off("pointerdown", onDown));
  }

  /**
   * Draws the cutting lance: a white-hot core inside a wider glow, both fading.
   *
   * Two strokes rather than one because a single line at this length reads as a
   * UI element rather than as something that just happened — the bloom around
   * it is what makes it look like it cut.
   */
  private spawnLaserBeam(msg: LaserFiredMessage): void {
    if (this.isDead) return;

    const beam = this.add.graphics().setDepth(6);
    beam.lineStyle(10, 0xff5c2a, 0.35).lineBetween(msg.fromX, msg.fromY, msg.toX, msg.toY);
    beam.lineStyle(3, 0xfff0d0, 0.95).lineBetween(msg.fromX, msg.fromY, msg.toX, msg.toY);
    this.world.add(beam);

    this.tweens.add({
      targets: beam,
      alpha: 0,
      duration: 260,
      onComplete: () => beam.destroy(),
    });

    // A beam stopped by plate throws sparks off it; one that simply ran out of
    // brick budget does not, so the two endings are tellable apart.
    if (msg.blocked) {
      const at = this.worldToScene(msg.toX, msg.toY);
      if (this.isLive(this.sparkEmitter)) this.sparkEmitter.explode(10, at.x, at.y);
    }
  }

  /** Draws the suppression pulse: a hard ring that expands and fades out. */
  private spawnPulseRing(x: number, y: number, radius: number): void {
    if (this.isDead) return;

    const ring = this.add.graphics().setDepth(6);
    ring.lineStyle(4, 0x76c8ff, 0.9).strokeCircle(x, y, radius * 0.2);
    this.world.add(ring);

    this.tweens.add({
      targets: ring,
      scaleX: 5,
      scaleY: 5,
      alpha: 0,
      duration: 380,
      onComplete: () => ring.destroy(),
    });
    // Phaser scales a Graphics object about its own origin, so the circle has
    // to be centred there and the object moved into place.
    ring.setPosition(x, y);
    ring.clear();
    ring.lineStyle(4, 0x76c8ff, 0.9).strokeCircle(0, 0, radius * 0.2);
  }

  /** Explodes a tank and shakes the camera to match what was destroyed. */
  private spawnTankExplosion(message: TankDestroyedMessage): void {
    if (this.isDead || !this.isLive(this.explosionEmitter)) return;

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
    if (this.isDead || !this.isLive(this.sparkEmitter)) return;

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
   * Everyone gets their own Return to Lobby control: clicking it leaves the room
   * and reloads into fresh matchmaking, so each client tears itself down cleanly
   * rather than one client's reset dragging the others through a reused room.
   */
  private showResult(status: MatchStatus): void {
    if (this.isDead || this.overlay) return;

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

    const footer = this.buildReturnButton();

    this.overlay = this.add
      .container(0, 0, [backdrop, heading, detail, footer])
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
    if (this.isDead || !this.overlay || !this.matchStats) return;

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

  /** The Return to Lobby control shown on the result overlay. */
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

  /**
   * Leaves the room cleanly and returns to a fresh lobby.
   *
   * A hard break, not an in-place reset: the seat is released with an explicit
   * `room.leave()`, the resume token is dropped, and the page reloads into fresh
   * matchmaking. This is what keeps the client from clinging to — or getting
   * stuck reconnecting to — a room that is finished or gone.
   */
  private returnToLobby(button: Phaser.GameObjects.Text): void {
    this.tweens.killTweensOf(button);
    button.disableInteractive().setAlpha(1).setColor("#8fa1b3").setText("returning to lobby...");

    // The reload does not wait on the server: the token is dropped first, so a
    // slow (or hung) leave cannot hold the player on a dead screen.
    leaveRoomAndReload(this.room);
  }

  // -------------------------------------------------------------------- input

  /**
   * Polls the keyboard every frame and forwards intent to the server.
   *
   * Nothing moves locally: the tank's position comes back over the wire, so the
   * server stays the single authority on where anything is.
   */
  override update(time: number): void {
    if (this.isDead) return;

    if (this.isCampaign) {
      this.updateCampaign(time);
      return;
    }

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
    const room = this.joinedRoom as BattleRoom;
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

  // ------------------------------------------------------------------ campaign

  /**
   * Wires the single-player campaign: a DOM briefing overlay driven entirely by
   * the replicated `phase`. No battlefield binding — the campaign has no tanks,
   * grid or bullets in state yet, so only the narrative flow is set up here.
   */
  private attachCampaign(room: CampaignRoom): void {
    this.campaignRoom = room;
    this.buildCampaignOverlay();
    this.status.setText(`CAMPAIGN  ·  ${room.roomId}`);

    // Same battlefield renderer and combat effects as the battle room (cast
    // bridges Colyseus' contravariant Room type; CampaignStateView extends it).
    this.bindWorld(room as unknown as Room<WorldStateView>);
    this.bindEffects(room as unknown as Room<WorldStateView>);

    const $ = getStateCallbacks(room);

    // `listen` fires immediately with the current phase, then on every change —
    // so the opening intro renders without waiting for a transition.
    this.roomCleanups.push(
      $(room.state).listen("phase", (phase: CampaignPhase) => this.onCampaignPhase(phase)),
    );

    this.roomCleanups.push(
      $(room.state).listen("currentLevel", (level: number) => this.onCampaignLevelChange(level)),
    );

    this.buildBestiary();

    const cheatWin = () => room.send(CampaignMessage.CheatWin);
    this.input.keyboard?.on("keydown-G", cheatWin);
    this.roomCleanups.push(() => this.input.keyboard?.off("keydown-G", cheatWin));

    // SHIFT raises the deflector shield (unlocked from SHIELD_UNLOCK_LEVEL).
    const raiseShield = () => room.send(CampaignMessage.ActivateShield);
    this.input.keyboard?.on("keydown-SHIFT", raiseShield);
    this.roomCleanups.push(() => this.input.keyboard?.off("keydown-SHIFT", raiseShield));

    // Q blinks forward (unlocked from TELEPORT_UNLOCK_LEVEL).
    const blink = () => room.send(CampaignMessage.Teleport);
    this.input.keyboard?.on("keydown-Q", blink);
    this.roomCleanups.push(() => this.input.keyboard?.off("keydown-Q", blink));

    this.buildShieldHud();

    const onShield = (msg: ShieldChangedMessage) => this.onShieldChanged(msg);
    room.onMessage(ServerMessage.ShieldChanged, onShield);

    const onTeleport = (msg: TeleportChangedMessage) => this.onTeleportChanged(msg);
    room.onMessage(ServerMessage.TeleportChanged, onTeleport);

    // E detonates the close-in blast (unlocked from BLAST_UNLOCK_LEVEL).
    const blast = () => room.send(CampaignMessage.Blast);
    this.input.keyboard?.on("keydown-E", blast);
    this.roomCleanups.push(() => this.input.keyboard?.off("keydown-E", blast));

    const onBlast = (msg: BlastChangedMessage) => this.onBlastChanged(msg);
    room.onMessage(ServerMessage.BlastChanged, onBlast);

    // R surges forward; F drops a decoy beacon.
    const ram = () => room.send(CampaignMessage.Ram);
    this.input.keyboard?.on("keydown-R", ram);
    this.roomCleanups.push(() => this.input.keyboard?.off("keydown-R", ram));

    const decoy = () => room.send(CampaignMessage.Decoy);
    this.input.keyboard?.on("keydown-F", decoy);
    this.roomCleanups.push(() => this.input.keyboard?.off("keydown-F", decoy));

    // X fires the suppression pulse (unlocked from EMP_UNLOCK_LEVEL).
    const pulse = () => room.send(CampaignMessage.Emp);
    this.input.keyboard?.on("keydown-X", pulse);
    this.roomCleanups.push(() => this.input.keyboard?.off("keydown-X", pulse));

    // C fires the cutting lance (unlocked from LASER_UNLOCK_LEVEL).
    const lance = () => room.send(CampaignMessage.Laser);
    this.input.keyboard?.on("keydown-C", lance);
    this.roomCleanups.push(() => this.input.keyboard?.off("keydown-C", lance));

    room.onMessage(ServerMessage.LaserChanged, (msg: LaserChangedMessage) => {
      if (this.isDead) return;
      this.laserReadyAt = msg.cooldownMs > 0 ? Date.now() + msg.cooldownMs : 0;
      this.refreshLaserHud();
    });

    room.onMessage(ServerMessage.TranslocateChanged, (msg: TranslocateChangedMessage) => {
      if (this.isDead) return;
      this.jumpReadyAt = msg.cooldownMs > 0 ? Date.now() + msg.cooldownMs : 0;
      this.refreshJumpHud();
    });

    room.onMessage(ServerMessage.LaserFired, (msg: LaserFiredMessage) => {
      if (this.isDead) return;
      this.spawnLaserBeam(msg);
      this.tone({ type: "sawtooth", startHz: 1600, endHz: 700, duration: 0.22, volume: 0.11 });
    });

    room.onMessage(ServerMessage.StrikeChanged, (msg: StrikeChangedMessage) => {
      if (this.isDead) return;
      this.strikeReadyAt = msg.cooldownMs > 0 ? Date.now() + msg.cooldownMs : 0;
      this.refreshStrikeHud();
    });

    room.onMessage(ServerMessage.EmpChanged, (msg: EmpChangedMessage) => {
      if (this.isDead) return;
      this.empReadyAt = msg.cooldownMs > 0 ? Date.now() + msg.cooldownMs : 0;
      this.refreshEmpHud();
    });

    room.onMessage(ServerMessage.EmpFired, (msg: EmpFiredMessage) => {
      if (this.isDead) return;
      this.spawnPulseRing(msg.x, msg.y, msg.radius);
      this.tone({ type: "sine", startHz: 1200, endHz: 90, duration: 0.4, volume: 0.12 });
    });

    this.bindPointerAbilities(room);

    room.onMessage(ServerMessage.RamChanged, (msg: RamChangedMessage) => {
      if (this.isDead) return;
      // A surge somebody else is running — the mirror boss's — is drawn and
      // heard, but never written into this player's own cooldown.
      if (!msg.foreign) {
        this.ramReadyAt = msg.cooldownMs > 0 ? Date.now() + msg.cooldownMs : 0;
      }
      if (msg.active) {
        this.cameras.main.shake(160, 0.006);
        this.tone({ type: "sawtooth", startHz: 140, endHz: 420, duration: 0.28, volume: 0.15 });
      }
      this.refreshRamHud();
    });

    room.onMessage(ServerMessage.DecoyChanged, (msg: DecoyChangedMessage) => {
      if (this.isDead) return;
      this.decoyReadyAt = msg.cooldownMs > 0 ? Date.now() + msg.cooldownMs : 0;
      if (msg.x !== undefined && msg.y !== undefined) {
        this.spawnDecoyBeacon(msg.x, msg.y, msg.durationMs ?? 6000);
        this.tone({ type: "triangle", startHz: 600, endHz: 900, duration: 0.2, volume: 0.1 });
      }
      this.refreshDecoyHud();
    });

    room.onMessage(ServerMessage.GrappleHit, (msg: GrappleHitMessage) => {
      this.spawnGrappleTether(msg);
    });

    room.onMessage(ServerMessage.UpgradeOffer, (msg: UpgradeOfferMessage) => {
      this.renderUpgradeOffer(msg);
    });

    const onError = (code: number, message?: string) => {
      this.status.setText(`connection error ${code}: ${message ?? ""}`).setColor("#e0483a");
      console.error("[client] campaign room error", code, message);
    };
    room.onError(onError);
    this.roomCleanups.push(() => room.onError.remove(onError));
  }

  /** Reacts to a phase change: which briefing to show, and what SPACE does. */
  private onCampaignPhase(phase: CampaignPhase): void {
    if (this.isDead) return;

    // Levels are 1-based; the array is 0-based. Guard the lookup so a level
    // beyond the authored set never dereferences undefined.
    const level = CAMPAIGN_LEVELS[(this.campaignRoom?.state?.currentLevel ?? 1) - 1];

    switch (phase) {
      case CampaignPhase.Staging:
        // Handled by the DOM staging panel before Phaser boots; the scene only
        // ever sees this if a run somehow returns to it, so show nothing.
        this.hideCampaignOverlay();
        break;

      case CampaignPhase.Intro:
        // Forty levels is long enough that "which one is this?" is a real
        // question, so the briefing names the act and the level rather than
        // opening straight into the voice.
        this.setBriefingHeading(
          level ? `ACT ${level.act}  ·  ${level.id}. ${level.title.toUpperCase()}` : "",
        );
        this.showBriefing(level?.introText ?? "", "Press SPACE to Start");
        this.armCampaignAdvance(CampaignMessage.StartLevel);
        break;

      case CampaignPhase.Playing:
        this.hideCampaignOverlay();
        break;

      case CampaignPhase.Outro:
        this.setBriefingHeading("");
        // The offer message and this phase change race, so the prompt is
        // decided from the flag rather than from their arrival order.
        this.showBriefing(level?.outroText ?? "", this.outroPrompt());
        if (!this.awaitingUpgradePick) this.armCampaignAdvance(CampaignMessage.NextLevel);
        break;

      case CampaignPhase.GameOver:
        this.showBriefing("MISSION FAILED", "Press SPACE to Return");
        this.armCampaignReturn();
        break;

      case CampaignPhase.CampaignComplete:
        this.showBriefing("CAMPAIGN DEMO COMPLETED", "Press SPACE to Return");
        this.armCampaignReturn();
        break;
    }
  }

  /**
   * Arms a one-shot Spacebar that leaves the room and returns to the lobby.
   *
   * Used on `game_over`: unlike {@link armCampaignAdvance}, this does not message
   * the server — it cleanly drops the seat and reloads back to the start screen.
   */
  private armCampaignReturn(): void {
    this.disarmCampaignAdvance();

    const handler = () => {
      this.disarmCampaignAdvance();
      const room = this.campaignRoom;
      if (!room) return;
      // Clear the token first (there is none for campaign, but stay consistent
      // with the battle path), then leave and reload into a fresh lobby.
      leaveRoomAndReload(room);
    };

    this.campaignAdvance = handler;
    this.input.keyboard?.once("keydown-SPACE", handler);
  }

  /** Builds the full-screen black briefing overlay once, hidden to start. */
  private buildCampaignOverlay(): void {
    if (this.campaignOverlay) return;

    const overlay = document.createElement("div");
    overlay.className = "campaign-overlay";
    overlay.hidden = true;

    // Names the act and the level above the voice. Forty levels in, "which
    // one is this?" is a question the briefing should not make anyone ask.
    const heading = document.createElement("div");
    heading.className = "campaign-heading";
    heading.hidden = true;

    const text = document.createElement("div");
    text.className = "campaign-text";

    // Upgrade cards sit between the debrief and the "continue" prompt, so the
    // choice is the thing in the middle of the screen rather than a footnote.
    const cards = document.createElement("div");
    cards.className = "upgrade-cards";
    cards.hidden = true;

    const prompt = document.createElement("div");
    prompt.className = "campaign-prompt";

    overlay.append(heading, text, cards, prompt);
    document.body.appendChild(overlay);

    this.campaignOverlay = overlay;
    this.campaignHeadingEl = heading;
    this.campaignTextEl = text;
    this.campaignCardsEl = cards;
    this.campaignPromptEl = prompt;
  }

  /**
   * Renders this player's upgrade hand.
   *
   * An empty offer means the pick has already been spent (or there was nothing
   * left to offer), so the row collapses and the debrief reads as it always did.
   */
  private renderUpgradeOffer(msg: UpgradeOfferMessage): void {
    const cards = this.campaignCardsEl;
    if (!cards || this.isDead) return;

    this.ownedUpgrades = msg.owned;
    this.awaitingUpgradePick = msg.ids.length > 0;
    this.syncOutroPrompt();

    if (this.upgradeKeyHandler) {
      window.removeEventListener("keydown", this.upgradeKeyHandler);
      this.upgradeKeyHandler = undefined;
    }

    // An empty hand means the pick has been spent (or there was nothing left to
    // offer). Rather than blanking the row — which left the player unsure which
    // card, if any, had actually been taken — name the one they chose.
    if (msg.ids.length === 0) {
      cards.replaceChildren();

      const picked = this.pickedUpgradeId ? findUpgrade(this.pickedUpgradeId) : undefined;
      if (!picked) {
        cards.hidden = true;
        return;
      }

      const taken = document.createElement("div");
      taken.className = "upgrade-taken";
      taken.textContent = `ACQUIRED: ${picked.name} — ${picked.detail}`;
      cards.appendChild(taken);
      cards.hidden = false;
      return;
    }

    cards.replaceChildren();
    this.pickedUpgradeId = null;
    cards.hidden = false;

    msg.ids.forEach((id, index) => {
      const upgrade = findUpgrade(id);
      if (!upgrade) return;

      const card = document.createElement("button");
      card.className = "upgrade-card";
      card.type = "button";
      card.dataset.upgradeId = id;

      const owned = msg.owned[id] ?? 0;
      card.innerHTML =
        `<span class="upgrade-key">${index + 1}</span>` +
        `<span class="upgrade-name"></span>` +
        `<span class="upgrade-detail"></span>` +
        (owned > 0 ? `<span class="upgrade-owned"></span>` : "");

      // Names and details come from the shared catalogue, but they are written
      // in as text rather than markup so the card can never inject anything.
      card.querySelector(".upgrade-name")!.textContent = upgrade.name;
      card.querySelector(".upgrade-detail")!.textContent = upgrade.detail;
      if (owned > 0) {
        card.querySelector(".upgrade-owned")!.textContent = `owned x${owned}`;
      }

      card.addEventListener("click", () => this.pickUpgrade(id));
      cards.appendChild(card);
    });

    // 1/2/3 pick without reaching for the mouse.
    this.upgradeKeyHandler = (event: KeyboardEvent) => {
      const slot = Number.parseInt(event.key, 10);
      if (Number.isNaN(slot) || slot < 1 || slot > msg.ids.length) return;
      this.pickUpgrade(msg.ids[slot - 1]!);
    };
    window.addEventListener("keydown", this.upgradeKeyHandler);
  }

  /** What the debrief asks for: a card first, then the keypress. */
  private outroPrompt(): string {
    return this.awaitingUpgradePick ? "Choose an upgrade to continue" : "Press SPACE to Continue";
  }

  /**
   * Re-reads the debrief prompt and arms (or holds back) the advance key.
   *
   * Called whenever the outstanding offer changes, which is the only thing that
   * moves the debrief between its two states.
   */
  private syncOutroPrompt(): void {
    if (this.campaignRoom?.state?.phase !== CampaignPhase.Outro) return;

    const promptEl = this.campaignPromptEl;
    if (promptEl) promptEl.textContent = this.outroPrompt();

    if (this.awaitingUpgradePick) this.disarmCampaignAdvance();
    else this.armCampaignAdvance(CampaignMessage.NextLevel);
  }

  /** Sends a pick and disarms the hand so it cannot be spent twice. */
  private pickUpgrade(id: string): void {
    const room = this.campaignRoom;
    if (!room) return;
    if (this.pickedUpgradeId) return; // one card per hand

    this.pickedUpgradeId = id;
    room.send(CampaignMessage.ChooseUpgrade, { id });

    // Mark the choice immediately rather than waiting on the round trip: the
    // three cards are otherwise identical the instant after a click, and only
    // one of them was taken.
    const cards = this.campaignCardsEl;
    if (cards) {
      for (const card of cards.querySelectorAll<HTMLButtonElement>(".upgrade-card")) {
        card.disabled = true;
        card.classList.add(card.dataset.upgradeId === id ? "picked" : "passed");
      }
    }

    if (this.upgradeKeyHandler) {
      window.removeEventListener("keydown", this.upgradeKeyHandler);
      this.upgradeKeyHandler = undefined;
    }
    // The server echoes an empty offer back, which clears the row for real.
  }

  /**
   * Shows the overlay and types `body` out character by character, revealing the
   * blinking `prompt` only once the line has finished — an empty prompt hides it.
   */
  private showBriefing(body: string, prompt: string): void {
    this.buildCampaignOverlay();
    if (this.campaignOverlay) this.campaignOverlay.hidden = false;

    const promptEl = this.campaignPromptEl;
    if (promptEl) {
      promptEl.textContent = prompt;
      // Held out of sight until the typewriter lands, so it doesn't blink over
      // a still-typing line.
      promptEl.style.visibility = "hidden";
    }

    this.typeBriefing(body, () => {
      if (!this.isDead && promptEl && prompt) promptEl.style.visibility = "visible";
    });
  }

  /** Sets (or clears) the act-and-level line above the briefing. */
  private setBriefingHeading(heading: string): void {
    this.buildCampaignOverlay();
    const el = this.campaignHeadingEl;
    if (!el) return;

    el.textContent = heading;
    el.hidden = heading.length === 0;
  }

  /** Reveals `full` one character at a time, then calls `onDone`. */
  private typeBriefing(full: string, onDone: () => void): void {
    window.clearTimeout(this.typewriterTimer);

    const el = this.campaignTextEl;
    if (!el) return;

    if (full.length === 0) {
      el.textContent = "";
      onDone();
      return;
    }

    let revealed = 1;
    const step = () => {
      if (this.isDead || !this.campaignTextEl) return;

      this.campaignTextEl.textContent = full.slice(0, revealed);
      if (revealed >= full.length) {
        onDone();
        return;
      }

      revealed++;
      this.typewriterTimer = window.setTimeout(step, CAMPAIGN_TYPE_SPEED_MS);
    };
    step();
  }

  /** Hides the overlay and stops any in-flight typing or armed keypress. */
  private hideCampaignOverlay(): void {
    window.clearTimeout(this.typewriterTimer);
    this.typewriterTimer = undefined;
    this.disarmCampaignAdvance();

    // The hand goes with the overlay — 1/2/3 must not stay bound once the
    // level is running and those keys mean nothing.
    if (this.campaignCardsEl) {
      this.campaignCardsEl.replaceChildren();
      this.campaignCardsEl.hidden = true;
    }
    if (this.upgradeKeyHandler) {
      window.removeEventListener("keydown", this.upgradeKeyHandler);
      this.upgradeKeyHandler = undefined;
    }

    if (this.campaignOverlay) this.campaignOverlay.hidden = true;
  }

  private onCampaignLevelChange(level: number): void {
    if (this.isDead) return;
    const UPGRADE_MESSAGES: Record<number, string> = {
      6: "UPGRADE ACQUIRED: UPGRADED TRACKS (+15% Speed)",
      11: "UPGRADE ACQUIRED: HIGH-VELOCITY BARRELS (+Fire Rate & Bullet Speed)",
      16: "UPGRADE ACQUIRED: REACTIVE ARMOR (+2 Max Lives, +Invulnerability Time)",
    };
    const message = UPGRADE_MESSAGES[level];
    if (message) this.showUpgradeNotification(message);
  }

  private showUpgradeNotification(message: string): void {
    window.clearTimeout(this.upgradeNotifyTimer);

    let el = document.querySelector<HTMLDivElement>(".upgrade-notification");
    if (!el) {
      el = document.createElement("div");
      el.className = "upgrade-notification";
      document.body.appendChild(el);
    }

    el.textContent = message;
    el.hidden = false;
    el.style.opacity = "1";

    this.upgradeNotifyTimer = window.setTimeout(() => {
      if (el) {
        el.style.opacity = "0";
        window.setTimeout(() => { if (el) el.hidden = true; }, 600);
      }
    }, 4000);
  }

  /**
   * Builds the deflector-shield readout and starts its countdown ticker.
   *
   * The element is only shown once the campaign reaches the unlock level, so
   * earlier levels are not cluttered with a control the player does not have.
   */
  private buildShieldHud(): void {
    if (this.shieldHudEl) return;

    const bar = document.createElement("div");
    bar.className = "ability-bar";
    document.body.appendChild(bar);
    this.abilityBarEl = bar;

    const el = document.createElement("div");
    el.className = "shield-hud";
    el.hidden = true;
    bar.appendChild(el);
    this.shieldHudEl = el;

    const tp = document.createElement("div");
    tp.className = "teleport-hud";
    tp.hidden = true;
    bar.appendChild(tp);
    this.teleportHudEl = tp;

    const bl = document.createElement("div");
    bl.className = "blast-hud";
    bl.hidden = true;
    bar.appendChild(bl);
    this.blastHudEl = bl;

    const rm = document.createElement("div");
    rm.className = "ram-hud";
    rm.hidden = true;
    bar.appendChild(rm);
    this.ramHudEl = rm;

    const dc = document.createElement("div");
    dc.className = "decoy-hud";
    dc.hidden = true;
    bar.appendChild(dc);
    this.decoyHudEl = dc;

    const st = document.createElement("div");
    st.className = "strike-hud";
    st.hidden = true;
    bar.appendChild(st);
    this.strikeHudEl = st;

    const ep = document.createElement("div");
    ep.className = "emp-hud";
    ep.hidden = true;
    bar.appendChild(ep);
    this.empHudEl = ep;

    const lz = document.createElement("div");
    lz.className = "laser-hud";
    lz.hidden = true;
    bar.appendChild(lz);
    this.laserHudEl = lz;

    const jp = document.createElement("div");
    jp.className = "jump-hud";
    jp.hidden = true;
    bar.appendChild(jp);
    this.jumpHudEl = jp;

    // Driven on a timer rather than per-frame: the text only changes by whole
    // tenths, and this keeps it off the render path.
    this.shieldHudTimer = window.setInterval(() => {
      this.refreshShieldHud();
      this.refreshTeleportHud();
      this.refreshBlastHud();
      this.refreshRamHud();
      this.refreshDecoyHud();
      this.refreshStrikeHud();
      this.refreshEmpHud();
      this.refreshLaserHud();
      this.refreshJumpHud();
    }, 100);
    this.roomCleanups.push(() => window.clearInterval(this.shieldHudTimer));

    this.refreshShieldHud();
    this.refreshTeleportHud();
    this.refreshBlastHud();
    this.refreshRamHud();
    this.refreshDecoyHud();
    this.refreshStrikeHud();
    this.refreshEmpHud();
    this.refreshLaserHud();
    this.refreshJumpHud();
  }

  /** Repaints the translocator readout. */
  private refreshJumpHud(): void {
    this.refreshCooldownHud(
      this.jumpHudEl,
      "jump",
      TRANSLOCATE_UNLOCK_LEVEL,
      this.jumpReadyAt,
      "JUMP",
      "[LEFT CLICK]",
    );
  }

  /** Repaints the cutting-lance readout. */
  private refreshLaserHud(): void {
    this.refreshCooldownHud(
      this.laserHudEl,
      "laser",
      LASER_UNLOCK_LEVEL,
      this.laserReadyAt,
      "LANCE",
      "[C]",
    );
  }

  /** Repaints the called-strike readout. */
  private refreshStrikeHud(): void {
    this.refreshCooldownHud(
      this.strikeHudEl,
      "strike",
      STRIKE_UNLOCK_LEVEL,
      this.strikeReadyAt,
      "STRIKE",
      "[RIGHT CLICK]",
    );
  }

  /** Repaints the suppression-pulse readout. */
  private refreshEmpHud(): void {
    this.refreshCooldownHud(
      this.empHudEl,
      "emp",
      EMP_UNLOCK_LEVEL,
      this.empReadyAt,
      "PULSE",
      "[X]",
    );
  }

  /**
   * The shared shape of a cooldown readout: hidden until unlocked, greyed while
   * suppressed, counting down while cooling, and naming its key when ready.
   *
   * The four earlier readouts each spell this out themselves. Rather than
   * rewrite those — they carry per-ability wording the shared version would
   * flatten — the two new ones start from the common shape.
   */
  private refreshCooldownHud(
    el: HTMLDivElement | undefined,
    kind: string,
    unlockLevel: number,
    readyAt: number,
    label: string,
    key: string,
  ): void {
    if (!el || this.isDead) return;

    const level = this.campaignRoom?.state?.currentLevel ?? 1;
    if (level < unlockLevel) {
      el.hidden = true;
      return;
    }
    el.hidden = false;

    if (this.abilitiesSuppressed()) {
      el.className = `${kind}-hud ability-suppressed`;
      el.textContent = `${label} JAMMED`;
      return;
    }

    const now = Date.now();
    if (readyAt > now) {
      el.className = `${kind}-hud ${kind}-cooling`;
      el.textContent = `${label} ${Math.ceil((readyAt - now) / 1000)}s`;
    } else {
      el.className = `${kind}-hud ${kind}-ready`;
      el.textContent = `${label} READY ${key}`;
    }
  }

  /**
   * True when a live Nullifier is close enough to have switched the kit off.
   *
   * Computed here from the replicated tank positions rather than published by
   * the server — the radius is a shared constant, so both ends agree without an
   * extra field on the wire.
   */
  private abilitiesSuppressed(): boolean {
    const player = this.findLocalTank();
    if (!player) return false;

    const room = this.room ?? this.campaignRoom;
    const tanks = room?.state?.tanks;
    if (!tanks) return false;

    const px = player.x + player.width / 2;
    const py = player.y + player.height / 2;
    const radius = NULLIFIER_RADIUS_TILES * TILE_SIZE;

    return tanks.some((tank: TankView) => {
      if (tank.variant !== "nullifier") return false;
      const dx = tank.x + tank.width / 2 - px;
      const dy = tank.y + tank.height / 2 - py;
      return Math.hypot(dx, dy) <= radius;
    });
  }

  /** Repaints the ram readout. */
  private refreshRamHud(): void {
    const el = this.ramHudEl;
    if (!el || this.isDead) return;

    const level = this.campaignRoom?.state?.currentLevel ?? 1;
    if (level < RAM_UNLOCK_LEVEL) {
      el.hidden = true;
      return;
    }
    el.hidden = false;

    if (this.abilitiesSuppressed()) {
      el.className = "ram-hud ability-suppressed";
      el.textContent = "RAM JAMMED";
      return;
    }

    const now = Date.now();
    if (this.ramReadyAt > now) {
      el.className = "ram-hud ram-cooling";
      el.textContent = `RAM ${Math.ceil((this.ramReadyAt - now) / 1000)}s`;
    } else {
      el.className = "ram-hud ram-ready";
      el.textContent = "RAM READY [R]";
    }
  }

  /** Repaints the decoy readout. */
  private refreshDecoyHud(): void {
    const el = this.decoyHudEl;
    if (!el || this.isDead) return;

    const level = this.campaignRoom?.state?.currentLevel ?? 1;
    if (level < DECOY_UNLOCK_LEVEL) {
      el.hidden = true;
      return;
    }
    el.hidden = false;

    if (this.abilitiesSuppressed()) {
      el.className = "decoy-hud ability-suppressed";
      el.textContent = "DECOY JAMMED";
      return;
    }

    const now = Date.now();
    if (this.decoyReadyAt > now) {
      el.className = "decoy-hud decoy-cooling";
      el.textContent = `DECOY ${Math.ceil((this.decoyReadyAt - now) / 1000)}s`;
    } else {
      el.className = "decoy-hud decoy-ready";
      el.textContent = "DECOY READY [F]";
    }
  }

  /** A pulsing beacon marking where enemy attention has been pulled to. */
  private spawnDecoyBeacon(x: number, y: number, durationMs: number): void {
    if (this.isDead) return;

    const beacon = this.add.graphics().setDepth(5);
    beacon.fillStyle(0x35e0a1, 0.30).fillCircle(0, 0, TILE_SIZE * 1.4);
    beacon.lineStyle(3, 0x7dffcf, 0.95).strokeCircle(0, 0, TILE_SIZE * 1.4);
    beacon.fillStyle(0xbfffe8, 0.95).fillCircle(0, 0, TILE_SIZE * 0.3);
    beacon.setPosition(x, y);
    this.world.add(beacon);

    this.tweens.add({ targets: beacon, alpha: 0.45, duration: 320, yoyo: true, repeat: -1 });
    this.time.delayedCall(durationMs, () => {
      if (!this.isLive(beacon)) return;
      this.tweens.killTweensOf(beacon);
      beacon.destroy();
    });
  }

  /** The Lurcher's grapple line, snapping taut as it reels the player in. */
  private spawnGrappleTether(msg: GrappleHitMessage): void {
    if (this.isDead) return;

    const line = this.add.graphics().setDepth(5);
    line.lineStyle(3, 0xff5c8a, 0.95);
    line.lineBetween(msg.fromX, msg.fromY, msg.toX, msg.toY);
    this.world.add(line);

    this.tweens.add({
      targets: line,
      alpha: 0,
      duration: 380,
      onComplete: () => line.destroy(),
    });

    this.cameras.main.shake(140, 0.005);
    this.tone({ type: "sawtooth", startHz: 420, endHz: 140, duration: 0.22, volume: 0.13 });
  }

  /** Repaints the blast readout: ready, or counting down. */
  private refreshBlastHud(): void {
    const el = this.blastHudEl;
    if (!el || this.isDead) return;

    const level = this.campaignRoom?.state?.currentLevel ?? 1;
    if (level < BLAST_UNLOCK_LEVEL) {
      el.hidden = true;
      return;
    }
    el.hidden = false;

    if (this.abilitiesSuppressed()) {
      el.className = "blast-hud ability-suppressed";
      el.textContent = "BLAST JAMMED";
      return;
    }

    const now = Date.now();
    if (this.blastReadyAt > now) {
      el.className = "blast-hud blast-cooling";
      el.textContent = `BLAST ${Math.ceil((this.blastReadyAt - now) / 1000)}s`;
    } else {
      el.className = "blast-hud blast-ready";
      el.textContent = "BLAST READY [E]";
    }
  }

  /** Applies a blast state change, firing the shockwave on an actual blast. */
  private onBlastChanged(msg: BlastChangedMessage): void {
    if (this.isDead) return;

    // Only this player's own blast moves this player's cooldown; the mirror
    // boss's copy of the ability is drawn and nothing more.
    if (!msg.foreign) {
      this.blastReadyAt = msg.cooldownMs > 0 ? Date.now() + msg.cooldownMs : 0;
    }

    if (msg.x !== undefined && msg.y !== undefined) {
      this.spawnBlastWave(msg.x, msg.y, msg.radius ?? TILE_SIZE * 6, msg.brickRadius);
      this.cameras.main.shake(220, 0.010);
      this.tone({ type: "square", startHz: 320, endHz: 40, duration: 0.42, volume: 0.18 });
    }

    this.refreshBlastHud();
  }

  /**
   * An expanding shockwave marking exactly what the blast reached.
   *
   * Two rings, because the blast now has two radii: the outer one is everything
   * it killed, the inner, hotter one is the smaller area where terrain actually
   * broke. Drawing only the outer would imply the whole circle was demolished.
   */
  private spawnBlastWave(x: number, y: number, radius: number, brickRadius?: number): void {
    if (this.isDead) return;

    // Drawn at full radius and scaled up from nothing, so the ring the player
    // sees at its peak is precisely the area the server cleared.
    const wave = this.add.graphics().setDepth(7);
    wave.fillStyle(0xffd23f, 0.18).fillCircle(0, 0, radius);
    wave.lineStyle(4, 0xfff3b0, 0.95).strokeCircle(0, 0, radius);
    if (brickRadius !== undefined && brickRadius < radius) {
      wave.fillStyle(0xff8a00, 0.28).fillCircle(0, 0, brickRadius);
      wave.lineStyle(3, 0xffb347, 0.9).strokeCircle(0, 0, brickRadius);
    }
    wave.setPosition(x, y).setScale(0.1);
    this.world.add(wave);

    this.tweens.add({
      targets: wave,
      scale: 1,
      alpha: 0,
      duration: 420,
      ease: "Cubic.Out",
      onComplete: () => wave.destroy(),
    });
  }

  /** Repaints the blink readout: charges banked, and the recharge countdown. */
  private refreshTeleportHud(): void {
    const el = this.teleportHudEl;
    if (!el || this.isDead) return;

    const level = this.campaignRoom?.state?.currentLevel ?? 1;
    if (level < TELEPORT_UNLOCK_LEVEL) {
      el.hidden = true;
      return;
    }
    el.hidden = false;

    if (this.abilitiesSuppressed()) {
      el.className = "teleport-hud ability-suppressed";
      el.textContent = "BLINK JAMMED";
      return;
    }

    // The ceiling rises with each Phase Capacitor, so the empty pips have to
    // be counted against that rather than against the base two.
    const cap = Math.max(
      TELEPORT_MAX_CHARGES + (this.ownedUpgrades.blink ?? 0),
      this.teleportCharges,
    );
    const pips = "●".repeat(this.teleportCharges) + "○".repeat(
      Math.max(0, cap - this.teleportCharges),
    );

    const now = Date.now();
    if (this.teleportCharges > 0) {
      el.className = "teleport-hud teleport-ready";
      el.textContent = `BLINK ${pips} [Q]`;
    } else {
      el.className = "teleport-hud teleport-empty";
      const left = this.teleportReadyAt > now ? Math.ceil((this.teleportReadyAt - now) / 1000) : 0;
      el.textContent = `BLINK ${pips} ${left}s`;
    }
  }

  /** Applies a blink state change from the server, animating an actual jump. */
  private onTeleportChanged(msg: TeleportChangedMessage): void {
    if (this.isDead) return;

    // Same rule as the blast: a blink the mirror boss took is an effect to
    // draw, not a charge count to adopt.
    if (!msg.foreign) {
      this.teleportCharges = msg.charges;
      this.teleportReadyAt = msg.rechargeMs > 0 ? Date.now() + msg.rechargeMs : 0;
    }

    if (msg.fromX !== undefined && msg.toX !== undefined) {
      this.spawnBlinkEffect(msg.fromX, msg.fromY ?? 0, msg.toX, msg.toY ?? 0);
      this.tone({ type: "square", startHz: 900, endHz: 300, duration: 0.16, volume: 0.1 });
    }

    this.refreshTeleportHud();
  }

  /**
   * Draws the blink: a fading ghost at the departure point and a streak along
   * the path, so the jump reads as movement rather than a snap.
   */
  private spawnBlinkEffect(fromX: number, fromY: number, toX: number, toY: number): void {
    if (this.isDead) return;

    const half = TILE_SIZE / 2;

    const ghost = this.add.graphics().setDepth(5);
    ghost.fillStyle(0x9a7bff, 0.55).fillRect(fromX, fromY, TILE_SIZE, TILE_SIZE);
    this.world.add(ghost);
    this.tweens.add({
      targets: ghost,
      alpha: 0,
      duration: 320,
      onComplete: () => ghost.destroy(),
    });

    const streak = this.add.graphics().setDepth(5);
    streak.lineStyle(6, 0xc4b0ff, 0.7);
    streak.lineBetween(fromX + half, fromY + half, toX + half, toY + half);
    this.world.add(streak);
    this.tweens.add({
      targets: streak,
      alpha: 0,
      duration: 260,
      onComplete: () => streak.destroy(),
    });
  }

  /** Repaints the shield readout from the replicated state and local timers. */
  private refreshShieldHud(): void {
    const el = this.shieldHudEl;
    if (!el || this.isDead) return;

    const level = this.campaignRoom?.state?.currentLevel ?? 1;
    if (level < SHIELD_UNLOCK_LEVEL) {
      el.hidden = true;
      return;
    }
    el.hidden = false;

    // A shield already up is not stripped by a Nullifier — only reaching for a
    // new one is refused — so the jam marker waits until it has dropped.
    if (this.shieldActiveUntil <= Date.now() && this.abilitiesSuppressed()) {
      el.className = "shield-hud ability-suppressed";
      el.textContent = "SHIELD JAMMED";
      return;
    }

    const now = Date.now();
    if (this.shieldActiveUntil > now) {
      const left = ((this.shieldActiveUntil - now) / 1000).toFixed(1);
      el.className = "shield-hud shield-active";
      el.textContent = `SHIELD UP ${left}s`;
    } else if (this.shieldReadyAt > now) {
      const left = Math.ceil((this.shieldReadyAt - now) / 1000);
      el.className = "shield-hud shield-cooling";
      el.textContent = `SHIELD ${left}s`;
    } else {
      el.className = "shield-hud shield-ready";
      el.textContent = "SHIELD READY [SHIFT]";
    }
  }

  /** Tracks shield windows locally so the HUD can count down between packets. */
  private shieldActiveUntil = 0;
  private shieldReadyAt = 0;

  /** Applies a shield state change from the server. */
  private onShieldChanged(msg: ShieldChangedMessage): void {
    if (this.isDead) return;

    const now = Date.now();
    if (msg.active) {
      this.shieldActiveUntil = now + (msg.durationMs ?? 0);
      this.shieldReadyAt = 0;
      // Rising chime as it comes up.
      this.tone({ type: "sine", startHz: 440, endHz: 880, duration: 0.22 });
    } else if (msg.ready) {
      this.shieldActiveUntil = 0;
      this.shieldReadyAt = 0;
      this.tone({ type: "sine", startHz: 880, duration: 0.09, volume: 0.08 });
    } else {
      this.shieldActiveUntil = 0;
      this.shieldReadyAt = now + (msg.cooldownMs ?? 0);
    }

    this.refreshShieldHud();
  }

  private buildMenuButton(): void {
    const btn = document.createElement("button");
    btn.className = "menu-btn";
    btn.type = "button";
    btn.textContent = "MENU";
    btn.addEventListener("click", () => {
      btn.disabled = true;
      btn.textContent = "...";
      leaveRoomAndReload(this.room ?? this.campaignRoom);
    });
    document.body.appendChild(btn);
    this.menuBtnEl = btn;
  }

  private buildBestiary(): void {
    if (this.bestiaryEl) return;

    const entries: Array<{ name: string; color: string; desc: string }> = [
      { name: "Standard", color: "#808080", desc: "" },
      { name: "Kamikaze", color: "#ff0000", desc: "Explodes on contact" },
      { name: "Constructor", color: "#ffff00", desc: "Drops brick walls" },
      { name: "Trapper", color: "#800080", desc: "Lays hidden mines" },
      { name: "Aegis", color: "#00ffff", desc: "Shields nearby enemies" },
      { name: "Jammer", color: "#00008b", desc: "Halves your fire rate" },
      { name: "Mimic", color: "#ffd700", desc: "Disguises as Intel" },
      { name: "Ghost", color: "#cccccc", desc: "Cloaked until firing" },
      { name: "Sapper", color: "#ff8a00", desc: "Shells you over walls" },
      { name: "Lurcher", color: "#ff5c8a", desc: "Grapples and drags you in" },
      { name: "Nullifier", color: "#6f7d8c", desc: "Jams your abilities nearby" },
      { name: "Sentinel", color: "#b0b8c4", desc: "Emplaced; long reach, never moves" },
      { name: "Howler", color: "#ffaa00", desc: "Speeds up everything near it" },
      { name: "Leech", color: "#7fff3f", desc: "Contact drains your cooldowns" },
      { name: "Overseer", color: "#4b2fa8", desc: "Calls in reinforcements" },
      { name: "Reclaimer", color: "#c06020", desc: "Rebuilds what you level" },
      { name: "Burrower", color: "#6b4a2f", desc: "Submerges, surfaces beside you" },
      { name: "Warden aura", color: "#00ffff", desc: "Shields everything inside it" },
    ];

    const panel = document.createElement("div");
    panel.className = "bestiary-panel bestiary-collapsed";

    const title = document.createElement("div");
    title.className = "bestiary-title";
    title.textContent = "BESTIARY";
    panel.appendChild(title);

    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "bestiary-row";

      const swatch = document.createElement("span");
      swatch.className = "bestiary-swatch";
      swatch.style.backgroundColor = entry.color;

      const name = document.createElement("span");
      name.className = "bestiary-name";
      name.style.color = entry.color;
      name.textContent = entry.name;

      row.append(swatch, name);

      if (entry.desc) {
        const desc = document.createElement("span");
        desc.className = "bestiary-desc";
        desc.textContent = entry.desc;
        row.appendChild(desc);
      }

      panel.appendChild(row);
    }

    document.body.appendChild(panel);
    this.bestiaryEl = panel;

    const toggle = document.createElement("div");
    toggle.className = "bestiary-toggle";
    toggle.textContent = "?";
    toggle.addEventListener("click", () => {
      panel.classList.toggle("bestiary-collapsed");
      toggle.textContent = panel.classList.contains("bestiary-collapsed") ? "?" : "X";
    });
    document.body.appendChild(toggle);
    this.bestiaryToggleEl = toggle;
  }

  /**
   * Arms a one-shot Spacebar press that sends `message` to advance the phase.
   *
   * Any previously armed press is cleared first, so exactly one is ever live —
   * pressing SPACE during the intro sends `start_level`, during the outro
   * `next_level`, and the server decides what that does.
   */
  private armCampaignAdvance(message: CampaignMessage): void {
    this.disarmCampaignAdvance();

    const handler = () => {
      this.disarmCampaignAdvance();
      this.campaignRoom?.send(message);
    };

    this.campaignAdvance = handler;
    this.input.keyboard?.once("keydown-SPACE", handler);
  }

  /** Removes the armed Spacebar handler, if one is still waiting. */
  private disarmCampaignAdvance(): void {
    if (!this.campaignAdvance) return;
    this.input?.keyboard?.off("keydown-SPACE", this.campaignAdvance);
    this.campaignAdvance = undefined;
  }

  /** Per-frame campaign work: HUD, name labels, and (while playing) input. */
  private updateCampaign(time: number): void {
    const room = this.campaignRoom;
    // The collections are only built when the first patch decodes, a frame or
    // two after joining — see the note in refreshHud. Nothing downstream may
    // read through the state until they exist.
    if (!room || !room.state?.tanks) return;

    this.followLabels();
    this.refreshCampaignHud();

    // Only the live level accepts input; intro/outro/game-over are frozen.
    if (room.state.phase !== CampaignPhase.Playing) return;

    const direction = this.readDirection();
    if (direction !== null && time - this.lastMoveSentAt >= MOVE_SEND_INTERVAL_MS) {
      room.send(ClientMessage.Move, { dir: direction } satisfies MoveMessage);
      this.lastMoveSentAt = time;
    }

    if (this.isShootDown() && time - this.lastShotAt >= this.campaignShootInterval()) {
      room.send(ClientMessage.Shoot);
      this.soundFire();
      this.lastShotAt = time;
    }
  }

  /**
   * This tank's current reload, in ms — the same figure the server enforces.
   *
   * Throttling on the flat base instead would quietly eat the shots an
   * Autoloader stack (or the late-campaign refit) has earned, and throttling
   * looser than the server would play a firing sound for shots it then refuses.
   */
  private campaignShootInterval(): number {
    const state = this.campaignRoom?.state;
    const level = state?.currentLevel ?? 1;
    const jammed =
      state?.tanks?.some((tank: TankView) => tank.isEnemy && tank.variant === "jammer") ?? false;

    return campaignShootCooldownMs(level, this.ownedUpgrades.rate ?? 0, jammed);
  }

  /** Pulls the campaign HUD — level, enemies, the dynamic objective, and lives. */
  private refreshCampaignHud(): void {
    const state = this.campaignRoom?.state;
    if (!state?.tanks) return;

    this.setField(this.hudTime, `LEVEL ${state.currentLevel}`);

    const enemies = state.tanks.filter((tank) => tank.isEnemy).length;
    this.setField(this.hudEnemies, `ENEMIES ${enemies}`);

    // The server keeps `objectiveText` current for whatever this level's win
    // condition is — radars remaining, extraction, or the survival countdown.
    this.setField(this.hudEagle, state.objectiveText, "#00ff88");

    // Lives *and* hull integrity. Several threats now chip a single point at a
    // time (Sapper lobs, the Effigy's blast), so without the pips the player
    // cannot tell a scratch from being one hit off dead.
    const me = this.findLocalTank();
    const hp = me?.currentHealth ?? 0;
    const maxHp = me?.maxHealth ?? 0;
    const pips = maxHp > 0 ? `  ${"█".repeat(hp)}${"░".repeat(Math.max(0, maxHp - hp))}` : "";

    // Colour tracks whichever is more urgent — the last life or the last pip.
    const critical = state.lives <= 0 || (maxHp > 0 && hp === 1);
    const hurt = maxHp > 0 && hp <= maxHp / 2;

    this.setField(
      this.hudPlayer,
      `LIVES ${state.lives}${pips}`,
      critical ? "#e0483a" : hurt ? "#f2c14e" : "#4caf50",
    );
    this.reflowHud();

    // A Jammer on the field throttles the player's weapons — flash a warning so
    // the sluggish fire rate reads as an effect, not a bug.
    const jammed = state.tanks.some((tank) => tank.isEnemy && tank.variant === "jammer");
    if (jammed) {
      const on = Math.floor(this.time.now / 400) % 2 === 0;
      this.status.setText(on ? "WARNING: WEAPONS JAMMED" : "").setColor("#ff3030");
    } else {
      this.status.setText(`CAMPAIGN  ·  ${this.campaignRoom?.roomId ?? ""}`).setColor("#5c6b7a");
    }
  }

  // -------------------------------------------------------------- state binding

  private bindState(room: BattleRoom): void {
    const $ = getStateCallbacks(room);

    // The battlefield itself — map and entities — plus the combat effect
    // messages, are shared with the campaign renderer. Both concrete states
    // extend WorldStateView; the cast bridges Colyseus' contravariant Room type.
    this.bindWorld(room as unknown as Room<WorldStateView>);
    this.bindEffects(room as unknown as Room<WorldStateView>);

    // The match result drives the overlay. The token is deliberately kept: the
    // room lives on to be reset back to the lobby, so a refresh should resume
    // into it rather than opening a fresh lobby.
    this.roomCleanups.push(
      $(room.state).listen("matchState", (status: MatchStatus) => {
        if (!isMatchOver(status)) return;
        this.showResult(status);
      }),
    );

    this.roomCleanups.push(
      room.onMessage(ServerMessage.BoonCollected, (message: BoonCollectedMessage) => {
        this.announceBoon(message);
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
   * Renders the battlefield from replicated state: the tile grid and every tank,
   * bullet and boon on it. Shared by both room modes — battle and campaign carry
   * the same collections, so the same bindings draw both.
   */
  private bindWorld(room: Room<WorldStateView>): void {
    const $ = getStateCallbacks(room);

    // Repaint the whole map once the first snapshot lands, then keep it in
    // sync cell by cell — a destroyed brick only ever touches one index.
    room.onStateChange.once(() => {
      room.state.grid.forEach((tile, index) => this.paintTile(index, tile));
    });
    this.roomCleanups.push($(room.state).grid.onChange((tile, index) => this.paintTile(index, tile)));

    this.roomCleanups.push($(room.state).tanks.onAdd((tank) => {
      const sprite = this.spawnSprite(tank.isEnemy ? TextureKey.TankEnemy : TextureKey.TankPlayer);

      // Enemy tint: the boss is scaled up to its massive hitbox and painted dark
      // and menacing; kamikaze rushers burn bright red; otherwise tier colour —
      // red normal, purple armoured, near-black heavy.
      if (tank.variant === "convoy") {
        // The friendly escort carrier: bright green and stretched into a truck.
        sprite.setTint(0x00ff00);
        sprite.setScale(1, 1.2);
      } else if (tank.isEnemy) {
        if (tank.variant === "sweeper") {
          // Match the server hitbox (width is 3x a tile) and darken it.
          sprite.setScale(tank.width / TILE_SIZE);
          sprite.setTint(0x333333);
        } else if (tank.variant === "artillery") {
          // Scaled up to its hitbox (1.5x a tile) and painted siege-orange.
          sprite.setScale(tank.width / TILE_SIZE);
          sprite.setTint(0xffa500);
        } else if (tank.variant === "bastion") {
          // Gunmetal, with a plating marker drawn across its armoured face so
          // the player can read which side is safe to shoot at a glance.
          sprite.setScale(tank.width / TILE_SIZE);
          sprite.setTint(0x8a94a6);
          this.createBastionPlate(tank);
        } else if (tank.variant === "hydra") {
          // Sickly green, and scaled to whichever tier this fragment is.
          sprite.setScale(tank.width / TILE_SIZE);
          sprite.setTint(0x66cc44);
        } else if (tank.variant === "architect") {
          // Cold violet. Pulses while sealed so its invulnerability is legible.
          sprite.setScale(tank.width / TILE_SIZE);
          sprite.setTint(0x9a7bff);
        } else if (tank.variant === "juggernaut") {
          // Massive crimson siege boss — scaled up to fill its 2-tile hull.
          sprite.setScale(2.0);
          sprite.setTint(0x8b0000);
        } else if (tank.variant === "mimic") {
          // Gold while disguised as an item drop, magenta once it springs.
          this.syncMimicAppearance(tank, sprite);
        } else if (tank.variant === "kamikaze") {
          sprite.setTint(0xff0000);
        } else if (tank.variant === "constructor") {
          // Yellow trench-layer — distinct from red kamikazes and tier enemies.
          sprite.setTint(0xffff00);
        } else if (tank.variant === "trapper") {
          // Purple mine-layer.
          sprite.setTint(0x800080);
        } else if (tank.variant === "aegis") {
          // Cyan shield unit; its protective aura is drawn separately.
          sprite.setTint(0x00ffff);
          this.createAegisAura(tank);
        } else if (tank.variant === "sapper") {
          // Orange standoff siege unit — matches its lob telegraph.
          sprite.setTint(0xff8a00);
        } else if (tank.variant === "lurcher") {
          // Hot pink grappler — matches the colour of its tether.
          sprite.setTint(0xff5c8a);
        } else if (tank.variant === "nullifier") {
          // Muted slate, with a bubble drawn separately showing its reach.
          sprite.setTint(0x6f7d8c);
          this.createNullifierField(tank);
        } else if (tank.variant === "effigy") {
          // The mirror boss. Player-sized, so colour is the only thing marking
          // it out — bright magenta, plus a pulse, so it never reads as an add.
          sprite.setTint(0xff33cc);
          this.time.addEvent({
            delay: 90,
            loop: true,
            callback: () => {
              if (!this.isLive(sprite)) return;
              const hot = Math.floor(Date.now() / 180) % 2 === 0;
              sprite.setTint(hot ? 0xff33cc : 0xffffff);
            },
          });
        } else if (tank.variant === "sentinel") {
          // Steel grey, and visibly bolted down: an emplacement, not a patrol.
          sprite.setTint(0xb0b8c4);
        } else if (tank.variant === "howler") {
          // Hot amber, pulsing in time with the rally it is broadcasting.
          sprite.setTint(0xffaa00);
          this.createHowlerAura(tank);
        } else if (tank.variant === "leech") {
          // Sickly green — the colour of the cooldowns it takes.
          sprite.setTint(0x7fff3f);
        } else if (tank.variant === "overseer") {
          // Deep indigo command unit.
          sprite.setTint(0x4b2fa8);
        } else if (tank.variant === "reclaimer") {
          // Rust orange repair crew.
          sprite.setTint(0xc06020);
        } else if (tank.variant === "burrower") {
          // Earth brown, and near-invisible while it is under the floor; the
          // cloak flag it shares with the Ghost drives the fade.
          sprite.setTint(0x6b4a2f);
          this.syncGhostAppearance(tank, sprite);
        } else if (tank.variant === "foundry") {
          // Furnace red, three tiles across.
          sprite.setScale(3.0);
          sprite.setTint(0xd2401e);
        } else if (tank.variant === "choir") {
          // The twins. Identical on purpose: telling them apart is not the
          // fight, finishing them together is.
          sprite.setScale(2.0);
          sprite.setTint(0xc8a2ff);
        } else if (tank.variant === "leviathan") {
          // Deep teal, and gone entirely while it is submerged.
          sprite.setScale(3.0);
          sprite.setTint(0x1e7a86);
          this.syncGhostAppearance(tank, sprite);
        } else if (tank.variant === "jammer") {
          // Dark-blue electronic-warfare unit.
          sprite.setTint(0x00008b);
        } else if (tank.variant === "ghost") {
          this.syncGhostAppearance(tank, sprite);
        } else if (tank.variant === "warden") {
          sprite.setScale(2.0);
          sprite.setTint(0x006400);
          // It carries a six-tile version of the Aegis aura, which was doing
          // its work invisibly: rushers inside it were soaking three shells
          // each and the reason was nowhere on screen.
          this.createWardenAura(tank);
        } else if (tank.variant === "core") {
          sprite.setScale(3.0);
          sprite.setTint(0xff0066);
          let corePhase = 0;
          this.time.addEvent({
            delay: 50,
            loop: true,
            callback: () => {
              if (!this.isLive(sprite)) return;
              const hp = tank.currentHealth;
              if (hp <= 15) {
                const flash = Math.floor(Date.now() / 100) % 2 === 0;
                sprite.setTint(flash ? 0xff0000 : 0xffffff);
              } else if (hp <= 35) {
                sprite.setTint(0xff8800);
              } else {
                corePhase = (corePhase + 1) % 32;
                const progress = corePhase / 32;
                const r = Math.round(0xff - progress * 0x64);
                const g = Math.round(progress * 0x59);
                const b = Math.round(0x66 + progress * 0x6a);
                sprite.setTint((r << 16) | (g << 8) | b);
              }
            },
          });
        } else {
          sprite.setTint(ENEMY_TINT[tank.maxHealth] ?? ENEMY_TINT[1]!);
        }
      }

      this.tankSprites.set(tank, sprite);
      this.placeEntity(sprite, tank);
      this.syncShield(tank, sprite);
      this.syncMarker(tank, sprite);

      if (!tank.isEnemy) {
        const owner = room.state.players.get(tank.ownerId);
        if (owner) this.syncPlayerVisuals(owner);
      }

      // Seed the health watcher so the first change is measured against the
      // value the tank arrived with, not against zero.
      this.lastHealth.set(tank, tank.currentHealth);

      $(tank).onChange(() => {
        this.placeEntity(sprite, tank);
        this.syncShield(tank, sprite);
        this.syncMarker(tank, sprite);
        // A Mimic flips gold→magenta and unfreezes its facing when it springs.
        this.syncMimicAppearance(tank, sprite);
        // A Ghost fades in and out as it cloaks/uncloaks after firing.
        this.syncGhostAppearance(tank, sprite);
        this.syncDamageFlash(tank, sprite);
      });
    }));

    this.roomCleanups.push($(room.state).tanks.onRemove((tank) => {
      this.tankSprites.get(tank)?.destroy();
      this.tankSprites.delete(tank);
      this.shields.get(tank)?.destroy();
      this.shields.delete(tank);
      this.labels.get(tank)?.destroy();
      this.labels.delete(tank);
      this.aegisAuras.get(tank)?.destroy();
      this.aegisAuras.delete(tank);
      this.markers.get(tank)?.destroy();
      this.markers.delete(tank);
      this.bastionPlates.get(tank)?.destroy();
      this.bastionPlates.delete(tank);
      this.lastHealth.delete(tank);
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
  }

  /** Binds the combat effect messages (explosions, sparks) shared by both modes. */
  private bindEffects(room: Room<WorldStateView>): void {
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
      room.onMessage(ServerMessage.MineDetonated, (message: MineDetonatedMessage) => {
        this.spawnMineBlast(message);
      }),
    );

    // The campaign boss rebounding off a wall throws a heavy jolt through the
    // camera, to sell its weight. The Juggernaut's frequent block-crushes send
    // `subtle` — a barely-there rumble instead, so grinding the maze open does
    // not shake the screen apart.
    this.roomCleanups.push(
      room.onMessage(ServerMessage.BossBounce, (message: BossBounceMessage) => {
        if (this.isDead) return;
        if (message.subtle) this.cameras.main.shake(100, 0.002);
        else this.cameras.main.shake(180, 0.008);
      }),
    );

    // An inbound artillery mortar: draw a red telegraph circle that pulses until
    // it detonates.
    this.roomCleanups.push(
      room.onMessage(ServerMessage.MortarWarning, (message: MortarWarningMessage) => {
        this.showMortarWarning(message);
      }),
    );
  }

  /** Draws a pulsing red mortar telegraph that clears itself when it detonates. */
  private showMortarWarning(message: MortarWarningMessage): void {
    if (this.isDead) return;

    // Sapper lobs carry their own, tighter radius; the artillery boss's mortars
    // omit it and keep the original 1.5-tile circle.
    const radius = message.radius ?? 1.5 * TILE_SIZE;
    const small = message.radius !== undefined;

    // A strike the player called down themselves is drawn in their own colour.
    // Red would read as incoming fire, which is actively misleading when the
    // circle is the thing they just asked for.
    const fill = message.friendly ? 0x2a8fd8 : small ? 0xff8a00 : 0xff0000;
    const line = message.friendly ? 0x76c8ff : small ? 0xffaa33 : 0xff2020;

    const circle = this.add.graphics().setDepth(3);
    circle.fillStyle(fill, 0.25).fillCircle(message.x, message.y, radius);
    circle.lineStyle(2, line, 0.9).strokeCircle(message.x, message.y, radius);
    this.world.add(circle);

    // Pulse the alpha so it reads as an active, incoming threat.
    this.tweens.add({ targets: circle, alpha: 0.35, duration: 250, yoyo: true, repeat: -1 });

    // Clear it at the moment of detonation and set off the blast. delayedCall is
    // scoped to the scene, so it never fires after teardown.
    this.time.delayedCall(message.delay, () => {
      if (this.isLive(circle)) {
        this.tweens.killTweensOf(circle);
        circle.destroy();
      }
      this.spawnMortarBlast(message.x, message.y, small ? 0.6 : 1);
    });
  }

  /**
   * A violent mortar blast at the impact point: a bright orange/yellow disc that
   * snaps outward and fades over ~300ms, so the hit lands hard visually.
   */
  /**
   * A mine going off underfoot.
   *
   * An absorbed blast is drawn in the shield's own cyan and kept small, so it
   * reads as the shield eating the hit rather than as a near miss.
   */
  private spawnMineBlast(message: MineDetonatedMessage): void {
    if (this.isDead) return;

    const { x, y, absorbed } = message;

    const blast = this.add.graphics().setDepth(6);
    if (absorbed) {
      blast.fillStyle(0x66ddff, 0.7).fillCircle(0, 0, TILE_SIZE * 1.1);
      blast.fillStyle(0xccf6ff, 0.9).fillCircle(0, 0, TILE_SIZE * 0.55);
    } else {
      blast.fillStyle(0xff8a00, 0.85).fillCircle(0, 0, TILE_SIZE * 1.3);
      blast.fillStyle(0xffe14a, 0.95).fillCircle(0, 0, TILE_SIZE * 0.75);
    }
    blast.setPosition(x, y).setScale(0.3);
    this.world.add(blast);

    this.tweens.add({
      targets: blast,
      scale: absorbed ? 1.0 : 1.5,
      alpha: 0,
      duration: absorbed ? 260 : 320,
      ease: "Cubic.Out",
      onComplete: () => blast.destroy(),
    });

    this.tone(
      absorbed
        ? { type: "sine", startHz: 520, endHz: 720, duration: 0.12, volume: 0.09 }
        : { type: "square", startHz: 180, endHz: 60, duration: 0.3, volume: 0.16 },
    );
  }

  private spawnMortarBlast(x: number, y: number, scale = 1): void {
    if (this.isDead) return;

    const blast = this.add.graphics().setDepth(6);
    // Layered fireball — a yellow-hot core inside an orange shell.
    blast.fillStyle(0xff8a00, 0.85).fillCircle(0, 0, TILE_SIZE * 1.5);
    blast.fillStyle(0xffe14a, 0.95).fillCircle(0, 0, TILE_SIZE * 0.9);
    blast.setPosition(x, y).setScale(0.3 * scale);
    this.world.add(blast);

    this.tweens.add({
      targets: blast,
      scale: 1.6 * scale,
      alpha: 0,
      duration: 300,
      ease: "Cubic.Out",
      onComplete: () => blast.destroy(),
    });
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
    if (this.isDead) return;
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
    // A late `players.onChange` can land after the scene is gone; bail before
    // touching `this.add` or any sprite.
    if (this.isDead) return;

    for (const [tank, sprite] of this.tankSprites) {
      if (tank.isEnemy || tank.ownerId !== player.sessionId) continue;
      if (!this.isLive(sprite)) continue;

      // Hull colour now signals the star tier rather than player identity —
      // names above the tanks still tell players apart.
      const tint = playerTierTint(player.tier);
      if (tint === null) sprite.clearTint();
      else sprite.setTint(tint);

      const label = this.labels.get(tank) ?? this.createLabel(tank);
      if (!this.isLive(label)) continue;

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
      if (!sprite || !this.isLive(sprite) || !this.isLive(label)) continue;

      label.setPosition(sprite.x, sprite.y - TILE_SIZE);
    }

    // Aegis auras follow their unit.
    for (const [tank, aura] of this.aegisAuras) {
      const sprite = this.tankSprites.get(tank);
      if (!sprite || !this.isLive(sprite) || !this.isLive(aura)) continue;

      aura.setPosition(sprite.x, sprite.y);
    }

    this.syncShieldAura();
    this.syncBastionPlates();
    this.syncObjectiveTarget();
  }

  /**
   * This client's own tank in the replicated state, if it is currently alive.
   *
   * The render loop starts before the first state patch lands, so the schema
   * collections are briefly undefined — a gap that is easy to miss locally and
   * reliably hit over a real network. Everything here is optional-chained.
   */
  private findLocalTank(): TankView | undefined {
    const room = this.room ?? this.campaignRoom;
    const tanks = room?.state?.tanks;
    if (!room || !tanks) return undefined;
    return tanks.find(
      (tank: TankView) => !tank.isEnemy && tank.ownerId === room.sessionId,
    );
  }

  /**
   * Draws a ring around the local player while their deflector is up.
   *
   * Created on demand and destroyed the moment the shield drops, so there is
   * nothing to keep in step when the ability is idle.
   */
  private syncShieldAura(): void {
    const player = this.findLocalTank();
    const up = player?.isShielded === true;

    if (!up) {
      if (this.shieldAura) {
        this.shieldAura.destroy();
        this.shieldAura = undefined;
      }
      return;
    }

    const sprite = player ? this.tankSprites.get(player) : undefined;
    if (!sprite || !this.isLive(sprite)) return;

    if (!this.shieldAura || !this.isLive(this.shieldAura)) {
      this.shieldAura = this.add.circle(0, 0, TILE_SIZE * 0.95, 0x66ddff, 0.16).setDepth(3);
      this.shieldAura.setStrokeStyle(2, 0x99eeff, 0.9);
      this.world.add(this.shieldAura);
    }

    // Gentle pulse so it reads as an active field rather than a static decal.
    const pulse = 0.9 + Math.sin(Date.now() / 120) * 0.08;
    this.shieldAura.setPosition(sprite.x, sprite.y).setScale(pulse);
  }

  /**
   * Keeps a Mimic's look in step with its disguise.
   *
   * Disguised, it is tinted gold and its facing is frozen upright so it reads as
   * an intel drive rather than a tank (the server holds it still, but its spawn
   * facing would otherwise rotate the hull). Once it springs it turns bright
   * magenta and rotates with its heading like any other enemy. A no-op for every
   * non-Mimic sprite, so it is cheap to call from the shared onChange handler.
   */
  private syncMimicAppearance(tank: TankView, sprite: Phaser.GameObjects.Image): void {
    if (tank.variant !== "mimic") return;
    if (!this.isLive(sprite)) return;

    if (tank.isDisguised) {
      sprite.setTint(0xffd700);
      sprite.setRotation(0);
    } else {
      sprite.setTint(0xff00ff);
    }
  }

  /**
   * Keeps a Ghost's visibility in step with its cloak state.
   *
   * Cloaked: nearly invisible (alpha 0.08) with a white tint, so it reads as a
   * faint shimmer. Uncloaked (after firing): fully opaque with a light-grey tint,
   * clearly marking it as exposed and vulnerable. A no-op for every non-Ghost
   * sprite, so it is cheap to call from the shared onChange handler.
   */
  private syncGhostAppearance(tank: TankView, sprite: Phaser.GameObjects.Image): void {
    if (tank.variant !== "ghost") return;
    if (!this.isLive(sprite)) return;

    if (tank.isCloaked) {
      sprite.setAlpha(0.08);
      sprite.setTint(0xffffff);
    } else {
      sprite.setAlpha(1.0);
      sprite.setTint(0xdddddd);
    }
  }

  /** Draws a faint cyan aura circle (3-tile radius) around an Aegis unit. */
  /**
   * Registers a Bastion's armour marker. The drawing itself happens in
   * {@link syncBastionPlates}, which re-runs as the hull swings around.
   */
  private createBastionPlate(tank: TankView): void {
    const plate = this.add.graphics().setDepth(4);
    this.world.add(plate);
    this.bastionPlates.set(tank, plate);
  }

  /**
   * Redraws every Bastion's plating: a heavy slab across its armoured bow, and
   * bright bars over the three faces that are not.
   *
   * The bright markers are the important half — they tell the player exactly
   * where a shot will land, which is the whole puzzle of the encounter. They
   * cover both flanks as well as the stern because the plating is bow armour
   * only: standing anywhere but in front of it is enough.
   */
  /**
   * Marks the one objective that will answer, on a level that imposes an order.
   *
   * Without this the level is unplayable rather than hard: every mast and every
   * package looks identical, so an order nobody can see reads as the game
   * refusing shots at random. The marker is the whole mechanic made visible.
   */
  private syncObjectiveTarget(): void {
    const index = this.campaignRoom?.state?.objectiveTargetTile ?? -1;

    if (index < 0) {
      if (this.objectiveMarker) {
        this.tweens.killTweensOf(this.objectiveMarker);
        this.objectiveMarker.destroy();
        this.objectiveMarker = undefined;
      }
      return;
    }

    const x = (index % GRID_WIDTH) * TILE_SIZE + TILE_SIZE / 2;
    const y = Math.floor(index / GRID_WIDTH) * TILE_SIZE + TILE_SIZE / 2;

    if (this.objectiveMarker && this.isLive(this.objectiveMarker)) {
      this.objectiveMarker.setPosition(x, y);
      return;
    }

    const marker = this.add.graphics().setDepth(7);

    // Deliberately loud. This is not decoration — on an ordered level it is the
    // only thing separating the one objective that answers from eleven
    // identical ones that will not, and a subtle mark here reads as the game
    // dropping shots at random. Sized well outside the tile so it is legible
    // with the whole battlefield on screen, which is how the map is actually
    // played.
    const gap = TILE_SIZE * 1.4;
    const arm = TILE_SIZE * 0.8;

    marker.fillStyle(0x7dffcf, 0.14).fillRect(-gap, -gap, gap * 2, gap * 2);
    // A bracket rather than a ring: the objective tiles are already square
    // structures, and a circle around one reads as a shield.
    marker.lineStyle(5, 0x7dffcf, 1);
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as Array<[number, number]>) {
      marker.lineBetween(sx * gap, sy * gap, sx * (gap - arm), sy * gap);
      marker.lineBetween(sx * gap, sy * gap, sx * gap, sy * (gap - arm));
    }
    marker.setPosition(x, y);
    this.world.add(marker);
    this.objectiveMarker = marker;

    this.tweens.add({
      targets: marker,
      alpha: { from: 1, to: 0.4 },
      duration: 700,
      yoyo: true,
      repeat: -1,
    });
  }

  private syncBastionPlates(): void {
    for (const [tank, plate] of this.bastionPlates) {
      const sprite = this.tankSprites.get(tank);
      if (!sprite || !this.isLive(sprite) || !this.isLive(plate)) continue;

      const half = tank.width / 2;
      const span = half * 0.85;
      const cx = sprite.x;
      const cy = sprite.y;

      plate.clear();

      // Outward normal of each face, indexed by the cardinal that names it.
      const normals: ReadonlyArray<readonly [number, number]> = [
        [0, -1], // Up
        [1, 0], // Right
        [0, 1], // Down
        [-1, 0], // Left
      ];

      // The whole encounter is "which side is open right now", so the three
      // sealed faces are drawn flat and dark and the open one is drawn bright
      // and thick. It is deliberately the loudest thing on the boss.
      for (let side = 0; side < normals.length; side++) {
        const [nx, ny] = normals[side]!;
        const open = side === tank.weakSide;

        plate.lineStyle(open ? 7 : 5, open ? 0xffd23f : 0x3d4655, 0.95);

        // The span runs across the face: the axis perpendicular to its normal.
        const sx = ny;
        const sy = nx;
        plate.lineBetween(
          cx + nx * half - sx * span,
          cy + ny * half - sy * span,
          cx + nx * half + sx * span,
          cy + ny * half + sy * span,
        );
      }
    }
  }

  /**
   * The Nullifier's suppression bubble.
   *
   * Drawn at the shared radius so the player can see exactly where their kit
   * stops working, rather than discovering it by pressing a dead key.
   */
  /**
   * Flashes a tank white when its health drops, and kicks the camera when the
   * hit landed on the local player.
   *
   * Landing a shot previously produced no feedback at all until the target
   * actually died, which made everything with more than one hit point feel
   * unresponsive to shoot at. The flash restores the tint afterwards rather
   * than assuming white — variants paint themselves in {@link bindWorld} and a
   * blanket clearTint would wipe a Ghost's fade or a Mimic's disguise.
   */
  private syncDamageFlash(tank: TankView, sprite: Phaser.GameObjects.Image): void {
    const previous = this.lastHealth.get(tank);
    this.lastHealth.set(tank, tank.currentHealth);

    if (previous === undefined || tank.currentHealth >= previous) return;
    if (!this.isLive(sprite)) return;

    const restore = sprite.tintTopLeft;
    sprite.setTint(0xffffff);
    this.time.delayedCall(70, () => {
      if (this.isLive(sprite)) sprite.setTint(restore);
    });

    // Taking a hit yourself should be felt, not just seen.
    const room = this.room ?? this.campaignRoom;
    if (!tank.isEnemy && room && tank.ownerId === room.sessionId) {
      this.cameras.main.shake(120, 0.006);
      this.tone({ type: "square", startHz: 220, endHz: 90, duration: 0.14, volume: 0.13 });
    }
  }

  private createNullifierField(tank: TankView): void {
    const radius = NULLIFIER_RADIUS_TILES * TILE_SIZE;
    const aura = this.add.graphics().setDepth(2);
    aura.fillStyle(0x6f7d8c, 0.10).fillCircle(0, 0, radius);
    aura.lineStyle(2, 0x9fb0c2, 0.45).strokeCircle(0, 0, radius);
    aura.setPosition(tank.x + tank.width / 2, tank.y + tank.height / 2);
    this.world.add(aura);
    this.aegisAuras.set(tank, aura);
  }

  private createAegisAura(tank: TankView): void {
    const radius = 3 * TILE_SIZE;
    const aura = this.add.graphics().setDepth(2);
    aura.fillStyle(0x00ffff, 0.08).fillCircle(0, 0, radius);
    aura.lineStyle(2, 0x00ffff, 0.4).strokeCircle(0, 0, radius);
    aura.setPosition(tank.x + tank.width / 2, tank.y + tank.height / 2);
    this.world.add(aura);
    this.aegisAuras.set(tank, aura);
  }

  /**
   * Draws the Warden's protective aura.
   *
   * The same language as the Aegis bubble it is a bigger version of, so a
   * player who has met one reads the other immediately — and twice the radius,
   * because that is what it is.
   */
  private createWardenAura(tank: TankView): void {
    const radius = 6 * TILE_SIZE;
    const aura = this.add.graphics().setDepth(2);
    aura.fillStyle(0x00ffff, 0.05).fillCircle(0, 0, radius);
    aura.lineStyle(2, 0x00ffff, 0.3).strokeCircle(0, 0, radius);
    aura.setPosition(tank.x + tank.width / 2, tank.y + tank.height / 2);
    this.world.add(aura);
    this.aegisAuras.set(tank, aura);
  }

  /**
   * Draws a Howler's rally aura.
   *
   * Deliberately the same shape as the Aegis bubble but in the opposite colour:
   * both are "everything inside this circle is different", and the player
   * should read the shape first and the consequence second. Tracked in the same
   * map, so it is positioned and cleaned up by the code that already does that.
   */
  private createHowlerAura(tank: TankView): void {
    const radius = 6 * TILE_SIZE;
    const aura = this.add.graphics().setDepth(2);
    aura.fillStyle(0xffaa00, 0.06).fillCircle(0, 0, radius);
    aura.lineStyle(2, 0xffaa00, 0.35).strokeCircle(0, 0, radius);
    aura.setPosition(tank.x + tank.width / 2, tank.y + tank.height / 2);
    this.world.add(aura);
    this.aegisAuras.set(tank, aura);
  }

  /**
   * Rings a marked target on a purge level.
   *
   * The whole level is the player being able to tell one identical hull from
   * another, so the mark is drawn large, bright and on top of everything —
   * subtlety here would just be a level that reads as broken.
   */
  private syncMarker(tank: TankView, sprite: Phaser.GameObjects.Image): void {
    if (this.isDead || !this.isLive(sprite)) return;

    const existing = this.markers.get(tank);

    if (!tank.isMarked) {
      if (existing) {
        this.tweens.killTweensOf(existing);
        existing.destroy();
        this.markers.delete(tank);
      }
      return;
    }

    if (existing) {
      if (this.isLive(existing)) existing.setPosition(sprite.x, sprite.y);
      return;
    }

    const marker = this.add.graphics().setDepth(7);
    marker.lineStyle(3, 0xff2d55, 0.95).strokeCircle(0, 0, TILE_SIZE * 0.85);
    // A short cross through the middle, so it reads as a sight rather than a
    // shield — the two are drawn at similar sizes and must not be confused.
    marker.lineStyle(2, 0xff2d55, 0.7);
    marker.lineBetween(-TILE_SIZE * 0.5, 0, TILE_SIZE * 0.5, 0);
    marker.lineBetween(0, -TILE_SIZE * 0.5, 0, TILE_SIZE * 0.5);
    marker.setPosition(sprite.x, sprite.y);
    this.world.add(marker);
    this.markers.set(tank, marker);

    this.tweens.add({
      targets: marker,
      alpha: { from: 1, to: 0.45 },
      duration: 600,
      yoyo: true,
      repeat: -1,
    });
  }

  /** Adds or removes the flashing shield that marks respawn invulnerability. */
  private syncShield(tank: TankView, sprite: Phaser.GameObjects.Image): void {
    if (this.isDead || !this.isLive(sprite)) return;

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
    // Reached from per-entity `onChange`, which can fire after the sprite (or the
    // whole scene) is gone — guard before touching it.
    if (this.isDead || !this.isLive(sprite)) return;

    sprite.setPosition(entity.x + entity.width / 2, entity.y + entity.height / 2);
    sprite.setRotation(ROTATION[entity.direction]);
  }

  private paintTile(index: number, tile: number): void {
    if (this.isDead) return;
    const tile$ = this.tiles[index];
    if (!this.isLive(tile$)) return;

    tile$!.setTexture(this.textureForTile(tile));
    // Objective tiles blink so they read as "interact with me"; a mine pulses
    // too, as a lethal-trap warning.
    const shouldPulse =
      tile === TileType.ExtractionZone ||
      tile === TileType.Bomb ||
      tile === TileType.Intel ||
      tile === TileType.Mine;
    this.syncTilePulse(index, tile$!, shouldPulse);
  }

  /** Starts or stops a looping alpha pulse on an objective tile. */
  private syncTilePulse(
    index: number,
    image: Phaser.GameObjects.Image,
    shouldPulse: boolean,
  ): void {
    const existing = this.pulseTiles.get(index);

    if (shouldPulse) {
      if (existing) return;
      const tween = this.tweens.add({
        targets: image,
        alpha: 0.4,
        duration: 700,
        yoyo: true,
        repeat: -1,
      });
      this.pulseTiles.set(index, tween);
      return;
    }

    if (existing) {
      existing.stop();
      image.setAlpha(1);
      this.pulseTiles.delete(index);
    }
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
      case TileType.Radar:
        return TextureKey.Radar;
      case TileType.ExtractionZone:
        return TextureKey.Extraction;
      case TileType.UplinkZone:
        return TextureKey.Uplink;
      case TileType.Factory:
        return TextureKey.Factory;
      case TileType.Bomb:
        return TextureKey.Bomb;
      case TileType.Intel:
        return TextureKey.Intel;
      case TileType.Mine:
        return TextureKey.Mine;
      default:
        return TextureKey.Empty;
    }
  }
}
