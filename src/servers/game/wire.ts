import { Writer } from "../protocol";
import { ANIMAL_FLAGS, type Entity, PROP } from "./entities";

/** types whose records carry a secondary type id (animalType) – see _0x4f466c in the client */
const HAS_SECONDARY = new Set([2]);

const deg2 = (a: number) => Math.round((((a % 360) + 360) % 360) / 2) & 0xff;
const angleWire = (a: number) => Math.round((((a % 360) + 360) % 360) * 182) & 0xffff;

function animalFlagBits(e: Entity): boolean[] {
  const bits = ANIMAL_FLAGS.map((f) => !!e.flags?.has(f));
  // client reads an extra bool right after isDevMode when it is set
  if (e.flags?.has("isDevMode")) bits.splice(ANIMAL_FLAGS.indexOf("isDevMode") + 1, 0, false);
  // trim trailing false so the group stays short (missing flags read as false)
  while (bits.length > 1 && !bits[bits.length - 1]) bits.pop();
  return bits;
}

/** worldUpd_readMsgNewlyVisible */
export function writeNewlyVisible(w: Writer, e: Entity) {
  w.u16(e.type);
  if (HAS_SECONDARY.has(e.type)) w.u16(e.animalType ?? 0);
  w.u32(e.id).u32(e.rad * 4).u16(e.x * 4).u16(e.y * 4).u8(e.biome);
  if (e.type !== 2) w.u8(e.season ?? 1).u16(0).u16(0).u16(0);
  w.bits([false, false, true, false]); // hasSpawner, isRect, objGetsAngleUpdate, clientBatchDraw
  w.u8(deg2(e.angle));
  w.u8(e.spec).u8(e.spec2);
  if (e.kind === "animal") {
    w.str(e.nick ?? "").u16(e.species ?? 0).u16(e.sub ?? 0).u8(e.premium ?? 0).u8(e.theme ?? 0).u8(e.season ?? 1).u8(e.vip ?? 0);
    w.bits(animalFlagBits(e));
    if (e.flags?.has("webStuck")) w.u8(0);
    if (e.flags?.has("isInArena")) w.u8(0);
    if (e.flags?.has("isDevMode")) w.u8(0);
    w.u16(0); // wins1v1
    w.u8(0); // teamID
  } else if (e.type === 101) {
    w.u16(0).u8(1).u8(0); // tree: foodType, canopy, eventType
  } else if (e.type === 5 || e.type === 9 || e.type === 13) {
    w.u16((e.innerRad ?? e.rad * 0.8) * 4);
  }
}

export interface Snapshot {
  x: number;
  y: number;
  rad: number;
  angle: number;
  hp: number;
  flags: string;
}

export function snapshot(e: Entity): Snapshot {
  return { x: e.x, y: e.y, rad: e.rad, angle: e.angle, hp: e.hp, flags: e.flags ? [...e.flags].join(",") : "" };
}

/** worldUpd_readMsgUpdate; returns false when nothing changed (caller skips the record). */
export function writeUpdate(w: Writer, e: Entity, prev: Snapshot): boolean {
  const props: (() => void)[] = [];
  if (Math.abs(prev.x - e.x) >= 0.25 || Math.abs(prev.y - e.y) >= 0.25) props.push(() => w.u16(PROP.POS).u16(e.x * 4).u16(e.y * 4));
  if (Math.abs(prev.rad - e.rad) >= 0.1) props.push(() => w.u16(PROP.RAD).u16(e.rad * 10));
  if (Math.abs(prev.angle - e.angle) >= 1) props.push(() => w.u16(PROP.ANGLE).u16(angleWire(e.angle)));
  if (prev.hp !== e.hp) props.push(() => w.u16(PROP.HP).u8(e.hp));
  const flagsNow = e.flags ? [...e.flags].join(",") : "";
  if (!props.length && flagsNow === prev.flags) return false;
  w.u32(e.id);
  if (e.kind === "animal") w.bits(animalFlagBits(e));
  else w.bits([false, false]);
  w.u8(props.length);
  for (const p of props) p();
  return true;
}

export function writeRemoved(w: Writer, id: number, killerId = 0) {
  w.u32(id);
  if (killerId) w.u8(1).u32(killerId);
  else w.u8(0);
}
