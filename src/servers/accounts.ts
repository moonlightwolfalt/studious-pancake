import { db } from "./db";
import { shopCatalog } from "./shop";

/** MOPE_FREE_SHOP=0 makes purchases cost coins/gems; default is free local purchases. */
const FREE_SHOP = process.env.MOPE_FREE_SHOP !== "0";

/**
 * Accounts with unlimited coins/gems (local admin). Comma-separated emails in
 * MOPE_INFINITE_EMAILS are added to the built-in default.
 */
const INFINITE = new Set(
  ["moonlightw12575@gmail.com", ...(process.env.MOPE_INFINITE_EMAILS ?? "").split(",")]
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);
const INFINITE_AMOUNT = 999_999_999;
const isInfinite = (u: { email: string }) => INFINITE.has(u.email.toLowerCase());

interface UserRow {
  id: number;
  email: string;
  username: string;
  pass_hash: string;
  token: string;
  coins: number;
  gems: number;
  level: number;
  xp: number;
  vip: number;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const fail = (error: string, status = 400) => json({ success: false, error }, status);

const newToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");

function avatar(name: string) {
  const c = (name[0] ?? "?").toUpperCase().replace(/[<>&"']/g, "?");
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' rx='32' fill='#09992f'/><text x='32' y='43' font-size='34' font-family='Arial' text-anchor='middle' fill='white'>${c}</text></svg>`;
  return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}

export function publicUser(u: UserRow) {
  if (isInfinite(u)) u = { ...u, coins: INFINITE_AMOUNT, gems: INFINITE_AMOUNT };
  const xpNextLvl = 300 + u.level * 100;
  return {
    userId: String(u.id),
    token: u.token,
    userName: u.username,
    avatar: avatar(u.username),
    coins: u.coins,
    gems: u.gems,
    level: u.level,
    xp: u.xp,
    xpNextLvl,
    hasVip: !!u.vip,
    hasAutoRenew: false,
  };
}

/** game-server sessionId -> user id, learned from /auth/@me (the client sends its session id there). */
export const sessionUsers = new Map<string, number>();

/** Shared with the game server so it can authenticate message 71. */
export function authenticate(userId: unknown, token: unknown): UserRow | null {
  if (userId == null || typeof token !== "string" || !token) return null;
  const row = db.query("SELECT * FROM users WHERE id = ?").get(Number(userId)) as UserRow | null;
  return row && row.token === token ? row : null;
}

export function equippedSkins(userId: number): Map<number, string> {
  const rows = db.query("SELECT animal_type, equipped FROM wardrobe WHERE user_id = ?").all(userId) as {
    animal_type: number;
    equipped: string;
  }[];
  return new Map(rows.map((r) => [r.animal_type, r.equipped]));
}

export function ownedItems(userId: number): Set<string> {
  const rows = db.query("SELECT item_id FROM purchases WHERE user_id = ?").all(userId) as { item_id: string }[];
  return new Set(rows.map((r) => r.item_id));
}

const grant = db.prepare("INSERT OR IGNORE INTO purchases (user_id, item_id, ts) VALUES (?, ?, ?)");

async function readBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

async function register(req: Request) {
  const { email, password, username } = await readBody(req);
  if (typeof email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Invalid email address");
  if (typeof password !== "string" || password.length < 6) return fail("Password must be at least 6 characters");
  const name = String(username || email.split("@")[0]).slice(0, 15);
  if (db.query("SELECT 1 FROM users WHERE email = ?").get(email)) return fail("Email already registered", 409);
  const hash = await Bun.password.hash(password);
  const token = newToken();
  db.query("INSERT INTO users (email, username, pass_hash, token, created_at) VALUES (?, ?, ?, ?, ?)").run(
    email,
    name,
    hash,
    token,
    Date.now(),
  );
  const row = db.query("SELECT * FROM users WHERE email = ?").get(email) as UserRow;
  return json({ success: true, data: publicUser(row) });
}

async function login(req: Request) {
  const { email, password } = await readBody(req);
  if (typeof email !== "string" || typeof password !== "string") return fail("Email and password required");
  const row = db.query("SELECT * FROM users WHERE email = ?").get(email) as UserRow | null;
  if (!row || !(await Bun.password.verify(password, row.pass_hash))) return fail("Wrong email or password", 401);
  const token = newToken();
  db.query("UPDATE users SET token = ? WHERE id = ?").run(token, row.id);
  return json({ success: true, data: publicUser({ ...row, token }) });
}

/**
 * Google sign-in (free): set GOOGLE_CLIENT_ID to an OAuth Web client id whose authorised
 * JavaScript origins include this server. Accepts a GSI ID token or an OAuth access token.
 */
async function googleLogin(req: Request) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return fail("Google login is not configured (set GOOGLE_CLIENT_ID)");
  const { accessToken } = await readBody(req);
  if (typeof accessToken !== "string" || !accessToken) return fail("Missing token");
  let email: string | undefined, name: string | undefined;
  try {
    const idRes = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(accessToken));
    if (idRes.ok) {
      const t = (await idRes.json()) as any;
      if (t.aud !== clientId || t.email_verified === "false") return fail("Token was not issued for this app", 401);
      email = t.email;
      name = t.name;
    } else {
      const acc = await fetch("https://oauth2.googleapis.com/tokeninfo?access_token=" + encodeURIComponent(accessToken));
      const t = acc.ok ? ((await acc.json()) as any) : null;
      if (!t || (t.aud ?? t.azp) !== clientId) return fail("Invalid Google token", 401);
      const ui = (await (await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { authorization: "Bearer " + accessToken } })).json()) as any;
      email = ui.email;
      name = ui.name;
    }
  } catch {
    return fail("Could not reach Google", 502);
  }
  if (!email) return fail("Google account has no email", 401);
  const token = newToken();
  let row = db.query("SELECT * FROM users WHERE email = ?").get(email) as UserRow | null;
  if (!row) {
    const hash = await Bun.password.hash(newToken()); // no password login for Google-only users
    db.query("INSERT INTO users (email, username, pass_hash, token, created_at) VALUES (?, ?, ?, ?, ?)").run(email, (name || email.split("@")[0]).slice(0, 15), hash, token, Date.now());
  } else db.query("UPDATE users SET token = ? WHERE id = ?").run(token, row.id);
  row = db.query("SELECT * FROM users WHERE email = ?").get(email) as UserRow;
  return json({ success: true, data: publicUser(row) });
}

