import { type Boon, type GameState, type Tank } from "../schema/index.js";
import { boxesOverlap } from "./tanks.js";

/**
 * Hands out any power-up a player is standing on.
 *
 * Only player tanks pick boons up — an enemy driving over one leaves it alone.
 * Collected boons are removed from the state before `onCollect` runs, so an
 * effect is free to add or remove entities without disturbing this pass.
 *
 * @returns how many boons were collected this tick.
 */
export function collectBoons(
  state: GameState,
  onCollect: (boon: Boon, player: Tank) => void,
): number {
  let collected = 0;

  for (let i = state.boons.length - 1; i >= 0; i--) {
    const boon = state.boons.at(i);

    const player = findCollector(state, boon);
    if (!player) continue;

    state.boons.splice(i, 1);
    collected++;

    onCollect(boon, player);
  }

  return collected;
}

function findCollector(state: GameState, boon: Boon): Tank | null {
  for (let i = 0; i < state.tanks.length; i++) {
    const tank = state.tanks.at(i);
    if (tank.isEnemy) continue;

    if (boxesOverlap(boon.x, boon.y, boon.width, boon.height, tank.x, tank.y, tank.width, tank.height)) {
      return tank;
    }
  }

  return null;
}
