import net from 'node:net';

const HARDCODED_ADDRESS = 'bc1qtlqwdh6va8x50ax5nmgt4hq8ca66qsrv9l4k0c';
const host = process.env.POOL_HOST || 'stratum.ckpool.org';
const port = Number(process.env.POOL_PORT || 3333);
const address = process.env.BTC_ADDRESS || HARDCODED_ADDRESS;
const worker = process.env.WORKER_NAME || 'probe';
const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS || 12_000);

const username = `${address}.${worker}`;
const socket = net.createConnection({ host, port });
let buffer = '';
let id = 1;
let gotSubscribe = false;
let gotAuthorize = false;
let gotJob = false;

const timer = setTimeout(() => {
  console.error(JSON.stringify({ ok: false, error: 'probe timeout', gotSubscribe, gotAuthorize, gotJob, username }, null, 2));
  socket.destroy();
  process.exitCode = 1;
}, timeoutMs);

function send(method, params) {
  socket.write(JSON.stringify({ id: id++, method, params }) + '\n');
}

socket.on('connect', () => {
  console.log(JSON.stringify({ event: 'connected', pool: `${host}:${port}`, username }));
  send('mining.subscribe', ['ckpool-http-bridge-probe/1.1']);
});

socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  for (;;) {
    const idx = buffer.indexOf('\n');
    if (idx < 0) break;
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    console.log(JSON.stringify(msg));
    if (msg.id === 1 && !msg.error) {
      gotSubscribe = true;
      send('mining.authorize', [username, 'x']);
    } else if (msg.id === 2 && msg.result === true) {
      gotAuthorize = true;
    } else if (msg.method === 'mining.notify') {
      gotJob = true;
      clearTimeout(timer);
      console.log(JSON.stringify({ ok: true, gotSubscribe, gotAuthorize, gotJob, username }));
      socket.end();
    }
  }
});

socket.on('error', (err) => {
  clearTimeout(timer);
  console.error(JSON.stringify({ ok: false, error: err.message, code: err.code || null, username }, null, 2));
  process.exitCode = 1;
});
