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
  process.env.TRUST_PROXY_HEADER = 'cf'; // tests use CF-Connecting-IP to simulate many clients
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
  // Memory is capped: least recently used keys are dropped.
  const small = new Limiter({ capacity: 1, perMinute: 1 }, () => t, 3);
  for (const k of ['k1', 'k2', 'k3', 'k4']) small.take(k);
  assert.equal(small.size, 3);
  assert.equal(small.take('k1'), 0, 'k1 was evicted, so it starts full again');
});

test('one IP guessing one account is limited (429 + Retry-After); the owner can still log in from elsewhere', async () => {
  const u = await app.signUp('Rita');
  const attacker = '10.0.0.1';
  const statuses: number[] = [];
  for (let i = 0; i < 8; i++) statuses.push((await post('/auth/login', { email: u.user.email, password: 'wrong-pass' }, attacker)).status);
  assert.deepEqual(statuses, Array(8).fill(401));
  const r = await post('/auth/login', { email: u.user.email.toUpperCase(), password: 'wrong-pass' }, attacker);
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.match((await r.json()).error, /Too many attempts/);
  // No lock-out: the real user, from their own IP, gets in.
  assert.equal((await post('/auth/login', { email: u.user.email, password: 'password123' }, '10.9.9.9')).status, 200);
});

test('a distributed attack on one account only slows logins down; it never locks the owner out', async () => {
  const u = await app.signUp('Dina');
  for (let i = 0; i < 40; i++) assert.equal((await post('/auth/login', { email: u.user.email, password: 'nope-nope' }, `172.16.${i}.1`)).status, 401);
  const t = Date.now();
  const ok = await post('/auth/login', { email: u.user.email, password: 'password123' }, '172.31.0.1');
  assert.equal(ok.status, 200);
  assert.ok(Date.now() - t >= 1900, 'slowed down by the per-account delay');
});

test('CF-Connecting-IP is ignored unless TRUST_PROXY_HEADER=cf (it could be forged)', async () => {
  delete process.env.TRUST_PROXY_HEADER;
  // From loopback with a forged header: treated as loopback → exempt, and the header can't be used to dodge limits elsewhere.
  for (let i = 0; i < 25; i++) assert.equal((await post('/auth/login', { email: 'f@example.com', password: 'x' }, `9.9.9.${i}`)).status, 401);
  process.env.RATE_LIMIT_LOOPBACK = '1';
  resetRateLimits();
  let last = 0;
  for (let i = 0; i < 21; i++) last = (await post('/auth/login', { email: `g${i}@example.com`, password: 'x' }, `9.9.8.${i}`)).status;
  assert.equal(last, 429, 'rotating a forged header does not give fresh buckets');
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
