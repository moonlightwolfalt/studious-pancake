/*
 * Headless-Chromium introspection of the patched client.
 *   node tools/probe.cjs <baseUrl> <outDir>
 * Uses window.__mopeEval (direct eval inside the client closure) to read the
 * game's own animal tables, so the shop catalog / upgrade tree are derived from
 * the client instead of being hand-copied.
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const [base = "http://localhost:8080", out = "data"] = process.argv.slice(2);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.goto(base + "/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__mopeEval, null, { timeout: 60000 });
  await page.waitForTimeout(1000);

  const data = await page.evaluate(() => {
    const E = window.__mopeEval;
    const reg = E("_0x4fd9f7.customClassesForOType")[2];
    const types = Object.keys(reg.secondaryTypeClasses).map(Number).sort((a, b) => a - b);
    const tiers = E("_0x26aaf1");
    const factory = E("_0x4fd9f7");

    const probe = (t, species, sub, season) => {
      const o = factory.createGameObjOfOType(2, t);
      o.animalType = t;
      o.animalSpecies = species;
      o.animalSubSpecies = sub;
      o.mopeSeasonID = season;
      o.skinThemeID = 0;
      o.animalPremiumSkin = 0;
      o.curBiome = 0;
      const i = o.animalInfo();
      return i && { name: i.aniName, skin: i.skinName, text: i.upgradeText, col: i.aniCol };
    };

    const animals = [];
    for (const t of types) {
      let base;
      try {
        base = probe(t, 0, 0, 1);
      } catch (e) {
        continue;
      }
      if (!base || !base.name) continue;
      const variants = [];
      const seen = new Set([base.name]);
      for (let sp = 1; sp <= 260; sp++) {
        for (let sub = 0; sub <= 3; sub++) {
          let v;
          try {
            v = probe(t, sp, sub, 1);
          } catch (e) {
            continue;
          }
          if (!v || !v.name) continue;
          // some classes derive the skin path from the species number for every
          // value; a real variant has its own display name
          if (v.name === base.name) continue;
          const key = v.name;
          if (seen.has(key)) continue;
          seen.add(key);
          variants.push({ species: sp, sub, name: v.name, skin: v.skin });
        }
      }
      animals.push({
        id: t,
        tier: tiers[t] ?? 0,
        name: base.name,
        skin: base.skin,
        folder: (base.skin || "").split("/")[0],
        color: base.col || null,
        text: base.text || "",
        variants,
      });
    }
    return animals;
  });

  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "animals.json"), JSON.stringify(data, null, 1));
  console.log(`probe: ${data.length} animals, ${data.reduce((n, a) => n + a.variants.length, 0)} skin variants`);
  await browser.close();
})();
