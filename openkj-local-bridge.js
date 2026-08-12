'use strict';

const http = require('http');

const PORT = 3000;
const HOST = '127.0.0.1';
const WORKER_URL = 'https://cloudflare-request-server.amkoud.workers.dev';

const ensureOpenKjApiKey = () => {
  const key = process.env.OPENKJ_API_KEY;
  if (!key || !String(key).trim()) {
    console.error('ERROR: OPENKJ_API_KEY is not set. Export it in the current PowerShell session before starting the bridge.');
    process.exit(1);
  }
  return key;
};

const getAllowedOrigin = (origin) => {
  if (!origin) return 'http://127.0.0.1:5500';
  return origin;
};

const corsHeaders = (origin) => {
  const allowedOrigin = getAllowedOrigin(origin);
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
};

const writeJson = (res, status, body, headers) => {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, headers));
  res.end(JSON.stringify(body));
};

const writeText = (res, status, body, headers) => {
  res.writeHead(status, Object.assign({ 'Content-Type': 'text/plain' }, headers));
  res.end(body);
};

const readRequestBody = (req) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1e6) {
      req.destroy();
      reject(new Error('request body too large'));
    }
  });
  req.on('end', () => resolve(body));
  req.on('error', reject);
});

const normalizeRequestBody = async (req) => {
  const raw = await readRequestBody(req);
  if (!raw || raw.trim() === '') {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error('invalid json');
  }
};

