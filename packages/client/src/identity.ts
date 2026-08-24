import {
  randomPlayerColor,
  sanitizeDeviceId,
  sanitizePlayerName,
  type JoinOptions,
} from "@battletank/shared";

const NAME_KEY = "battletank.name";

/** Survives refreshes, tab closes and new matches — deliberately long-lived. */
const DEVICE_KEY = "battle_city_device_id";

/**
 * A stable id for this browser.
 *
 * `localStorage`, not `sessionStorage`: the point is to still recognise someone
 * after they close the tab and come back, which is exactly how an eliminated
 * player would try to rejoin for fresh lives.
 */
export function deviceId(): string {
  const existing = sanitizeDeviceId(localStorage.getItem(DEVICE_KEY));
  if (existing) return existing;

  const fresh = generateDeviceId();
  localStorage.setItem(DEVICE_KEY, fresh);
  return fresh;
}

function generateDeviceId(): string {
  // randomUUID needs a secure context; getRandomValues is far more widely
  // available, and Math.random is the last resort rather than the default.
  if (typeof crypto !== "undefined") {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

    if (typeof crypto.getRandomValues === "function") {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    }
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** The name this browser used last, or a fresh one. */
export function rememberedName(): string {
  const stored = localStorage.getItem(NAME_KEY);
  return sanitizePlayerName(stored, randomName());
}

/** Persists a name so the next visit starts with it filled in. */
export function rememberName(name: string): void {
  localStorage.setItem(NAME_KEY, name);
}

/**
 * Builds the join options for a lobby submission.
 *
 * Colour is picked at random from the allowed palette each time — the brief
 * asks for a random colour rather than a chosen one. The server sanitises all
 * of this again on arrival; this is convenience, not validation.
 */
export function joinOptionsFor(name: string): Required<JoinOptions> {
  const clean = sanitizePlayerName(name, randomName());
  rememberName(clean);

  return { name: clean, color: randomPlayerColor(), deviceId: deviceId() };
}

function randomName(): string {
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `Player-${suffix}`;
}

/** Room code from `?room=...`, if this page was opened from a shared link. */
export function roomCodeFromUrl(): string {
  return new URLSearchParams(window.location.search).get("room")?.trim() ?? "";
}

/**
 * Pulls a room code out of whatever the user pasted.
 *
 * People paste the whole invite link as often as the bare code, so accept both
 * rather than making them edit it down.
 */
export function parseRoomCode(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return "";

  if (trimmed.includes("?") || trimmed.includes("/")) {
    try {
      const url = new URL(trimmed, window.location.origin);
      const fromQuery = url.searchParams.get("room");
      if (fromQuery) return fromQuery.trim();
    } catch {
      // Not a URL after all; fall through and use it verbatim.
    }
  }

  return trimmed;
}
