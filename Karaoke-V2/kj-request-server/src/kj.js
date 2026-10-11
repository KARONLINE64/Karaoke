// Espaces KJ (KaroliveBox KJ) : un espace par KJ, désigné par un code
// permanent (celui du QR code : https://karonline64.github.io/Karaoke/?kj=CODE).
//
// Indépendant de la partie OpenKJ du KJ propriétaire (routes « / »,
// « /request », « /status » de index.js), qui ne change pas.
//
// Routes publiques (page de demandes des clients) :
//   GET  /kj/CODE/info      nom, état (en ligne, demandes ouvertes...)
//   GET  /kj/CODE/catalog   catalogue du KJ [{id, artist, title}]
//   GET  /kj/CODE/logo      logo du KJ
//   POST /kj/CODE/request   demande d'un client
// Routes du logiciel KaroliveBox KJ (Authorization: Bearer <clé du KJ>) :
//   POST /kj/CODE           commandes au format OpenKJ (heartbeat, getSerial,
//                           getRequests, deleteRequest, clearRequests,
//                           getAccepting, setAccepting) + getProfile,
//                           setProfile, close
//   PUT  /kj/CODE/catalog   publication du catalogue
//   PUT  /kj/CODE/logo      envoi du logo (PNG, JPEG ou WebP)
//                           startSession, getSessions (formules)
// Routes d'administration (serveur karolive.com, Bearer KJ_ADMIN_TOKEN) :
//   POST /admin/kj          création / mise à jour d'un KJ (abonnement)
//   POST /admin/kj/packs    ajout d'une formule achetée {code, plan}
//   POST /admin/kj/sessions sessions restantes d'un KJ {code}
//
// Formules (sessions de 8 h) : UN JOUR (1 session, sans limite), UN WEEKEND
// (2 sessions, dans les 3 jours après la 1re), UN MOIS (4 sessions, dans les
// 30 jours après l'achat). La 1re session est offerte à la création du KJ.
// Une session commence quand le KJ clique « Démarrer ma soirée » ; pendant
// 8 h, sa page accepte les demandes (logiciel ouvert) ; ensuite, plus de
// demandes jusqu'à la session suivante (la lecture, locale, continue).

const CODE_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
// Le KJ est « en ligne » si son logiciel s'est signalé depuis moins de 35 s.
// Le signe de vie n'est écrit qu'une fois toutes les 15 s (quota d'écritures).
const ONLINE_MS = 35000;
const HEARTBEAT_WRITE_MS = 15000;
// Logiciel fermé (options « hors soirée ») : catalogue consultable
// (allow_offline) et, en plus, demandes possibles (offline_requests),
// gardées 48 h maximum.
const OFFLINE_REQUEST_TTL_MS = 48 * 3600 * 1000;
const MAX_PENDING = 300;
const MAX_LOGO_BYTES = 300 * 1024;
const MAX_CATALOG_SONGS = 100000;
const CATALOG_PART_CHARS = 800000;
const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];
const SESSION_MS = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const PLANS = {
  trial: { sessions: 1 },                             // 1re session offerte
  day: { sessions: 1 },                               // UN JOUR
  weekend: { sessions: 2, afterFirstUseMs: 3 * DAY_MS },  // UN WEEKEND
  month: { sessions: 4, afterPurchaseMs: 30 * DAY_MS },   // UN MOIS
};

let schemaReady = false;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });

// Données publiques : lisibles depuis n'importe quelle page (aucun cookie).
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const run = (env, sql, params = []) => env.REQUEST_DB.prepare(sql).bind(...params).run();
const first = (env, sql, params = []) => env.REQUEST_DB.prepare(sql).bind(...params).first();
const all = async (env, sql, params = []) =>
  (await env.REQUEST_DB.prepare(sql).bind(...params).all()).results || [];

