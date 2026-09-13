import net from 'node:net';
import crypto from 'node:crypto';

const ADDRESS = 'bc1qtlqwdh6va8x50ax5nmgt4hq8ca66qsrv9l4k0c';
const HOST = process.env.POOL_HOST || 'uesolo.ckpool.org';
const PORT = Number(process.env.POOL_PORT || 3333);
const USERNAME = `${ADDRESS}.${process.env.WORKER_NAME || 'proof'}`;
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 20000);

const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const dsha = (b) => sha256(sha256(b));

function readVarInt(buf, state) {
  const first = buf[state.i++];
  if (first < 0xfd) return first;
  if (first === 0xfd) { const v = buf.readUInt16LE(state.i); state.i += 2; return v; }
  if (first === 0xfe) { const v = buf.readUInt32LE(state.i); state.i += 4; return v; }
  const v = Number(buf.readBigUInt64LE(state.i)); state.i += 8; return v;
}

function parseOutputs(tx) {
  const s = { i: 0 };
  s.i += 4;
  const vin = readVarInt(tx, s);
  for (let n = 0; n < vin; n++) {
    s.i += 32 + 4;
    const scriptLen = readVarInt(tx, s);
    s.i += scriptLen + 4;
  }
  const vout = readVarInt(tx, s);
  const outputs = [];
  for (let n = 0; n < vout; n++) {
    const value = tx.readBigUInt64LE(s.i); s.i += 8;
    const scriptLen = readVarInt(tx, s);
    const script = tx.subarray(s.i, s.i + scriptLen); s.i += scriptLen;
    outputs.push({ value, script });
  }
  return outputs;
}

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= gen[i];
    chk >>>= 0;
  }
  return chk >>> 0;
}
function hrpExpand(hrp) {
  return [...hrp].map(c => c.charCodeAt(0) >>> 5).concat([0], [...hrp].map(c => c.charCodeAt(0) & 31));
}
function convertBits(data, fromBits, toBits, pad) {
  let acc = 0, bits = 0;
  const out = [], maxv = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >>> bits) & maxv);
    }
    acc &= (1 << Math.min(bits + fromBits, 30)) - 1;
  }
  if (pad && bits) out.push((acc << (toBits - bits)) & maxv);
  else if (!pad && (bits >= fromBits || ((acc << (toBits - bits)) & maxv))) throw new Error('invalid convertbits padding');
  return out;
}
function decodeSegwitAddress(addr) {
  const pos = addr.lastIndexOf('1');
  if (pos < 1) throw new Error('invalid bech32 separator');
  const hrp = addr.slice(0, pos);
  const values = [...addr.slice(pos + 1)].map(c => CHARSET.indexOf(c));
  if (values.some(v => v < 0) || polymod(hrpExpand(hrp).concat(values)) !== 1) throw new Error('invalid bech32 checksum');
  const data = values.slice(0, -6);
  const version = data[0];
  const program = Buffer.from(convertBits(data.slice(1), 5, 8, false));
  return { hrp, version, program };
}

function swab32(hex) {
  const b = Buffer.from(hex, 'hex');
  const out = Buffer.alloc(b.length);
  for (let i = 0; i < b.length; i += 4) {
    out[i] = b[i + 3]; out[i + 1] = b[i + 2]; out[i + 2] = b[i + 1]; out[i + 3] = b[i];
  }
  return out;
}
function le32FromHex(hex) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number.parseInt(hex, 16) >>> 0);
  return b;
}
function targetFromNBits(hex) {
  const n = Number.parseInt(hex, 16) >>> 0;
  const exponent = n >>> 24;
  const coefficient = n & 0x007fffff;
  return BigInt(coefficient) << BigInt(8 * (exponent - 3));
}

let socket;
let buffer = '';
let nextId = 1;
let extranonce1 = null;
let extranonce2Size = null;
let difficulty = null;
let authorized = false;
let job = null;
let finished = false;

