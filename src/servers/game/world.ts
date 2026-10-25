import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../../config";
import { Writer } from "../protocol";
import { BIOME, loadAnimals, xpForTier, type Animal } from "./catalog";
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

/** object types that can be eaten for XP (berries, fruit, sea food, ...) */
export const FOOD = new Set([3, 29, 30, 31, 32, 35, 36, 37, 38, 39, 48, 49, 50, 52, 53, 54, 60, 68, 69, 98]);

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
  send(w: Writer): void;
  onEaten(by: Entity | null): void;
  onLevel(): void;
}

export class World {
  ents = new Map<number, Entity>();
  grid = new Map<number, Set<Entity>>();
  players = new Set<PlayerLike>();
  nextId = 1;
  respawns: { at: number; make: () => Entity }[] = [];
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
    this.spawnNpcs(120);
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
    const k = this.key(e.x, e.y);
    (e as any)._cell = k;
    let c = this.grid.get(k);
    if (!c) this.grid.set(k, (c = new Set()));
    c.add(e);
  }
  remove(e: Entity) {
    this.ents.delete(e.id);
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
    const pool = loadAnimals().filter((a) => a.tier <= 5);
    for (let i = 0; i < n; i++) this.spawnNpc(pool);
  }
  spawnNpc(pool = loadAnimals().filter((a) => a.tier <= 5)) {
    const spot = this.randomSpot();
    const biome = this.biomeAt(spot.x, spot.y);
    const fit = pool.filter((a) => a.biome === biome);
    const a = (fit.length ? fit : pool)[Math.floor(Math.random() * (fit.length || pool.length))];
    const e = this.makeAnimal(a, spot.x, spot.y, "");
    e.ai = { tx: spot.x, ty: spot.y, next: 0 };
    this.add(e);
    return e;
  }
  radFor(tier: number, progress = 0) {
    return 20 + tier * 6 + progress * 8;
  }
  makeAnimal(a: Animal, x: number, y: number, nick: string, species = 0, sub = 0): Entity {
    return {
      id: this.nextId++, kind: "animal", type: OT.ANIMAL, animalType: a.id, x, y, rad: this.radFor(a.tier), biome: this.biomeAt(x, y),
      angle: 0, spec: 0, spec2: 0, hp: 100, species, sub, premium: 0, theme: 0, season: 1, vip: 0, nick, flags: new Set(),
      vx: 0, vy: 0,
    };
  }

  // ---- simulation ---------------------------------------------------------
  tick() {
    const now = performance.now();
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    const W = this.file.width, H = this.file.height;

    for (const e of this.ents.values()) {
      if (e.kind !== "animal") continue;
      const pl = e.owner as PlayerLike | undefined;
      let tx: number, ty: number, speed: number;
      const tier = loadAnimals().find((a) => a.id === e.animalType)?.tier ?? 1;
      speed = Math.max(110, 250 - tier * 7);
      if (pl) {
        tx = pl.mouse.x; ty = pl.mouse.y;
        if (pl.boost) speed *= 1.5;
      } else if (e.ai) {
        if (now > e.ai.next || Math.hypot(e.ai.tx - e.x, e.ai.ty - e.y) < 20) {
          e.ai.tx = Math.min(W - 100, Math.max(100, e.x + rand(-500, 500)));
          e.ai.ty = Math.min(H - 100, Math.max(100, e.y + rand(-500, 500)));
          e.ai.next = now + rand(2000, 6000);
        }
        tx = e.ai.tx; ty = e.ai.ty; speed *= 0.45;
      } else continue;
      const dx = tx - e.x, dy = ty - e.y, d = Math.hypot(dx, dy);
      if (d > 4) {
        const k = Math.min(1, d / (e.rad * 2)) * speed * dt;
        e.x += (dx / d) * k;
        e.y += (dy / d) * k;
        // wire angle: client subtracts 90 for animals, art faces up
        e.angle = (Math.atan2(dy, dx) * 180) / Math.PI + 180;
      }
      e.x = Math.min(W - e.rad, Math.max(e.rad, e.x));
      e.y = Math.min(H - e.rad, Math.max(e.rad, e.y));
      e.biome = this.biomeAt(e.x, e.y);
      this.reindex(e);
    }

    // eating
    for (const p of this.players) {
      const me = p.ent;
      if (!me || !p.animal) continue;
      for (const o of this.near(me.x, me.y, me.rad + 60)) {
        if (o === me || o.dead) continue;
        const d = Math.hypot(o.x - me.x, o.y - me.y);
        if (o.kind === "obj" && FOOD.has(o.type) && d < me.rad + o.rad * 0.4) {
          this.consume(o, me);
          this.gain(p, 8 + p.animal.tier * 4);
        } else if (o.kind === "animal" && d < me.rad * 0.8 && me.rad > o.rad * 1.1 && o !== me) {
          const victim = o.owner as PlayerLike | undefined;
          const vt = loadAnimals().find((a) => a.id === o.animalType)?.tier ?? 1;
          if (vt < p.animal.tier || (victim && me.rad > o.rad * 1.25)) {
            p.kills++;
            this.gain(p, 30 * vt + (victim ? victim.xp * 0.2 : 0));
            this.kill(o, me);
          }
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

  kill(victim: Entity, by: Entity | null) {
    const pl = victim.owner as PlayerLike | undefined;
    victim.dead = true;
    this.remove(victim);
    this.pendingRemovals.push({ id: victim.id, killer: by?.id ?? 0 });
    if (pl) pl.onEaten(by);
    else {
      this.respawns.push({ at: performance.now() + 8000, make: () => this.spawnNpcEntity() });
    }
  }
  private spawnNpcEntity(): Entity {
    const e = this.spawnNpc();
    this.remove(e); // spawnNpc added it; respawn callback re-adds
    return e;
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
        () => w.u8(16).u8(100), // water bar (kept full: no thirst model)
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
