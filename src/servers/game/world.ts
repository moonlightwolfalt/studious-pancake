import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../../config";
import { Writer } from "../protocol";
import { BIOME, loadAnimals, xpForTier, type Animal } from "./catalog";
import { canEat, canHunt, FOOD, foodXp, MEAT } from "./diet";
import { type Entity, OT } from "./entities";
import { snapshot, type Snapshot, writeNewlyVisible, writeRemoved, writeUpdate } from "./wire";

export interface WorldFile {
  seed: number;
  width: number;
  height: number;
  grid?: { cell: number; cols: number; rows: number; layout: string[]; biomes: Record<string, number> };
  minimap: { biome: number; x: number; y: number; w: number; h: number }[];
  objects: { id: number; type: number; biome: number; x: number; y: number; rad: number; innerRad?: number; respawn?: number }[];
}

export { FOOD };

export function loadWorldFile(): WorldFile {
  const p = join(DATA, "world.json");
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  console.warn("[game] data/world.json missing – run `node tools/genworld.mjs`; using an empty arena");
  return { seed: 0, width: 4000, height: 4000, minimap: [{ biome: 0, x: 0, y: 0, w: 4000, h: 4000 }], objects: [] };
}

export const TICK_MS = 100;
const CELL = 400;
const rand = (a: number, b: number) => a + Math.random() * (b - a);

export interface PlayerLike {
  ent: Entity | null;
  animal: Animal | null;
  xp: number;
  kills: number;
  bornAt: number;
  maxXp: number;
  mouse: { x: number; y: number };
  boost: boolean;
  view: { w: number; h: number };
  known: Map<number, Snapshot>;
  menu: Animal[] | null;
  wantsMenu: boolean;
  /** 0-100, drains on land and refills in lakes */
  water: number;
  /** float hit points (ent.hp is the rounded copy sent to the client) */
  hpF: number;
  /** performance.now() times when each ability is ready again */
  cooldown: { W: number; S: number };
  send(w: Writer): void;
  /** reason: 1 eaten, 4 thirst */
  onDeath(reason: number, by: Entity | null): void;
  onLevel(): void;
}

const LAKES = new Set([5, 9, 13]);
/** MOPE_DEBUG_THIRST_RATE=30 makes thirst 30x faster (to test death and respawn quickly) */
const THIRST_RATE = Number(process.env.MOPE_DEBUG_THIRST_RATE ?? 1) || 1;

