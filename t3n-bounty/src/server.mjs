import http from 'node:http';
import {
  T3nClient,
  createEthAuthInput,
  eth_get_address,
  loadWasmComponent,
  metamask_sign,
  setEnvironment,
} from '@terminal3/t3n-sdk';

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
let sessionPromise = null;

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function sendHtml(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/0x[0-9a-fA-F]{64}/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/0x[0-9a-fA-F]{40}/g, '[REDACTED_ADDRESS]')
    .replace(/did:t3n:[A-Za-z0-9:._-]+/g, '[REDACTED_DID]')
    .slice(0, 500);
}

function mask(value) {
  const text = String(value || '');
  if (text.length < 20) return text || 'unavailable';
  return `${text.slice(0, 12)}...${text.slice(-6)}`;
}

async function t3nSession() {
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    const key = process.env.T3N_API_KEY;
    if (!key) throw new Error('T3N_API_KEY_MISSING');

    setEnvironment('sandbox');
    const address = eth_get_address(key);
    const wasmComponent = await loadWasmComponent();
    const client = new T3nClient({
      wasmComponent,
      handlers: {
        EthSign: metamask_sign(address, undefined, key),
      },
    });

    await client.handshake();
    const did = await client.authenticate(createEthAuthInput(address));
    const usage = await client.getUsage();

    return {
      client,
      address,
      did: String(did),
      usage,
      authenticatedAt: new Date().toISOString(),
    };
  })().catch((error) => {
    sessionPromise = null;
    throw error;
  });

  return sessionPromise;
}

function assessOpportunity(input) {
  const reward = Math.max(0, Number(input?.reward ?? 0));
  const humanMinutes = Math.max(0, Number(input?.humanMinutes ?? 0));
  const prefunded = input?.prefunded === true;
  const payoutRail = typeof input?.payoutRail === 'string' ? input.payoutRail.trim() : '';
  const unsupportedIdentity = input?.requiresUnsupportedIdentity === true;
  const physicalAction = input?.requiresPhysicalAction === true;
  const deception = input?.requiresDeception === true;
  const explicitPermission = input?.explicitPermission !== false;

  const allowed = prefunded && reward > 0 && payoutRail && !unsupportedIdentity && !physicalAction && !deception && explicitPermission;
  const score = humanMinutes === 0 ? reward : reward / humanMinutes;

  return {
    allowed: Boolean(allowed),
    reward,
    humanMinutes,
    fundedValuePerHumanMinute: Number(score.toFixed(4)),
    reasons: [
      prefunded ? 'funding committed' : 'funding not verified',
      payoutRail ? `payout rail: ${payoutRail}` : 'payout rail unknown',
      unsupportedIdentity ? 'unsupported identity requirement' : null,
      physicalAction ? 'physical action required' : null,
      deception ? 'deceptive action required' : null,
      explicitPermission ? null : 'permission or scope not established',
    ].filter(Boolean),
  };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

const landing = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>T3N Funded Opportunity Trust Agent</title><style>body{font-family:system-ui,sans-serif;max-width:900px;margin:48px auto;padding:0 20px;background:#0b1020;color:#eaf0ff}article{background:#151d33;border:1px solid #2a3657;border-radius:18px;padding:24px;margin:18px 0}code,pre{background:#090d18;padding:4px 8px;border-radius:8px}a{color:#8ec5ff}.ok{color:#8ff0b5}</style></head><body><h1>T3N Funded Opportunity Trust Agent</h1><p>A trust gate for autonomous revenue work. The server authenticates through the Terminal 3 sandbox, then scores opportunities by funded value per irreducible human-checkpoint minute.</p><article><h2>Live proof</h2><p><a href="/proof">GET /proof</a> returns a redacted T3N identity and credit proof. No API key or private address is returned.</p><p><a href="/health">GET /health</a> reports service status.</p></article><article><h2>Policy endpoint</h2><p><code>POST /assess</code> accepts reward, humanMinutes, prefunded, payoutRail and execution-risk flags. It rejects unfunded, deceptive, physical-action, unsupported-identity or unpermissioned work.</p><pre>{"reward":25,"humanMinutes":5,"prefunded":true,"payoutRail":"Wise USD","explicitPermission":true}</pre></article><article><h2>Why Terminal 3</h2><p>The runtime keeps signing material server-side, opens an encrypted sandbox session, proves the agent identity, and exposes only masked proof metadata to callers.</p></article></body></html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/') {
      return sendHtml(res, 200, landing);
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, service: 't3n-funded-opportunity-trust-agent', now: new Date().toISOString() });
    }

    if (req.method === 'GET' && url.pathname === '/proof') {
      const session = await t3nSession();
      const balance = session?.usage?.balance?.available ?? null;
      return sendJson(res, 200, {
        connected: true,
        environment: 'sandbox',
        did: mask(session.did),
        address: mask(session.address),
        creditsAvailable: balance,
        authenticatedAt: session.authenticatedAt,
      });
    }

    if (req.method === 'POST' && url.pathname === '/assess') {
      const body = await readBody(req);
      const session = await t3nSession();
      const decision = assessOpportunity(body);
      return sendJson(res, 200, {
        ...decision,
        trust: {
          provider: 'Terminal 3',
          environment: 'sandbox',
          did: mask(session.did),
          verifiedAt: new Date().toISOString(),
        },
      });
    }

    return sendJson(res, 404, { error: 'NOT_FOUND' });
  } catch (error) {
    return sendJson(res, 500, { error: safeError(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`T3N funded opportunity trust agent listening on ${HOST}:${PORT}`);
});
