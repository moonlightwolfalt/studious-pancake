import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../../config";
import type { AnimalDef } from "../../shopgen";

/** biome ids used on the wire (see _0x44060d in the client) */
export const BIOME = { LAND: 0, WATER: 1, ARCTIC: 2, VOLCANO: 3, DESERT: 4, FOREST: 5 } as const;

const FOLDER_BIOME: Record<string, number> = {
  land: BIOME.LAND,
  ocean: BIOME.WATER,
  arctic: BIOME.ARCTIC,
  volcano: BIOME.VOLCANO,
  desert: BIOME.DESERT,
  forest: BIOME.FOREST,
};

export type Diet = "herbivore" | "omnivore" | "carnivore";

export interface Animal {
  id: number;
  name: string;
  tier: number;
  biome: number;
  diet: Diet;
  def: AnimalDef;
}

/**
 * The client has no diet data (the server decides), so diets are inferred from animal names:
 * hunters eat meat and smaller animals, omnivores both plants and meat, everything else plants only.
 */
const CARNIVORE =
  /lion|tiger|wolf|croc|rex\b|shark|orca|killer|cheetah|leopard|jaguar|lynx|panther|snake|cobra|python|viper|anaconda|spider|widow|scorpion|dragon|kraken|monster|eagle|hawk|falcon|owl|piranha|barracuda|squid|moray|vulture|hyena|komodo|raptor|pterodactyl|phoenix|yeti|bigfoot|saber|mantis|dino|seal\b|walrus|pelican|heron|stork|kingfisher|angler|swordfish|stingray|jelly|marlin|polar|puma|cougar|crocodile|gator|alligator|osprey|harpy|condor|secretary|mongoose|weasel|ferret|otter|orca|manta|octopus/i;
const OMNIVORE = /bear|pig|boar|warthog|raccoon|crab|fox|badger|skunk|monkey|gorilla|chimp|duck|chicken|crow|raven|turkey|lizard|frog|toad|ostrich|cassowary|hedgehog|armadillo|opossum|possum|lemur|coati|tarsier|pheasant|chukar|kakapo/i;

function dietOf(name: string): Diet {
  if (CARNIVORE.test(name)) return "carnivore";
  if (OMNIVORE.test(name)) return "omnivore";
  return "herbivore";
}

let animals: Animal[] | null = null;

export function loadAnimals(): Animal[] {
  if (animals) return animals;
  const p = join(DATA, "animals.json");
  if (!existsSync(p)) {
    console.warn("[game] data/animals.json missing – run `bun mopeio.ts probe`; falling back to a mouse-only ladder");
    animals = [{ id: 1, name: "Mouse", tier: 1, biome: 0, diet: "herbivore", def: { id: 1, tier: 1, name: "Mouse", skin: "land/mouse/0/mouse", folder: "land", color: null, text: "", variants: [] } }];
    return animals;
  }
  const raw = JSON.parse(readFileSync(p, "utf8")) as AnimalDef[];
  animals = raw
    // tier 0 = event / special animals that are not part of the evolution ladder
    .filter((a) => a.tier >= 1 && a.name && !a.name.startsWith("("))
    .map((a) => ({
      id: a.id,
      name: a.name.replace(/[!\n]/g, " ").trim(),
      tier: a.tier,
      biome: FOLDER_BIOME[(a.skin ?? a.folder ?? "").replace(/^\//, "").split("/")[0]] ?? BIOME.LAND,
      diet: dietOf(a.name),
      def: a,
    }));
  return animals;
}

let byId: Map<number, Animal> | null = null;
export function animalById(id: number): Animal | undefined {
  byId ??= new Map(loadAnimals().map((a) => [a.id, a]));
  return byId.get(id);
}

export function maxTier(): number {
  return Math.max(...loadAnimals().map((a) => a.tier));
}

/** XP needed to leave tier t. */
export function xpForTier(t: number): number {
  const table = [0, 80, 300, 800, 1800, 3600, 6800, 12000, 20000, 32000, 50000, 78000, 120000, 180000, 270000, 400000, 600000, 900000];
  return table[Math.min(t, table.length - 1)];
}

/**
 * Upgrade choices when leaving tier `tier`.
 *  - "all":  every animal of the next tiers is offered (default)
 *  - "tier": only animals of tier+1 in the player's biome
 */
export function upgradeChoices(tier: number, biome: number, mode: "all" | "tier"): Animal[] {
  const list = loadAnimals();
  if (mode === "all") return list.filter((a) => a.tier > tier).sort((a, b) => a.tier - b.tier || a.id - b.id);
  const next = list.filter((a) => a.tier === tier + 1);
  const inBiome = next.filter((a) => a.biome === biome);
  return inBiome.length ? inBiome : next;
}
