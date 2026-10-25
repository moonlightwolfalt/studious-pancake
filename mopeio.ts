#!/usr/bin/env bun
import { join } from "node:path";
import { ROOT } from "./src/config";
import { runDeobfuscation } from "./src/deobfuscate";
import { fetchSite } from "./src/fetch";
import { buildDist } from "./src/patch";
import { runProbe } from "./src/probe";
import { writeNamed } from "./src/rename";
import { serve } from "./src/serve";

const run = (cmd: string[]) => Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", cwd: ROOT }).exited;

async function genWorld(seed = "1337") {
  if ((await run(["node", join(ROOT, "tools/genworld.mjs"), seed])) !== 0) throw new Error("world generation failed");
}

const cmd = process.argv[2] ?? "help";
switch (cmd) {
  case "fetch":
    await fetchSite();
    break;
  case "deobf": {
    const { pretty } = await runDeobfuscation();
    await writeNamed();
    // second crawl pass: asset paths only become visible after deobfuscation
    await fetchSite({ extraTexts: [{ text: pretty, base: "/client.js" }] });
    break;
  }
  case "patch":
    await buildDist();
    break;
  case "build": // what the Docker image runs: everything except probe/serve (generated data is committed)
    await fetchSite();
    {
      const { pretty } = await runDeobfuscation();
      await writeNamed();
      await fetchSite({ extraTexts: [{ text: pretty, base: "/client.js" }] });
    }
    await buildDist();
    break;
  case "world":
    await genWorld(process.argv[3]);
    break;
  case "probe":
    await runProbe();
    break;
  case "serve":
    await serve();
    break;
  case "all": // everything, then serve
    await fetchSite();
    {
      const { pretty } = await runDeobfuscation();
      await writeNamed();
      await fetchSite({ extraTexts: [{ text: pretty, base: "/client.js" }] });
    }
    await buildDist();
    await runProbe();
    await genWorld();
    await serve();
    break;
  default:
    console.log(`usage: bun mopeio.ts <command>
  fetch   mirror v1.mope.io into work/site
  deobf   deobfuscate + prettify client.js, decode \$config, rename known identifiers, crawl decoded assets
  patch   apply client patches -> work/dist
  world   generate data/world.json  [seed]
  probe   read animal/skin tables from the client -> data/animals.json, data/shop-catalog.json
  serve   run master + accounts + game servers + static site on :8080
  build   fetch + deobf + patch (no probe/serve) – used by the Docker build
  all     run every step above, then serve`);
}
