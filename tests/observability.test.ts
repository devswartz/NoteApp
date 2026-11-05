import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { startTestApp, type TestApp } from './helpers/app.ts';

let app: TestApp;
before(async () => {
  delete process.env.ADMIN_EMAILS;
  app = await startTestApp();
});
after(() => app.close());

test('every API response carries a request id; a sane incoming id is kept', async () => {
  const r = await fetch(`${app.origin}/api/health`);
  assert.match(r.headers.get('x-request-id') ?? '', /^[0-9a-f]{16}$/);
  const r2 = await fetch(`${app.origin}/api/health`, { headers: { 'x-request-id': 'client-abc-123' } });
  assert.equal(r2.headers.get('x-request-id'), 'client-abc-123');
  const r3 = await fetch(`${app.origin}/api/health`, { headers: { 'x-request-id': 'bad id <script>' } });
  assert.notEqual(r3.headers.get('x-request-id'), 'bad id <script>');
});

test('unexpected errors return 500 with the request id, never internals', async () => {
  const { requestLog } = await import('../server/requests.ts');
  const { errorHandler } = await import('../server/http.ts');
  const e = express();
  e.use(requestLog);
  e.get('/boom', () => {
    throw new Error('secret internal detail');
  });
  e.use(errorHandler);
  const srv = e.listen(0);
  await new Promise((r) => srv.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/boom`);
    const body = (await res.json()) as { error: string; requestId: string };
    assert.equal(res.status, 500);
    assert.equal(body.requestId, res.headers.get('x-request-id'));
    assert.doesNotMatch(JSON.stringify(body), /secret internal detail/);
  } finally {
    srv.close();
  }
});

test('admin stats: the first account is the instance admin; others get 403', async () => {
  const first = await app.signUp('Admin');
  const other = await app.signUp('Regular');
  const r = await app.call('GET', '/admin/stats', first.token);
  assert.equal(r.status, 200);
  assert.ok(r.data.db.users >= 2);
  assert.ok(r.data.requests.total > 0);
  assert.ok(r.data.db.activeSessions >= 2);
  assert.equal(typeof r.data.sockets.collab.openPages, 'number');
  assert.equal((await app.call('GET', '/admin/stats', other.token)).status, 403);
  assert.equal((await app.call('GET', '/admin/stats')).status, 401);
});

test('ADMIN_EMAILS overrides the first-account rule', async () => {
  const u = await app.signUp('Ops', 'ops@example.com');
  process.env.ADMIN_EMAILS = 'someone@else.com, OPS@example.com';
  try {
    assert.equal((await app.call('GET', '/admin/me', u.token)).status, 200);
  } finally {
    delete process.env.ADMIN_EMAILS;
  }
});
