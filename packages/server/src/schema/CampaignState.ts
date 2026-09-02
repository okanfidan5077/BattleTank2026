import { type } from "@colyseus/schema";

import { CampaignPhase } from "@battletank/shared";

import { GameState } from "./GameState.js";

/**
 * Replicated root state of a single-player campaign room.
 *
 * Extends {@link GameState} so the campaign inherits the same battlefield
 * collections — `grid`, `tanks`, `bullets`, `boons`, `players` — and can drive
 * the exact same physics systems (all typed against `GameState`) and the same
 * client renderer without duplicating any of it. The inherited match-lifecycle
 * fields (`matchState`, `hostId`, timers) simply go unused here; the campaign is
 * sequenced by {@link phase} instead.
 */
export class CampaignState extends GameState {
  /** 1-based index of the level being played; starts on Level 1. */
  @type("uint8") currentLevel = 1;

  /** Lives remaining in this run. */
  @type("uint8") lives = 100;

  /**
   * Where the playthrough is in its lifecycle; one of {@link CampaignPhase}.
   * Starts on the intro briefing with the world frozen.
   */
  @type("string") phase: CampaignPhase = CampaignPhase.Intro;

  /**
   * Human-readable objective line for the HUD, kept current by the server —
   * e.g. "RADARS LEFT: 3", "REACH EXTRACTION POINT", "SURVIVE: 42s".
   */
  @type("string") objectiveText = "";

  /**
   * The objective's raw number, for any client logic: radars remaining, or
   * seconds left on a survival timer. Zero when the objective has no count.
   */
  @type("uint16") objectiveValue = 0;
}
