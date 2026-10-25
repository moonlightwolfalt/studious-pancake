import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ORIGIN, SEED_PATHS, SITE } from "./config";

export interface MirrorEntry {
  path: string;
  status: number;
  bytes: number;
  type: string | null;
}

const ASSET_EXT =
  "png|jpe?g|gif|webp|svg|ico|mp3|ogg|wav|mp4|webm|json|css|js|html|woff2?|ttf|otf";

const IGNORED_HOSTS = [
  "google",
  "gstatic",
  "facebook",
  "apple",
  "cloudflare",
  "unpkg",
  "nitropay",
  "scorecardresearch",
  "googletagmanager",
  "discord",
  "xsolla",
  "adinplay",
  "crazygames",
  "wackagames",
  "reddit",
  "fandom",
  "vexxusarts",
  "mope.io/privacy",
];

/** Local path for a URL on the mope origin, or null if it should be skipped. */
function normalise(ref: string, base: string): string | null {
  ref = ref.trim();
  if (!ref || ref.startsWith("data:") || ref.startsWith("#") || ref.startsWith("javascript:")) return null;
  let url: URL;
  try {
    url = new URL(ref, ORIGIN + base);
  } catch {
    return null;
  }
  const origin = new URL(ORIGIN);
  if (url.host !== origin.host) {
    if (url.host === "mope.io" || url.host.endsWith(".mope.io")) {
      // same product, other subdomain – only pull static assets
    } else return null;
  }
  if (IGNORED_HOSTS.some((h) => url.host.includes(h))) return null;
  let p = url.pathname;
  if (p.includes("..") || p.startsWith("/cdn-cgi/") || p.startsWith("/privacy")) return null;
  if (p.endsWith("/")) p += "index.html";
  return p;
}

export function extractRefs(text: string, basePath: string): Set<string> {
  const out = new Set<string>();
  const add = (r: string) => {
    const p = normalise(r, basePath);
    if (p) out.add(p);
  };
  for (const m of text.matchAll(/(?:src|href)\s*=\s*["']([^"'>]+)["']/gi)) add(m[1]);
  for (const m of text.matchAll(/url\(\s*["']?([^)"']+)["']?\s*\)/gi)) add(m[1]);
  // string literals that look like asset paths (client.js after deobfuscation)
  const lit = new RegExp(`["'\`]((?:\\.{0,2}/)?[A-Za-z0-9_@%./+-]+\\.(?:${ASSET_EXT}))(?:\\?[^"'\`]*)?["'\`]`, "g");
  for (const m of text.matchAll(lit)) {
    const s = m[1];
    // skip fragments like ".png" / "/0.png" (those are concatenated at runtime)
    if (s.startsWith(".") && !s.startsWith("./") && !s.startsWith("../")) continue;
    if (/^\/?[^/]*\.[a-z0-9]+$/i.test(s) && s.startsWith("/")) continue;
    add(s);
  }
  return out;
}

async function download(path: string, retries = 3): Promise<MirrorEntry> {
  const url = ORIGIN + path;
  let last: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (mopeio-re)" } });
      if (!res.ok) return { path, status: res.status, bytes: 0, type: res.headers.get("content-type") };
      const buf = new Uint8Array(await res.arrayBuffer());
      const file = join(SITE, path === "/" ? "index.html" : path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, buf);
      return { path, status: res.status, bytes: buf.length, type: res.headers.get("content-type") };
    } catch (e) {
      last = e;
      await Bun.sleep(300 * (i + 1));
    }
  }
  return { path, status: 0, bytes: 0, type: String(last) };
}

/** Crawl v1.mope.io and mirror everything reachable into work/site. */
export async function fetchSite(
  opts: { concurrency?: number; log?: (s: string) => void; extraTexts?: { text: string; base: string }[] } = {},
) {
  const log = opts.log ?? console.log;
  const concurrency = opts.concurrency ?? 16;
  const seen = new Map<string, MirrorEntry>();
  const queue: string[] = [...SEED_PATHS];
  const queued = new Set(queue);
  for (const { text, base } of opts.extraTexts ?? []) {
    for (const r of extractRefs(text, base)) {
      if (!queued.has(r)) {
        queued.add(r);
        queue.push(r);
      }
    }
  }
  let active = 0;

  await new Promise<void>((resolve) => {
    const pump = () => {
      while (active < concurrency && queue.length) {
        const p = queue.shift()!;
        active++;
        download(p)
          .then(async (entry) => {
            seen.set(p, entry);
            if (entry.status === 200) {
              if (/\.(html?|css|js)$/i.test(p) || p === "/") {
                const text = await Bun.file(join(SITE, p === "/" ? "index.html" : p)).text();
                for (const r of extractRefs(text, p)) {
                  if (!queued.has(r)) {
                    queued.add(r);
                    queue.push(r);
                  }
                }
              }
              log(`  ok   ${p} (${entry.bytes}b)`);
            } else if (entry.status !== 404) {
              log(`  ${entry.status || "ERR"} ${p}`);
            }
          })
          .finally(() => {
            active--;
            if (!queue.length && !active) resolve();
            else pump();
          });
      }
      if (!queue.length && !active) resolve();
    };
    pump();
  });

  const entries = [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
  await writeFile(join(SITE, "_manifest.json"), JSON.stringify(entries, null, 1));
  const ok = entries.filter((e) => e.status === 200).length;
  log(`mirrored ${ok}/${entries.length} files into ${SITE}`);
  return entries;
}
