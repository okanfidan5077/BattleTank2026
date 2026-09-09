/**
 * Names of every unit the campaign can field, shared by both ends.
 *
 * These used to live as loose string constants inside `CampaignRoom`, which was
 * fine while the room alone decided what appeared on a level. Levels are data
 * now — a level names the units it wants — so the vocabulary has to be somewhere
 * both the level table and the room can see it. The client also branches on
 * these strings to draw a hull, and was matching hand-written literals against
 * them; it can import them instead.
 *
 * The values are the wire format (`Tank.variant`), so they are stable strings
 * rather than a numeric enum: a bad one is obvious in devtools.
 */
export const EnemyVariant = {
  /** The rank and file: hunts the player, shoots, nothing more. */
  Standard: "standard",
  /** Fast rusher that detonates on contact and never fires. */
  Kamikaze: "kamikaze",
  /** Lays permanent walls behind it, rewriting the map as it goes. */
  Constructor: "constructor",
  /** Wanders fast, seeding mines. */
  Trapper: "trapper",
  /** Projects an aura that soaks shells for every enemy inside it. */
  Aegis: "aegis",
  /** Halves the player's rate of fire while it is alive. */
  Jammer: "jammer",
  /** Sits disguised as an item drop, then springs. */
  Mimic: "mimic",
  /** Near-invisible until it fires. */
  Ghost: "ghost",
  /** Refuses to close; lobs arcing shells over cover. */
  Sapper: "sapper",
  /** Grapples the player and drags them out of position. */
  Lurcher: "lurcher",
  /** Suppresses every player ability inside its bubble. */
  Nullifier: "nullifier",

  // ---------------------------------------------------------------- act 4+
  /** Immobile turret with a long reach; has to be approached, not outrun. */
  Sentinel: "sentinel",
  /** Buffs the speed and rate of fire of everything near it — inverse Aegis. */
  Howler: "howler",
  /** Contact drains the player's ability cooldowns back to zero. */
  Leech: "leech",
  /** Calls in reinforcement drops on a timer. */
  Overseer: "overseer",
  /** Rebuilds the objective structures the player is trying to level. */
  Reclaimer: "reclaimer",
  /** Submerges — untargetable — and resurfaces next to the player. */
  Burrower: "burrower",

  // ------------------------------------------------------------------ allies
  /** The escort carrier. A friendly: `isEnemy` is false. */
  Convoy: "convoy",
} as const;
export type EnemyVariant = (typeof EnemyVariant)[keyof typeof EnemyVariant];

/**
 * Boss units. Also carried in `Tank.variant`, alongside `isBoss`.
 *
 * Split from {@link EnemyVariant} because levels treat them differently: rank
 * and file are rolled from a weighted table, bosses are placed deliberately.
 */
export const BossKind = {
  /** Ballistic wrecking ball: bounces off walls, crushes what it touches. */
  Sweeper: "sweeper",
  /** Standoff siege gun. Skulks away, shells the player from across the map. */
  Artillery: "artillery",
  /** Silent battering ram that ploughs through the map at the player. */
  Juggernaut: "juggernaut",
  /** One unarmoured face at a time, and the face keeps moving. */
  Bastion: "bastion",
  /** Shielded siege tank that carpets the ground with mines. */
  Warden: "warden",
  /** Splits in two every time it is killed, down through three tiers. */
  Hydra: "hydra",
  /** Sealed behind pylons while it walls the arena in around the player. */
  Architect: "architect",
  /** The Logic Core: three phases of radial, shotgun and spiral fire. */
  Core: "core",
  /** A copy of the player, carrying the player's own kit. */
  Effigy: "effigy",

  // ------------------------------------------------------------- act 4 to 6
  /** Builds and repairs; has to be starved by levelling its intakes. */
  Foundry: "foundry",
  /** Twins on one health pool that must be finished within seconds of each other. */
  Choir: "choir",
  /** Burrows, and surfaces underneath the player. */
  Leviathan: "leviathan",
} as const;
export type BossKind = (typeof BossKind)[keyof typeof BossKind];

/** Every boss kind, for validation and for the bestiary. */
export const BOSS_KINDS: readonly BossKind[] = Object.values(BossKind);

/** True when `variant` names a boss rather than a rank-and-file unit. */
export function isBossKind(variant: string): variant is BossKind {
  return (BOSS_KINDS as readonly string[]).includes(variant);
}
