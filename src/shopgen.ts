import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA } from "./config";
import type { ShopItem } from "./servers/shop";

export interface AnimalVariant {
  species: number;
  sub: number;
  name: string;
  skin: string;
}
export interface AnimalDef {
  id: number;
  tier: number;
  name: string;
  skin: string;
  folder: string;
  color: string | null;
  text: string;
  variants: AnimalVariant[];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/**
 * Turn the animal table (read out of the client by tools/probe.cjs) into the
 * item list GET /shop/get serves. Item ids are stable: <animal>_<species>_<sub>.
 */
export function buildCatalog(animals: AnimalDef[]): ShopItem[] {
  const items: ShopItem[] = [];
  for (const a of animals) {
    for (const v of a.variants) {
      const premium = v.species >= 200;
      const rare = v.species >= 100;
      items.push({
        itemId: `${slug(a.name)}_${v.species}_${v.sub}`,
        shopCategory: 0,
        itemType: 0,
        animalType: a.id,
        animalSpecies: v.species,
        animalSubSpecies: v.sub,
        season: 1,
        currencyType: premium ? 1 : 0,
        price: Math.max(1, a.tier) * (premium ? 25 : rare ? 1500 : 400),
        info: v.name.replace(/\n/g, " "),
      });
    }
  }
  return items;
}

export async function writeCatalog(animals: AnimalDef[]) {
  const items = buildCatalog(animals);
  await writeFile(join(DATA, "shop-catalog.json"), JSON.stringify(items, null, 1));
  return items;
}
