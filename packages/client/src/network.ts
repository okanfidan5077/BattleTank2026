import { Client, type Room } from "colyseus.js";

import { BATTLE_ROOM, CAMPAIGN_ROOM, type JoinOptions } from "@battletank/shared";

import type { BattleStateView, CampaignStateView } from "./state.js";

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
export type CampaignRoom = Room<CampaignStateView>;

/** Either room the game scene can be handed. Branch on `room.name`. */
export type GameRoom = BattleRoom | CampaignRoom;

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
 * Opens a fresh campaign run.
 *
 * `create` rather than `joinOrCreate`: the campaign now seats up to four for
 * co-op, and matchmaking into it would drop a player who just wanted to play
 * alone into a stranger's half-finished run — inheriting their level and their
 * shared lives. Co-op is opt-in instead: the host shares their room code and a
 * friend joins it through {@link joinRoomById}, exactly like a battle room.
 *
 * Deliberately not passed through {@link remember}: a campaign seat is
 * short-lived, so there is nothing to hold open for a reconnect — a refresh
 * simply returns to the lobby.
 */
export async function joinCampaign(options: JoinOptions): Promise<CampaignRoom> {
  return colyseus.create<CampaignStateView>(CAMPAIGN_ROOM, options);
}

/**
 * Longest a resume attempt may hold the lobby, in ms.
 *
 * A token for a room that is gone does not fail fast — the reconnect sits on
 * the transport's own timeout, and the lobby cannot be shown until it settles,
 * so the whole app looks hung on the way back in. A seat that is genuinely
 * still held answers in well under this.
 */
const RESUME_TIMEOUT_MS = 2500;

/**
 * Resumes the previous session if this page load is a refresh.
 *
 * This is the client half of the anti-refresh fix: the server holds the seat,
 * but only a client offering the token back can claim it. Returns `null` when
 * there is nothing to resume, in which case the lobby is shown.
 *
 * Bounded by {@link RESUME_TIMEOUT_MS}: giving up early only costs a seat that
 * was probably not there, while waiting costs the player a blank screen.
 */
export async function tryResume(): Promise<BattleRoom | null> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (!token) return null;

  const attempt = colyseus.reconnect<BattleStateView>(token);

  const timeout = new Promise<null>((resolve) => {
    window.setTimeout(() => resolve(null), RESUME_TIMEOUT_MS);
  });

  try {
    const resumed = await Promise.race([attempt, timeout]);
    if (!resumed) {
      console.log("[client] resume timed out — starting fresh");
      sessionStorage.removeItem(TOKEN_KEY);
      // A room that turns up after we have given up on it is nobody's seat any
      // more: release it rather than leaving it held until the server expires it.
      void attempt.then((late) => void late.leave(true).catch(() => {})).catch(() => {});
      return null;
    }

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
 * Leaves the room for good and clears the resume token.
 *
 * A clean break for "Return to Lobby": the token is dropped first (so nothing
 * can auto-resume, even if the leave hangs), then the seat is released with a
 * consented leave. The next visit runs fresh matchmaking rather than trying to
 * reconnect to a room that may already be gone.
 */
export async function leaveRoom(room: GameRoom): Promise<void> {
  forgetSession();
  try {
    await room.leave(true);
  } catch {
    // Already disconnected or disposed — the token is cleared either way.
  }
}

/**
 * Longest the UI will wait on a leave before reloading anyway, in ms.
 *
 * `room.leave()` only settles once the *server* closes the socket, which can
 * take seconds — long enough that pressing MENU looked like it had hung. The
 * frame itself goes out synchronously, so a short grace is all that is actually
 * needed to get it onto the wire.
 */
const LEAVE_FLUSH_TIMEOUT_MS = 250;

/**
 * Drops the seat and reloads into a fresh lobby, without waiting on the server.
 *
 * The reload happens as soon as the leave settles or {@link
 * LEAVE_FLUSH_TIMEOUT_MS} elapses, whichever comes first. Reloading early is
 * safe because {@link forgetSession} has already run inside {@link leaveRoom}:
 * with no token there is nothing to auto-resume, so the worst case is that the
 * server sees an unconsented drop and releases the seat on its own timer.
 */
export function leaveRoomAndReload(room: GameRoom | undefined): void {
  const reload = () => window.location.reload();
  if (!room) {
    reload();
    return;
  }

  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    reload();
  };

  window.setTimeout(once, LEAVE_FLUSH_TIMEOUT_MS);
  void leaveRoom(room).finally(once);
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
