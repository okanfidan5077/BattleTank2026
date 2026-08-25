/**
 * Persistent, per-browser meta-progression.
 *
 * Two lifetime figures kept in `localStorage` across matches, tabs and visits:
 * the longest a match this browser played in lasted, and the running total of
 * enemies it has destroyed. Deliberately local and best-effort — this is a
 * personal keepsake, not an authoritative score, so a cleared store just resets
 * it to zero rather than failing anything.
 */

const BEST_TIME_KEY = "battle_city_best_time";
const TOTAL_KILLS_KEY = "battle_city_total_kills";

export interface Progression {
  /** Longest match survived, in seconds. */
  bestTime: number;
  /** Lifetime enemy tanks destroyed. */
  totalKills: number;
}

/** Reads a stored non-negative integer, treating anything unusable as 0. */
function readCounter(key: string): number {
  const raw = localStorage.getItem(key);
  if (raw === null) return 0;

  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** The stats to show in the lobby. */
export function loadProgression(): Progression {
  return {
    bestTime: readCounter(BEST_TIME_KEY),
    totalKills: readCounter(TOTAL_KILLS_KEY),
  };
}

/**
 * Folds one finished match into the stored totals and persists them.
 *
 * The best time only moves up; kills always accumulate. Both inputs are floored
 * to non-negative integers so a stray value can never corrupt the store.
 *
 * @param survivedSeconds - how long the match lasted (the client's `finalTime`).
 * @param kills - enemies this client destroyed in the match.
 * @returns the updated progression, ready to render.
 */
export function recordMatch(survivedSeconds: number, kills: number): Progression {
  const current = loadProgression();

  const bestTime = Math.max(current.bestTime, Math.max(0, Math.floor(survivedSeconds)));
  const totalKills = current.totalKills + Math.max(0, Math.floor(kills));

  localStorage.setItem(BEST_TIME_KEY, String(bestTime));
  localStorage.setItem(TOTAL_KILLS_KEY, String(totalKills));

  return { bestTime, totalKills };
}

/** Formats a survival time as `m:ss`, or a dash when there is no record yet. */
export function formatBestTime(seconds: number): string {
  if (seconds <= 0) return "—";

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}
