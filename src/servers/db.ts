import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DB_DIR } from "../config";

mkdirSync(DB_DIR, { recursive: true });
export const db = new Database(join(DB_DIR, "accounts.sqlite"), { create: true });
db.run("PRAGMA journal_mode = WAL");
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
