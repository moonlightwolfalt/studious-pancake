/*
 * World generator:  node tools/genworld.mjs [seed]
 * Reads the decoded client, collects every game-object type and image asset it
 * references (gameobj/<type>/..., img/..., skins/...), and lays out a
 * 16000x16000 map with all six biomes using those object types.
 *
 * NOTE: the real servers' world layout is server-side and not observable from
 * the client, so this is a faithful-in-spirit generator, not a byte-exact copy.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const decoded = fs.readFileSync(path.join(root, "work/decoded/client.deobf.js"), "utf8");
const seed = Number(process.argv[2] ?? 1337);

// ---- asset inventory -------------------------------------------------------
const gameobjTypes = new Set([...decoded.matchAll(/gameobj\/(\d+)/g)].map((m) => +m[1]));
const imgAssets = new Set([...decoded.matchAll(/"(img\/[A-Za-z0-9_\-/]+\.png)"/g)].map((m) => m[1]));
const skinAssets = new Set([...decoded.matchAll(/"(skins\/[A-Za-z0-9_\-/]+\.png)"/g)].map((m) => m[1]));
fs.mkdirSync(path.join(root, "data"), { recursive: true });
fs.writeFileSync(
  path.join(root, "data/assets-inventory.json"),
  JSON.stringify({ gameobjTypes: [...gameobjTypes].sort((a, b) => a - b), img: [...imgAssets].sort(), skins: [...skinAssets].sort() }, null, 1),
);

// ---- deterministic RNG -----------------------------------------------------
let s = seed >>> 0;
const rnd = () => ((s = (s + 0x6d2b79f5) >>> 0), (((t) => ((t = Math.imul(t ^ (t >>> 15), t | 1)), (t ^= t + Math.imul(t ^ (t >>> 7), t | 61)), ((t ^ (t >>> 14)) >>> 0) / 4294967296))(s)));
const between = (a, b) => a + rnd() * (b - a);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const W = 16000, H = 16000;
// biome ids: 0 land 1 water 2 arctic 3 volcano 4 desert 5 forest
const regions = [
  { biome: 1, x: 0, y: 0, w: 4000, h: 16000 }, // ocean, west edge
  { biome: 2, x: 4000, y: 0, w: 12000, h: 3500 }, // arctic, north
  { biome: 4, x: 4000, y: 12500, w: 7000, h: 3500 }, // desert, south
  { biome: 3, x: 11000, y: 12500, w: 5000, h: 3500 }, // volcano, south-east
  { biome: 5, x: 11000, y: 3500, w: 5000, h: 9000 }, // forest, east
  { biome: 0, x: 4000, y: 3500, w: 7000, h: 9000 }, // land, centre
];

// object palettes per biome (oType ids as drawn by the client)
const food = {
  0: [3, 29, 31, 32, 49, 50],
  1: [35, 36, 37, 38, 39],
  2: [3, 48, 60],
  3: [3, 30],
  4: [3, 30, 98],
  5: [3, 29, 31, 32, 68, 69],
};
// only types the server can fully encode (no undecoded custom per-class data)
const decor = { 0: [101, 8, 47, 7], 1: [5, 9, 13], 2: [8, 17, 47], 3: [44, 58, 8], 4: [8, 47], 5: [101, 101, 7] };
const known = new Set(gameobjTypes);
for (const v of Object.values(food)) for (const t of v) known.add(t);
for (const v of Object.values(decor)) for (const t of v) known.add(t);

const objects = [];
let id = 1;
const add = (type, biome, x, y, rad, extra = {}) => objects.push({ id: id++, type, biome, x: Math.round(x), y: Math.round(y), rad, ...extra });

for (const r of regions) {
  const area = r.w * r.h;
  const nFood = Math.floor(area / 38000);
  const nDecor = Math.floor(area / 600000);
  for (let i = 0; i < nFood; i++) add(pick(food[r.biome]), r.biome, between(r.x + 60, r.x + r.w - 60), between(r.y + 60, r.y + r.h - 60), between(9, 16), { respawn: 20 });
  for (let i = 0; i < nDecor; i++) {
    const t = pick(decor[r.biome]);
    const rad = [5, 9, 13].includes(t) ? between(180, 420) : t === 101 ? between(70, 130) : between(40, 120);
    add(t, r.biome, between(r.x + rad, r.x + r.w - rad), between(r.y + rad, r.y + r.h - rad), rad, [5, 9, 13].includes(t) ? { innerRad: rad * 0.82 } : {});
  }
}
// at least one of every object type the client knows how to draw, so none is untested
const placed = new Set(objects.map((o) => o.type));
const encodable = new Set([...Object.values(food).flat(), ...Object.values(decor).flat()]);
for (const t of [...known].filter((t) => encodable.has(t) && !placed.has(t))) {
  const r = pick(regions);
  add(t, r.biome, between(r.x + 200, r.x + r.w - 200), between(r.y + 200, r.y + r.h - 200), 40);
}

const out = {
  seed, width: W, height: H, scale: 1,
  minimap: regions.map((r) => ({ biome: r.biome, x: r.x, y: r.y, w: r.w, h: r.h })),
  objects,
};
fs.writeFileSync(path.join(root, "data/world.json"), JSON.stringify(out));
const types = new Set(objects.map((o) => o.type));
console.log(`world seed ${seed}: ${objects.length} objects, ${types.size} object types, ${gameobjTypes.size} gameobj asset folders, ${imgAssets.size} img + ${skinAssets.size} skin assets indexed`);
