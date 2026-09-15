const parseAllowedOrigins = value => String(value || "http://127.0.0.1:5500").split(",").map(s => s.trim()).filter(Boolean);

const makeCorsHeaders = (origin, allowedOrigins) => {
  const allowedOrigin = allowedOrigins.includes(origin) ? origin : null;
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-Token",
  };
  if (allowedOrigin) {
    headers["Access-Control-Allow-Origin"] = allowedOrigin;
    headers.Vary = "Origin";
  }
  return headers;
};

const getEnv = env => ({
  allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS),
  requestEndpointToken: env.REQUEST_ENDPOINT_TOKEN,
  openKjApiKey: env.OPENKJ_API_KEY,
});

const dbRun = async (env, sql, params = []) => env.REQUEST_DB.prepare(sql).run(params);
const dbGet = async (env, sql, params = []) => env.REQUEST_DB.prepare(sql).first(params);
const dbAll = async (env, sql, params = []) => env.REQUEST_DB.prepare(sql).all(params);

const initSchema = async env => {
  await dbRun(env, `CREATE TABLE IF NOT EXISTS requests (
    request_id TEXT PRIMARY KEY,
    artist TEXT NOT NULL,
    title TEXT NOT NULL,
    singer TEXT NOT NULL,
    key_change TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);

  await dbRun(env, `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  const serialRow = await dbGet(env, `SELECT value FROM meta WHERE key = ?`, ["serial"]);
  if (!serialRow) {
    await dbRun(env, `INSERT INTO meta(key, value) VALUES(?, ?)`, ["serial", "1"]);
  }

  const acceptingRow = await dbGet(env, `SELECT value FROM meta WHERE key = ?`, ["accepting"]);
  if (!acceptingRow) {
    await dbRun(env, `INSERT INTO meta(key, value) VALUES(?, ?)`, ["accepting", "true"]);
  }
};

const ensureSchema = async env => {
  try {
    await initSchema(env);
  } catch (error) {
    console.error("Failed to initialize schema", error);
    throw error;
  }
};

const getMetaValue = async (env, key) => {
  const row = await dbGet(env, `SELECT value FROM meta WHERE key = ?`, [key]);
  return row?.value ?? null;
};

const setMetaValue = async (env, key, value) => {
  await dbRun(env, `INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)`, [key, String(value)]);
};

const getSerial = async env => {
  const value = await getMetaValue(env, "serial");
  const serial = parseInt(value, 10);
  return Number.isFinite(serial) ? serial : 1;
};

const incrementSerial = async env => {
  const current = await getSerial(env);
  const next = current + 1;
  await setMetaValue(env, "serial", next);
  return next;
};

const isAccepting = async env => {
  const value = await getMetaValue(env, "accepting");
  return value !== "false";
};

const setAccepting = async (env, accepting) => {
  await setMetaValue(env, "accepting", accepting ? "true" : "false");
  return accepting;
};

const generateRequestId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

const parseKeyChange = value => {
  if (value === undefined || value === null) {
    return "Normal";
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized.length === 0) {
      return "Normal";
    }
    if (/^[-+]?(?:\d+)$/.test(normalized)) {
      const parsed = parseInt(normalized, 10);
      return Number.isNaN(parsed) ? null : parsed;
    }
    return normalized.toLowerCase() === "normal" ? "Normal" : null;
  }
  return null;
};

const validateOpenKjAuth = (request, openKjApiKey) => {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  return openKjApiKey && token && token === openKjApiKey;
};

const validateRequestToken = (request, requestEndpointToken) => {
  if (!requestEndpointToken) {
    return true;
  }
  const token = request.headers.get("X-Request-Token") || "";
  return token === requestEndpointToken;
};

const jsonResponse = (body, status = 200, headers = {}) => {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
};

const buildErrorResponse = (body, status, headers) => {
  return jsonResponse(body, status, headers);
};

