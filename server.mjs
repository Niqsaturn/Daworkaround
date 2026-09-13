import http from 'node:http';
import { URL } from 'node:url';
import { StratumSession, createSessionId } from './stratum-session.mjs';
import { ManagedStratumSession } from './managed-session.mjs';

const HARDCODED_ADDRESS = 'bc1qtlqwdh6va8x50ax5nmgt4hq8ca66qsrv9l4k0c';
const HOST = process.env.BIND_HOST || (process.env.RAILWAY_ENVIRONMENT ? '0.0.0.0' : '127.0.0.1');
const PORT = Number(process.env.PORT || process.env.HTTP_PORT || 8787);
const POOL_HOST = process.env.POOL_HOST || 'stratum.ckpool.org';
const POOL_PORT = Number(process.env.POOL_PORT || 3333);
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';
const DEFAULT_ADDRESS = process.env.BTC_ADDRESS || HARDCODED_ADDRESS;
const DEFAULT_WORKER = process.env.WORKER_NAME || 'chatgpt';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 6 * 60 * 60 * 1000);
const AUTO_CONNECT = !['0', 'false', 'no'].includes(String(process.env.AUTO_CONNECT || 'true').toLowerCase());

const sessions = new Map();
const managed = new ManagedStratumSession({
  host: POOL_HOST,
  port: POOL_PORT,
  address: DEFAULT_ADDRESS,
  worker: DEFAULT_WORKER,
  password: process.env.POOL_PASSWORD || 'x',
});

function setCors(res) {
  const allowOrigin = process.env.ALLOW_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-bridge-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
}

function sendJson(res, status, data) {
  setCors(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

function authorized(req, url) {
  if (!BRIDGE_TOKEN) return true;
  const auth = req.headers.authorization;
  const headerToken = req.headers['x-bridge-token'];
  const queryToken = url.searchParams.get('token');
  return auth === `Bearer ${BRIDGE_TOKEN}` || headerToken === BRIDGE_TOKEN || queryToken === BRIDGE_TOKEN;
}

async function readJson(req, limit = 64 * 1024) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function getSession(id) {
  const entry = sessions.get(id);
  if (!entry) return null;
  entry.touchedAt = Date.now();
  return entry.session;
}

async function longPollEvents(source, after, wait) {
  let events = source.getEventsAfter(after);
  if (events.length || wait <= 0) return events;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(source.getEventsAfter(after)); }, wait);
    const onEvent = () => { cleanup(); resolve(source.getEventsAfter(after)); };
    const cleanup = () => { clearTimeout(timer); source.off('event', onEvent); };
    source.on('event', onEvent);
  });
}

function parseShare(body) {
  return {
    jobId: String(body.jobId || ''),
    extranonce2: String(body.extranonce2 || ''),
    ntime: String(body.ntime || ''),
    nonce: String(body.nonce || ''),
  };
}

