import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DECODED, DIST, ROOT, SITE } from "./config";

export interface PatchReport {
  name: string;
  applied: boolean;
  note?: string;
}

type Patch = {
  name: string;
  /** missing anchor aborts the build when true */
  required?: boolean;
  apply: (code: string) => string;
};

/** Replace `re` once; returns the new source or the same string if it did not match. */
function sub(code: string, re: RegExp, to: string | ((...m: string[]) => string)): string {
  return code.replace(re, to as any);
}

/** Find the bracket-balanced `[...]` that starts at `open`. */
function balanced(code: string, open: number, o = "[", c = "]"): number {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") inStr = ch;
    else if (ch === o) depth++;
    else if (ch === c && --depth === 0) return i;
  }
  throw new Error("unbalanced");
}

export const clientPatches: Patch[] = [
  {
    // Anti-tamper traps: `while (true) {}` hidden behind `... === this` checks,
    // a stray `debugger`, and a timer that evals `server = null`.
    name: "strip-anti-tamper",
    apply(code) {
      code = sub(code, /while \(true\) \{\s*(?:console\.log\([^)]*\);\s*)?\}/g, "/* [mopeio-re] anti-tamper loop removed */");
      code = sub(code, /^\s*debugger;\s*$/gm, "");
      code = sub(
        code,
        /eval\((\w+) \+ (\w+) \+ (\w+) \+ (\w+) \+ \2 \+ \3 \+ " = null"\)/g,
        "void 0 /* [mopeio-re] eval('server = null') removed */",
      );
      return code;
    },
  },
  {
    // The "master server": replace the static list with the local master.
    name: "master-server-list",
    required: true,
    apply(code) {
      const key = "gameServers: [";
      const at = code.indexOf(key);
      if (at < 0) throw new Error("gameServers not found");
      const open = at + key.length - 1;
      const close = balanced(code, open);
      return code.slice(0, at) + "gameServers: window.__mopeLoadServers()" + code.slice(close + 1);
    },
  },
  {
    // Google sign-in: swap mope.io's OAuth client id for yours (GOOGLE_CLIENT_ID)
    name: "google-client-id",
    apply(code) {
      const id = process.env.GOOGLE_CLIENT_ID;
      if (!id) return code;
      return code.replace(/(google: ")[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com(")/, `$1${id}$2`);
    },
  },
  {
    // Account server -> same origin, /accounts prefix.
    name: "account-server-url",
    required: true,
    apply(code) {
      const re = /(let \w+ = )"https:\/\/prod-accounts\.[a-z0-9.-]+";/;
      if (!re.test(code)) throw new Error("account server url not found");
      return sub(code, re, `$1location.origin + "/accounts";`);
    },
  },
  {
    // Upgrade menu: the canvas grid is hard-wired to 7 buttons per row. With every
    // animal on offer (100+), grow the row length and shrink the buttons to fit.
    name: "upgrade-menu-all-animals",
    required: true,
    apply(code) {
      // rows are now wider than the 8-key hotkey table: tolerate missing keys
      code = code.replace(
        /setHotKey\((\w+)\[(\w+) - 1\]\[(\w+)\]\.toUpperCase\(\)\)/g,
        'setHotKey((($1[$2 - 1] || [])[$3] || " ").toUpperCase())',
      );
      const re =
        /(var (\w+) = 150;[\s\S]{0,600}?var (\w+) = (\w+) \* (\w+);\s*var \w+ = 10;\s*var \w+ = \3 \+ 20;\s*)var (\w+) = 7;/;
      const m = code.match(re);
      if (!m) throw new Error("upgrade menu layout not found");
      const [, head, , size, , , perRow] = m;
      // the choices array is the identifier compared against `.length > perRow + 1` just below
      const arr = code.match(new RegExp(`var \\w+ = Math\\.max\\(0, (\\w+)\\.length\\);\\s*if \\(\\1\\.length > ${perRow} \\+ 1\\)`))?.[1];
      if (!arr) throw new Error("choices array not found");
      return code.replace(
        re,
        `${head}var ${perRow} = Math.min(18, Math.max(7, Math.ceil(Math.sqrt(${arr}.length * 1.7))));\n` +
          `          if (${arr}.length > 8) { ${size} = Math.min(${size}, _mopeFit(${arr}.length, ${perRow})); }`,
      );
    },
  },
  {
    // Direct eval inside the closure lets tooling (and the dev console) reach
    // every obfuscated binding: __mopeEval("_0x26aaf1").
    name: "expose-internals",
    required: true,
    apply(code) {
      const tail = /\n  \},\n\};\na0_0x5035d2\.run\(\);\s*$/;
      if (!tail.test(code)) throw new Error("run() tail not found");
      return sub(
        code,
        tail,
        `\n    window.__mopeEval = function (s) { return eval(s); };\n  },\n};\na0_0x5035d2.run();\n`,
      );
    },
  },
];

