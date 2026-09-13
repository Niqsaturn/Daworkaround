import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { StratumSession } from '../src/stratum-session.mjs';

function startMockPool() {
  const server = net.createServer((socket) => {
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
          socket.write(JSON.stringify({ id: msg.id, result: [[['mining.notify','deadbeef']], 'a1b2c3d4', 4], error: null }) + '\n');
        } else if (msg.method === 'mining.authorize') {
          socket.write(JSON.stringify({ id: msg.id, result: true, error: null }) + '\n');
          socket.write(JSON.stringify({ id: null, method: 'mining.set_difficulty', params: [10000] }) + '\n');
          socket.write(JSON.stringify({ id: null, method: 'mining.notify', params: ['job-1','00'.repeat(32),'0102','0304',[],'20000000','1702abcd','65f00000',true] }) + '\n');
        } else if (msg.method === 'mining.submit') {
          socket.write(JSON.stringify({ id: msg.id, result: true, error: null }) + '\n');
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('persistent Stratum session subscribes, authorizes, receives job, and submits share', async (t) => {
  const pool = await startMockPool();
  t.after(() => pool.close());
  const port = pool.address().port;
  const s = new StratumSession({ host: '127.0.0.1', port, address: 'bc1qexample', worker: 'test' });
  t.after(() => s.close());

  await s.connect();
  const job = await s.waitForJob(2000);
  assert.equal(s.subscribed, true);
  assert.equal(s.authorized, true);
  assert.equal(s.extranonce1, 'a1b2c3d4');
  assert.equal(s.extranonce2Size, 4);
  assert.equal(s.difficulty, 10000);
  assert.equal(job.jobId, 'job-1');

  const result = await s.submit({ jobId: 'job-1', extranonce2: '00000001', ntime: '65f00000', nonce: '00000002' });
  assert.deepEqual(result, { accepted: true, result: true });
  assert.equal(s.shares.submitted, 1);
  assert.equal(s.shares.accepted, 1);
});
