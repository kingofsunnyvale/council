import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';

test('health checks the database without returning database internals', async () => {
  const env = { DB: { prepare(sql) { assert.equal(sql, 'SELECT 1 AS ok'); return { first: async () => ({ ok: 1 }) }; } } };
  const response = await worker.fetch(new Request('https://council.example/health'), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { service: 'council', status: 'ok', database: 'connected' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('database failure is contained and does not disclose the error', async () => {
  const env = { DB: { prepare() { throw new Error('private database detail'); } } };
  const response = await worker.fetch(new Request('https://council.example/health'), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { service: 'council', status: 'unavailable' });
});

test('bootstrap exposes no application or write endpoints', async () => {
  assert.equal((await worker.fetch(new Request('https://council.example/api/conversations'), {})).status, 404);
  assert.equal((await worker.fetch(new Request('https://council.example/health', { method: 'POST' }), {})).status, 405);
});
