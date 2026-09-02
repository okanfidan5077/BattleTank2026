import Phaser from "phaser";
import { getStateCallbacks } from "colyseus.js";

import { CAMPAIGN_ROOM, MatchStatus, PROTOCOL_VERSION } from "@battletank/shared";

import { BASE_HEIGHT, BASE_WIDTH, GameScene } from "./GameScene.js";
import { hideLobby, reflectRoomInUrl, runLobby, showShareLink } from "./lobby.js";
import { tryResume, type BattleRoom, type CampaignRoom, type GameRoom } from "./network.js";
import { runStaging } from "./staging.js";
import "./style.css";

/** The div Phaser renders its canvas into; hidden while in the staging lobby. */
function gameContainer(): HTMLElement {
  const found = document.getElementById("game");
  if (!found) throw new Error("main: #game is missing from index.html");
  return found;
}

/**
 * Wires the top-right fullscreen button.
 *
 * Fullscreens the whole document (not just the canvas) so the DOM overlays go
 * fullscreen with it, and toggles back out when already fullscreen. Both calls
 * must be driven by the click gesture, and either can reject (a browser policy,
 * an iframe without permission), so failures are swallowed rather than thrown.
 */
function setupFullscreenToggle(): void {
  const button = document.getElementById("fullscreen-toggle");
  if (!button) return;

  const sync = () => {
    button.title = document.fullscreenElement ? "Exit fullscreen" : "Toggle fullscreen";
  };

  button.addEventListener("click", () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void document.documentElement.requestFullscreen().catch(() => {});
    }
  });

  document.addEventListener("fullscreenchange", sync);
  sync();
}

/**
 * Boots a fresh Phaser instance around an already-connected room.
 *
 * Phaser is deliberately not started up front: the scene is handed an already
 * joined room, so it never has to render an empty world while it waits, and the
 * lobby is plain DOM sitting above the empty canvas container.
 */
function createGame(room: GameRoom): Phaser.Game {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game",
    backgroundColor: "#0b0d10",
    scale: {
      // Authored at 1920x1080; scaled down to whatever the window allows.
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: BASE_WIDTH,
      height: BASE_HEIGHT,
    },
    // Crisp edges for the generated pixel textures.
    pixelArt: true,
    // The game has no sound. Without this Phaser opens a Web Audio context that
    // Chrome blocks until a user gesture, logging two autoplay warnings.
    audio: { noAudio: true },
    // The scene is constructed with the room rather than joining one itself.
    scene: [new GameScene(room)],
  });

  if (import.meta.env.DEV) {
    // Debug handle for the browser console: __game.scene.keys.GameScene
    (window as unknown as { __game: Phaser.Game }).__game = game;
  }

  return game;
}

/**
 * Runs one match: boots Phaser and resolves once the room returns to the lobby.
 *
 * The host resets a resolved match from the game-over overlay, which flips
 * `matchState` back to `LOBBY` server-side. That is the cue to tear the Phaser
 * instance down — `destroy(true, false)` drops the WebGL canvas but leaves the
 * `#game` div in place for the next round — and hand control back to staging.
 * Each match gets its own fresh instance, so no scene or listener is reused.
 */
function runMatch(room: BattleRoom): Promise<void> {
  const container = gameContainer();
  container.hidden = false;

  const game = createGame(room);

  return new Promise<void>((resolve) => {
    const $ = getStateCallbacks(room);

    // Fires immediately with the current (PLAYING) value, so guard for LOBBY.
    const detach = $(room.state).listen("matchState", (status: MatchStatus) => {
      if (status !== MatchStatus.Lobby) return;

      detach();
      game.destroy(true, false);
      container.hidden = true;
      resolve();
    });
  });
}

/**
 * Runs a campaign playthrough: boots Phaser once and holds until the room ends.
 *
 * The single-player campaign has no staging lobby and no reset-to-lobby cycle —
 * the scene drives the whole thing off the replicated `phase`, so this just
 * keeps Phaser alive until the room is left.
 */
function runCampaign(room: CampaignRoom): Promise<void> {
  const container = gameContainer();
  container.hidden = false;

  const game = createGame(room);

  return new Promise<void>((resolve) => {
    room.onLeave(() => {
      game.destroy(true, false);
      container.hidden = true;
      resolve();
    });
  });
}

async function boot(): Promise<void> {
  console.log(`[client] BattleTank2026 booted (protocol v${PROTOCOL_VERSION})`);

  setupFullscreenToggle();

  // A refresh resumes the previous seat and skips the lobby entirely.
  const room: GameRoom = (await tryResume()) ?? (await runLobby());

  hideLobby();

  // The campaign is its own flow — no staging, no share link, no match loop.
  if (room.name === CAMPAIGN_ROOM) {
    await runCampaign(room as CampaignRoom);
    return;
  }

  const battle = room as BattleRoom;
  reflectRoomInUrl(battle);
  showShareLink(battle);

  // Staging <-> match cycle. `runStaging` holds in the DOM lobby until the host
  // starts (Phaser is not booted until then); `runMatch` boots Phaser and only
  // resolves once the host resets the room back to the lobby, at which point the
  // loop shows staging again. Both sides clean up their own listeners each pass.
  for (;;) {
    await runStaging(battle);
    await runMatch(battle);
  }
}

void boot();
