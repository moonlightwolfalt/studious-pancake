/*
 * World generator:  node tools/genworld.mjs [seed]
 * Reads the decoded client, collects every game-object type and image asset it
 * references (gameobj/<type>/..., img/..., skins/...), and lays out a
 * 16x16 cell grid (1000 units per cell) with all six biomes, using those object types.
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

const CELL = 1000;
// 16x16 biome grid (row = y, col = x): W water, A arctic, L land, F forest, D desert, V volcano
const LAYOUT = [
  "WWAAAAAAAAAAAAAA",
  "WWAAAAAAAAAAAAAA",
  "WWAAAAAAAAAAFFFF",
  "WWWALLLLLLFFFFFF",
  "WWWLLLLLLLFFFFFF",
  "WWLLLLLLLLLFFFFF",
  "WWLLLLLLLLLLFFFF",
  "WWLLLLLLLLLLLFFF",
  "WWLLLLLLLLLLLLFF",
  "WWLLLLLLLLLLLLLF",
  "WWWLLLLLLLLLLLLL",
  "WWWDDLLLLLLLLLVV",
  "WWWDDDDDLLLLLVVV",
  "WWWDDDDDDDDLLVVV",
  "WWWDDDDDDDDDVVVV",
  "WWWDDDDDDDDDVVVV",
];
const BIOME_OF = { L: 0, W: 1, A: 2, V: 3, D: 4, F: 5 };
const COLS = LAYOUT[0].length, ROWS = LAYOUT.length;
const W = COLS * CELL, H = ROWS * CELL;
const biomeOfCell = (cx, cy) => BIOME_OF[LAYOUT[cy][cx]];

// minimap regions: merge equal runs per row, then merge identical runs vertically
const regions = [];
for (let cy = 0; cy < ROWS; cy++) {
  let cx = 0;
  while (cx < COLS) {
    let end = cx;
    while (end + 1 < COLS && LAYOUT[cy][end + 1] === LAYOUT[cy][cx]) end++;
    const prev = regions.find((r) => r.biome === biomeOfCell(cx, cy) && r.x === cx * CELL && r.w === (end - cx + 1) * CELL && r.y + r.h === cy * CELL);
    if (prev) prev.h += CELL;
    else regions.push({ biome: biomeOfCell(cx, cy), x: cx * CELL, y: cy * CELL, w: (end - cx + 1) * CELL, h: CELL });
    cx = end + 1;
  }
}

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
const decor = { 0: [101, 8, 47, 7], 1: [8], 2: [8, 17, 47], 3: [44, 58, 8], 4: [8, 47], 5: [101, 101, 7] };
// objects per 1000x1000 cell
const DENSITY = { food: 26, decor: 1.6 };
const known = new Set(gameobjTypes);
for (const v of Object.values(food)) for (const t of v) known.add(t);
for (const v of Object.values(decor)) for (const t of v) known.add(t);

const objects = [];
let id = 1;
const add = (type, biome, x, y, rad, extra = {}) => objects.push({ id: id++, type, biome, x: Math.round(x), y: Math.round(y), rad, ...extra });
const isLake = (t) => t === 5 || t === 9 || t === 13;

// Cell-by-cell generation. Food: stratified jitter over a 6x6 sub-grid so it spreads
// evenly instead of clumping. Decor: rejection-sampled so large objects never overlap.
const SUB = 6;
for (let cy = 0; cy < ROWS; cy++) {
  for (let cx = 0; cx < COLS; cx++) {
    const biome = biomeOfCell(cx, cy);
    const ox = cx * CELL, oy = cy * CELL;
    const subs = [];
    for (let i = 0; i < SUB * SUB; i++) subs.push(i);
    subs.sort(() => rnd() - 0.5);
    for (const i of subs.slice(0, Math.round(DENSITY.food * (0.7 + rnd() * 0.6)))) {
      const sx = (i % SUB) * (CELL / SUB), sy = Math.floor(i / SUB) * (CELL / SUB);
      add(pick(food[biome]), biome, ox + sx + between(15, CELL / SUB - 15), oy + sy + between(15, CELL / SUB - 15), between(9, 16), { respawn: 20 });
    }
    const placed = [];
    const nDecor = Math.round(DENSITY.decor * (0.5 + rnd()));
    for (let k = 0, tries = 0; k < nDecor && tries < 40; tries++) {
      const t = pick(decor[biome]);
      const rad = isLake(t) ? between(120, 330) : t === 101 ? between(70, 130) : between(40, 120);
      const x = ox + between(rad, CELL - rad), y = oy + between(rad, CELL - rad);
      if (placed.some((p) => Math.hypot(p.x - x, p.y - y) < p.rad + rad + 20)) continue;
      placed.push({ x, y, rad });
      add(t, biome, x, y, rad, isLake(t) ? { innerRad: rad * 0.82 } : {});
      k++;
    }
  }
}
// at least one of every encodable object type, so none stays untested
const encodable = new Set([...Object.values(food).flat(), ...Object.values(decor).flat()]);
const present = new Set(objects.map((o) => o.type));
for (const t of [...known].filter((t) => encodable.has(t) && !present.has(t))) {
  const r = pick(regions);
  add(t, r.biome, between(r.x + 200, r.x + r.w - 200), between(r.y + 200, r.y + r.h - 200), 40);
}

const out = {
  seed, width: W, height: H, scale: 1,
  grid: { cell: CELL, cols: COLS, rows: ROWS, layout: LAYOUT, biomes: BIOME_OF },
  minimap: regions.map((r) => ({ biome: r.biome, x: r.x, y: r.y, w: r.w, h: r.h })),
  objects,
};
fs.writeFileSync(path.join(root, "data/world.json"), JSON.stringify(out));
const types = new Set(objects.map((o) => o.type));
console.log(`world seed ${seed}: ${objects.length} objects, ${types.size} object types, ${gameobjTypes.size} gameobj asset folders, ${imgAssets.size} img + ${skinAssets.size} skin assets indexed`);