function startCleanup() {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of sessions) {
      if (now - entry.touchedAt > SESSION_TTL_MS || !entry.session.connected) {
        entry.session.close();
        sessions.delete(id);
      }
    }
  }, 60_000);
  timer.unref();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  setCors(res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  if (url.pathname === '/' && req.method === 'GET') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><meta charset="utf-8"><title>CKPool HTTP Bridge</title><style>body{font:16px system-ui;max-width:880px;margin:40px auto;padding:0 16px;background:#0d1117;color:#e6edf3}code,pre{background:#161b22}pre{white-space:pre-wrap;padding:16px;border-radius:8px}</style><h1>CKPool HTTP Bridge</h1><p>Persistent HTTPS/JSON → Stratum V1 bridge. Pool: <code>${POOL_HOST}:${POOL_PORT}</code>.</p><p>Default managed worker starts automatically and reconnects if CKPool drops the socket.</p><pre>GET /health\nGET /v1/default\nGET /v1/default/events?after=0&wait=20000\nPOST /v1/default/submit\nPOST /v1/default/reconnect\n\nPOST /v1/session\nGET /v1/session/:id\nGET /v1/session/:id/events?after=0&wait=20000\nPOST /v1/session/:id/submit\nDELETE /v1/session/:id</pre>`);
    return;
  }

  if (url.pathname === '/health' && req.method === 'GET') {
    const state = managed.snapshot();
    sendJson(res, 200, {
      ok: true,
      pool: `${POOL_HOST}:${POOL_PORT}`,
      sessions: sessions.size,
      managedOnline: state.online,
      managedConnecting: state.connecting,
      managedLastError: state.lastError,
      authRequired: Boolean(BRIDGE_TOKEN),
    });
    return;
  }

  if (!authorized(req, url)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  try {
    if (url.pathname === '/v1/default' && req.method === 'GET') {
      sendJson(res, 200, { status: managed.snapshot() });
      return;
    }

    if (url.pathname === '/v1/default/events' && req.method === 'GET') {
      const after = Number(url.searchParams.get('after') || 0);
      const wait = Math.min(25_000, Math.max(0, Number(url.searchParams.get('wait') || 0)));
      const events = await longPollEvents(managed, after, wait);
      sendJson(res, 200, { events, lastSeq: managed.seq });
      return;
    }

    if (url.pathname === '/v1/default/submit' && req.method === 'POST') {
      const body = await readJson(req);
      const result = await managed.submit(parseShare(body));
      sendJson(res, 200, result);
      return;
    }

    if (url.pathname === '/v1/default/reconnect' && req.method === 'POST') {
      managed.reconnectNow();
      try { await managed.waitUntilOnline(Number(url.searchParams.get('wait') || 12_000)); } catch { /* snapshot carries error */ }
      sendJson(res, 200, { status: managed.snapshot() });
      return;
    }

    if (url.pathname === '/v1/session' && req.method === 'POST') {
      const body = await readJson(req);
      const address = String(body.address || DEFAULT_ADDRESS || '').trim();
      const worker = String(body.worker || DEFAULT_WORKER || 'chatgpt').trim();
      if (!address) { sendJson(res, 400, { error: 'address is required' }); return; }
      const id = createSessionId();
      const session = new StratumSession({
        host: POOL_HOST,
        port: POOL_PORT,
        address,
        worker,
        password: String(body.password || 'x'),
      });
      sessions.set(id, { session, touchedAt: Date.now() });
      try {
        await session.connect();
      } catch (err) {
        session.close();
        sessions.delete(id);
        throw err;
      }
      let job = null;
      try { job = await session.waitForJob(Number(body.jobWaitMs || 10_000)); } catch { /* snapshot remains useful */ }
      sendJson(res, 201, { sessionId: id, job, status: session.snapshot() });
      return;
    }

    const match = url.pathname.match(/^\/v1\/session\/([^/]+)(?:\/(events|submit))?$/);
    if (match) {
      const id = match[1];
      const action = match[2] || '';
      const session = getSession(id);
      if (!session) { sendJson(res, 404, { error: 'session not found' }); return; }

      if (!action && req.method === 'GET') {
        sendJson(res, 200, { sessionId: id, status: session.snapshot() });
        return;
      }
      if (!action && req.method === 'DELETE') {
        session.close();
        sessions.delete(id);
        sendJson(res, 200, { closed: true });
        return;
      }
      if (action === 'events' && req.method === 'GET') {
        const after = Number(url.searchParams.get('after') || 0);
        const wait = Math.min(25_000, Math.max(0, Number(url.searchParams.get('wait') || 0)));
        const events = await longPollEvents(session, after, wait);
        sendJson(res, 200, { events, lastSeq: session.seq });
        return;
      }
      if (action === 'submit' && req.method === 'POST') {
        const body = await readJson(req);
        const result = await session.submit(parseShare(body));
        sendJson(res, 200, result);
        return;
      }
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    sendJson(res, 500, { error: err?.message || String(err) });
  }
});

startCleanup();
if (AUTO_CONNECT) managed.start();

server.listen(PORT, HOST, () => {
  console.log(`CKPool HTTP bridge listening on http://${HOST}:${PORT}`);
  console.log(`Upstream pool: ${POOL_HOST}:${POOL_PORT}`);
  console.log(`Default payout worker: ${DEFAULT_ADDRESS}.${DEFAULT_WORKER}`);
  console.log(`Managed auto-connect: ${AUTO_CONNECT ? 'enabled' : 'disabled'}`);
  console.log(BRIDGE_TOKEN ? 'API authentication: enabled' : 'API authentication: DISABLED (set BRIDGE_TOKEN before exposing publicly)');
});

function shutdown() {
  managed.stop();
  for (const [, entry] of sessions) entry.session.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
