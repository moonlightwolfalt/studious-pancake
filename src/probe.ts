import { join } from "node:path";
import { DATA, ROOT } from "./config";
import { serve } from "./serve";
import { writeCatalog, type AnimalDef } from "./shopgen";

/** Boot the stack on a spare port, let headless Chromium read the client's tables, write data/*.json. */
export async function runProbe(log: (s: string) => void = console.log) {
  const server = await serve({ port: 0, quiet: true });
  const base = `http://localhost:${server.port}`;
  log(`probing client at ${base} (headless chromium) ...`);
  const proc = Bun.spawn(["node", join(ROOT, "tools/probe.cjs"), base, DATA], {
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  const code = await proc.exited;
  server.stop(true);
  if (code !== 0) throw new Error(`probe exited with ${code}`);
  const animals = JSON.parse(await Bun.file(join(DATA, "animals.json")).text()) as AnimalDef[];
  const items = await writeCatalog(animals);
  log(`shop catalog: ${items.length} items -> data/shop-catalog.json`);
}
