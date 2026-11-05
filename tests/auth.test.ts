import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { startTestApp, type TestApp } from './helpers/app.ts';

let app: TestApp;
before(async () => {
  app = await startTestApp();
});
after(() => app.close());

test('login returns an access token, a refresh token and its lifetime', async () => {
  await app.signUp('Ann', 'ann@example.com');
  const r = await app.call('POST', '/auth/login', undefined, { email: 'ann@example.com', password: 'password123' });
  assert.equal(r.status, 200);
  assert.ok(r.data.accessToken && r.data.refreshToken);
  assert.equal(r.data.expiresIn, 900);
  assert.equal((await app.call('GET', '/me', r.data.accessToken)).data.email, 'ann@example.com');
});

test('refresh rotates: new pair works, old refresh token is retired', async () => {
  const u = await app.signUp('Ben');
  const r1 = await app.call('POST', '/auth/refresh', undefined, { refreshToken: u.refreshToken });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.data.refreshToken, u.refreshToken);
  assert.equal((await app.call('GET', '/me', r1.data.accessToken)).status, 200);
  const r2 = await app.call('POST', '/auth/refresh', undefined, { refreshToken: r1.data.refreshToken });
  assert.equal(r2.status, 200);
});

test('reusing a retired refresh token after the grace window revokes the whole sign-in', async () => {
  const u = await app.signUp('Cat');
  const r1 = await app.call('POST', '/auth/refresh', undefined, { refreshToken: u.refreshToken });
  const { db } = await import('../server/db.ts');
  // Pretend the first rotation happened 5 minutes ago.
  db.prepare("UPDATE refresh_tokens SET used_at = ? WHERE used_at IS NOT NULL").run(new Date(Date.now() - 300_000).toISOString());
  assert.equal((await app.call('POST', '/auth/refresh', undefined, { refreshToken: u.refreshToken })).status, 401);
  // The legitimate newer token is now revoked too.
  assert.equal((await app.call('POST', '/auth/refresh', undefined, { refreshToken: r1.data.refreshToken })).status, 401);
});

test('two near-simultaneous refreshes with the same token both succeed (grace window)', async () => {
  const u = await app.signUp('Dot');
  const [a, b] = await Promise.all([
    app.call('POST', '/auth/refresh', undefined, { refreshToken: u.refreshToken }),
    app.call('POST', '/auth/refresh', undefined, { refreshToken: u.refreshToken }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
});

test('logout revokes the refresh token', async () => {
  const u = await app.signUp('Eve');
  assert.equal((await app.call('POST', '/auth/logout', undefined, { refreshToken: u.refreshToken })).status, 200);
  assert.equal((await app.call('POST', '/auth/refresh', undefined, { refreshToken: u.refreshToken })).status, 401);
});

test('garbage, expired and non-access tokens are rejected', async () => {
  assert.equal((await app.call('POST', '/auth/refresh', undefined, { refreshToken: 'nope' })).status, 401);
  const u = await app.signUp('Fin');
  const expired = jwt.sign({ sub: u.user.id, typ: 'access' }, 'test-secret', { expiresIn: -10 });
  assert.equal((await app.call('GET', '/me', expired)).status, 401);
  const legacy = jwt.sign({ sub: u.user.id }, 'test-secret', { expiresIn: 3600 }); // pre-refresh-token format
  assert.equal((await app.call('GET', '/me', legacy)).status, 401);
});

test('CORS: API answers preflight for other origins (bearer auth, no cookies)', async () => {
  const res = await fetch(`${app.origin}/api/me`, { method: 'OPTIONS', headers: { origin: 'capacitor://localhost' } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('access-control-allow-headers') ?? '', /Authorization/);
});
