import { join } from "node:path";

export const ORIGIN = "https://v1.mope.io";
export const ROOT = join(import.meta.dir, "..");
export const WORK = join(ROOT, "work");
export const SITE = join(WORK, "site"); // raw mirror of v1.mope.io
export const DECODED = join(WORK, "decoded"); // deobfuscation output
export const DIST = join(WORK, "dist"); // patched, ready to serve
export const DATA = join(ROOT, "data"); // sqlite db etc (gitignored)

export const PORT = Number(process.env.PORT ?? 8080);

/** Files the HTML/JS always needs, even if crawling misses them. */
export const SEED_PATHS = [
  "/",
  "/client.js",
  "/main_nerged.css",
  "/jquery_3_3_1.js",
  "/updates.html",
  "/updates.json",
  "/favicon.ico",
  "/adblockdet/ads.js",
  "/dfp.js",
  "/ui_build/static/css/main.css",
];
