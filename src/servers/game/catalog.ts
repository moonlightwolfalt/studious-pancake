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

export interface Animal {
  id: number;
  name: string;
  tier: number;
  biome: number;
  def: AnimalDef;
}

let animals: Animal[] | null = null;

export function loadAnimals(): Animal[] {
  if (animals) return animals;
  const p = join(DATA, "animals.json");
  if (!existsSync(p)) {
    console.warn("[game] data/animals.json missing – run `bun mopeio.ts probe`; falling back to a mouse-only ladder");
    animals = [{ id: 1, name: "Mouse", tier: 1, biome: 0, def: { id: 1, tier: 1, name: "Mouse", skin: "land/mouse/0/mouse", folder: "land", color: null, text: "", variants: [] } }];
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
      def: a,
    }));
  return animals;
}

export function animalById(id: number): Animal | undefined {
  return loadAnimals().find((a) => a.id === id);
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
