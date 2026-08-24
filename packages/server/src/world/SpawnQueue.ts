/** A single pending enemy, waiting for a slot on the battlefield. */
export interface SpawnRequest {
  /** Index into {@link ENEMY_SPAWN_TILES}, chosen when the request is queued. */
  spawnPointIndex: number;
}

/**
 * FIFO queue of enemies still to be released into the battle.
 *
 * Filled once at room creation and drained a couple at a time by the
 * simulation loop, so the whole wave never lands at once.
 */
export class SpawnQueue {
  private readonly pending: SpawnRequest[] = [];

  get size(): number {
    return this.pending.length;
  }

  get isEmpty(): boolean {
    return this.pending.length === 0;
  }

  push(request: SpawnRequest): void {
    this.pending.push(request);
  }

  /** Removes and returns up to `count` requests, fewest-first. */
  take(count: number): SpawnRequest[] {
    if (count <= 0) return [];
    return this.pending.splice(0, count);
  }

  /** Puts a request back at the front, for when a spawn point is occupied. */
  requeue(request: SpawnRequest): void {
    this.pending.unshift(request);
  }

  /** Drops every pending request, for tearing a match down on reset. */
  clear(): void {
    this.pending.length = 0;
  }
}
