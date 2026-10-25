import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DECODED } from "./config";

/**
 * Hand-curated names for the identifiers recovered while reverse engineering
 * the protocol. Obfuscator names are stable for a given client build; names that
 * do not occur are simply skipped, so a new build degrades gracefully.
 */
export const NAMES: Record<string, string> = {
  // wire format
  _0x1bd7e6: "MsgReader",
  _0x389af7: "MsgWriter",
  _0x21c98e: "BitGroupReader",
  _0x5179af: "utf8Encode",
  _0x1a7d1c: "utf8Decode",
  _0x54ccb7: "testBit",
  _0x4aac69: "sendToServer",
  _0x5bf032: "gameSocket",
  _0x35fb88: "onGameMessage",
  // packets
  _0x2978f3: "HelloMsg",
  _0x165768: "SessionInfoMsg",
  _0x1f1e09: "CameraMsg",
  _0x5d049b: "SpawnMsg",
  _0x4e53b8: "UpgradeMenuMsg",
  _0x4446b2: "MiniMapMsg",
  _0x2f05bb: "UserBuffsMsg",
  // world update
  _0x556505: "onWorldUpdateMsg",
  _0x30f187: "applyWorldUpdate",
  _0x159c3a: "readWorldHeader",
  _0x767f8c: "readPlayerProps",
  _0x26eeef: "readPlayerProp",
  _0x2d5e57: "readHeaderFlags",
  _0x4cfdc9: "readTreesBlock",
  _0x1cbe3b: "readTeamBlock",
  // objects
  _0x4fd9f7: "GameObjFactory",
  _0x42d8d9: "BaseGameObject",
  _0x53ec64: "AnimalObject",
  _0x3ea5ca: "OTYPE_ANIMAL",
  _0x26aaf1: "ANIMAL_TIER",
  _0x876b80: "visibleObjects",
  _0xe23054: "objectsById",
  _0x2c86ef: "ownObjectId",
  _0x43646d: "isAliveInGame",
  _0x44060d: "biomeColor",
  // servers / accounts
  _0x33cbff: "currentServer",
  _0x1bca71: "connectToServer",
  _0x5c4685: "buildServerList",
  _0x35989a: "fetchServerStats",
  _0x1da4c3: "ACCOUNT_SERVER",
  _0x109182: "loginWithProvider",
  _0x35d2e8: "refreshAccountData",
  _0x1aa20f: "fetchShopItems",
  _0x526bc9: "fetchPurchases",
  _0x5187fb: "buyShopItem",
  _0x3ccfa6: "saveWardrobe",
  _0x13ccc0: "loginUserId",
  _0x3bdd43: "loginToken",
  _0x454dea: "isLoggedIn",
  _0x570f74: "accountData",
  // shop
  _0x1a00a9: "ShopUI",
  _0x2515e0: "ShopItemFactory",
  _0x3d80c2: "shop",
  // upgrade menu
  _0x55c283: "upgradeButtons",
  _0x1e4a62: "showUpgradeMenu",
  _0x2415a9: "sendUpgradeChoice",
  _0x3e8efa: "upgradeMenuOpen",
  _0x14372a: "UPGRADE_HOTKEYS",
};

export function applyNames(code: string): { code: string; renamed: number } {
  let renamed = 0;
  for (const [from, to] of Object.entries(NAMES)) {
    const re = new RegExp(`\\b${from}\\b`, "g");
    code = code.replace(re, () => (renamed++, to));
  }
  return { code, renamed };
}

export async function writeNamed(log: (s: string) => void = console.log) {
  const src = await Bun.file(join(DECODED, "client.deobf.js")).text();
  const { code, renamed } = applyNames(src);
  await writeFile(join(DECODED, "client.named.js"), code);
  log(`rename: ${Object.keys(NAMES).length} names, ${renamed} replacements -> client.named.js`);
}
