import { BIOME, type Animal } from "./catalog";

/**
 * Which animals can eat which food objects. The real server's table isn't visible to the client,
 * so this is a reasonable ladder: small animals eat only basic food, bigger ones unlock more.
 *  - `biomes`: biomes of the *animal* (a land mouse can't eat sea food, a fish can't eat berries)
 *  - `min`/`max`: animal tier range
 */
interface FoodRule {
  biomes: number[];
  min: number;
  max: number;
  /** base XP before the tier bonus */
  xp: number;
}

const GROUND = [BIOME.LAND, BIOME.FOREST, BIOME.DESERT, BIOME.VOLCANO, BIOME.ARCTIC];
const COLD = [BIOME.ARCTIC];
const ANY = [BIOME.LAND, BIOME.WATER, BIOME.ARCTIC, BIOME.VOLCANO, BIOME.DESERT, BIOME.FOREST];

/** meat object types dropped by dead animals */
export const MEAT = new Set([52, 53, 54]);

export const FOOD_RULES: Record<number, FoodRule> = {
  3: { biomes: GROUND, min: 1, max: 7, xp: 8 }, // berries: the starter food
  31: { biomes: GROUND, min: 2, max: 8, xp: 12 }, // raspberry
  49: { biomes: GROUND, min: 2, max: 7, xp: 12 }, // carrot
  32: { biomes: GROUND, min: 3, max: 9, xp: 16 }, // pear
  98: { biomes: GROUND, min: 3, max: 9, xp: 14 }, // anthill
  29: { biomes: GROUND, min: 4, max: 10, xp: 20 }, // banana
  30: { biomes: GROUND, min: 5, max: 11, xp: 24 }, // coconut
  50: { biomes: GROUND, min: 6, max: 12, xp: 32 }, // watermelon
  68: { biomes: GROUND, min: 6, max: 17, xp: 36 }, // beehive
  69: { biomes: GROUND, min: 6, max: 17, xp: 30 }, // honeycomb
  48: { biomes: COLD, min: 1, max: 8, xp: 10 }, // arctic nut
  60: { biomes: COLD, min: 1, max: 6, xp: 10 }, // cloudberry
  52: { biomes: ANY, min: 1, max: 17, xp: 16 }, // small meat
  53: { biomes: ANY, min: 1, max: 17, xp: 40 }, // meat
  54: { biomes: ANY, min: 1, max: 17, xp: 90 }, // large meat
  35: { biomes: [BIOME.WATER], min: 1, max: 4, xp: 8 }, // seaweed
  36: { biomes: [BIOME.WATER], min: 1, max: 5, xp: 10 }, // starfish
  37: { biomes: [BIOME.WATER], min: 2, max: 6, xp: 14 }, // kelp
  38: { biomes: [BIOME.WATER], min: 3, max: 8, xp: 18 }, // clam
  39: { biomes: [BIOME.WATER], min: 4, max: 9, xp: 22 }, // conch
};

/** object types the world treats as food at all */
export const FOOD = new Set(Object.keys(FOOD_RULES).map(Number));

export function canEat(a: Animal, foodType: number): boolean {
  const r = FOOD_RULES[foodType];
  if (!r) return false;
  if (MEAT.has(foodType)) return a.diet !== "herbivore"; // hunters and omnivores eat meat
  if (a.diet === "carnivore") return false; // pure hunters don't eat plants
  return r.biomes.includes(a.biome) && a.tier >= r.min && a.tier <= r.max;
}

/** can this animal eat other animals? */
export const canHunt = (a: Animal) => a.diet !== "herbivore";

/** food object types this animal can eat (sent to the client for the green outlines) */
export function ediblesFor(a: Animal): number[] {
  return [...FOOD].filter((t) => canEat(a, t));
}

export function foodXp(a: Animal, foodType: number): number {
  return (FOOD_RULES[foodType]?.xp ?? 8) + a.tier * 2;
}