const handleOpenKjCommand = async (env, data, corsHeaders) => {
  const command = typeof data.command === "string" ? data.command : "";
  switch (command) {
    case "connectionTest":
      return jsonResponse({ command: "connectionTest", error: "" }, 200, corsHeaders);
    case "getSerial": {
      const serial = await getSerial(env);
      return jsonResponse({ command: "getSerial", error: "", serial }, 200, corsHeaders);
    }
    case "getAccepting": {
      const accepting = await isAccepting(env);
      return jsonResponse({ command: "getAccepting", error: "", accepting }, 200, corsHeaders);
    }
    case "setAccepting": {
      const accepting = data.accepting === true || data.accepting === "true";
      await setAccepting(env, accepting);
      return jsonResponse({ command: "setAccepting", error: "", accepting }, 200, corsHeaders);
    }
    case "getVenues": {
      const accepting = await isAccepting(env);
      return jsonResponse({
        command: "getVenues",
        error: "",
        venues: [{ venue_id: "FLORIBARBASILIX", name: "FLORIBARBASILIX", accepting }]
      }, 200, corsHeaders);
    }
    case "getRequests": {
      const requests = await dbAll(env, `SELECT request_id, artist, title, singer, key_change AS key_change, created_at FROM requests ORDER BY created_at ASC`);
      const serial = await getSerial(env);
      return jsonResponse({ command: "getRequests", error: "", requests, serial }, 200, corsHeaders);
    }
    case "clearRequests": {
      await dbRun(env, `DELETE FROM requests`);
      await incrementSerial(env);
      return jsonResponse({ command: "clearRequests", error: "" }, 200, corsHeaders);
    }
    case "deleteRequest": {
      const request_id = typeof data.request_id === "string" ? data.request_id : "";
      if (!request_id) {
        return buildErrorResponse({ command: "deleteRequest", error: "missing request_id" }, 400, corsHeaders);
      }
      const result = await dbRun(env, `DELETE FROM requests WHERE request_id = ?`, [request_id]);
      if (!result.changes || result.changes === 0) {
        return buildErrorResponse({ command: "deleteRequest", error: "request not found" }, 404, corsHeaders);
      }
      await incrementSerial(env);
      return jsonResponse({ command: "deleteRequest", error: "", request_id }, 200, corsHeaders);
    }
    case "addSongs":
      return jsonResponse({ command: "addSongs", error: "" }, 200, corsHeaders);
    case "clearDatabase":
      return jsonResponse({ command: "clearDatabase", error: "" }, 200, corsHeaders);
    default:
      return buildErrorResponse({ command: command || null, error: "unsupported command" }, 400, corsHeaders);
  }
};

const handleRequestSubmission = async (env, request, data, corsHeaders, requestEndpointToken) => {
  const artist = typeof data.artist === "string" ? data.artist.trim() : "";
  const title = typeof data.title === "string" ? data.title.trim() : "";
  const singer = typeof data.singer === "string" ? data.singer.trim() : "";
  const keyChange = parseKeyChange(data.keyChange);

  if (!artist) {
    return buildErrorResponse({ status: "error", message: "missing artist" }, 400, corsHeaders);
  }
  if (!title) {
    return buildErrorResponse({ status: "error", message: "missing title" }, 400, corsHeaders);
  }
  if (!singer) {
    return buildErrorResponse({ status: "error", message: "missing singer" }, 400, corsHeaders);
  }
  if (keyChange === null) {
    return buildErrorResponse({ status: "error", message: "invalid keyChange" }, 400, corsHeaders);
  }
  if (typeof keyChange === "number" && (keyChange < -12 || keyChange > 12)) {
    return buildErrorResponse({ status: "error", message: "keyChange out of range" }, 400, corsHeaders);
  }

  const accepting = await isAccepting(env);
  if (!accepting) {
    return buildErrorResponse({ status: "error", message: "requests not accepted" }, 403, corsHeaders);
  }

  if (!validateRequestToken(request, requestEndpointToken)) {
    return buildErrorResponse({ status: "error", message: "invalid request token" }, 401, corsHeaders);
  }

  await dbRun(env, `INSERT INTO requests(request_id, artist, title, singer, key_change, created_at) VALUES(?, ?, ?, ?, ?, ?)`, [
    generateRequestId(), artist, title, singer, String(keyChange), Date.now()
  ]);
  await incrementSerial(env);
  return jsonResponse({ status: "ok" }, 200, corsHeaders);
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const { allowedOrigins, requestEndpointToken, openKjApiKey } = getEnv(env);
    const corsHeaders = makeCorsHeaders(origin, allowedOrigins);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    await ensureSchema(env);

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/accepting-status") {
      const accepting = await isAccepting(env);
      return jsonResponse({ accepting }, 200, corsHeaders);
    }

    if (request.method === "POST" && url.pathname === "/") {
      if (!validateOpenKjAuth(request, openKjApiKey)) {
        return buildErrorResponse({ command: null, error: "unauthorized" }, 401, corsHeaders);
      }

      let data;
      try {
        data = await request.json();
      } catch {
        return buildErrorResponse({ command: null, error: "invalid json" }, 400, corsHeaders);
      }
      return handleOpenKjCommand(env, data, corsHeaders);
    }

    if (request.method === "POST" && url.pathname === "/request") {
      let data;
      try {
        data = await request.json();
      } catch {
        return buildErrorResponse({ status: "error", message: "invalid json" }, 400, corsHeaders);
      }
      return handleRequestSubmission(env, request, data, corsHeaders, requestEndpointToken);
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }
};
