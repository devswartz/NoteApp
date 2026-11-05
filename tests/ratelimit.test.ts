// Auth rate limiting: token buckets per IP and per account, 429 + Retry-After.
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers/app.ts';
import { Limiter, resetRateLimits } from '../server/ratelimit.ts';

let app: TestApp;
before(async () => {
  app = await startTestApp();
});
after(() => app.close());
beforeEach(() => {
  delete process.env.RATE_LIMIT_LOOPBACK;
  resetRateLimits();
});

const post = (path: string, body: unknown, ip?: string) =>
  fetch(`${app.origin}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(ip ? { 'cf-connecting-ip': ip } : {}) },
    body: JSON.stringify(body),
  });

test('Limiter: burst, refill and retry-after', () => {
  let t = 0;
  const l = new Limiter({ capacity: 3, perMinute: 6 }, () => t); // one token per 10 s
  assert.deepEqual([l.take('a'), l.take('a'), l.take('a')], [0, 0, 0]);
  assert.equal(l.take('a'), 10);
  assert.equal(l.take('b'), 0, 'keys are independent');
  t += 10_000;
  assert.equal(l.take('a'), 0);
  t += 60_000;
  l.prune();
  assert.equal(l.size, 0, 'full buckets are pruned');
});

test('wrong passwords for one account are limited (per account, across IPs), with Retry-After', async () => {
  const u = await app.signUp('Rita');
  const statuses: number[] = [];
  for (let i = 0; i < 8; i++) statuses.push((await post('/auth/login', { email: u.user.email, password: 'wrong-pass' }, `10.0.0.${i}`)).status);
  assert.deepEqual(statuses, Array(8).fill(401));
  const r = await post('/auth/login', { email: u.user.email.toUpperCase(), password: 'wrong-pass' }, '10.0.1.1');
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.match((await r.json()).error, /Too many attempts/);
  // Even the right password waits now (otherwise the limit would be a password oracle).
  assert.equal((await post('/auth/login', { email: u.user.email, password: 'password123' }, '10.0.1.2')).status, 429);
  // Other accounts are unaffected.
  const v = await app.signUp('Vera');
  assert.equal((await post('/auth/login', { email: v.user.email, password: 'password123' }, '10.0.1.3')).status, 200);
});

test('successful logins do not use up the account allowance', async () => {
  const u = await app.signUp('Sol');
  for (let i = 0; i < 12; i++) assert.equal((await post('/auth/login', { email: u.user.email, password: 'password123' }, `10.1.0.${i}`)).status, 200);
});

test('per-IP limits: login sprays and sign-ups from one IP', async () => {
  const ip = '203.0.113.7';
  let last = 0;
  for (let i = 0; i < 21; i++) last = (await post('/auth/login', { email: `nobody${i}@example.com`, password: 'x' }, ip)).status;
  assert.equal(last, 429, 'the 21st login attempt from one IP is refused');
  assert.equal((await post('/auth/login', { email: 'nobody@example.com', password: 'x' }, '203.0.113.8')).status, 401, 'other IPs fine');

  const reg = (i: number) => post('/auth/register', { name: `R${i}`, email: `rl-${i}-${Date.now()}@example.com`, password: 'password123' }, '198.51.100.9');
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await reg(i)).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429]);
});

test('invite token guessing is capped per IP', async () => {
  let last = 0;
  for (let i = 0; i < 21; i++) last = (await fetch(`${app.origin}/api/invites/guess${i}xxxxxxxxxxxxxxxx`, { headers: { 'cf-connecting-ip': '192.0.2.50' } })).status;
  assert.equal(last, 429);
});

test('loopback without a proxy header is exempt (dev, e2e), unless RATE_LIMIT_LOOPBACK=1', async () => {
  for (let i = 0; i < 25; i++) assert.equal((await post('/auth/login', { email: 'x@example.com', password: 'x' })).status, 401);
  process.env.RATE_LIMIT_LOOPBACK = '1';
  resetRateLimits();
  let last = 0;
  for (let i = 0; i < 21; i++) last = (await post('/auth/login', { email: `y${i}@example.com`, password: 'x' })).status;
  assert.equal(last, 429);
});
