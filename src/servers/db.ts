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
const store = chooseStore();
let database: Database;
if (store) {
  await store.init();
  const snap = await store.load();
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
