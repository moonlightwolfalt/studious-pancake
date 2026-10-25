#!/usr/bin/env bun
import { runDeobfuscation } from "./src/deobfuscate";
import { fetchSite } from "./src/fetch";
import { buildDist } from "./src/patch";
import { runProbe } from "./src/probe";
import { serve } from "./src/serve";

const cmd = process.argv[2] ?? "help";
switch (cmd) {
  case "fetch":
    await fetchSite();
    break;
  case "deobf":
    await runDeobfuscation();
    break;
  case "patch":
    await buildDist();
    break;
  case "probe":
    await runProbe();
    break;
  case "serve":
    await serve();
    break;
  default:
    console.log("usage: bun mopeio.ts <fetch|deobf|patch|serve>");
}