function wardrobeFor(user: UserRow) {
  const owned = ownedItems(user.id);
  const equipped = equippedSkins(user.id);
  const wardrobe: Record<string, { equippedSkin: string; available: string[]; alreadySet: boolean }> = {};
  for (const item of shopCatalog()) {
    if (item.itemType !== 0 || item.animalType == null || !owned.has(item.itemId)) continue;
    const w = (wardrobe[item.animalType] ??= {
      equippedSkin: equipped.get(item.animalType) ?? "RANDOM",
      available: ["RANDOM"],
      alreadySet: equipped.has(item.animalType),
    });
    w.available.push(item.itemId);
  }
  return wardrobe;
}

function price(item: ReturnType<typeof shopCatalog>[number]) {
  return FREE_SHOP ? 0 : item.price;
}

function purchase(user: UserRow, itemId: string): string | null {
  const item = shopCatalog().find((i) => i.itemId === itemId);
  if (!item) return "Item does not exist";
  if (ownedItems(user.id).has(itemId)) return "You already own this item";
  const cost = isInfinite(user) ? 0 : price(item);
  const col = item.currencyType === 1 ? "gems" : "coins";
  if (!isInfinite(user) && (user as any)[col] < cost) return `Not enough ${col}`;
  db.query(`UPDATE users SET ${col} = ${col} - ? WHERE id = ?`).run(cost, user.id);
  (user as any)[col] -= cost;
  grant.run(user.id, itemId, Date.now());
  return null;
}