async function ensureKjSchema(env) {
  if (schemaReady) return;
  await env.REQUEST_DB.batch([
    env.REQUEST_DB.prepare(`CREATE TABLE IF NOT EXISTS kjs (
      code TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      accepting INTEGER NOT NULL DEFAULT 1,
      allow_offline INTEGER NOT NULL DEFAULT 0,
      offline_requests INTEGER NOT NULL DEFAULT 0,
      session_until INTEGER NOT NULL DEFAULT 0,
      last_heartbeat INTEGER NOT NULL DEFAULT 0,
      serial INTEGER NOT NULL DEFAULT 1,
      catalog_version INTEGER NOT NULL DEFAULT 0,
      catalog_count INTEGER NOT NULL DEFAULT 0,
      logo_type TEXT NOT NULL DEFAULT '',
      logo TEXT NOT NULL DEFAULT '',
      logo_version INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`),
    env.REQUEST_DB.prepare(`CREATE TABLE IF NOT EXISTS kj_requests (
      request_id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      artist TEXT NOT NULL,
      title TEXT NOT NULL,
      singer TEXT NOT NULL,
      key_change TEXT NOT NULL,
      song_id TEXT NOT NULL DEFAULT '',
      offline INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`),
    env.REQUEST_DB.prepare(
      "CREATE INDEX IF NOT EXISTS kj_requests_code ON kj_requests(code, created_at)"),
    env.REQUEST_DB.prepare(`CREATE TABLE IF NOT EXISTS kj_packs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      plan TEXT NOT NULL,
      sessions_left INTEGER NOT NULL,
      expires_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`),
    env.REQUEST_DB.prepare(`CREATE TABLE IF NOT EXISTS kj_catalog (
      code TEXT NOT NULL,
      part INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (code, part)
    )`),
  ]);
  // Bases créées avant ces options : colonnes ajoutées.
  for (const column of ["offline_requests", "session_until"]) {
    try {
      await run(env, `ALTER TABLE kjs ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    } catch (error) {
      if (!String(error && error.message).includes("duplicate column")) throw error;
    }
  }
  // Une seule session offerte par KJ, même si deux requêtes arrivent ensemble.
  await run(env, "CREATE UNIQUE INDEX IF NOT EXISTS kj_packs_trial ON kj_packs(code) WHERE plan = 'trial'");
  // KJ inscrits avant les formules : leur 1re session offerte.
  await run(env, `INSERT OR IGNORE INTO kj_packs (code, plan, sessions_left, expires_at, created_at)
      SELECT code, 'trial', 1, 0, ? FROM kjs`, [Date.now()]);
  schemaReady = true;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function bearer(request) {
  return (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
}

function sameSecret(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const clean = (value, max) =>
  String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

function parseKey(value) {
  if (value === undefined || value === null || value === "" || String(value).toLowerCase() === "normal") return 0;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) || parsed < -12 || parsed > 12 ? null : parsed;
}

function status(kj, now = Date.now()) {
  const online = now - kj.last_heartbeat < ONLINE_MS;
  const active = kj.active === 1;
  const inSession = now < (kj.session_until || 0);
  return {
    online,
    inSession,
    // Catalogue consultable : logiciel ouvert, ou option « catalogue hors soirée ».
    browse: active && (online || kj.allow_offline === 1),
    // Demandes acceptées : case « Accepter les demandes » cochée, et logiciel
    // ouvert pendant une session (soirée de 8 h), ou logiciel fermé avec
    // l'option « demandes hors soirée » (avec le catalogue).
    open: active && kj.accepting === 1
      && ((online && inSession)
        || (!online && kj.allow_offline === 1 && kj.offline_requests === 1)),
  };
}

const getKj = (env, code) => first(env, "SELECT * FROM kjs WHERE code = ?", [code]);

async function purgeExpired(env, code) {
  await run(env, "DELETE FROM kj_requests WHERE code = ? AND created_at < ?",
    [code, Date.now() - OFFLINE_REQUEST_TTL_MS]);
}

async function bumpSerial(env, code) {
  await run(env, "UPDATE kjs SET serial = serial + 1 WHERE code = ?", [code]);
}

// --- Public --------------------------------------------------------------
async function publicInfo(kj) {
  const s = status(kj);
  return json({
    code: kj.code,
    name: kj.name,
    active: kj.active === 1,
    online: s.online,
    browse: s.browse,
    open: s.open,
    accepting: kj.accepting === 1,
    allowOffline: kj.allow_offline === 1,
    offlineRequests: kj.offline_requests === 1,
    inSession: s.inSession,
    catalogVersion: kj.catalog_version,
    catalogCount: kj.catalog_count,
    logoVersion: kj.logo ? kj.logo_version : 0,
  }, 200, { ...CORS, "Cache-Control": "no-store" });
}

async function publicCatalog(env, kj) {
  const parts = await all(env, "SELECT data FROM kj_catalog WHERE code = ? ORDER BY part", [kj.code]);
  const body = parts.length ? parts.map(p => p.data).join("") : "[]";
  return new Response(body, {
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300" },
  });
}

function publicLogo(kj) {
  if (!kj.logo) return new Response("Not Found", { status: 404, headers: CORS });
  const bytes = Uint8Array.from(atob(kj.logo), c => c.charCodeAt(0));
  return new Response(bytes, {
    headers: { ...CORS, "Content-Type": kj.logo_type, "Cache-Control": "public, max-age=86400" },
  });
}

async function publicRequest(env, request, kj) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ status: "error", message: "invalid json" }, 400, CORS);
  }
  const artist = clean(data.artist, 120);
  const title = clean(data.title, 120);
  const singer = clean(data.singer, 40);
  const keyChange = parseKey(data.keyChange);
  if (!artist || !title) return json({ status: "error", message: "missing song" }, 400, CORS);
  if (!singer) return json({ status: "error", message: "missing singer" }, 400, CORS);
  if (keyChange === null) return json({ status: "error", message: "invalid keyChange" }, 400, CORS);
  const s = status(kj);
  if (!s.open) {
    return json({ status: "error", message: s.browse ? "requests not accepted" : "service offline" },
      403, CORS);
  }
  await purgeExpired(env, kj.code);
  const pending = await first(env, "SELECT COUNT(*) AS n FROM kj_requests WHERE code = ?", [kj.code]);
  if (pending && pending.n >= MAX_PENDING) {
    return json({ status: "error", message: "too many requests" }, 429, CORS);
  }
  await run(env, `INSERT INTO kj_requests
      (request_id, code, artist, title, singer, key_change, song_id, offline, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), kj.code, artist, title, singer, String(keyChange),
      clean(data.songId, 40), s.online ? 0 : 1, Date.now()]);
  await bumpSerial(env, kj.code);
  return json({ status: "ok" }, 200, CORS);
}

// --- Logiciel du KJ -------------------------------------------------------
async function authorizeKj(env, request, kj) {
  if (!kj) return json({ error: "unknown kj" }, 404);
  const hash = await sha256Hex(bearer(request));
  if (!sameSecret(hash, kj.key_hash)) return json({ command: null, error: "unauthorized" }, 401);
  if (kj.active !== 1) return json({ command: null, error: "subscription inactive" }, 403);
  return null;
}

async function heartbeat(env, kj) {
  const now = Date.now();
  if (now - kj.last_heartbeat >= HEARTBEAT_WRITE_MS) {
    await run(env, "UPDATE kjs SET last_heartbeat = ? WHERE code = ?", [now, kj.code]);
  }
}

// --- Formules et sessions ----------------------------------------------------
async function validPacks(env, code, now = Date.now()) {
  return all(env, `SELECT * FROM kj_packs WHERE code = ? AND sessions_left > 0
      AND (expires_at = 0 OR expires_at > ?)
      ORDER BY CASE WHEN expires_at > 0 THEN expires_at ELSE 9007199254740991 END, id`,
    [code, now]);
}

async function sessionsSummary(env, kj, now = Date.now()) {
  const packs = await validPacks(env, kj.code, now);
  return {
    sessionUntil: now < (kj.session_until || 0) ? kj.session_until : 0,
    sessionsLeft: packs.reduce((sum, pack) => sum + pack.sessions_left, 0),
    packs: packs.map(pack => ({ plan: pack.plan, sessionsLeft: pack.sessions_left,
      expiresAt: pack.expires_at })),
  };
}

async function addPack(env, code, plan, now = Date.now()) {
  const def = PLANS[plan];
  const expires = def.afterPurchaseMs ? now + def.afterPurchaseMs : 0;
  await run(env, `INSERT OR IGNORE INTO kj_packs (code, plan, sessions_left, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)`, [code, plan, def.sessions, expires, now]);
}

// « Démarrer ma soirée » : une session de 8 h (rien n'est décompté si une
// session est déjà en cours).
async function startSession(env, kj, now = Date.now()) {
  if (now < (kj.session_until || 0)) return { started: false, ...(await sessionsSummary(env, kj, now)) };
  const pack = (await validPacks(env, kj.code, now))[0];
  if (!pack) return null;
  let expires = pack.expires_at;
  if (pack.plan === "weekend" && !expires) expires = now + PLANS.weekend.afterFirstUseMs;
  const until = now + SESSION_MS;
  await env.REQUEST_DB.batch([
    env.REQUEST_DB.prepare("UPDATE kj_packs SET sessions_left = sessions_left - 1, expires_at = ? WHERE id = ?")
      .bind(expires, pack.id),
    env.REQUEST_DB.prepare("UPDATE kjs SET session_until = ?, serial = serial + 1 WHERE code = ?")
      .bind(until, kj.code),
  ]);
  return { started: true, ...(await sessionsSummary(env, { ...kj, session_until: until }, now)) };
}

function profileOf(kj) {
  return {
    code: kj.code, name: kj.name, accepting: kj.accepting === 1,
    allowOffline: kj.allow_offline === 1, offlineRequests: kj.offline_requests === 1,
    sessionUntil: Date.now() < (kj.session_until || 0) ? kj.session_until : 0,
    catalogVersion: kj.catalog_version,
    catalogCount: kj.catalog_count, logoVersion: kj.logo ? kj.logo_version : 0,
  };
}

async function kjCommand(env, request, kj) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ command: null, error: "invalid json" }, 400);
  }
  const command = typeof data.command === "string" ? data.command : "";
  const ok = (extra = {}) => json({ command, error: "", ...extra });
  switch (command) {
    case "connectionTest":
      return ok();
    case "heartbeat":
      await heartbeat(env, kj);
      return ok();
    case "getSerial":
      return ok({ serial: kj.serial });
    case "getAccepting":
      return ok({ accepting: kj.accepting === 1 });
    case "setAccepting": {
      const accepting = data.accepting === true || data.accepting === "true";
      await run(env, "UPDATE kjs SET accepting = ? WHERE code = ?", [accepting ? 1 : 0, kj.code]);
      return ok({ accepting });
    }
    case "getRequests": {
      await purgeExpired(env, kj.code);
      const requests = await all(env, `SELECT request_id, artist, title, singer, key_change,
          song_id, offline, created_at FROM kj_requests WHERE code = ? ORDER BY created_at`,
        [kj.code]);
      return ok({ requests, serial: kj.serial });
    }
    case "deleteRequest": {
      const id = typeof data.request_id === "string" ? data.request_id : "";
      const result = await run(env, "DELETE FROM kj_requests WHERE code = ? AND request_id = ?",
        [kj.code, id]);
      if (!result.meta || !result.meta.changes) {
        return json({ command, error: "request not found" }, 404);
      }
      await bumpSerial(env, kj.code);
      return ok({ request_id: id });
    }
    case "clearRequests":
      await run(env, "DELETE FROM kj_requests WHERE code = ?", [kj.code]);
      await bumpSerial(env, kj.code);
      return ok();
    case "getSessions":
      return ok({ sessions: await sessionsSummary(env, kj) });
    case "startSession": {
      const result = await startSession(env, kj);
      if (!result) {
        return json({ command, error: "no session left",
          sessions: await sessionsSummary(env, kj) }, 402);
      }
      return ok({ sessions: result });
    }
    case "getProfile":
      return ok({ profile: profileOf(kj) });
    case "setProfile": {
      const name = data.name === undefined ? kj.name : clean(data.name, 60);
      const allow = data.allowOffline === undefined ? kj.allow_offline
        : (data.allowOffline === true ? 1 : 0);
      const offlineRequests = data.offlineRequests === undefined ? kj.offline_requests
        : (data.offlineRequests === true ? 1 : 0);
      await run(env, "UPDATE kjs SET name = ?, allow_offline = ?, offline_requests = ? WHERE code = ?",
        [name, allow, offlineRequests, kj.code]);
      return ok({ profile: profileOf({ ...kj, name, allow_offline: allow,
        offline_requests: offlineRequests }) });
    }
    case "close":
      // Fin de soirée : les demandes restantes sont effacées, le KJ passe
      // hors ligne tout de suite.
      await run(env, "DELETE FROM kj_requests WHERE code = ?", [kj.code]);
      await run(env, "UPDATE kjs SET last_heartbeat = 0, serial = serial + 1 WHERE code = ?",
        [kj.code]);
      return ok();
    default:
      return json({ command: command || null, error: "unsupported command" }, 400);
  }
}

