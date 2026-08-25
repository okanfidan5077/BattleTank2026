import { getStateCallbacks } from "colyseus.js";

import { ClientMessage, MatchStatus } from "@battletank/shared";

import type { BattleRoom } from "./network.js";
import { formatBestTime, loadProgression } from "./progression.js";
import type { PlayerView } from "./state.js";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`staging: #${id} is missing from index.html`);
  return found as T;
}

/**
 * Runs the staging lobby that sits between joining and playing.
 *
 * The world is frozen server-side while `matchState` is `LOBBY`, so a room can
 * sit open as long as it takes for people to arrive. Only the host sees a live
 * Start button; everyone else is told who they are waiting on.
 *
 * @returns a promise that settles once the match has left `LOBBY` — which is
 *   the caller's cue to boot Phaser. It also settles immediately for a room
 *   that is already under way (a late join, or a resumed session), so those
 *   never see the panel at all.
 */
export function runStaging(room: BattleRoom): Promise<void> {
  const panel = element("staging");
  const roomLabel = element("staging-room");
  const roster = element<HTMLUListElement>("staging-players");
  const startButton = element<HTMLButtonElement>("start-match");
  const hint = element("staging-hint");
  const bestTimeStat = element("stat-best-time");
  const totalKillsStat = element("stat-total-kills");

  // Read fresh each pass, so returning here after a match shows the totals the
  // just-finished game folded in.
  const progression = loadProgression();
  bestTimeStat.textContent = formatBestTime(progression.bestTime);
  totalKillsStat.textContent = String(progression.totalKills);

  // Note: `room.state` is not decoded yet at this point — this runs as soon as
  // the join resolves. Reading `matchState` here would give `undefined`, so
  // everything below is driven by the listener, which fires with the real value
  // the moment the first patch lands.
  roomLabel.textContent = room.roomId;

  // Re-entered after a match: clear any state the previous pass left on the DOM
  // controls (the Start button is disabled once clicked).
  startButton.disabled = false;

  return new Promise<void>((resolve) => {
    // Every subscription this pass registers, detached the moment the match
    // leaves the lobby. Without this, returning here for a rematch would stack a
    // second matchState listener and a second Start-button click handler on top
    // of the first — the classic duplicate-send bug.
    const cleanups: Array<() => void> = [];
    const controller = new AbortController();

    const isHost = () => room.state.hostId === room.sessionId;

    const render = () => {
      if (!room.state?.players) return;

      roster.replaceChildren();

      for (const [sessionId, player] of room.state.players) {
        const row = document.createElement("li");

        const swatch = document.createElement("span");
        swatch.className = "swatch";
        swatch.style.background = `#${player.color.toString(16).padStart(6, "0")}`;

        const name = document.createElement("span");
        name.textContent = player.name;

        row.append(swatch, name);

        const tags = [
          sessionId === room.state.hostId ? "host" : "",
          sessionId === room.sessionId ? "you" : "",
        ].filter(Boolean);

        if (tags.length > 0) {
          const tag = document.createElement("span");
          tag.className = "tag";
          tag.textContent = tags.join(" · ");
          row.append(tag);
        }

        roster.append(row);
      }

      const hostName = room.state.players.get(room.state.hostId)?.name;

      startButton.hidden = !isHost();
      hint.textContent = isHost()
        ? "Share the link in the corner, then start when everyone is in."
        : `Waiting for ${hostName ?? "the host"} to start the match...`;
    };

    const $ = getStateCallbacks(room);

    cleanups.push(
      $(room.state).players.onAdd((player: PlayerView) => {
        render();
        // Per-player handler; Colyseus detaches it when the player is removed.
        $(player).onChange(render);
      }),
    );
    cleanups.push($(room.state).players.onRemove(render));
    cleanups.push($(room.state).listen("hostId", render));

    // Settles this pass and detaches every listener it registered, so the next
    // trip through staging starts clean.
    const finish = (): void => {
      controller.abort();
      for (const detach of cleanups) detach();
      resolve();
    };

    // Drives visibility both ways, and is what tells the caller to boot Phaser.
    // Fires with the current value as soon as state decodes, so a room already
    // under way resolves without the panel ever being shown.
    cleanups.push(
      $(room.state).listen("matchState", (state: MatchStatus) => {
        const staging = state === MatchStatus.Lobby;
        panel.hidden = !staging;

        if (staging) {
          render();
          return;
        }

        finish();
      }),
    );

    // The AbortController detaches this DOM listener in `finish`, so a rematch
    // never accumulates a second click handler.
    startButton.addEventListener(
      "click",
      () => {
        if (!isHost()) return;

        startButton.disabled = true;
        hint.textContent = "Starting...";
        room.send(ClientMessage.StartGame);
      },
      { signal: controller.signal },
    );

    render();
  });
}