export async function handleAccounts(
  req: Request,
  path: string,
  opts: { serverStats: () => { id: string; totalPlayerCount: number }[] },
): Promise<Response> {
  const url = new URL(req.url);
  const m = req.method;

  if (m === "OPTIONS") return new Response(null, { status: 204 });

  if (path === "/auth/register" && m === "POST") return register(req);
  if (path === "/auth/login/local" && m === "POST") return login(req);
  if (path === "/auth/login/google" && m === "POST") return googleLogin(req);
  if (path.startsWith("/auth/login/") && m === "POST") return fail("Only email/password and Google login are available");

  if (path === "/auth/@me" && m === "POST") {
    const b = await readBody(req);
    const u = authenticate(b.userId, b.token);
    if (u && typeof b.sessionId === "string" && b.sessionId) sessionUsers.set(b.sessionId, u.id);
    return u ? json({ success: true, data: publicUser(u), coins: isInfinite(u) ? INFINITE_AMOUNT : u.coins }) : fail("Invalid session", 401);
  }
  if (path === "/auth/logout" && m === "POST") return json({ success: true });

  if (path === "/shop/get") return json({ items: shopCatalog().map((i) => ({ ...i, price: price(i) })), settings: [] });

  if (path === "/shop/purchases" && m === "POST") {
    const b = await readBody(req);
    const u = authenticate(b.userId, b.token);
    if (!u) return fail("Invalid session", 401);
    return json({
      success: true,
      data: { purchases: [...ownedItems(u.id)], wardrobe: wardrobeFor(u), settings: [] },
    });
  }

  if (path === "/shop/buy" && m === "POST") {
    const b = await readBody(req);
    const u = authenticate(b.userId, b.token);
    if (!u) return fail("Invalid session", 401);
    const err = purchase(u, String(b.shopItem));
    return err ? fail(err) : json({ success: true, reason: "ok" });
  }

  // Extension used by the "Buy all" button added to the shop UI.
  if (path === "/shop/buyall" && m === "POST") {
    const b = await readBody(req);
    const u = authenticate(b.userId, b.token);
    if (!u) return fail("Invalid session", 401);
    const tx = db.transaction(() => {
      const ts = Date.now();
      let n = 0;
      for (const item of shopCatalog()) {
        if (item.itemType === 3) continue; // consumable power-ups are not "owned"
        n += grant.run(u.id, item.itemId, ts).changes;
      }
      return n;
    });
    return json({ success: true, reason: "ok", granted: tx() });
  }

  if (path === "/shop/wardrobe/save" && m === "POST") {
    const b = await readBody(req);
    const u = authenticate(b.userId, b.token);
    if (!u) return fail("Invalid session", 401);
    const set = db.query(
      "INSERT INTO wardrobe (user_id, animal_type, equipped) VALUES (?, ?, ?) ON CONFLICT(user_id, animal_type) DO UPDATE SET equipped = excluded.equipped",
    );
    for (const c of Array.isArray(b.data) ? b.data : []) set.run(u.id, Number(c.id), String(c.changedSkin));
    return json({ success: true, data: wardrobeFor(u) });
  }

  // Real-money store (Xsolla) is not available locally; answer with well-formed JSON
  // so the shop UI doesn't choke.
  if (path === "/xsolla/getPackets") return json({ success: true, data: [] });
  if (path === "/xsolla/getVip") return json({ success: false, error: "VIP is disabled in the local build" });
  if (path.startsWith("/xsolla/")) return json({ success: false, reason: "Payments are disabled in the local build" }, 400);

  if (path === "/servers/get") return json(opts.serverStats());

  // Dev helpers the original client already knows about.
  if (path === "/addCoins") {
    const u = authenticate(url.searchParams.get("userId"), url.searchParams.get("passwordToken"));
    if (u) db.query("UPDATE users SET coins = coins + 100000 WHERE id = ?").run(u.id);
    return json({ success: !!u });
  }

  return fail("Not found", 404);
}