/** helper injected next to the patched menu: button size so the whole grid fits the canvas */
export const MENU_FIT_HELPER = `
function _mopeFit(n, perRow) {
  var rows = Math.ceil(n / perRow);
  var byW = (window.innerWidth * 0.94) / (perRow * 1.15 * 1.0);
  var byH = (window.innerHeight * 0.62) / (rows * 1.15 * 1.15);
  return Math.max(36, Math.min(byW, byH));
}
`;

export function applyClientPatches(
  code: string,
  log: (s: string) => void = console.log,
): { code: string; reports: PatchReport[] } {
  const reports: PatchReport[] = [];
  let out = code;
  for (const p of clientPatches) {
    try {
      const next = p.apply(out);
      reports.push({ name: p.name, applied: next !== out });
      out = next;
    } catch (e) {
      if (p.required) throw new Error(`patch '${p.name}' failed: ${(e as Error).message}`);
      reports.push({ name: p.name, applied: false, note: (e as Error).message });
    }
  }
  for (const r of reports) log(`  ${r.applied ? "✔" : "·"} ${r.name}${r.note ? " – " + r.note : ""}`);
  return { code: out, reports };
}

/** index.html: drop CF rocket-loader, ads, analytics, captcha; boot the client directly. */
export function patchIndex(html: string): string {
  // rocket-loader rewrites script types with a hash prefix
  html = html.replace(/type="[0-9a-f]{16,}-text\/javascript"/g, 'type="text/javascript"');
  const dropScripts = [
    /<script[^>]+rocket-loader[^>]*><\/script>/g,
    /<script>window\.__CF\$cv\$params[\s\S]*?<\/script>/g,
    /<script[^>]+(?:nitropay|googletagmanager|scorecardresearch|challenges\.cloudflare|apis\.google\.com|adblockdet\/ads\.js|dfp\.js)[^>]*><\/script>/g,
  ];
  for (const re of dropScripts) html = html.replace(re, "");
  // gtag + comscore inline blocks
  html = html.replace(/<script[^>]*>\s*window\.dataLayer[\s\S]*?<\/script>/g, "");
  html = html.replace(/<script[^>]*>\s*var _comscore[\s\S]*?<\/script>/g, "");
  html = html.replace(/<script[^>]*>window\.nitroAds[\s\S]*?<\/script>/g, "");
  // prelude first thing in <head>, local UI + boot at the end of <body>
  html = html.replace(/<head>/i, `<head>\n  <script src="mopeio/prelude.js"></script>`);
  html = html.replace(
    /<script[^>]*>\s*\/\/if \(typeof turnstile[\s\S]*?\n<\/script>/,
    `<script>
  function run() {
    var s = document.createElement('script');
    s.src = 'client.js?v=' + (+new Date());
    s.async = false; s.defer = true; s.type = 'text/javascript';
    document.head.appendChild(s);
  }
  window.turnstile = window.turnstile || { render: function (_el, o) { setTimeout(function () { o.callback('local'); }); return 0; }, remove: function () {} };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
</script>
<script src="mopeio/local-ui.js"></script>`,
  );
  return html;
}

export async function buildDist(log: (s: string) => void = console.log) {
  await mkdir(DIST, { recursive: true });
  await cp(SITE, DIST, { recursive: true, filter: (s) => !s.endsWith("_manifest.json") });
  await mkdir(join(DIST, "mopeio"), { recursive: true });
  for (const f of await readdir(join(ROOT, "client"))) await cp(join(ROOT, "client", f), join(DIST, "mopeio", f));

  const decoded = await Bun.file(join(DECODED, "client.deobf.js")).text();
  log("patching client.js");
  const { code } = applyClientPatches(decoded, log);
  await writeFile(join(DIST, "client.js"), MENU_FIT_HELPER + code);
  await writeFile(join(DIST, "index.html"), patchIndex(await Bun.file(join(SITE, "index.html")).text()));
  log(`dist ready: ${DIST}`);
}
