import { Client, type Room } from "colyseus.js";

import { BATTLE_ROOM, type JoinOptions } from "@battletank/shared";

import type { BattleStateView } from "./state.js";

/**
 * The Colyseus endpoint to connect to.
 *
 * Resolution order:
 *  1. `VITE_SERVER_URL` — an explicit override, baked in at build time.
 *  2. In production, the page's own origin. The single-container deployment
 *     serves this client from the game server itself, so the current host (and
 *     its `wss`/`ws` scheme, matched to `https`/`http`) is exactly right — and
 *     it follows the app to any domain without a rebuild.
 *  3. In dev, the same host on the server's port: the client is served by Vite
 *     on 5173 while the server listens on 2567, so the origin cannot be reused.
 */
function resolveEndpoint(): string {
  const override = import.meta.env["VITE_SERVER_URL"];
  if (override) return override;

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";

  if (import.meta.env.DEV) {
    return `${protocol}://${window.location.hostname}:2567`;
  }

  return `${protocol}://${window.location.host}`;
}

export const SERVER_URL = resolveEndpoint();

export const colyseus = new Client(SERVER_URL);

export type BattleRoom = Room<BattleStateView>;

/**
 * Where the reconnection token lives.
 *
 * `sessionStorage` rather than `localStorage` on purpose: it survives a refresh
 * of *this tab* and nothing else. A second tab is a genuinely new player, and a
 * closed tab should not resurrect a seat hours later.
 */
const TOKEN_KEY = "battletank.reconnection";

/** Opens a brand new room and takes the first seat in it. */
export async function createRoom(options: JoinOptions): Promise<BattleRoom> {
  return remember(await colyseus.create<BattleStateView>(BATTLE_ROOM, options));
}

/** Joins an existing room by its id. */
export async function joinRoomById(roomId: string, options: JoinOptions): Promise<BattleRoom> {
  return remember(await colyseus.joinById<BattleStateView>(roomId, options));
}

/**
 * Resumes the previous session if this page load is a refresh.
 *
 * This is the client half of the anti-refresh fix: the server holds the seat,
 * but only a client offering the token back can claim it. Returns `null` when
 * there is nothing to resume, in which case the lobby is shown.
 */
export async function tryResume(): Promise<BattleRoom | null> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (!token) return null;

  try {
    const resumed = await colyseus.reconnect<BattleStateView>(token);
    console.log("[client] resumed previous session");
    return remember(resumed);
  } catch (error) {
    // Expired, already claimed, or the room is gone. Fall back to the lobby.
    console.log("[client] could not resume:", String(error));
    sessionStorage.removeItem(TOKEN_KEY);
    return null;
  }
}

/** Stores the token for the next reload, and clears it on a clean exit. */
function remember(room: BattleRoom): BattleRoom {
  sessionStorage.setItem(TOKEN_KEY, room.reconnectionToken);

  // A deliberate leave is final — do not try to resume it afterwards.
  room.onLeave(() => {
    sessionStorage.removeItem(TOKEN_KEY);
  });

  return room;
}

/** Drops the stored token, so the next load starts a brand new session. */
export function forgetSession(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

/**
 * The link that drops a friend straight into this room.
 *
 * Note colyseus.js exposes `roomId`, not `id`.
 */
export function shareableLink(room: BattleRoom): string {
  const url = new URL(window.location.href);
  url.search = `?room=${encodeURIComponent(room.roomId)}`;
  url.hash = "";
  return url.toString();
}
