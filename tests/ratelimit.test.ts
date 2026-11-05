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

test('300 parallel wrong passwords from 300 IPs: most refused before bcrypt; the owner from a known IP gets in within ~1 s', async () => {
  const u = await app.signUp('Dina');
  const home = '172.31.0.1';
  assert.equal((await post('/auth/login', { email: u.user.email, password: 'password123' }, home)).status, 200); // known-good from now on
  const attack = Array.from({ length: 300 }, (_, i) => post('/auth/login', { email: u.user.email, password: 'nope-nope' }, `172.16.${i >> 8}.${i & 255}`).then((r) => r.status));
  await new Promise((r) => setTimeout(r, 20)); // the attack is already in progress
  const t = Date.now();
  const owner = await post('/auth/login', { email: u.user.email, password: 'password123' }, home);
  const ownerMs = Date.now() - t;
  const codes = await Promise.all(attack);
  assert.equal(owner.status, 200);
  assert.ok(ownerMs < 1500, `owner waited ${ownerMs} ms`);
  const reachedBcrypt = codes.filter((c) => c === 401).length;
  assert.ok(reachedBcrypt <= 20, `${reachedBcrypt} of 300 attack attempts reached a password check`);
  assert.equal(codes.filter((c) => c === 429).length, 300 - reachedBcrypt);
  // The account budget is spent: a new, unknown IP is refused even with the right password; the known one still works.
  assert.equal((await post('/auth/login', { email: u.user.email, password: 'password123' }, '172.30.0.9')).status, 429);
  assert.equal((await post('/auth/login', { email: u.user.email, password: 'password123' }, home)).status, 200);
});

test('server-wide budget for password checks across many accounts', async () => {
  // Real accounts (an unknown email skips bcrypt), one attempt each from its own IP.
  const users = await Promise.all(Array.from({ length: 12 }, (_, i) => app.signUp(`Cap${i}`)));
  resetRateLimits(); // sign-ups above don't count (they come from loopback anyway)
  const t = Date.now();
  const codes = await Promise.all(
    users.flatMap((u, i) => [0, 1, 2, 3].map((j) => post('/auth/login', { email: u.user.email, password: 'wrong-pass' }, `198.18.${i}.${j}`).then((r) => r.status))),
  );
  const secs = (Date.now() - t) / 1000;
  const ran = codes.filter((c) => c === 401).length;
  assert.ok(ran >= 30, `the burst runs (${ran})`);
  assert.ok(ran <= 30 + Math.ceil(secs * 5) + 1, `no more than burst + 5/s ran (${ran} in ${secs.toFixed(1)} s)`);
  assert.equal(codes.filter((c) => c === 429).length, 48 - ran, 'the rest are refused at once, not queued');
  assert.ok(ran < 48);
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