function send(method, params) {
  socket.write(`${JSON.stringify({ id: nextId++, method, params })}\n`);
}
function maybeFinish() {
  if (finished || !authorized || !job || !extranonce1 || extranonce2Size == null) return;
  finished = true;
  clearTimeout(timer);

  const extranonce2 = '00'.repeat(extranonce2Size);
  const coinbaseHex = job.coinb1 + extranonce1 + extranonce2 + job.coinb2;
  const coinbase = Buffer.from(coinbaseHex, 'hex');
  const outputs = parseOutputs(coinbase);
  const decoded = decodeSegwitAddress(ADDRESS);
  const expectedScript = Buffer.concat([Buffer.from([decoded.version, decoded.program.length]), decoded.program]);
  const payout = outputs.find(o => o.script.equals(expectedScript));

  let merkle = dsha(coinbase);
  for (const branch of job.merkleBranch) merkle = dsha(Buffer.concat([merkle, Buffer.from(branch, 'hex')]));

  const nonce = 0;
  const nonceBuf = Buffer.alloc(4); nonceBuf.writeUInt32LE(nonce);
  const header = Buffer.concat([
    le32FromHex(job.version),
    swab32(job.prevHash),
    merkle,
    le32FromHex(job.nBits),
  ]);

  // nTime precedes nBits in an 80-byte Bitcoin header; rebuild the final prefix explicitly.
  const header80 = Buffer.concat([
    le32FromHex(job.version),
    swab32(job.prevHash),
    merkle,
    le32FromHex(job.nTime),
    le32FromHex(job.nBits),
    nonceBuf,
  ]);
  if (header80.length !== 80) throw new Error(`header length ${header80.length}`);
  void header;

  const hashRaw = dsha(header80);
  const hashDisplay = Buffer.from(hashRaw).reverse().toString('hex');
  const hashInt = BigInt(`0x${hashDisplay}`);
  const target = targetFromNBits(job.nBits);
  const totalReward = outputs.reduce((a, o) => a + o.value, 0n);

  const result = {
    ok: true,
    pool: `${HOST}:${PORT}`,
    username: USERNAME,
    authorized,
    difficulty,
    extranonce1,
    extranonce2,
    extranonce2Size,
    job,
    payoutAddress: ADDRESS,
    payoutScript: expectedScript.toString('hex'),
    payoutMatched: Boolean(payout),
    payoutSats: payout ? payout.value.toString() : null,
    outputs: outputs.map(o => ({ sats: o.value.toString(), script: o.script.toString('hex') })),
    totalRewardSats: totalReward.toString(),
    coinbaseHex,
    coinbaseTxid: Buffer.from(dsha(coinbase)).reverse().toString('hex'),
    merkleRoot: Buffer.from(merkle).reverse().toString('hex'),
    nonce,
    headerHex: header80.toString('hex'),
    sampleHash: hashDisplay,
    networkTarget: target.toString(16).padStart(64, '0'),
    isMainnetBlock: hashInt <= target,
  };
  console.log(`LIVE_JOB_PROOF=${JSON.stringify(result)}`);
  socket.end();
}

socket = net.createConnection({ host: HOST, port: PORT });
const timer = setTimeout(() => {
  console.error(JSON.stringify({ ok: false, error: 'timeout', authorized, gotJob: Boolean(job) }));
  socket.destroy();
  process.exitCode = 1;
}, TIMEOUT_MS);

socket.on('connect', () => send('mining.subscribe', ['ckpool-live-job-proof/1.0']));
socket.on('data', chunk => {
  buffer += chunk.toString('utf8');
  for (;;) {
    const idx = buffer.indexOf('\n');
    if (idx < 0) break;
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === 1 && !msg.error) {
      extranonce1 = msg.result?.[1] ?? null;
      extranonce2Size = Number(msg.result?.[2]);
      send('mining.authorize', [USERNAME, 'x']);
    } else if (msg.id === 2) {
      if (msg.result !== true) throw new Error(`authorization failed: ${JSON.stringify(msg)}`);
      authorized = true;
    } else if (msg.method === 'mining.set_difficulty') {
      difficulty = Number(msg.params?.[0]);
    } else if (msg.method === 'mining.notify') {
      const p = msg.params || [];
      job = {
        jobId: p[0], prevHash: p[1], coinb1: p[2], coinb2: p[3], merkleBranch: p[4] || [],
        version: p[5], nBits: p[6], nTime: p[7], cleanJobs: Boolean(p[8]),
      };
    }
    maybeFinish();
  }
});
socket.on('error', err => {
  clearTimeout(timer);
  console.error(JSON.stringify({ ok: false, error: err.message, code: err.code || null }));
  process.exitCode = 1;
});
