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

export const BRAND = "Moonlight Wolf";

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
    // Upgrade menu: split by the client's own tier table (ANIMAL_TIER, tiers 1-17).
    // Every tier gets its own row(s) with a "T<n>" label instead of a flat 7-wide grid.
    name: "upgrade-menu-by-tier",
    required: true,
    apply(code) {
      // rows are wider than the 8-key hotkey table: tolerate missing keys
      code = code.replace(
        /setHotKey\((\w+)\[(\w+) - 1\]\[(\w+)\]\.toUpperCase\(\)\)/g,
        'setHotKey((($1[$2 - 1] || [])[$3] || " ").toUpperCase())',
      );

      // tier table: the object literal whose first keys map to tiers 1,2,4,...
      const tierTable = code.match(/const (\w+) = \{\s*\[\w+\]: 1,\s*\[\w+\]: 2,\s*\[\w+\]: 4,/)?.[1];
      if (!tierTable) throw new Error("ANIMAL_TIER table not found");

      // tag each menu button with its tier when the server's menu message is turned into buttons
      const push = code.match(/(\w+)\.push\((\w+)\);\s*\}\s*\};\s*const \w+ = \(\w+\) => \{\s*const \{\s*choiceIndex/);
      if (!push) throw new Error("menu button creation not found");
      const [, arr0, btn] = push;
      code = code.replace(push[0], push[0].replace(`${arr0}.push(${btn});`, `${btn}._tier = ${tierTable}[${btn}.aniT] || 0;\n        ${arr0}.push(${btn});`));

      // layout block
      const lay = code.match(
        /var (\w+) = (\w+) \* (\w+);\s*var \w+ = 10;\s*var \w+ = \1 \+ 20;\s*var (\w+) = 7;\s*var (\w+) = Math\.max\(0, (\w+)\.length\);\s*if \(\6\.length > \4 \+ 1\) \{\s*\5 = Math\.min\(\4, \5\);\s*\}/,
      );
      if (!lay) throw new Error("upgrade menu layout not found");
      const [whole, size, , , perRow, cnt, arr] = lay;
      code = code.replace(
        whole,
        whole
          .replace(`var ${perRow} = 7;`, `var ${perRow} = _mopePerRow(${arr});`)
          .replace(
            new RegExp(`var ${cnt} = Math\\.max\\(0, ${arr}\\.length\\);\\s*if \\(${arr}\\.length > ${perRow} \\+ 1\\) \\{\\s*${cnt} = Math\\.min\\(${perRow}, ${cnt}\\);\\s*\\}`),
            `${size} = Math.min(${size}, _mopeFit(${arr}, ${perRow}));\n          var ${cnt} = _mopeRowLen(${arr}, 0, ${perRow});`,
          ),
      );

      // first row y
      code = code.replace(/var (\w+) = (\w+) \* 0\.25;(\s*var \w+ = \w+ \* 1\.15;)/, (_m, y, h, rest) => `var ${y} = ${arr}.length > 8 ? ${h} * 0.1 : ${h} * 0.25;${rest}`);

      // row wrapping: new tier, or the tier's row is full. Scoped to the code after the
      // layout block (an earlier, unrelated menu in the file has the same shape).
      const at = code.indexOf(`var ${perRow} = _mopePerRow(${arr});`);
      let rest = code.slice(at);
      const wrap = rest.match(/if \((\w+) > 0 && (\w+) > (\w+) \+ 1\) \{\s*if \(\1 % \3 == 0\) \{/);
      if (!wrap) throw new Error("upgrade menu row wrapping not found");
      rest = rest.replace(wrap[0], `if (${wrap[1]} > 0) {\n              if (_mopeRowStart(${arr}, ${wrap[1]}, ${wrap[3]})) {`);
      const remain = rest.match(/var (\w+) = \w+ - \w+;\s*if \(\1 < \w+\) \{\s*(\w+) = \1;\s*\} else \{\s*\2 = \w+;\s*\}/);
      if (!remain) throw new Error("upgrade menu row length not found");
      rest = rest.replace(remain[0], `${remain[2]} = _mopeRowLen(${arr}, ${wrap[1]}, ${wrap[3]});`);
      code = code.slice(0, at) + rest;

      // tier labels, drawn after each button
      const from = code.indexOf(`var ${perRow} = _mopePerRow(${arr});`);
      const draw = code.slice(from).match(
        /(\w+)\.globalAlpha = (\w+);\s*for \(var (\w+) = 0; \3 < \w+\.length; \3\+\+\) \{\s*var (\w+) = (\w+)\[\3\];\s*\4\.imgSizeF = (\w+);\s*\4\.draw\(\);/,
      );
      if (!draw) throw new Error("upgrade menu draw loop not found");
      const [dw, ctx, , di, db, darr] = draw;
      code = code.slice(0, from) + code.slice(from).replace(dw, `${dw}\n            _mopeTierLabel(${ctx}, ${darr}, ${di}, ${db}, ${perRow});`);
      return code;
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

/** helpers injected next to the patched menu (tiers are arr[i]._tier, set by the patch) */
export const MENU_HELPERS = `
function _mopeRowStart(arr, i, perRow) {
  if (i === 0) return true;
  if (arr[i]._tier !== arr[i - 1]._tier) return true;
  var k = i, c = 0;
  while (k > 0 && arr[k - 1]._tier === arr[i]._tier) { k--; c++; }
  return c % perRow === 0;
}
function _mopeRowLen(arr, i, perRow) {
  var t = arr[i]._tier, j = i;
  while (j < arr.length && arr[j]._tier === t && j - i < perRow) j++;
  return j - i;
}
function _mopePerRow(arr) {
  var max = 0, i = 0;
  while (i < arr.length) { var t = arr[i]._tier, j = i; while (j < arr.length && arr[j]._tier === t) j++; max = Math.max(max, j - i); i = j; }
  return Math.max(7, Math.min(24, max));
}
function _mopeFit(arr, perRow) {
  var rows = 0, i = 0;
  while (i < arr.length) { i += _mopeRowLen(arr, i, perRow); rows++; }
  var byW = (window.innerWidth * 0.86) / (perRow * 1.15);
  var byH = (window.innerHeight * 0.8) / (rows * 1.15 * 1.15);
  return Math.max(22, Math.min(150, byW, byH));
}
function _mopeTierLabel(ctx, arr, i, b, perRow) {
  if (!_mopeRowStart(arr, i, perRow)) return;
  ctx.save();
  ctx.fillStyle = "#fff";
  ctx.font = "bold " + Math.max(11, b.w * 0.34) + "px Arial";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "black";
  ctx.shadowBlur = 3;
  ctx.fillText("T" + b._tier, b.x - b.w * 0.75, b.y);
  ctx.restore();
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
  html = html.replace(/<h2([^>]*)>\s*Mistik\s*<\/h2>/g, `<h2$1>${BRAND}</h2>`);
  html = html.replace(/<div class="g-ytsubscribe"[^>]*><\/div>/g, ""); // YouTube subscribe widget (Google script removed)
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
  await writeFile(join(DIST, "client.js"), MENU_HELPERS + code);
  await writeFile(join(DIST, "index.html"), patchIndex(await Bun.file(join(SITE, "index.html")).text()));
  log(`dist ready: ${DIST}`);
}
