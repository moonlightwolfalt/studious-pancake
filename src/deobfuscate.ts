import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import * as prettier from "prettier";
import { webcrack } from "webcrack";
import { DECODED, SITE } from "./config";

const prettierOpts: prettier.Options = { parser: "babel", printWidth: 120, tabWidth: 2 };

export async function prettify(code: string): Promise<string> {
  return prettier.format(code, prettierOpts);
}

/**
 * client.js is obfuscator.io output (rotated string array, hex escapes,
 * control-flow wrappers, self-defending regex checks). webcrack inlines the
 * string array / proxies and strips the self-defence; we then run prettier.
 */
export async function deobfuscate(code: string): Promise<string> {
  const res = await webcrack(code, { mangle: false, unpack: false, jsx: false, deobfuscate: true });
  return res.code;
}

/** Evaluate a (side-effect free) object literal AST node into JSON. */
function literalToJs(node: any): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const o: Record<string, unknown> = {};
      for (const p of node.properties) {
        if (p.type !== "ObjectProperty") continue;
        const key = p.key.type === "Identifier" ? p.key.name : p.key.value;
        o[key] = literalToJs(p.value);
      }
      return o;
    }
    case "ArrayExpression":
      return node.elements.map(literalToJs);
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
      return node.value;
    case "NullLiteral":
      return null;
    case "UnaryExpression":
      if (node.operator === "!" && node.argument.type === "NumericLiteral") return !node.argument.value;
      if (node.operator === "-") return -(literalToJs(node.argument) as number);
      return undefined;
    case "TemplateLiteral":
      return node.quasis.map((q: any) => q.value.cooked).join("");
    default:
      return undefined;
  }
}

/** Pull `$config = {...}` (the "environment") out of decoded source. */
export function extractConfig(decoded: string): Record<string, any> | null {
  const start = decoded.indexOf("$config");
  const end = decoded.indexOf("\n};", start);
  if (start < 0 || end < 0) return null;
  const ast = parse(decoded.slice(start, end + 3), { sourceType: "script" });
  let cfg: any = null;
  traverse(ast, {
    AssignmentExpression(path) {
      const l = path.node.left;
      if (l.type === "Identifier" && l.name === "$config" && path.node.right.type === "ObjectExpression") {
        cfg = literalToJs(path.node.right);
        path.stop();
      }
    },
  });
  return cfg;
}

/** Decode `\xNN` / `\uNNNN` escapes in any string, for html inline scripts etc. */
export function decodeEscapes(s: string): string {
  return s
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export interface EnvReport {
  config: Record<string, any> | null;
  accountServer: string | null;
  platformEnv: string[];
  localStorageKeys: string[];
  externalHosts: string[];
  constants: Record<string, string>;
}

/** Collect every environment-like value the client carries. */
export function scanEnvironment(decoded: string, html: string): EnvReport {
  const config = extractConfig(decoded);
  const accountServer = decoded.match(/https:\/\/prod-accounts\.[a-z0-9.-]+/)?.[0] ?? null;
  const uniq = (re: RegExp, src: string, g = 1) => [...new Set([...src.matchAll(re)].map((m) => m[g]))].sort();
  const externalHosts = uniq(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi, decoded + html);
  const platformEnv = uniq(/PLATFORM_ENV\s*(?:===?|!==?)\s*"([^"]+)"/g, decoded);
  const localStorageKeys = uniq(/localStorage\.(?:get|set|remove)Item\(\s*"([^"]+)"/g, decoded);
  const constants: Record<string, string> = {};
  for (const m of decoded.matchAll(/\b(isTestingMode|isBetaMode|isProduction|useDevAccountServer|gameVersion|env)\s*:\s*([^,\n]+)/g))
    constants[m[1]] = m[2].trim();
  return { config, accountServer, platformEnv, localStorageKeys, externalHosts, constants };
}

export async function runDeobfuscation(log: (s: string) => void = console.log) {
  await mkdir(DECODED, { recursive: true });
  const raw = await Bun.file(join(SITE, "client.js")).text();
  log(`client.js: ${raw.length} bytes`);

  log("prettifying raw client.js ...");
  await writeFile(join(DECODED, "client.pretty.js"), await prettify(raw));

  log("deobfuscating (webcrack) ...");
  const t0 = performance.now();
  const decoded = await deobfuscate(raw);
  log(`  webcrack finished in ${((performance.now() - t0) / 1000).toFixed(1)}s -> ${decoded.length} bytes`);
  const pretty = await prettify(decoded);
  await writeFile(join(DECODED, "client.deobf.js"), pretty);

  const html = await Bun.file(join(SITE, "index.html")).text();
  const report = scanEnvironment(pretty, html);
  await writeFile(join(DECODED, "env.json"), JSON.stringify(report, null, 2));
  log(`decoded environment: ${Object.keys(report.config ?? {}).length} config keys, ${report.externalHosts.length} external hosts`);
  return { pretty, report };
}