export class World {
  ents = new Map<number, Entity>();
  grid = new Map<number, Set<Entity>>();
  players = new Set<PlayerLike>();
  /** every connected client (spawned or not) – used for the "players online" counter */
  connected = new Set<object>();
  /** all animals (players + NPCs); the sim loops over this instead of every entity */
  animals = new Set<Entity>();
  /** short-lived objects (meat) */
  temps: Entity[] = [];
  nextId = 1;
  respawns: { at: number; make: () => Entity }[] = [];
  /** biome ground rectangles; too big for the spatial grid, so they're tested against the view directly */
  ground: Entity[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = performance.now();

  constructor(
    public serverId: string,
    public file: WorldFile,
  ) {
    for (const o of file.objects) {
      this.add({
        id: o.id, kind: "obj", type: o.type, x: o.x, y: o.y, rad: o.rad, biome: o.biome, angle: 0, spec: 0, spec2: 0, hp: 100,
        innerRad: o.innerRad, respawn: o.respawn, vx: 0, vy: 0,
      });
      this.nextId = Math.max(this.nextId, o.id + 1);
    }
    this.buildGround();
    this.spawnNpcs(120);
  }

  /**
   * Biome ground. The client has no background colour of its own: each biome is a big rectangle
   * object (12 = ocean, 16 = snow, 33 = sand; volcano/forest reuse 33, recoloured by a client patch).
   * Land is the page's own green.
   */
  private buildGround() {
    const typeFor: Record<number, number> = { [BIOME.WATER]: 12, [BIOME.ARCTIC]: 16, [BIOME.DESERT]: 33, [BIOME.VOLCANO]: 33, [BIOME.FOREST]: 33 };
    for (const r of this.file.minimap) {
      const type = typeFor[r.biome];
      if (!type) continue;
      this.ground.push({
        id: this.nextId++, kind: "obj", type, x: r.x + r.w / 2, y: r.y + r.h / 2, rad: Math.max(r.w, r.h) / 2, biome: r.biome,
        angle: 0, spec: 0, spec2: 0, hp: 100, rectW: r.w, rectH: r.h, ground: true, vx: 0, vy: 0,
      });
    }
  }

  start() {
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- spatial index ---------------------------------------------------
  private key(x: number, y: number) {
    return Math.floor(x / CELL) * 1000 + Math.floor(y / CELL);
  }
  private cellOf(e: Entity & { _cell?: number }) {
    return (e as any)._cell as number | undefined;
  }
  add(e: Entity) {
    this.ents.set(e.id, e);
    if (e.kind === "animal") this.animals.add(e);
    const k = this.key(e.x, e.y);
    (e as any)._cell = k;
    let c = this.grid.get(k);
    if (!c) this.grid.set(k, (c = new Set()));
    c.add(e);
  }
  remove(e: Entity) {
    this.ents.delete(e.id);
    this.animals.delete(e);
    this.grid.get(this.cellOf(e)!)?.delete(e);
  }
  private reindex(e: Entity) {
    const k = this.key(e.x, e.y);
    const old = this.cellOf(e);
    if (k === old) return;
    this.grid.get(old!)?.delete(e);
    let c = this.grid.get(k);
    if (!c) this.grid.set(k, (c = new Set()));
    c.add(e);
    (e as any)._cell = k;
  }
  near(x: number, y: number, r: number): Entity[] {
    const out: Entity[] = [];
    const x0 = Math.floor((x - r) / CELL), x1 = Math.floor((x + r) / CELL);
    const y0 = Math.floor((y - r) / CELL), y1 = Math.floor((y + r) / CELL);
    for (let cx = x0; cx <= x1; cx++)
      for (let cy = y0; cy <= y1; cy++) {
        const c = this.grid.get(cx * 1000 + cy);
        if (c) for (const e of c) out.push(e);
      }
    return out;
  }

  biomeAt(x: number, y: number): number {
    const g = this.file.grid;
    if (g) {
      const cx = Math.min(g.cols - 1, Math.max(0, Math.floor(x / g.cell)));
      const cy = Math.min(g.rows - 1, Math.max(0, Math.floor(y / g.cell)));
      return g.biomes[g.layout[cy][cx]] ?? BIOME.LAND;
    }
    for (const r of this.file.minimap) if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r.biome;
    return BIOME.LAND;
  }
  randomSpot(biome?: number): { x: number; y: number } {
    const regions = biome == null ? this.file.minimap : this.file.minimap.filter((r) => r.biome === biome);
    const r = regions[Math.floor(Math.random() * regions.length)] ?? this.file.minimap[0];
    return { x: rand(r.x + 200, r.x + r.w - 200), y: rand(r.y + 200, r.y + r.h - 200) };
  }

  // ---- NPC animals ------------------------------------------------------
  private spawnNpcs(n: number) {
    for (let i = 0; i < n; i++) this.spawnNpc();
  }
  /** wandering NPC animals: mostly small herbivores plus some predators up to tier 7 */
  makeNpc(): Entity {
    const pool = loadAnimals().filter((a) => a.tier <= 7);
    const spot = this.randomSpot();
    const biome = this.biomeAt(spot.x, spot.y);
    const fit = pool.filter((a) => a.biome === biome && (a.tier <= 4 || Math.random() < 0.35));
    const list = fit.length ? fit : pool;
    const a = list[Math.floor(Math.random() * list.length)];
    const e = this.makeAnimal(a, spot.x, spot.y, "");
    e.ai = { tx: spot.x, ty: spot.y, next: 0 };
    return e;
  }
  spawnNpc() {
    const e = this.makeNpc();
    this.add(e);
    return e;
  }
  radFor(tier: number, progress = 0) {
    return 20 + tier * 6 + progress * 8;
  }
  makeAnimal(a: Animal, x: number, y: number, nick: string, species = 0, sub = 0): Entity {
    return {
      id: this.nextId++, kind: "animal", type: OT.ANIMAL, animalType: a.id, ref: a, x, y, rad: this.radFor(a.tier), biome: this.biomeAt(x, y),
      angle: 0, spec: 0, spec2: 0, hp: 100, species, sub, premium: 0, theme: 0, season: 1, vip: 0, nick, flags: new Set(),
      vx: 0, vy: 0,
    };
  }

  // ---- simulation ---------------------------------------------------------
  /** where an NPC wants to go this tick: flee from hunters, chase prey, else wander */
  private aiTarget(e: Entity, now: number): { tx: number; ty: number; mul: number } {
    const A = e.ref!;
    let threat: Entity | null = null, td = Infinity;
    let prey: Entity | null = null, pd = Infinity;
    for (const o of this.near(e.x, e.y, 460)) {
      if (o === e || o.kind !== "animal" || o.dead || !o.ref) continue;
      const d = Math.hypot(o.x - e.x, o.y - e.y);
      if (canHunt(o.ref) && o.ref.tier > A.tier && o.rad >= e.rad * 1.1 && d < 400 && d < td) (threat = o), (td = d);
      if (canHunt(A) && A.tier >= 2 && A.tier > o.ref.tier && e.rad >= o.rad * 1.1 && !o.flags?.has("underWater") && d < 450 && d < pd) (prey = o), (pd = d);
    }
    if (threat) {
      const dx = e.x - threat.x, dy = e.y - threat.y, d = Math.hypot(dx, dy) || 1;
      return { tx: e.x + (dx / d) * 500, ty: e.y + (dy / d) * 500, mul: 0.85 };
    }
    if (prey) return { tx: prey.x, ty: prey.y, mul: 1.2 };
    const ai = e.ai!;
    if (now > ai.next || Math.hypot(ai.tx - e.x, ai.ty - e.y) < 20) {
      ai.tx = Math.min(this.file.width - 100, Math.max(100, e.x + rand(-500, 500)));
      ai.ty = Math.min(this.file.height - 100, Math.max(100, e.y + rand(-500, 500)));
      ai.next = now + rand(2000, 6000);
    }
    return { tx: ai.tx, ty: ai.ty, mul: 0.45 };
  }

  /** `fixedDt` (seconds) lets tests step the simulation faster than real time */
  tick(fixedDt?: number) {
    const now = performance.now();
    const dt = fixedDt ?? Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    const W = this.file.width, H = this.file.height;

    // meat and other temporary objects expire
    if (this.temps.length) {
      this.temps = this.temps.filter((t) => {
        if (t.dead) return false;
        if (now < (t.expires ?? Infinity)) return true;
        t.dead = true;
        this.remove(t);
        this.pendingRemovals.push({ id: t.id, killer: 0 });
        return false;
      });
    }

    for (const e of [...this.animals]) {
      if (e.dead) continue;
      const pl = e.owner as PlayerLike | undefined;
      const A = e.ref!;

      // timed ability effects wear off
      if (e.stunUntil && now > e.stunUntil) (e.stunUntil = 0), e.flags!.delete("eff_stunned");
      if (e.diveUntil && now > e.diveUntil) (e.diveUntil = 0), e.flags!.delete("underWater"), e.flags!.delete("usingDiveAbility");
      if (e.dashUntil && now > e.dashUntil) (e.dashUntil = 0), e.flags!.delete("usingAbility");

      // ---- movement
      let tx = e.x, ty = e.y, mul = 1;
      // fairly flat across tiers: hunters (x1.2 while chasing) can catch fleeing prey (x0.85), players can outrun with boost
      let speed = Math.max(120, 220 - A.tier * 3);
      if (pl) {
        tx = pl.mouse.x; ty = pl.mouse.y;
        if (pl.boost) speed *= 1.5;
      } else if (e.ai) {
        const t = this.aiTarget(e, now);
        tx = t.tx; ty = t.ty; mul = t.mul;
      }
      if (e.dashUntil) speed *= 2.2;
      speed *= mul;
      const stunned = !!e.stunUntil;
      const dx = tx - e.x, dy = ty - e.y, d = Math.hypot(dx, dy);
      if (!stunned && d > 4 && (pl || e.ai)) {
        // players ease off near the cursor; NPCs (chasing/fleeing) keep full speed to their target
        const k = (pl ? Math.min(1, d / (e.rad * 2)) : 1) * speed * dt;
        e.x += (dx / d) * k;
        e.y += (dy / d) * k;
        // wire angle: the client subtracts 90 for animals and the art faces up
        e.angle = (Math.atan2(dy, dx) * 180) / Math.PI + 180;
      }
      e.x = Math.min(W - e.rad, Math.max(e.rad, e.x));
      e.y = Math.min(H - e.rad, Math.max(e.rad, e.y));
      e.biome = this.biomeAt(e.x, e.y);
      this.reindex(e);

      // ---- thirst (players only): land animals drain water, lakes refill it
      if (pl) {
        if (A.biome === BIOME.WATER) {
          pl.water = 100;
        } else {
          let inLake = false;
          for (const o of this.near(e.x, e.y, e.rad + 350)) {
            if (o.kind === "obj" && LAKES.has(o.type) && Math.hypot(o.x - e.x, o.y - e.y) < o.rad * 0.95) { inLake = true; break; }
          }
          if (inLake) e.flags!.add("inWater"); else e.flags!.delete("inWater");
          pl.water = Math.min(100, Math.max(0, pl.water + (inLake ? 14 : -0.9 * THIRST_RATE) * dt));
        }
        if (pl.water <= 0) pl.hpF -= 6 * THIRST_RATE * dt;
        else if (pl.water > 20 && pl.hpF < 100) pl.hpF = Math.min(100, pl.hpF + 3 * dt);
        e.hp = Math.max(0, Math.round(pl.hpF));
        if (pl.hpF <= 0) { this.kill(e, null, 4); continue; }
      }

      // ---- eating
      for (const o of this.near(e.x, e.y, e.rad + 60)) {
        if (o === e || o.dead || e.dead) continue;
        const od = Math.hypot(o.x - e.x, o.y - e.y);
        if (o.kind === "obj") {
          if (!pl || !FOOD.has(o.type) || od >= e.rad + o.rad * 0.4) continue;
          if (!canEat(A, o.type)) continue; // not on this animal's diet: it passes over it
          this.consume(o, e);
          this.gain(pl, foodXp(A, o.type));
        } else if (o.ref && canHunt(A) && A.tier > o.ref.tier && e.rad >= o.rad * 1.1 && od < e.rad * 0.8) {
          if (o.flags?.has("underWater") && !e.flags?.has("underWater")) continue; // divers can't be caught from above
          const victim = o.owner as PlayerLike | undefined;
          if (pl) {
            pl.kills++;
            this.gain(pl, 30 * o.ref.tier + (victim ? victim.xp * 0.2 : 0));
          }
          this.kill(o, e, 1);
        }
      }
    }

    // respawns
    this.respawns = this.respawns.filter((r) => {
      if (r.at > now) return true;
      this.add(r.make());
      return false;
    });

    this.broadcast();
  }

  consume(o: Entity, by: Entity | null) {
    o.dead = true;
    this.remove(o);
    this.pendingRemovals.push({ id: o.id, killer: by?.id ?? 0 });
    if (o.respawn && o.respawn > 0) {
      const spec = { type: o.type, biome: o.biome, rad: o.rad, respawn: o.respawn };
      this.respawns.push({
        at: performance.now() + o.respawn * 1000,
        make: () => {
          const s = this.randomSpot(spec.biome);
          return { id: this.nextId++, kind: "obj", type: spec.type, x: s.x, y: s.y, rad: spec.rad, biome: spec.biome, angle: 0, spec: 0, spec2: 0, hp: 100, respawn: spec.respawn, vx: 0, vy: 0 };
        },
      });
    }
  }
  pendingRemovals: { id: number; killer: number }[] = [];

  /** an animal dies: remove it, leave meat, tell the player (reason 1 = eaten, 4 = thirst) */
  kill(victim: Entity, by: Entity | null, reason = 1) {
    const pl = victim.owner as PlayerLike | undefined;
    victim.dead = true;
    this.remove(victim);
    this.pendingRemovals.push({ id: victim.id, killer: by?.id ?? 0 });
    this.dropMeat(victim);
    if (pl) pl.onDeath(reason, by);
    else this.respawns.push({ at: performance.now() + 8000, make: () => this.makeNpc() });
  }

  /** bigger animals leave more (and bigger) pieces; carnivores and omnivores can eat them */
  private dropMeat(victim: Entity) {
    const tier = victim.ref?.tier ?? 1;
    const type = victim.rad < 28 ? 52 : victim.rad < 60 ? 53 : 54;
    const pieces = Math.min(4, 1 + Math.floor(tier / 4));
    for (let i = 0; i < pieces; i++) {
      const m: Entity = {
        id: this.nextId++, kind: "obj", type, x: victim.x + rand(-25, 25), y: victim.y + rand(-25, 25), rad: 9 + (type - 52) * 3,
        biome: victim.biome, angle: rand(0, 360), spec: 0, spec2: 0, hp: 100, vx: 0, vy: 0, expires: performance.now() + 25_000,
      };
      this.add(m);
      this.temps.push(m);
    }
  }

  /** ability keys: W = dash for everyone; S = dive (sea animals) or a stunning roar (everyone else) */
  useAbility(p: PlayerLike, key: "W" | "S") {
    const e = p.ent, A = p.animal;
    const now = performance.now();
    if (!e || !A || now < p.cooldown[key]) return;
    if (key === "W") {
      e.dashUntil = now + 1200;
      e.flags!.add("usingAbility");
      p.cooldown.W = now + 6000;
    } else if (A.biome === BIOME.WATER) {
      e.diveUntil = now + 3000;
      e.flags!.add("underWater");
      e.flags!.add("usingDiveAbility");
      p.cooldown.S = now + 8000;
    } else {
      for (const o of this.near(e.x, e.y, 300)) {
        if (o === e || o.kind !== "animal" || !o.ref || o.ref.tier >= A.tier) continue;
        if (Math.hypot(o.x - e.x, o.y - e.y) > 280) continue;
        o.stunUntil = now + 1500;
        o.flags!.add("eff_stunned");
      }
      p.cooldown.S = now + 9000;
    }
  }

  rankOf(p: PlayerLike): number {
    let r = 1;
    for (const o of this.players) if (o !== p && o.xp > p.xp) r++;
    return r;
  }

  gain(p: PlayerLike, xp: number) {
    p.xp += xp;
    p.maxXp = Math.max(p.maxXp, p.xp);
    if (p.ent && p.animal) {
      const need = xpForTier(p.animal.tier);
      const prev = xpForTier(p.animal.tier - 1);
      p.ent.rad = this.radFor(p.animal.tier, Math.min(1, Math.max(0, (p.xp - prev) / Math.max(1, need - prev))));
      if (p.xp >= need && !p.menu) p.onLevel();
    }
  }

  // ---- networking ---------------------------------------------------------
  zoomFor(rad: number) {
    return Math.max(0.25, Math.min(1.6, 36 / (rad + 6)));
  }

  broadcast() {
    const removals = this.pendingRemovals;
    this.pendingRemovals = [];
    for (const p of this.players) {
      const me = p.ent;
      if (!me) continue;
      const zoom = this.zoomFor(me.rad);
      const hw = p.view.w / 2 / zoom + 250, hh = p.view.h / 2 / zoom + 250;
      const visible = new Map<number, Entity>();
      for (const e of this.near(me.x, me.y, Math.max(hw, hh) + 600)) {
        // large objects (lakes, ...) stay visible while any part overlaps the view
        if (Math.abs(e.x - me.x) <= hw + e.rad && Math.abs(e.y - me.y) <= hh + e.rad) visible.set(e.id, e);
      }
      for (const g of this.ground) {
        if (Math.abs(g.x - me.x) <= hw + g.rectW! / 2 && Math.abs(g.y - me.y) <= hh + g.rectH! / 2) visible.set(g.id, g);
      }
      visible.set(me.id, me);

      const added: Entity[] = [];
      const updated: { e: Entity; prev: Snapshot }[] = [];
      for (const e of visible.values()) {
        const prev = p.known.get(e.id);
        if (!prev) added.push(e);
        else updated.push({ e, prev });
      }
      const gone: { id: number; killer: number }[] = [];
      for (const id of p.known.keys()) {
        if (!visible.has(id)) {
          const r = removals.find((x) => x.id === id);
          gone.push({ id, killer: r?.killer ?? 0 });
        }
      }

      const w = new Writer().u8(4);
      // header: player-state props
      const props: (() => void)[] = [
        () => w.u8(1).u16(zoom * 1000),
        () => w.u8(3).u16(me.x * 4).u16(me.y * 4),
        () => w.u8(7).u32(me.id),
        () => w.u8(11).u32(p.xp),
        () => w.u8(16).u8(Math.round(p.water)), // water bar
      ];
      w.u8(props.length);
      for (const f of props) f();
      w.bits([false, false, false]); // isAdmin, ?, moderator-surveillance
      w.u8(0); // trees
      w.u8(0); // team members

      w.u16(added.length);
      for (const e of added) writeNewlyVisible(w, e);
      const body = new Writer();
      let nUpd = 0;
      for (const { e, prev } of updated) if (writeUpdate(body, e, prev)) nUpd++;
      w.u16(nUpd);
      for (const b of body.bytes()) w.u8(b);
      w.u16(gone.length);
      for (const g of gone) writeRemoved(w, g.id, g.killer);

      p.send(w);
      for (const e of added) p.known.set(e.id, snapshot(e));
      for (const { e } of updated) p.known.set(e.id, snapshot(e));
      for (const g of gone) p.known.delete(g.id);
    }
  }

  leaderboard(limit = 10) {
    return [...this.players]
      .filter((p) => p.ent)
      .sort((a, b) => b.xp - a.xp)
      .slice(0, limit);
  }
}