const requestRemote = async (remotePath, payload) => {
  const token = ensureOpenKjApiKey();
  const url = `${WORKER_URL}${remotePath}`;

  console.log(`[bridge] Calling Cloudflare: POST ${remotePath}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  console.log(`[bridge] Cloudflare status for ${remotePath}: ${res.status}`);

  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();

  let parsedBody = null;
  if (text) {
    try {
      parsedBody = JSON.parse(text);
    } catch {
      parsedBody = text;
    }
  }

  if (res.status >= 400 && parsedBody && typeof parsedBody === 'object' && parsedBody !== null) {
    console.error(`[bridge] Cloudflare error for ${remotePath}: ${JSON.stringify(parsedBody)}`);
  } else if (res.status >= 400) {
    console.error(`[bridge] Cloudflare error for ${remotePath}: ${text}`);
  }

  return {
    status: res.status,
    headers: res.headers,
    body: parsedBody,
    rawText: text,
  };
};

const transformWorkerResponse = (responseBody, statusCode) => {
  if (!responseBody || typeof responseBody !== 'object') {
    return { status: statusCode, body: responseBody };
  }

  const body = { ...responseBody };
  const normalizeRequestEntry = (entry) => {
    if (!entry || typeof entry !== 'object') {
      return entry;
    }

    const result = { ...entry };

    if (Object.prototype.hasOwnProperty.call(result, 'key_change')) {
      const normalizedKeyChange = Number(result.key_change);
      if (!Number.isNaN(normalizedKeyChange)) {
        result.key_change = normalizedKeyChange;
      }
    }

    if (Object.prototype.hasOwnProperty.call(result, 'created_at')) {
      result.request_time = Math.floor(Number(result.created_at) / 1000);
      delete result.created_at;
    }

    return result;
  };

  if (Array.isArray(body.requests)) {
    body.requests = body.requests.map(normalizeRequestEntry);
  }

  if (body.requests && typeof body.requests === 'object' && Array.isArray(body.requests.results)) {
    body.requests = body.requests.results.map(normalizeRequestEntry);
  }

  return { status: statusCode, body };
};

const handleOpenKjCommand = async (payload) => {
  const command = typeof payload.command === 'string' ? payload.command : '';

  switch (command) {
    case 'connectionTest':
    case 'getSerial':
    case 'getAccepting':
    case 'setAccepting':
    case 'getVenues':
    case 'getRequests':
    case 'deleteRequest':
    case 'clearRequests':
    case 'addSongs':
    case 'clearDatabase':
      return requestRemote('/', payload);
    default:
      return {
        status: 400,
        body: { command: command || null, error: 'unsupported command' },
      };
  }
};

const isRequestSubmission = (payload) => {
  return payload &&
    typeof payload === 'object' &&
    !Object.prototype.hasOwnProperty.call(payload, 'command');
};

const validateRequestSubmission = (payload) => {
  const artist = typeof payload.artist === 'string' ? payload.artist.trim() : '';
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const singer = typeof payload.singer === 'string' ? payload.singer.trim() : '';

  let keyChange = payload.keyChange;
  if (keyChange === undefined || keyChange === null) {
    keyChange = 'Normal';
  }

  const parseKeyChange = (value) => {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      if (value.toLowerCase() === 'normal') return 'Normal';
      const parsed = parseInt(value, 10);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return null;
  };

  const normalizedKey = parseKeyChange(keyChange);

  if (!artist) return { ok: false, status: 400, body: { status: 'error', message: 'missing artist' } };
  if (!title) return { ok: false, status: 400, body: { status: 'error', message: 'missing title' } };
  if (!singer) return { ok: false, status: 400, body: { status: 'error', message: 'missing singer' } };
  if (normalizedKey === null) return { ok: false, status: 400, body: { status: 'error', message: 'invalid keyChange' } };
  if (typeof normalizedKey === 'number' && (normalizedKey < -12 || normalizedKey > 12)) {
    return { ok: false, status: 400, body: { status: 'error', message: 'keyChange out of range' } };
  }

  return {
    ok: true,
    body: {
      artist,
      title,
      singer,
      keyChange: normalizedKey,
    },
  };
};

const createServer = () => {
  const server = http.createServer(async (req, res) => {
    const headers = corsHeaders(req.headers.origin);
    const localUrl = req.url || '/';

    console.log(`[bridge] Local request received: ${req.method} ${localUrl}`);

    if (req.method === 'OPTIONS') {
      console.log('[bridge] Handling local OPTIONS without Cloudflare call');
      res.writeHead(204, headers);
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      console.log('[bridge] Local 404 for unsupported HTTP method');
      writeText(res, 404, 'Not Found', headers);
      return;
    }

    if (localUrl !== '/' && localUrl !== '/request') {
      console.log(`[bridge] Local 404 for route: ${localUrl}`);
      writeText(res, 404, 'Not Found', headers);
      return;
    }

    let payload;
    try {
      payload = await normalizeRequestBody(req);
    } catch (error) {
      console.log('[bridge] Invalid JSON received locally');
      writeJson(res, 400, { status: 'error', message: 'invalid json' }, headers);
      return;
    }

    if (payload && typeof payload.command === 'string') {
      const remoteResponse = await handleOpenKjCommand(payload);
      if (remoteResponse.status >= 400) {
        writeJson(res, remoteResponse.status, remoteResponse.body || { error: 'cloudflare error' }, headers);
        return;
      }
      const transformed = transformWorkerResponse(remoteResponse.body, remoteResponse.status);
      writeJson(res, transformed.status, transformed.body, headers);
      return;
    }

    if (!isRequestSubmission(payload)) {
      writeJson(res, 400, { status: 'error', message: 'invalid json' }, headers);
      return;
    }

    const validation = validateRequestSubmission(payload);
    if (!validation.ok) {
      writeJson(res, validation.status, validation.body, headers);
      return;
    }

    const remoteResponse = await requestRemote('/request', validation.body);
    if (remoteResponse.status >= 400) {
      const responseBody = remoteResponse.body && typeof remoteResponse.body === 'object'
        ? remoteResponse.body
        : { status: 'error', message: remoteResponse.rawText || 'cloudflare error' };
      writeJson(res, remoteResponse.status, responseBody, headers);
      return;
    }

    const transformed = transformWorkerResponse(remoteResponse.body, remoteResponse.status);
    writeJson(res, transformed.status, transformed.body, headers);
  });

  return server;
};

const startBridge = () => {
  const key = ensureOpenKjApiKey();
  console.log('[bridge] Starting OpenKJ local bridge');
  console.log(`[bridge] Target Cloudflare worker: ${WORKER_URL}`);
  console.log(`[bridge] Local listen address: http://${HOST}:${PORT}`);
  console.log('[bridge] Authorization uses process.env.OPENKJ_API_KEY without exposing the value');

  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`[bridge] Bridge ready and listening on http://${HOST}:${PORT}`);
  });

  const shutdown = () => {
    console.log('[bridge] Shutting down bridge');
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
};

if (require.main === module) {
  startBridge();
}

module.exports = { startBridge, createServer, WORKER_URL };
