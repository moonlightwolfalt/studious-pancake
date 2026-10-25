/**
 * Binary wire format of the mope.io client (big endian).
 *
 *  string   u16 length (utf-8 bytes + 1) | bytes | 0x00     <- the client's
 *           reader drops the final byte of every string it reads, so server
 *           strings carry an explicit NUL terminator. The client's own writer
 *           does NOT add one (length = byte count).
 *  bitgroup N bytes; bit0 = "another byte follows", bits 1..7 = flags in order
 */
export class Writer {
  private chunks: number[] = [];

  u8(v: number) {
    this.chunks.push(v & 0xff);
    return this;
  }
  u16(v: number) {
    v = Math.max(0, Math.min(0xffff, Math.round(v)));
    this.chunks.push(v >> 8, v & 0xff);
    return this;
  }
  i16(v: number) {
    return this.u16(v & 0xffff);
  }
  u32(v: number) {
    v = Math.max(0, Math.min(0xffffffff, Math.round(v))) >>> 0;
    this.chunks.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    return this;
  }
  str(s: string) {
    const b = new TextEncoder().encode(s);
    this.u16(b.length + 1);
    for (const x of b) this.chunks.push(x);
    this.chunks.push(0);
    return this;
  }
  /** Pack booleans into the client's bit-group encoding. */
  bits(flags: boolean[]) {
    const nBytes = Math.max(1, Math.ceil(flags.length / 7));
    for (let b = 0; b < nBytes; b++) {
      let byte = b < nBytes - 1 ? 1 : 0; // bit0: more bytes follow
      for (let i = 0; i < 7; i++) if (flags[b * 7 + i]) byte |= 1 << (i + 1);
      this.chunks.push(byte);
    }
    return this;
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
  get length() {
    return this.chunks.length;
  }
}

export class Reader {
  private dv: DataView;
  off = 0;
  constructor(buf: ArrayBuffer | Uint8Array) {
    const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  }
  get remaining() {
    return this.dv.byteLength - this.off;
  }
  u8() {
    return this.dv.getUint8(this.off++);
  }
  u16() {
    const v = this.dv.getUint16(this.off);
    this.off += 2;
    return v;
  }
  i16() {
    const v = this.dv.getInt16(this.off);
    this.off += 2;
    return v;
  }
  u32() {
    const v = this.dv.getUint32(this.off);
    this.off += 4;
    return v;
  }
  /** Client-written string: length-prefixed, no terminator. */
  str() {
    const n = this.u16();
    const b = new Uint8Array(this.dv.buffer, this.dv.byteOffset + this.off, Math.min(n, this.remaining));
    this.off += b.length;
    return new TextDecoder().decode(b);
  }
}

/** Client -> server message ids. */
export const C2S = {
  HELLO: 1,
  MOUSE: 5, // i16 x, i16 y (screen-relative)
  QUIT: 11,
  RESIZE: 17,
  CHAT: 19,
  ABILITY_A: 20, // u8 down
  BOOST: 21, // u8 down
  UPGRADE_CHOICE: 24, // u8 choice index
  WATER: 28,
  LOGIN: 71, // u8 loggedIn [str userId, str token]
  SPAWN: 113, // u16 w, u16 h, str nickname
  PING: 255,
} as const;

/** Server -> client message ids. */
export const S2C = {
  SESSION: 2,
  READY: 3,
  WORLD_UPDATE: 4,
  ALIVE: 6,
  PLAYERS_INFO: 10,
  DEAD: 14,
  CAMERA: 17,
  ANIMAL_CHANGED: 18,
  UPGRADE_MENU: 24,
  MINIMAP: 107,
  PING: 255,
} as const;
