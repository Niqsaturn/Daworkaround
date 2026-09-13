import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const DEFAULT_TIMEOUT_MS = 12_000;

function safeHex(value, bytes = null) {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]+$/.test(value)) return false;
  if (bytes !== null && value.length !== bytes * 2) return false;
  return true;
}

export class StratumSession extends EventEmitter {
  constructor({ host, port, address, worker = 'chatgpt', password = 'x', connectTimeoutMs = DEFAULT_TIMEOUT_MS }) {
    super();
    this.host = host;
    this.port = Number(port);
    this.address = address;
    this.worker = worker;
    this.username = worker ? `${address}.${worker}` : address;
    this.password = password;
    this.connectTimeoutMs = connectTimeoutMs;

    this.socket = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.seq = 0;
    this.maxEvents = 512;

    this.connected = false;
    this.subscribed = false;
    this.authorized = false;
    this.extranonce1 = null;
    this.extranonce2Size = null;
    this.difficulty = null;
    this.latestJob = null;
    this.lastError = null;
    this.startedAt = Date.now();
    this.lastMessageAt = null;
    this.shares = { submitted: 0, accepted: 0, rejected: 0 };
  }

  _record(type, data = {}) {
    const event = { seq: ++this.seq, at: new Date().toISOString(), type, ...data };
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    this.emit('event', event);
    return event;
  }

  getEventsAfter(after = 0) {
    const n = Number(after) || 0;
    return this.events.filter((e) => e.seq > n);
  }

  snapshot() {
    return {
      connected: this.connected,
      subscribed: this.subscribed,
      authorized: this.authorized,
      username: this.username,
      pool: `${this.host}:${this.port}`,
      extranonce1: this.extranonce1,
      extranonce2Size: this.extranonce2Size,
      difficulty: this.difficulty,
      latestJob: this.latestJob,
      shares: { ...this.shares },
      lastError: this.lastError,
      startedAt: new Date(this.startedAt).toISOString(),
      lastMessageAt: this.lastMessageAt ? new Date(this.lastMessageAt).toISOString() : null,
      lastSeq: this.seq,
    };
  }

  async connect() {
    if (this.socket) throw new Error('session already started');
    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setKeepAlive(true, 15_000);
    socket.setNoDelay(true);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`connect timeout to ${this.host}:${this.port}`)), this.connectTimeoutMs);
      const cleanup = () => clearTimeout(timer);
      socket.once('connect', () => { cleanup(); resolve(); });
      socket.once('error', (err) => { cleanup(); reject(err); });
    });

    this.connected = true;
    this._record('connected', { pool: `${this.host}:${this.port}` });
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => {
      this.lastError = err.message;
      this._record('socket_error', { error: err.message });
    });
    socket.on('close', () => {
      this.connected = false;
      this._record('disconnected');
      for (const [, pending] of this.pending) pending.reject(new Error('upstream connection closed'));
      this.pending.clear();
    });

    const sub = await this.request('mining.subscribe', ['ckpool-http-bridge/1.0']);
    if (!Array.isArray(sub) || sub.length < 3) throw new Error('unexpected mining.subscribe result');
    this.extranonce1 = sub[1];
    this.extranonce2Size = sub[2];
    this.subscribed = true;
    this._record('subscribed', { extranonce1: this.extranonce1, extranonce2Size: this.extranonce2Size });

    const auth = await this.request('mining.authorize', [this.username, this.password]);
    this.authorized = auth === true;
    this._record('authorized', { authorized: this.authorized });
    if (!this.authorized) throw new Error('pool authorization rejected');
    return this.snapshot();
  }

  _onData(chunk) {
    this.lastMessageAt = Date.now();
    this.buffer += chunk.toString('utf8');
    for (;;) {
      const idx = this.buffer.indexOf('\n');
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch {
        this._record('protocol_error', { error: 'invalid JSON from upstream', line: line.slice(0, 200) });
        continue;
      }
      this._handleMessage(msg);
    }
  }

  _handleMessage(msg) {
    if (msg.id !== null && msg.id !== undefined && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
      else pending.resolve(msg.result);
      return;
    }

    if (msg.method === 'mining.set_difficulty') {
      this.difficulty = Number(msg.params?.[0]);
      this._record('difficulty', { difficulty: this.difficulty });
      return;
    }

    if (msg.method === 'mining.set_extranonce') {
      this.extranonce1 = msg.params?.[0] ?? this.extranonce1;
      this.extranonce2Size = msg.params?.[1] ?? this.extranonce2Size;
      this._record('set_extranonce', { extranonce1: this.extranonce1, extranonce2Size: this.extranonce2Size });
      return;
    }

    if (msg.method === 'mining.notify') {
      const p = msg.params ?? [];
      this.latestJob = {
        jobId: p[0],
        prevHash: p[1],
        coinb1: p[2],
        coinb2: p[3],
        merkleBranch: p[4] ?? [],
        version: p[5],
        nBits: p[6],
        nTime: p[7],
        cleanJobs: Boolean(p[8]),
        receivedAt: new Date().toISOString(),
      };
      this._record('job', { job: this.latestJob });
      return;
    }

    this._record('upstream_message', { message: msg });
  }

  request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.write(payload, 'utf8', (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  async submit({ jobId, extranonce2, ntime, nonce }) {
    if (!this.authorized) throw new Error('session not authorized');
    if (!jobId || !safeHex(extranonce2) || !safeHex(ntime, 4) || !safeHex(nonce, 4)) {
      throw new Error('invalid share fields');
    }
    if (this.extranonce2Size && extranonce2.length !== Number(this.extranonce2Size) * 2) {
      throw new Error(`extranonce2 must be ${this.extranonce2Size} bytes`);
    }
    this.shares.submitted++;
    const result = await this.request('mining.submit', [this.username, jobId, extranonce2, ntime, nonce]);
    const accepted = result === true;
    if (accepted) this.shares.accepted++;
    else this.shares.rejected++;
    this._record('share_result', { accepted, jobId, nonce });
    return { accepted, result };
  }

  async waitForJob(timeoutMs = 15_000) {
    if (this.latestJob) return this.latestJob;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('timed out waiting for mining.notify')); }, timeoutMs);
      const onEvent = (ev) => {
        if (ev.type === 'job') { cleanup(); resolve(this.latestJob); }
        if (ev.type === 'disconnected') { cleanup(); reject(new Error('pool disconnected while waiting for job')); }
      };
      const cleanup = () => { clearTimeout(timer); this.off('event', onEvent); };
      this.on('event', onEvent);
    });
  }

  close() {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('session closed'));
    }
    this.pending.clear();
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    this.socket = null;
    this.connected = false;
  }
}

export function createSessionId() {
  return crypto.randomBytes(18).toString('base64url');
}