async function uploadCatalog(env, request, kj) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const input = Array.isArray(data && data.songs) ? data.songs : null;
  if (!input) return json({ error: "missing songs" }, 400);
  if (input.length > MAX_CATALOG_SONGS) return json({ error: "too many songs" }, 413);
  const seen = new Set();
  const songs = [];
  for (const song of input) {
    const artist = clean(song && song.artist, 120);
    const title = clean(song && song.title, 120);
    if (!title) continue;
    const key = (artist + "|" + title).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    songs.push({ id: clean(song.id, 40), artist, title });
  }
  songs.sort((a, b) => a.artist.localeCompare(b.artist, "fr") || a.title.localeCompare(b.title, "fr"));
  const text = JSON.stringify(songs);
  const statements = [env.REQUEST_DB.prepare("DELETE FROM kj_catalog WHERE code = ?").bind(kj.code)];
  for (let part = 0, at = 0; at < text.length; part += 1, at += CATALOG_PART_CHARS) {
    statements.push(env.REQUEST_DB.prepare(
      "INSERT INTO kj_catalog (code, part, data) VALUES (?, ?, ?)")
      .bind(kj.code, part, text.slice(at, at + CATALOG_PART_CHARS)));
  }
  const version = Date.now();
  statements.push(env.REQUEST_DB.prepare(
    "UPDATE kjs SET catalog_version = ?, catalog_count = ? WHERE code = ?")
    .bind(version, songs.length, kj.code));
  await env.REQUEST_DB.batch(statements);
  return json({ error: "", count: songs.length, catalogVersion: version });
}

