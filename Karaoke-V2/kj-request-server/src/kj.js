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
//                           startSession, endSession, getSessions (stock d'heures)
// Routes d'administration (serveur karolive.com, Bearer KJ_ADMIN_TOKEN) :
//   POST /admin/kj          création / mise à jour d'un KJ (abonnement)
//   POST /admin/kj/packs    ajout d'une formule achetée {code, plan}
//   POST /admin/kj/sessions sessions restantes d'un KJ {code}
//
// Formules (sessions de 8 h) : UN JOUR (1 session, sans limite), UN WEEKEND
// (2 sessions, dans les 3 jours après la 1re), UN MOIS (8 sessions, dans les
// 30 jours après l'achat), UN AN (96 sessions, dans les 365 jours). FREE :
// 1 session de 4 h offerte à la création du KJ. KJ « à vie » (abonnés
// d'avant les formules) : sessions illimitées, rien n'est décompté.
// STOCK D'HEURES : chaque formule ajoute des heures d'utilisation au stock du
// KJ (UN JOUR 8 h, UN WEEKEND 16 h, UN MOIS 64 h, UN AN 768 h ; session
// offerte 4 h), à consommer comme il veut pendant la durée de la formule.
// « Démarrer ma soirée » lance le compteur, « Terminer ma soirée »
// l'arrête. Il ne tourne que logiciel ouvert (signaux de vie) : fermé ou
// planté, il est en pause ; au-delà de 6 h de fermeture, la soirée est
// terminée d'office (oubli de « Terminer »). Décocher « Accepter les
// demandes » ne met PAS en pause. Le logiciel envoie aussi son propre compte
// (usedMs) avec chaque signal de vie : le plus grand des deux est retenu
// (connexion coupée : aucun gain). Stock épuisé en soirée : 2 h de rab
// (GRACE_MS), puis plus rien jusqu'au prochain achat.

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
// Fin de soirée : 2 h de rab (geste commercial, le temps de racheter une
// session) pendant lesquelles la page reste ouverte comme pendant la soirée,
// selon les réglages du KJ. Jamais pour un KJ désabonné (active = 0).
const GRACE_MS = 2 * 3600 * 1000;
// Logiciel fermé plus de 6 h pendant une soirée : soirée terminée d'office.
const AUTO_END_MS = 6 * 3600 * 1000;
// Écart entre deux signaux de vie au-delà duquel le logiciel était fermé :
// ce temps-là n'est pas compté (pause).
const PAUSE_GAP_MS = 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
// Heures ajoutées au stock ; délai : après la 1re utilisation (UN JOUR,
// UN WEEKEND) ou après l'achat (UN MOIS, UN MOIS PRO, UN AN).
const PLANS = {
  trial: { hoursMs: 4 * HOUR_MS },                                  // FREE : 4 h offertes
  day: { hoursMs: 8 * HOUR_MS, afterFirstUseMs: DAY_MS },           // UN JOUR
  weekend: { hoursMs: 16 * HOUR_MS, afterFirstUseMs: 3 * DAY_MS },  // UN WEEKEND
  month: { hoursMs: 64 * HOUR_MS, afterPurchaseMs: 30 * DAY_MS },   // UN MOIS
  pro: { hoursMs: 160 * HOUR_MS, afterPurchaseMs: 30 * DAY_MS },    // UN MOIS PRO
  year: { hoursMs: 768 * HOUR_MS, afterPurchaseMs: 365 * DAY_MS },  // UN AN
};
const PAID_PLANS = ["day", "weekend", "month", "pro", "year"];

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
  for (const column of ["offline_requests", "session_until", "lifetime", "session_start",
    "session_length", "session_used", "session_beat", "session_done", "show_running",
    "show_used", "show_done"]) {
    try {
      await run(env, `ALTER TABLE kjs ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    } catch (error) {
      if (!String(error && error.message).includes("duplicate column")) throw error;
    }
  }
  // Stock d'heures : ms_left par formule. Formules d'avant (en sessions) :
  // converties une fois (sessions_left remis à 0).
  try {
    await run(env, "ALTER TABLE kj_packs ADD COLUMN ms_left INTEGER NOT NULL DEFAULT 0");
  } catch (error) {
    if (!String(error && error.message).includes("duplicate column")) throw error;
  }
  await run(env, `UPDATE kj_packs SET ms_left = sessions_left * CASE WHEN plan = 'trial'
      THEN ${4 * 3600 * 1000} ELSE ${8 * 3600 * 1000} END, sessions_left = 0
      WHERE sessions_left > 0`);
  // Une seule session offerte par KJ, même si deux requêtes arrivent ensemble.
  await run(env, "CREATE UNIQUE INDEX IF NOT EXISTS kj_packs_trial ON kj_packs(code) WHERE plan = 'trial'");
  // KJ inscrits avant les formules : leur 1re session offerte.
  await run(env, `INSERT OR IGNORE INTO kj_packs (code, plan, sessions_left, ms_left, expires_at, created_at)
      SELECT code, 'trial', 0, ${4 * 3600 * 1000}, 0, ? FROM kjs`, [Date.now()]);
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

// --- Soirée : compteur du stock d'heures --------------------------------------
function showState(kj, now = Date.now()) {
  const running = kj.show_running === 1;
  const graceEnd = kj.show_done ? kj.show_done + GRACE_MS : 0;
  return { running, inGrace: !running && now < graceEnd, graceEnd };
}

function status(kj, now = Date.now()) {
  const online = now - kj.last_heartbeat < ONLINE_MS;
  const active = kj.active === 1;
  const show = showState(kj, now);
  const inSession = show.running;
  const inGrace = show.inGrace;
  return {
    online,
    inSession,
    inGrace,
    // Catalogue consultable : logiciel ouvert, ou option « catalogue hors soirée ».
    browse: active && (online || kj.allow_offline === 1),
    // Demandes acceptées : case « Accepter les demandes » cochée, et logiciel
    // ouvert pendant une session (soirée de 8 h), ou logiciel fermé avec
    // l'option « demandes hors soirée » (avec le catalogue).
    open: active && kj.accepting === 1
      && ((online && (inSession || inGrace))
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
    inGrace: s.inGrace,
    // KJ désabonné : page vide (aucun catalogue).
    catalogVersion: kj.active === 1 ? kj.catalog_version : 0,
    catalogCount: kj.active === 1 ? kj.catalog_count : 0,
    logoVersion: kj.logo ? kj.logo_version : 0,
  }, 200, { ...CORS, "Cache-Control": "no-store" });
}

async function publicCatalog(env, kj) {
  if (kj.active !== 1) {
    return new Response("[]", { headers: { ...CORS, "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store" } });
  }
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

// Formules encore valables, la plus proche de son échéance d'abord.
async function validPacks(env, code, now = Date.now()) {
  return all(env, `SELECT * FROM kj_packs WHERE code = ? AND ms_left > 0
      AND (expires_at = 0 OR expires_at > ?)
      ORDER BY CASE WHEN expires_at > 0 THEN expires_at ELSE 9007199254740991 END, id`,
    [code, now]);
}

// Retire `amount` ms du stock ; renvoie le stock restant.
async function consume(env, code, amount, now = Date.now()) {
  const packs = await validPacks(env, code, now);
  const statements = [];
  let left = amount;
  for (const pack of packs) {
    if (left <= 0) break;
    const take = Math.min(left, pack.ms_left);
    left -= take;
    const def = PLANS[pack.plan] || {};
    // UN JOUR / UN WEEKEND : le délai part de la 1re utilisation.
    const expires = !pack.expires_at && def.afterFirstUseMs ? now + def.afterFirstUseMs : pack.expires_at;
    statements.push(env.REQUEST_DB.prepare(
      "UPDATE kj_packs SET ms_left = ms_left - ?, expires_at = ? WHERE id = ?").bind(take, expires, pack.id));
  }
  if (statements.length) await env.REQUEST_DB.batch(statements);
  return packs.reduce((sum, pack) => sum + pack.ms_left, 0) - (amount - Math.max(left, 0));
}

// Signal de vie du logiciel : décompte le temps de soirée du stock d'heures.
async function heartbeat(env, kj, reportedUsed = 0) {
  const now = Date.now();
  const running = kj.show_running === 1;
  const shown = kj.show_used || 0;
  const reported = Math.max(0, Number(reportedUsed) || 0);
  const ahead = running && reported > shown + HEARTBEAT_WRITE_MS;
  if (now - kj.last_heartbeat < HEARTBEAT_WRITE_MS && !ahead) return;
  if (!running) {
    await run(env, "UPDATE kjs SET last_heartbeat = ? WHERE code = ?", [now, kj.code]);
    return;
  }
  const gap = now - (kj.session_beat || 0);
  if (kj.session_beat && gap > AUTO_END_MS) {
    // Logiciel fermé plus de 6 h : la soirée est terminée (rien de décompté).
    await run(env, `UPDATE kjs SET last_heartbeat = ?, show_running = 0, session_beat = 0,
        serial = serial + 1 WHERE code = ?`, [now, kj.code]);
    return;
  }
  const counted = kj.session_beat && gap <= PAUSE_GAP_MS ? gap : 0;  // sinon : pause
  let used = Math.max(shown + counted, reported);
  let stillRunning = 1;
  let done = kj.show_done || 0;
  if (kj.lifetime !== 1) {
    const left = await consume(env, kj.code, used - shown, now);
    if (left <= 0) {  // stock épuisé : fin de soirée, 2 h de rab
      stillRunning = 0;
      done = now;
    }
  }
  await run(env, `UPDATE kjs SET last_heartbeat = ?, show_used = ?, session_beat = ?,
      show_running = ?, show_done = ?, serial = serial + ? WHERE code = ?`,
    [now, used, stillRunning ? now : 0, stillRunning, done, stillRunning ? 0 : 1, kj.code]);
}

// Stock, soirée et rab, pour le logiciel et karolivekj.com.
async function sessionsSummary(env, kj, now = Date.now()) {
  const packs = await validPacks(env, kj.code, now);
  const stock = packs.reduce((sum, pack) => sum + pack.ms_left, 0);
  const lifetime = kj.lifetime === 1;
  const show = showState(kj, now);
  const running = show.running && (lifetime || stock > 0);
  return {
    showRunning: running,
    showUsed: running ? kj.show_used || 0 : 0,
    hoursLeft: stock,          // ms
    graceUntil: show.inGrace ? show.graceEnd : 0,
    lifetime,
    packs: packs.map(pack => ({ plan: pack.plan, msLeft: pack.ms_left, expiresAt: pack.expires_at })),
    // Anciennes versions du logiciel (sessions de 8 h).
    sessionUntil: running ? now + (lifetime ? SESSION_MS : stock) : 0,
    sessionsLeft: Math.floor(stock / SESSION_MS),
  };
}

async function addPack(env, code, plan, now = Date.now()) {
  const def = PLANS[plan];
  const expires = def.afterPurchaseMs ? now + def.afterPurchaseMs : 0;
  await run(env, `INSERT OR IGNORE INTO kj_packs (code, plan, sessions_left, ms_left, expires_at, created_at)
      VALUES (?, ?, 0, ?, ?, ?)`, [code, plan, def.hoursMs, expires, now]);
}

// « Démarrer ma soirée » : lance le compteur (stock d'heures non vide).
async function startSession(env, kj, now = Date.now()) {
  if (kj.show_running === 1) return { started: false, ...(await sessionsSummary(env, kj, now)) };
  if (kj.lifetime !== 1 && !(await validPacks(env, kj.code, now)).length) return null;
  await run(env, `UPDATE kjs SET show_running = 1, show_used = 0, session_beat = ?, show_done = 0,
      serial = serial + 1 WHERE code = ?`, [now, kj.code]);
  return { started: true, ...(await sessionsSummary(env,
    { ...kj, show_running: 1, show_used: 0, session_beat: now, show_done: 0 }, now)) };
}

// « Terminer ma soirée » : le compteur s'arrête (pas de rab).
async function endSession(env, kj, now = Date.now()) {
  await run(env, `UPDATE kjs SET show_running = 0, session_beat = 0, serial = serial + 1
      WHERE code = ?`, [kj.code]);
  return sessionsSummary(env, { ...kj, show_running: 0, session_beat: 0 }, now);
}

function profileOf(kj) {
  return {
    code: kj.code, name: kj.name, accepting: kj.accepting === 1,
    allowOffline: kj.allow_offline === 1, offlineRequests: kj.offline_requests === 1,
    showRunning: kj.show_running === 1,
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
      await heartbeat(env, kj, data.usedMs);
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
    case "endSession":
      return ok({ sessions: await endSession(env, kj) });
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
  const lifetime = data.lifetime === undefined ? null : (data.lifetime ? 1 : 0);
  if (!existing) {
    if (!email || !keyHash) return json({ error: "email and keyHash required" }, 400);
    await run(env, `INSERT INTO kjs (code, email, key_hash, name, active, lifetime, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [code, email, keyHash, name || "", active === null ? 1 : active, lifetime || 0, Date.now()]);
    await addPack(env, code, "trial");  // 1re session offerte
  } else {
    // Désabonnement (active = 0) : soirée et rab arrêtés, demandes effacées.
    await run(env, `UPDATE kjs SET key_hash = COALESCE(?, key_hash),
        active = COALESCE(?, active), name = COALESCE(?, name),
        lifetime = COALESCE(?, lifetime),
        session_until = CASE WHEN ? = 0 THEN 0 ELSE session_until END,
        show_running = CASE WHEN ? = 0 THEN 0 ELSE show_running END,
        show_used = CASE WHEN ? = 0 THEN 0 ELSE show_used END,
        show_done = CASE WHEN ? = 0 THEN 0 ELSE show_done END,
        serial = serial + 1 WHERE code = ?`,
      [keyHash, active, name, lifetime, active, active, active, active, code]);
    if (active === 0) await run(env, "DELETE FROM kj_requests WHERE code = ?", [code]);
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
    if (!PAID_PLANS.includes(plan)) return json({ error: "invalid plan" }, 400);
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
