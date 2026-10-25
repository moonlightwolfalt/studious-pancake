import { SQL } from "bun";
import { readFile, writeFile } from "node:fs/promises";

/**
 * Account data lives in SQLite. On hosts without a persistent disk (free tiers) the container's
 * file system is wiped on every deploy, so the whole (small) database is snapshotted to an external
 * store and restored at startup:
 *   DATABASE_URL=postgres://...   Postgres (Neon / Supabase / Render / Railway all have free tiers)
 *   MOPE_SNAPSHOT_FILE=/path      a plain file (for tests, or a mounted volume)
 */
export interface SnapshotStore {
  readonly name: string;
  init(): Promise<void>;
  load(): Promise<Uint8Array | null>;
  save(bytes: Uint8Array): Promise<void>;
}

class PostgresStore implements SnapshotStore {
  readonly name = "postgres";
  private sql: SQL;
  constructor(url: string) {
    this.sql = new SQL(url);
  }
  async init() {
    await this.sql`CREATE TABLE IF NOT EXISTS mope_snapshot (id integer PRIMARY KEY, data text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`;
  }
  async load() {
    const rows = await this.sql`SELECT data FROM mope_snapshot WHERE id = 1`;
    return rows.length ? new Uint8Array(Buffer.from(rows[0].data as string, "base64")) : null;
  }
  async save(bytes: Uint8Array) {
    const data = Buffer.from(bytes).toString("base64");
    await this.sql`INSERT INTO mope_snapshot (id, data, updated_at) VALUES (1, ${data}, now())
                   ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`;
  }
}

class FileStore implements SnapshotStore {
  readonly name = "file";
  constructor(private path: string) {}
  async init() {}
  async load() {
    try {
      return new Uint8Array(await readFile(this.path));
    } catch {
      return null;
    }
  }
  async save(bytes: Uint8Array) {
    await writeFile(this.path, bytes);
  }
}

export function chooseStore(): SnapshotStore | null {
  if (process.env.DATABASE_URL) return new PostgresStore(process.env.DATABASE_URL);
  if (process.env.MOPE_SNAPSHOT_FILE) return new FileStore(process.env.MOPE_SNAPSHOT_FILE);
  return null;
}

/** Save the database now and then (only when it changed), and once more on shutdown. */
export function startSnapshots(serialize: () => Uint8Array, store: SnapshotStore, log = console.log) {
  const every = Number(process.env.MOPE_SNAPSHOT_INTERVAL_MS ?? 20_000);
  let last = 0n;
  let busy = false;
  const flush = async (force = false) => {
    if (busy) return;
    busy = true;
    try {
      const bytes = serialize();
      const h = BigInt(Bun.hash(bytes));
      if (force || h !== last) {
        await store.save(bytes);
        last = h;
      }
    } catch (e) {
      log(`[persist] ${store.name} snapshot failed:`, (e as Error).message);
    } finally {
      busy = false;
    }
  };
  setInterval(() => void flush(), every).unref();
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, async () => {
      await flush(true);
      process.exit(0);
    });
  }
  return flush;
}
