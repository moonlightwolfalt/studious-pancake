import type { ServerWebSocket } from "bun";
import { authenticate, equippedSkins, sessionUsers } from "./accounts";
import { animalById, loadAnimals, upgradeChoices, xpForTier, type Animal } from "./game/catalog";
import { type Entity } from "./game/entities";
import { FOOD, loadWorldFile, type PlayerLike, World, type WorldFile } from "./game/world";
import type { Snapshot } from "./game/wire";
import { shopCatalog } from "./shop";
import { C2S, Reader, S2C, Writer } from "./protocol";

export interface WsData {
  serverId: string;
  ping: boolean;
  session?: Session;
}

/** "all" offers every animal in the upgrade menu, "tier" only the next tier of your biome */
const UPGRADE_MODE = (process.env.MOPE_UPGRADE_MODE ?? "all") as "all" | "tier";
/** custom client->server id used by local-ui.js ([U] key): open the upgrade menu on demand */
export const C2S_OPEN_MENU = 122;

let worldFile: WorldFile | null = null;
export const worlds = new Map<string, World>();
const stopTimers = new Map<string, ReturnType<typeof setTimeout>>();

function worldFor(id: string): World {
  let w = worlds.get(id);
  if (!w) {
    worldFile ??= loadWorldFile();
    w = new World(id, worldFile);
    worlds.set(id, w);
  }
  clearTimeout(stopTimers.get(id));
  w.start();
  return w;
}
function released(id: string) {
  const w = worlds.get(id);
  if (!w || w.players.size) return;
  stopTimers.set(id, setTimeout(() => (w.players.size ? null : (w.stop(), worlds.delete(id))), 30_000));
}
export const playerCount = (id: string) => worlds.get(id)?.players.size ?? 0;

const sessionId = () => Buffer.from(crypto.getRandomValues(new Uint8Array(9))).toString("hex");

export class Session implements PlayerLike {
  id = sessionId();
  world: World | null = null;
  ent: Entity | null = null;
  animal: Animal | null = null;
  xp = 0;
  kills = 0;
  bornAt = 0;
  maxXp = 0;
  mouse = { x: 0, y: 0 };
  boost = false;
  view = { w: 1280, h: 720 };
  known = new Map<number, Snapshot>();
  menu: Animal[] | null = null;
  wantsMenu = false;
  name = "mope.io";
  private lb: ReturnType<typeof setInterval> | null = null;

  constructor(public ws: ServerWebSocket<WsData>) {}

  send(w: Writer) {
    this.ws.sendBinary(w.bytes());
  }

  // ---- connection lifecycle -------------------------------------------------
  hello() {
    this.world = worldFor(this.ws.data.serverId);
    const f = this.world.file;
    this.send(new Writer().u8(S2C.SESSION).str(this.id).u8(0).u8(1).str(this.ws.data.serverId).u8(0).u16(0));
    this.camera(f.width / 2, f.height / 2, 1.0);
    this.minimap();
    this.send(new Writer().u8(S2C.READY));
    this.lb = setInterval(() => this.periodic(), 1000);
  }

  private camera(x: number, y: number, zoom: number) {
    const f = this.world!.file;
    this.send(new Writer().u8(S2C.CAMERA).u16(f.width).u16(f.height).u16(x * 4).u16(y * 4).u16(zoom * 1000));
  }

  /** minimap region rectangles (client type ids pick the colour: see getColorForObjType) */
  private minimap() {
    const f = this.world!.file;
    const typeFor = [1, 12, 16, 44, 11, 15]; // land water arctic volcano desert forest
    const w = new Writer().u8(S2C.MINIMAP).u8(1);
    w.u16(1).u16(1).u16(f.width).u16(f.height).u16(f.width).u16(f.height).u16(1);
    w.u16(f.minimap.length);
    for (const r of f.minimap) w.u16(typeFor[r.biome] ?? 1).u16(r.biome).u8(1).u16(r.x).u16(r.y).u16(r.w).u16(r.h);
    this.send(w);
  }

  close() {
    if (this.lb) clearInterval(this.lb);
    this.despawn();
    const id = this.ws.data.serverId;
    this.world?.players.delete(this);
    released(id);
  }

  // ---- gameplay -------------------------------------------------------------
  private userId(): number | null {
    return sessionUsers.get(this.id) ?? null;
  }

  /** species/sub for an animal from the player's equipped wardrobe skin ("RANDOM" = default skin) */
  private skinFor(a: Animal): { species: number; sub: number } {
    const uid = this.userId();
    if (!uid) return { species: 0, sub: 0 };
    const equipped = equippedSkins(uid).get(a.id);
    if (!equipped || equipped === "RANDOM") return { species: 0, sub: 0 };
    const item = shopCatalog().find((i) => i.itemId === equipped);
    return { species: item?.animalSpecies ?? 0, sub: item?.animalSubSpecies ?? 0 };
  }

  spawn(name: string) {
    const world = this.world!;
    if (this.ent) return;
    const start = animalById(1) ?? loadAnimals()[0];
    const spot = world.randomSpot(start.biome);
    this.name = (name || "mope.io").slice(0, 15);
    this.xp = 0;
    this.kills = 0;
    this.maxXp = 0;
    this.bornAt = Date.now();
    this.attach(start, spot.x, spot.y, 2);
    world.players.add(this);
    this.send(new Writer().u8(S2C.ALIVE));
    this.camera(spot.x, spot.y, world.zoomFor(this.ent!.rad));
  }

