import { EventEmitter } from 'node:events';
import { StratumSession } from './stratum-session.mjs';

const DEFAULT_MIN_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

export class ManagedStratumSession extends EventEmitter {
  constructor({
    host,
    port,
    address,
    worker = 'chatgpt',
    password = 'x',
    connectTimeoutMs = 12_000,
    minBackoffMs = DEFAULT_MIN_BACKOFF_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  }) {
    super();
    this.options = { host, port, address, worker, password, connectTimeoutMs };
    this.minBackoffMs = Number(minBackoffMs);
    this.maxBackoffMs = Number(maxBackoffMs);

    this.current = null;
    this.connecting = false;
    this.stopped = true;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.generation = 0;
    this.lastError = null;
    this.lastConnectedAt = null;
    this.lastDisconnectedAt = null;

    this.events = [];
    this.seq = 0;
    this.maxEvents = 1024;
  }

  _record(type, data = {}) {
    const event = { seq: ++this.seq, at: new Date().toISOString(), type, ...data };
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    this.emit('event', event);
    return event;
  }

  getEventsAfter(after = 0) {
    const n = Number(after) || 0;
    return this.events.filter((event) => event.seq > n);
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this._record('manager_started');
    this._scheduleReconnect(0);
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.current) this.current.close();
    this.current = null;
    this.connecting = false;
    this._record('manager_stopped');
  }

  reconnectNow() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.current) this.current.close();
    this.current = null;
    this.connecting = false;
    this.reconnectAttempt = 0;
    this.lastError = null;
    if (!this.stopped) this._scheduleReconnect(0);
  }

  _scheduleReconnect(delayMs = null) {
    if (this.stopped || this.reconnectTimer || this.connecting) return;
    const delay = delayMs ?? Math.min(
      this.maxBackoffMs,
      this.minBackoffMs * (2 ** Math.min(this.reconnectAttempt, 8)),
    );
    this._record('reconnect_scheduled', { delayMs: delay, attempt: this.reconnectAttempt + 1 });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this._connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  async _connect() {
    if (this.stopped || this.connecting) return;
    if (this.current?.connected && this.current?.authorized) return;

    this.connecting = true;
    this.reconnectAttempt += 1;
    const generation = ++this.generation;
    const session = new StratumSession(this.options);
    this.current = session;

    const forward = (event) => {
      this._record(`stratum_${event.type}`, { generation, upstreamSeq: event.seq, upstreamEvent: event });
      if (event.type === 'disconnected') {
        this.lastDisconnectedAt = Date.now();
        if (this.current === session) this.current = null;
        this.connecting = false;
        this._scheduleReconnect();
      }
    };
    session.on('event', forward);

    try {
      this._record('connect_attempt', {
        generation,
        attempt: this.reconnectAttempt,
        pool: `${this.options.host}:${this.options.port}`,
      });
      await session.connect();
      if (this.stopped) {
        session.close();
        return;
      }
      this.connecting = false;
      this.reconnectAttempt = 0;
      this.lastError = null;
      this.lastConnectedAt = Date.now();
      this._record('online', { generation, username: session.username });
    } catch (err) {
      this.connecting = false;
      this.lastError = err?.message || String(err);
      this._record('connect_failed', { generation, error: this.lastError });
      if (this.current === session) this.current = null;
      session.close();
      this._scheduleReconnect();
    }
  }

  snapshot() {
    const upstream = this.current?.snapshot?.() ?? null;
    return {
      running: !this.stopped,
      connecting: this.connecting,
      online: Boolean(upstream?.connected && upstream?.authorized),
      generation: this.generation,
      reconnectAttempt: this.reconnectAttempt,
      lastError: this.lastError,
      lastConnectedAt: this.lastConnectedAt ? new Date(this.lastConnectedAt).toISOString() : null,
      lastDisconnectedAt: this.lastDisconnectedAt ? new Date(this.lastDisconnectedAt).toISOString() : null,
      lastSeq: this.seq,
      upstream,
    };
  }

  async waitUntilOnline(timeoutMs = 15_000) {
    if (this.current?.connected && this.current?.authorized) return this.snapshot();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for managed Stratum session (${this.lastError || 'not online'})`));
      }, timeoutMs);
      const onEvent = () => {
        if (this.current?.connected && this.current?.authorized) {
          cleanup();
          resolve(this.snapshot());
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off('event', onEvent);
      };
      this.on('event', onEvent);
    });
  }

  async waitForJob(timeoutMs = 15_000) {
    await this.waitUntilOnline(timeoutMs);
    return this.current.waitForJob(timeoutMs);
  }

  async submit(share) {
    if (!this.current?.connected || !this.current?.authorized) {
      throw new Error(`managed Stratum session is offline${this.lastError ? `: ${this.lastError}` : ''}`);
    }
    return this.current.submit(share);
  }
}
