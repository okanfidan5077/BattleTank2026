import { joinOptionsFor, parseRoomCode, rememberedName, roomCodeFromUrl } from "./identity.js";
import { createRoom, joinRoomById, shareableLink, type BattleRoom } from "./network.js";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`lobby: #${id} is missing from index.html`);
  return found as T;
}

/**
 * Runs the start screen and resolves once a room has been joined.
 *
 * Phaser is not booted until this settles, so nothing renders behind the lobby
 * and the game scene can be handed an already-connected room.
 */
export function runLobby(): Promise<BattleRoom> {
  const lobby = element("lobby");
  const nameInput = element<HTMLInputElement>("player-name");
  const codeInput = element<HTMLInputElement>("room-code");
  const createButton = element<HTMLButtonElement>("create-room");
  const joinButton = element<HTMLButtonElement>("join-room");
  const status = element("lobby-status");

  nameInput.value = rememberedName();

  // Opened from an invite link: pre-fill the code and point at Join.
  const invited = roomCodeFromUrl();
  if (invited) {
    codeInput.value = invited;
    status.textContent = "You were invited — press Join Room.";
    joinButton.focus();
  } else {
    nameInput.focus();
    nameInput.select();
  }

  return new Promise<BattleRoom>((resolve) => {
    const setBusy = (busy: boolean) => {
      createButton.disabled = busy;
      joinButton.disabled = busy;
    };

    const fail = (message: string) => {
      status.textContent = message;
      status.classList.add("error");
      setBusy(false);
    };

    const attempt = async (what: string, connect: () => Promise<BattleRoom>) => {
      setBusy(true);
      status.classList.remove("error");
      status.textContent = what;

      try {
        const room = await connect();
        lobby.hidden = true;
        resolve(room);
      } catch (error) {
        fail(readableError(error));
      }
    };

    createButton.addEventListener("click", () => {
      void attempt("Creating room...", () => createRoom(joinOptionsFor(nameInput.value)));
    });

    joinButton.addEventListener("click", () => {
      const code = parseRoomCode(codeInput.value);
      if (!code) {
        fail("Enter a room code, or create a room instead.");
        return;
      }

      void attempt(`Joining ${code}...`, () => joinRoomById(code, joinOptionsFor(nameInput.value)));
    });

    // Enter submits whichever half the user is standing in.
    nameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") createButton.click();
    });
    codeInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") joinButton.click();
    });
  });
}

/** Hides the start screen. Needed on the resume path, which never shows it. */
export function hideLobby(): void {
  element("lobby").hidden = true;
}

/**
 * Writes the room into the address bar as `?room=<id>`.
 *
 * Without this the id only existed inside the share box, so inviting someone
 * meant reading it off the screen and retyping it — and room ids are
 * case-sensitive and contain `_` and `-`, so a single slip reads back as "no
 * room with that code". Now the URL itself is the invite.
 *
 * `replaceState`, not `pushState`: Back should leave the game, not step through
 * a history entry for every room joined.
 */
export function reflectRoomInUrl(room: BattleRoom): void {
  const url = new URL(window.location.href);
  if (url.searchParams.get("room") === room.roomId) return;

  url.search = `?room=${encodeURIComponent(room.roomId)}`;
  window.history.replaceState(null, "", url.toString());
}

/** Reveals the invite link once a room is live. */
export function showShareLink(room: BattleRoom): void {
  const share = element("share");
  const link = element<HTMLInputElement>("share-link");
  const copy = element<HTMLButtonElement>("copy-link");

  link.value = shareableLink(room);
  share.hidden = false;

  copy.addEventListener("click", () => {
    link.select();

    void navigator.clipboard
      ?.writeText(link.value)
      .then(() => {
        copy.textContent = "Copied";
        window.setTimeout(() => (copy.textContent = "Copy"), 1500);
      })
      .catch(() => {
        // Clipboard access can be refused; the text is selected either way.
        copy.textContent = "Ctrl+C";
        window.setTimeout(() => (copy.textContent = "Copy"), 1500);
      });
  });
}

/** Turns a Colyseus failure into something worth showing a player. */
function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/not found|does not exist/i.test(message)) {
    return "No room with that code. Codes are case-sensitive — paste the invite link instead.";
  }
  if (/locked|full/i.test(message)) return "That room is full or already finished.";

  return `Could not connect: ${message}`;
}