  /** (re)create the player's entity as `a`; change: 2 = spawn, 1 = upgrade, 0 = downgrade */
  private attach(a: Animal, x: number, y: number, change: number) {
    const world = this.world!;
    const skin = this.skinFor(a);
    const old = this.ent;
    if (old) {
      world.remove(old);
      world.pendingRemovals.push({ id: old.id, killer: 0 });
    }
    const e = world.makeAnimal(a, x, y, this.name, skin.species, skin.sub);
    e.owner = this;
    world.add(e);
    this.ent = e;
    this.animal = a;
    this.menu = null;
    this.mouse = { x, y };
    this.sendAnimalChanged(change);
  }

  private sendAnimalChanged(change: number) {
    const a = this.animal!, e = this.ent!;
    const all = loadAnimals();
    const w = new Writer().u8(S2C.ANIMAL_CHANGED);
    w.u8(a.id).u8((e.species ?? 0) & 255).u16(e.sub ?? 0).u8(change).u8(a.tier);
    w.u32(e.id).u32(xpForTier(a.tier)).u16(0).u16(0);
    const danger = all.filter((x) => x.tier > a.tier).map((x) => x.id);
    const edible = all.filter((x) => x.tier < a.tier).map((x) => x.id);
    for (const list of [danger, [], edible.slice(0, 0), [...FOOD]]) {
      w.u8(list.length);
      for (const v of list) w.u8(v);
    }
    this.send(w);
  }

  private openMenu() {
    if (!this.animal || !this.ent) return;
    const choices = upgradeChoices(this.wantsMenu ? 0 : this.animal.tier, this.ent.biome, UPGRADE_MODE).filter((c) => c.id !== this.animal!.id);
    if (!choices.length) return;
    this.menu = choices;
    const w = new Writer().u8(S2C.UPGRADE_MENU).u8(0).u8(0).u8(0).u8(this.animal.tier).u8(Math.min(255, choices.length));
    for (const c of choices.slice(0, 255)) {
      const skin = this.skinFor(c);
      w.u8(1).u8(c.id).u8(c.biome).u8(skin.species & 255).u16(skin.sub).u8(0).u8(0).u8(1).str("null");
    }
    this.send(w);
  }

  onLevel() {
    this.wantsMenu = false;
    this.openMenu();
  }

  private choose(idx: number) {
    const pick = this.menu?.[idx];
    if (!pick || !this.ent) return;
    const prev = this.animal!;
    this.xp = Math.max(this.xp, xpForTier(pick.tier - 1));
    this.attach(pick, this.ent.x, this.ent.y, pick.tier >= prev.tier ? 1 : 0);
    this.world!.gain(this, 0);
  }

  onEaten(by: Entity | null) {
    const killer = by ? (by.owner as Session | undefined)?.name ?? "" : "";
    this.send(
      new Writer().u8(S2C.DEAD).u8(1).u32(by?.id ?? 0).str(killer).u16(1).str(this.name).u32(this.xp).u16(Math.min(65535, (Date.now() - this.bornAt) / 1000)).u32(this.maxXp).u8(Math.min(255, this.kills)),
    );
    this.ent = null;
    this.animal = null;
    this.menu = null;
    this.known.clear();
    this.world?.players.delete(this);
  }

  private despawn() {
    if (this.ent && this.world) {
      this.world.remove(this.ent);
      this.world.pendingRemovals.push({ id: this.ent.id, killer: 0 });
    }
    this.ent = null;
    this.known.clear();
  }

  private periodic() {
    const world = this.world;
    if (!world) return;
    this.send(new Writer().u8(S2C.PLAYERS_INFO).u16(world.players.size).u16(30));
    const top = world.leaderboard(10);
    const me = this.ent ? top.findIndex((p) => p === this) : -1;
    const w = new Writer().u8(8).u16(me >= 0 ? me + 1 : 0).str(this.name).u32(this.xp).u8(top.length);
    top.forEach((p, i) => w.u16(i + 1).str((p as Session).name).u32(p.xp));
    this.send(w);
  }

  // ---- inbound messages -------------------------------------------------------
  handle(r: Reader) {
    const type = r.u8();
    switch (type) {
      case C2S.HELLO:
        this.hello();
        break;
      case C2S.SPAWN: {
        const w = r.u16(), h = r.u16();
        this.view = { w: w || this.view.w, h: h || this.view.h };
        this.spawn(r.str());
        break;
      }
      case C2S.MOUSE:
        this.mouse = { x: r.i16(), y: r.i16() };
        break;
      case C2S.BOOST:
        this.boost = r.u8() === 1;
        break;
      case C2S.RESIZE:
        this.view = { w: r.u16() || this.view.w, h: r.u16() || this.view.h };
        break;
      case C2S.UPGRADE_CHOICE:
        this.choose(r.u8());
        break;
      case C2S_OPEN_MENU:
        this.wantsMenu = true;
        this.openMenu();
        break;
      case C2S.QUIT:
        this.despawn();
        this.world?.players.delete(this);
        break;
      case C2S.PING:
        this.send(new Writer().u8(S2C.PING));
        break;
      case C2S.LOGIN:
        if (r.u8() === 1) {
          const u = authenticate(r.str(), r.str());
          if (u) sessionUsers.set(this.id, u.id);
        }
        break;
    }
  }
}

export const gameWs = {
  open(ws: ServerWebSocket<WsData>) {
    if (!ws.data.ping) ws.data.session = new Session(ws);
  },
  message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
    if (typeof raw === "string") return;
    try {
      const r = new Reader(raw);
      if (ws.data.ping) {
        if (r.u8() === C2S.PING) ws.sendBinary(new Writer().u8(S2C.PING).bytes());
        return;
      }
      ws.data.session!.handle(r);
    } catch (e) {
      console.error("[game] bad packet", e);
    }
  },
  close(ws: ServerWebSocket<WsData>) {
    ws.data.session?.close();
  },
};