async function uploadLogo(env, request, kj) {
  const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (!LOGO_TYPES.includes(type)) return json({ error: "logo must be png, jpeg or webp" }, 415);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_LOGO_BYTES) return json({ error: "logo too large" }, 413);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const version = Date.now();
  await run(env, "UPDATE kjs SET logo = ?, logo_type = ?, logo_version = ? WHERE code = ?",
    [btoa(binary), type, version, kj.code]);
  return json({ error: "", logoVersion: version });
}

// --- Administration (serveur karolive.com) ---------------------------------
async function adminUpsert(env, request) {
  if (!env.KJ_ADMIN_TOKEN || !sameSecret(bearer(request), env.KJ_ADMIN_TOKEN)) {
    return json({ error: "unauthorized" }, 401);
  }
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const code = clean(data.code, 31).toLowerCase();
  const email = clean(data.email, 200).toLowerCase();
  if (!CODE_RE.test(code)) return json({ error: "invalid code" }, 400);
  const existing = await getKj(env, code);
  // Un code appartient pour toujours à la même adresse e-mail : jamais
  // réattribué à un autre KJ (ses QR codes imprimés restent les siens).
  if (existing && existing.email !== email) return json({ error: "code taken" }, 409);
  const keyHash = typeof data.keyHash === "string" && /^[0-9a-f]{64}$/.test(data.keyHash)
    ? data.keyHash : null;
  const active = data.active === undefined ? null : (data.active ? 1 : 0);
  const name = data.name === undefined ? null : clean(data.name, 60);
  if (!existing) {
    if (!email || !keyHash) return json({ error: "email and keyHash required" }, 400);
    await run(env, `INSERT INTO kjs (code, email, key_hash, name, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      [code, email, keyHash, name || "", active === null ? 1 : active, Date.now()]);
    await addPack(env, code, "trial");  // 1re session offerte
  } else {
    await run(env, `UPDATE kjs SET key_hash = COALESCE(?, key_hash),
        active = COALESCE(?, active), name = COALESCE(?, name) WHERE code = ?`,
      [keyHash, active, name, code]);
  }
  return json({ error: "", code, created: !existing });
}

async function adminSessions(env, request, withPack) {
  if (!env.KJ_ADMIN_TOKEN || !sameSecret(bearer(request), env.KJ_ADMIN_TOKEN)) {
    return json({ error: "unauthorized" }, 401);
  }
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const kj = await getKj(env, clean(data.code, 31).toLowerCase());
  if (!kj) return json({ error: "unknown kj" }, 404);
  if (withPack) {
    const plan = clean(data.plan, 20);
    if (!["day", "weekend", "month"].includes(plan)) return json({ error: "invalid plan" }, 400);
    await addPack(env, kj.code, plan);
  }
  return json({ error: "", code: kj.code, sessions: await sessionsSummary(env, kj) });
}

export async function handleKj(request, env, url) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  await ensureKjSchema(env);
  if (url.pathname === "/admin/kj" && request.method === "POST") return adminUpsert(env, request);
  if (url.pathname === "/admin/kj/packs" && request.method === "POST") return adminSessions(env, request, true);
  if (url.pathname === "/admin/kj/sessions" && request.method === "POST") return adminSessions(env, request, false);

  const match = url.pathname.match(/^\/kj\/([^/]+)(?:\/(info|catalog|logo|request))?\/?$/);
  if (!match) return json({ error: "not found" }, 404, CORS);
  const code = decodeURIComponent(match[1]).toLowerCase();
  const action = match[2] || "";
  if (!CODE_RE.test(code)) return json({ error: "unknown kj" }, 404, CORS);
  const kj = await getKj(env, code);

  if (request.method === "GET" || (request.method === "POST" && action === "request")) {
    if (!kj) return json({ error: "unknown kj" }, 404, CORS);
    if (action === "info") return publicInfo(kj);
    if (action === "catalog") return publicCatalog(env, kj);
    if (action === "logo") return publicLogo(kj);
    if (action === "request") return publicRequest(env, request, kj);
    return json({ error: "not found" }, 404, CORS);
  }

  const refused = await authorizeKj(env, request, kj);
  if (refused) return refused;
  if (request.method === "POST" && action === "") return kjCommand(env, request, kj);
  if (request.method === "PUT" && action === "catalog") return uploadCatalog(env, request, kj);
  if (request.method === "PUT" && action === "logo") return uploadLogo(env, request, kj);
  return json({ error: "not found" }, 404);
}
