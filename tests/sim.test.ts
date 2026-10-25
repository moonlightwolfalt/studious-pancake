import { loadAnimals, animalById } from "../src/servers/game/catalog";
import { World, loadWorldFile, type PlayerLike } from "../src/servers/game/world";
import type { Entity } from "../src/servers/game/entities";

const file = loadWorldFile();
const A = loadAnimals();
const byName = (n: string) => A.find((a) => a.name.toLowerCase().startsWith(n))!;
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = "") => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"}  ${name} ${extra}`); };

function fresh() {
  const w = new World("t", file);
  // remove all NPCs/food so tests are isolated
  for (const e of [...w.ents.values()]) if (e.kind === "animal" || (e.kind === "obj" && !e.ground)) w.remove(e);
  w.respawns = []; w.temps = [];
  return w;
}
function player(w: World, animal: string, x: number, y: number) {
  const a = byName(animal);
  const e = w.makeAnimal(a, x, y, "T");
  const p: any = { ent: e, animal: a, xp: 0, kills: 0, bornAt: Date.now(), maxXp: 0, mouse: { x, y }, boost: false, view: { w: 1280, h: 800 }, known: new Map(), menu: null, wantsMenu: false, water: 100, hpF: 100, cooldown: { W: 0, S: 0 }, deaths: [] as any[], send() {}, onLevel() {}, onDeath(reason: number, by: Entity | null) { this.deaths.push({ reason, by }); this.ent = null; } };
  e.owner = p; w.add(e); w.players.add(p as PlayerLike);
  return p;
}
const npc = (w: World, name: string, x: number, y: number) => { const e = w.makeAnimal(byName(name), x, y, ""); e.ai = { tx: x, ty: y, next: Infinity }; w.add(e); return e; };
const landSpot = () => ({ x: 8000, y: 8000 }); // centre of the land biome

// 1. thirst kills a land animal that never finds water, reason 4
{ const w = fresh(); const p = player(w, "mouse", 8000, 8000);
  // keep clear of lakes
  for (const o of [...w.ents.values()]) if (o.kind === "obj" && [5, 9, 13].includes(o.type)) w.remove(o);
  for (let i = 0; i < 400 && p.ent; i++) w.tick(1);
  ok("thirst: land animal dies without water", p.deaths.length === 1 && p.deaths[0].reason === 4, `(water=${Math.round(p.water)})`); }

// 2. lake refills water
{ const w = fresh(); const p = player(w, "mouse", 8000, 8000); p.water = 10;
  w.add({ id: w.nextId++, kind: "obj", type: 5, x: 8000, y: 8000, rad: 200, biome: 0, angle: 0, spec: 0, spec2: 0, hp: 100, innerRad: 160, vx: 0, vy: 0 });
  for (let i = 0; i < 10; i++) w.tick(1);
  ok("thirst: lake refills water", p.water >= 99, `(water=${Math.round(p.water)})`); }

// 3. sea animals have no thirst
{ const w = fresh(); const p = player(w, "shrimp", 1000, 8000);
  for (let i = 0; i < 300; i++) w.tick(1);
  ok("thirst: sea animal never thirsty", p.ent && p.water === 100); }

// 4. carnivore NPC hunts and kills smaller prey, dropping meat
{ const w = fresh(); const hunter = npc(w, "fox", 8000, 8000); const prey = npc(w, "mouse", 8200, 8000);
  hunter.ref = byName("lion"); hunter.rad = w.radFor(hunter.ref!.tier); hunter.animalType = hunter.ref!.id;
  for (let i = 0; i < 80 && !prey.dead; i++) w.tick(0.2);
  ok("AI: carnivore hunts and eats smaller prey", prey.dead === true);
  ok("meat: kill leaves meat pieces", w.temps.length > 0 && w.temps.every((m) => [52, 53, 54].includes(m.type)), `(${w.temps.length} pieces)`); }

// 5. herbivore never eats animals
{ const w = fresh(); const big = npc(w, "deer", 8000, 8000); const small = npc(w, "mouse", 8010, 8000);
  for (let i = 0; i < 60; i++) w.tick(0.2);
  ok("diet: herbivore does not eat animals", !small.dead); }

// 6. prey flees from a hunter
{ const w = fresh(); const lion = npc(w, "lion", 8000, 8000); lion.ai!.next = Infinity;
  const mouse = npc(w, "mouse", 8150, 8000); const d0 = Math.hypot(mouse.x - lion.x, mouse.y - lion.y);
  for (let i = 0; i < 6; i++) w.tick(0.2);
  const d1 = Math.hypot(mouse.x - lion.x, mouse.y - lion.y);
  ok("AI: prey keeps its distance / flees", mouse.dead || d1 > d0 - 40, `(d ${Math.round(d0)} -> ${Math.round(d1)})`); }

// 7. carnivore player eats meat for xp; herbivore player ignores it
{ const w = fresh(); const lion = player(w, "lion", 8000, 8000); const deer = player(w, "deer", 9000, 8000);
  for (const [px, py] of [[8000, 8000], [9000, 8000]]) w.add({ id: w.nextId++, kind: "obj", type: 53, x: px, y: py, rad: 12, biome: 0, angle: 0, spec: 0, spec2: 0, hp: 100, vx: 0, vy: 0 });
  for (let i = 0; i < 3; i++) w.tick(0.1);
  ok("meat: carnivore player eats it for xp", lion.xp > 0, `(xp=${Math.round(lion.xp)})`);
  ok("meat: herbivore player ignores it", deer.xp === 0); }

// 8. abilities
{ const w = fresh(); const p = player(w, "lion", 8000, 8000); const small = npc(w, "mouse", 8100, 8000);
  w.useAbility(p, "W"); ok("ability W: dash starts", !!p.ent.dashUntil && p.ent.flags.has("usingAbility"));
  const until = p.ent.dashUntil; w.useAbility(p, "W"); ok("ability W: cooldown blocks a second use", p.ent.dashUntil === until);
  w.useAbility(p, "S"); ok("ability S: roar stuns smaller animals", !!small.stunUntil && small.flags!.has("eff_stunned"));
  const x0 = small.x; small.ai!.tx = 9000; small.ai!.next = Infinity; w.tick(0.2); ok("ability S: stunned animal cannot move", small.x === x0); }
{ const w = fresh(); const p = player(w, "shark", 1000, 8000); w.useAbility(p, "S");
  ok("ability S: sea animals dive", p.ent.flags.has("underWater") && !!p.ent.diveUntil);
  const hunter = npc(w, "killerwhale", 1000, 8000); hunter.rad = 200;
  for (let i = 0; i < 5; i++) w.tick(0.1);
  ok("ability S: divers can't be caught", p.ent && !p.ent.dead); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
