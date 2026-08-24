/**
 * Player identity: what a client asks for at join time, and what the server
 * decides it is actually allowed to have.
 *
 * Join options arrive straight off the socket, so everything here treats its
 * input as hostile and normalises it before it can reach the replicated state.
 */

/** Options a client may pass to `joinOrCreate`. */
export interface JoinOptions {
  name?: string;
  /** 24-bit hex colour, e.g. 0x4caf50. */
  color?: number;
  /**
   * Opaque per-browser id, used to keep an eliminated player eliminated when
   * they rejoin the same room. Self-asserted — see sanitizeDeviceId.
   */
  deviceId?: string;
}

/** Bounds on an acceptable device id. */
export const DEVICE_ID_MIN_LENGTH = 8;
export const DEVICE_ID_MAX_LENGTH = 64;

export const PLAYER_NAME_MAX_LENGTH = 16;

/**
 * The only colours a player tank may wear.
 *
 * Red, purple and near-black are reserved for the enemy tiers; gold, silver and
 * brown read as the eagle, steel and brick. Everything here stays legible
 * against the dark field and cannot be mistaken for terrain or an enemy.
 */
export const PLAYER_COLORS: readonly number[] = [
  0x0000ff, // blue
  0x00ffff, // cyan
  0xffff00, // yellow
  0xffa500, // orange
  0xffc0cb, // pink
  0x00ff00, // lime
];

/** Picks one of the allowed colours at random. */
export function randomPlayerColor(): number {
  return PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)]!;
}

export const DEFAULT_PLAYER_COLOR = PLAYER_COLORS[0]!;

/** Highest valid 24-bit colour. */
const MAX_COLOR = 0xffffff;

/** True for characters that must never reach a rendered name. */
function isDisallowed(codePoint: number): boolean {
  // C0 and C1 control characters.
  if (codePoint <= 0x1f) return true;
  if (codePoint >= 0x7f && codePoint <= 0x9f) return true;
  // Zero-width spaces, joiners and bidirectional overrides.
  if (codePoint >= 0x200b && codePoint <= 0x200f) return true;
  if (codePoint >= 0x202a && codePoint <= 0x202e) return true;
  // Line/paragraph separators and the byte order mark.
  return codePoint === 0x2028 || codePoint === 0x2029 || codePoint === 0xfeff;
}

/**
 * Normalises a requested display name.
 *
 * Invisible characters are stripped rather than escaped — the name is drawn as
 * text on a canvas, so a zero-width or bidi-override name would either vanish
 * or scramble the labels around it. An empty result falls back, so nobody can
 * join as a nameless player.
 */
export function sanitizePlayerName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;

  const cleaned = Array.from(value)
    .filter((character) => !isDisallowed(character.codePointAt(0) ?? 0))
    .join("")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length === 0) return fallback;
  return cleaned.slice(0, PLAYER_NAME_MAX_LENGTH);
}

/** Clamps a requested colour to a real 24-bit value, or falls back. */
export function sanitizePlayerColor(value: unknown, fallback = DEFAULT_PLAYER_COLOR): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;

  const rounded = Math.floor(value);
  if (rounded < 0 || rounded > MAX_COLOR) return fallback;

  return rounded;
}

/** Fallback name derived from the session, when a client offers nothing usable. */
export function defaultPlayerName(sessionId: string): string {
  return `Player-${sessionId.slice(0, 4).toUpperCase()}`;
}

/** Deterministic palette pick, so a session keeps the same default colour. */
export function defaultPlayerColor(sessionId: string): number {
  let hash = 0;
  for (const character of sessionId) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  }
  return PLAYER_COLORS[hash % PLAYER_COLORS.length]!;
}

/**
 * Narrows a client-supplied device id to something safe to key a Set with.
 *
 * Returns `null` for anything unusable, which the server treats as "no device
 * id" — an untracked, brand new player.
 *
 * This is **self-asserted identity**, not authentication. It stops a player
 * casually rejoining a room they were eliminated from; it does not stop someone
 * who clears storage or edits the payload. Real enforcement needs server-side
 * identity, which is a much larger change.
 */
export function sanitizeDeviceId(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();

  // Opaque token: letters, digits and the separators a UUID uses. Bounded so a
  // client cannot pad the set with megabyte-long keys.
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null;
  if (trimmed.length < DEVICE_ID_MIN_LENGTH || trimmed.length > DEVICE_ID_MAX_LENGTH) return null;

  return trimmed;
}
