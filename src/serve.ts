import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { DECODED, DIST, ORIGIN, PORT, WORK } from "./config";
import { handleAccounts } from "./servers/accounts";
import { gameWs, playerCount, type WsData } from "./servers/game";
import { buildServerList, publicList, type ServerEntry } from "./servers/master";

const CACHE = join(WORK, "cache");

async function baseServers() {
  const env = JSON.parse(await Bun.file(join(DECODED, "env.json")).text());
  return env.config.gameServers as { id: string; name: string; region: string; gm: number }[];
}

export async function serve(opts: { port?: number; quiet?: boolean } = {}) {
  const servers: ServerEntry[] = buildServerList(await baseServers());
  const byId = new Map(servers.map((s) => [s.id, s]));
  const serverStats = () => servers.map((s) => ({ id: s.id, totalPlayerCount: playerCount(s.id) }));

  const server = Bun.serve<WsData>({
    port: opts.port ?? PORT,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path.startsWith("/gs/")) {
        const [, , id, tail] = path.split("/");
        if (!byId.has(id)) return new Response("unknown game server", { status: 404 });
        if (srv.upgrade(req, { data: { serverId: id, ping: tail === "ping" } })) return;
        return new Response("websocket expected", { status: 426 });
      }
      if (path === "/master/servers") {
        return Response.json(publicList(servers, url.host), { headers: { "cache-control": "no-store" } });
      }
      if (path.startsWith("/accounts/")) {
        const res = await handleAccounts(req, path.slice("/accounts".length), { serverStats });
        res.headers.set("access-control-allow-origin", "*");
        return res;
      }
      return staticFile(path);
    },
    websocket: gameWs,
  });
  if (!opts.quiet) console.log(`mope.io local stack on http://localhost:${server.port}  (${servers.length} game servers)`);
  return server;
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".json": "application/json",
};

async function staticFile(path: string): Promise<Response> {
  if (path === "/") path = "/index.html";
  const rel = normalize(path).replace(/^(\.\.[/\\])+/, "");
  for (const root of [DIST, CACHE]) {
    const f = join(root, rel);
    if (f.startsWith(root) && existsSync(f) && (await Bun.file(f).exists())) {
      return new Response(Bun.file(f), { headers: { "cache-control": "no-cache" } });
    }
  }
  // read-through: assets are assembled at runtime by the client, so pull
  // anything we don't have yet from the real site and keep a copy
  const up = await fetch(ORIGIN + path).catch(() => null);
  if (!up || !up.ok) return new Response("not found", { status: 404 });
  const buf = new Uint8Array(await up.arrayBuffer());
  const f = join(CACHE, rel);
  await mkdir(dirname(f), { recursive: true });
  await writeFile(f, buf);
  return new Response(buf, { headers: { "content-type": up.headers.get("content-type") ?? MIME[extname(f)] ?? "application/octet-stream" } });
}
