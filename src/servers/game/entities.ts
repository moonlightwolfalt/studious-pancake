/** oType values (the client's GameObjType ids; names inferred from how the client draws them). */
export const OT = {
  ANIMAL: 2,
  BERRY: 3, // edible bush circle, colour by biome
  LAKE: 5,
  LAKE_B: 9,
  LAKE_C: 13,
  MUD: 7,
  ROCK: 8,
  HILL: 47,
  TREE: 101,
  COCONUT: 30,
  BANANA: 29,
  RASPBERRY: 31,
  PEAR: 32,
  SEAWEED: 35,
  STARFISH: 36,
  KELP: 37,
  CLAM: 38,
  CONCH: 39,
  CARROT: 49,
  WATERMELON: 50,
  MEAT_S: 52,
  MEAT_M: 53,
  MEAT_L: 54,
  BEEHIVE: 68,
  HONEYCOMB: 69,
} as const;

/** Order of the bit-group the client reads in Animal.readUpdatedFlags (decoded client.js). */
export const ANIMAL_FLAGS = [
  "hurt", "flying", "lowWat", "underWater", "usingDiveAbility", "eff_invincible", "usingAbility", "tailBitten",
  "eff_stunned", "iceSliding", "eff_frozen", "eff_onFire", "eff_healing", "eff_poison", "constricted", "webStuck",
  "stealth", "eff_bleeding", "flying2", "isGrabbed", "eff_aniInClaws", "eff_stunk", "cold", "inWater", "inLava",
  "canClimbHill", "isClimbingHill", "isDevMode", "eff_slimed", "eff_wobbling", "eff_hot", "eff_sweatPoisoned",
  "eff_shivering", "inHidingHole", "eff_grabbedByFlytrap", "eff_aloeveraHealing", "eff_tossedInAir",
  "eff_isOnSpiderWeb", "fliesLikeDragon", "eff_isInMud", "eff_statue", "eff_isOnTree", "eff_isUnderTree",
  "speared", "eff_dirty", "eff_virusInfection", "eff_wearingMask", "eff_sanitized", "viewing1v1Invite", "can1v1",
  "isInArena", "eff_electroStun",
] as const;
export type AnimalFlag = (typeof ANIMAL_FLAGS)[number];

/** Property ids inside "newly visible"/"update" records (readUpdatedPropertyItem). */
export const PROP = {
  POS: 1, // u16 x*4, u16 y*4
  RAD: 2, // u16 rad*10
  ANGLE: 3, // u16 deg*182
  HP: 4, // u8 0..100
  HURT: 5, // u8
  SPEC: 6, // u8
  SPEC2: 7, // u8
  BIOME: 66, // u8
  WINS_1V1: 63, // u16
  TEAM: 108, // u8
} as const;

import type { Animal } from "./catalog";

export interface Entity {
  id: number;
  kind: "animal" | "obj";
  type: number;
  x: number;
  y: number;
  rad: number;
  biome: number;
  /** degrees, wire convention (see wire.ts) */
  angle: number;
  spec: number;
  spec2: number;
  hp: number;
  // objects
  innerRad?: number;
  /** rectangle objects (biome ground): size in world units; the entity x,y is the centre */
  rectW?: number;
  rectH?: number;
  ground?: boolean;
  /** seconds until a consumed object respawns, <0 = permanent */
  respawn?: number;
  // animals
  animalType?: number;
  species?: number;
  sub?: number;
  premium?: number;
  theme?: number;
  season?: number;
  vip?: number;
  nick?: string;
  flags?: Set<AnimalFlag>;
  // simulation
  /** catalog entry for animals (not sent over the wire) */
  ref?: Animal;
  /** meat drops etc. disappear at this performance.now() time */
  expires?: number;
  stunUntil?: number;
  diveUntil?: number;
  dashUntil?: number;
  vx: number;
  vy: number;
  dead?: boolean;
  owner?: unknown;
  ai?: { tx: number; ty: number; next: number };
}
