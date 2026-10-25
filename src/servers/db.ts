import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DB_DIR } from "../config";
import { chooseStore, startSnapshots } from "./persist";

/**
 * Two modes:
 *  - default: a SQLite file in DB_DIR (use a persistent disk in production)
 *  - DATABASE_URL / MOPE_SNAPSHOT_FILE set: SQLite runs in memory, restored from and snapshotted to
 *    that external store, so accounts survive redeploys on hosts without a disk (see persist.ts)
 */
const withTimeout = <T>(p: Promise<T>, what: string): Promise<T> => {
  const ms = Number(process.env.MOPE_DB_TIMEOUT_MS ?? 15_000);
  return Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms))]);
};

function hint(msg: string): string {
  if (/ENOTFOUND|ENETUNREACH|EHOSTUNREACH|EAFNOSUPPORT|timed out/i.test(msg))
    return "The host can't be reached from here. On Supabase use the Session pooler string (not Direct, which is IPv6-only).";
  if (/password|authentication|28P01|SASL/i.test(msg)) return "Wrong user or password. Encode special characters in the password (@ -> %40, # -> %23, / -> %2F).";
  if (/prepared statement|pgbouncer|transaction/i.test(msg)) return "Use the Session pooler (port 5432), not the Transaction pooler (port 6543).";
  if (/Invalid URL|invalid connection/i.test(msg)) return "DATABASE_URL is not a valid postgres:// URL.";
  if (/ssl|tls|certificate/i.test(msg)) return "TLS problem: try DATABASE_SSL=off (local servers) or DATABASE_SSL=verify.";
  return "";
}

/**
 * A database problem must never stop the game from starting. If the store can't be reached we run on a
 * local SQLite file instead, say why in the log, and do NOT snapshot: saving an empty database over the
 * real snapshot would destroy it.
 */
let store = null as ReturnType<typeof chooseStore>;
let snap: Uint8Array | null = null;
let persistent = false;
try {
  store = chooseStore();
  if (store) {
    await withTimeout(store.init(), "database connection");
    snap = await withTimeout(store.load(), "loading the snapshot");
    persistent = true;
  }
} catch (e) {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  console.error(`[db] !! could not use the external database: ${msg}`);
  const h = hint(msg);
  if (h) console.error(`[db] !! hint: ${h}`);
  console.error("[db] !! continuing WITHOUT persistence: accounts will be lost on restart until this is fixed");
}

let database: Database;
if (store && persistent) {
  database = snap ? Database.deserialize(snap) : new Database(":memory:");
  console.log(`[db] ${store.name} persistence: ${snap ? `restored ${(snap.byteLength / 1024).toFixed(0)} KB` : "no snapshot yet, starting empty"}`);
  startSnapshots(() => database.serialize(), store);
} else {
  mkdirSync(DB_DIR, { recursive: true });
  database = new Database(join(DB_DIR, "accounts.sqlite"), { create: true });
  database.run("PRAGMA journal_mode = WAL");
}
export const db = database;

db.run(`CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  username    TEXT NOT NULL,
  pass_hash   TEXT NOT NULL,
  token       TEXT NOT NULL,
  coins       INTEGER NOT NULL DEFAULT 100000,
  gems        INTEGER NOT NULL DEFAULT 1000,
  level       INTEGER NOT NULL DEFAULT 1,
  xp          INTEGER NOT NULL DEFAULT 0,
  vip         INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
)`);
db.run(`CREATE TABLE IF NOT EXISTS purchases (
  user_id INTEGER NOT NULL, item_id TEXT NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
)`);
db.run(`CREATE TABLE IF NOT EXISTS wardrobe (
  user_id INTEGER NOT NULL, animal_type INTEGER NOT NULL, equipped TEXT NOT NULL,
  PRIMARY KEY (user_id, animal_type)
)`);
