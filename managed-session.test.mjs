import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ManagedStratumSession } from '../src/managed-session.mjs';

function startDroppingMockPool() {
  let connectionCount = 0;
  const server = net.createServer((socket) => {
    connectionCount += 1;
    const connectionNumber = connectionCount;
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString();
      for (;;) {
        const i = buf.indexOf('\n');
        if (i < 0) break;
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.method === 'mining.subscribe') {
          socket.write(JSON.stringify({ id: msg.id, result: [[['mining.notify', `sub-${connectionNumber}`]], `aa00${String(connectionNumber).padStart(4, '0')}`, 4], error: null }) + '\n');
        } else if (msg.method === 'mining.authorize') {
          socket.write(JSON.stringify({ id: msg.id, result: true, error: null }) + '\n');
          socket.write(JSON.stringify({ id: null, method: 'mining.set_difficulty', params: [10000] }) + '\n');
          socket.write(JSON.stringify({ id: null, method: 'mining.notify', params: [`job-${connectionNumber}`, '22'.repeat(32), '0102', '0304', [], '20000000', '1702abcd', '65f00000', true] }) + '\n');
          if (connectionNumber === 1) setTimeout(() => socket.destroy(), 40);
        } else if (msg.method === 'mining.submit') {
          socket.write(JSON.stringify({ id: msg.id, result: true, error: null }) + '\n');
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, getConnectionCount: () => connectionCount })));
}

test('managed session reconnects after upstream disconnect and keeps working', async (t) => {
  const pool = await startDroppingMockPool();
  t.after(() => pool.server.close());
  const port = pool.server.address().port;
  const managed = new ManagedStratumSession({
    host: '127.0.0.1',
    port,
    address: 'bc1qexample',
    worker: 'managed',
    minBackoffMs: 20,
    maxBackoffMs: 50,
  });
  t.after(() => managed.stop());

  managed.start();
  await managed.waitUntilOnline(2000);
  const firstJob = await managed.waitForJob(2000);
  assert.equal(firstJob.jobId, 'job-1');

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (pool.getConnectionCount() >= 2 && managed.snapshot().online && managed.snapshot().upstream?.latestJob?.jobId === 'job-2') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.ok(pool.getConnectionCount() >= 2, 'expected automatic reconnect');
  assert.equal(managed.snapshot().online, true);
  assert.equal(managed.snapshot().upstream.latestJob.jobId, 'job-2');

  const result = await managed.submit({ jobId: 'job-2', extranonce2: '00000001', ntime: '65f00000', nonce: '00000002' });
  assert.deepEqual(result, { accepted: true, result: true });
  assert.ok(managed.getEventsAfter(0).some((event) => event.type === 'connect_failed' || event.type === 'stratum_disconnected'));
});
