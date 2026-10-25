import type { ServerWebSocket } from "bun";
import { C2S, Reader, S2C, Writer } from "./protocol";

export interface WsData {
  serverId: string;
  ping: boolean;
  session?: Session;
}

export class Session {
  constructor(public ws: ServerWebSocket<WsData>) {}
  send(w: Writer) {
    this.ws.sendBinary(w.bytes());
  }
}

export const gameWs = {
  open(ws: ServerWebSocket<WsData>) {
    if (!ws.data.ping) ws.data.session = new Session(ws);
  },
  message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
    if (typeof raw === "string") return;
    const r = new Reader(raw);
    const type = r.u8();
    if (ws.data.ping) {
      if (type === C2S.PING) ws.sendBinary(new Writer().u8(S2C.PING).bytes());
      return;
    }
    const s = ws.data.session!;
    if (type === C2S.HELLO) {
      s.send(new Writer().u8(S2C.SESSION).str("local").u8(0).u8(1).str(ws.data.serverId).u8(0).u16(0));
      s.send(new Writer().u8(S2C.READY));
    }
  },
  close(_ws: ServerWebSocket<WsData>) {},
};
