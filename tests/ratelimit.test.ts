// Auth rate limiting: token buckets per IP and per account, 429 + Retry-After.
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers/app.ts';
import { Limiter, MAX_PASSWORD_CHECKS, resetRateLimits, setRateLimitClock } from '../server/ratelimit.ts';

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

/**
 * Hold password checks (bcrypt.compare) open until `release()`, so tests about requests that overlap
 * don't depend on how fast this machine opens connections or hashes (they failed on slower Windows hosts,
 * where requests arrived one after another and never overlapped). `held` counts checks waiting.
 */
async function holdPasswordChecks(only: (password: string) => boolean = () => true) {
  const bcrypt = (await import('bcryptjs')).default;
  const real = bcrypt.compare;
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const state = { held: 0 };
  (bcrypt as { compare: unknown }).compare = async (pw: string, hash: string) => {
    if (only(pw)) {
      state.held++;
      await gate;
    }
    return real(pw, hash);
  };
  return {
    state,
    release() {
      open();
      (bcrypt as { compare: unknown }).compare = real;
    },
  };
}
const until = async (cond: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; !cond() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 5));
};

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

test('300 parallel wrong passwords from 300 IPs: most refused before bcrypt; the owner from a known IP gets in within ~2 s', async () => {
  const u = await app.signUp('Dina');
  const home = '172.31.0.1';
  assert.equal((await post('/auth/login', { email: u.user.email, password: 'password123' }, home)).status, 200); // known-good from now on
  // The attackers' password checks are held open, so the attack is really in progress while the owner signs in.
  const hold = await holdPasswordChecks((pw) => pw === 'nope-nope');
  let codes: number[];
  let owner: Response;
  let ownerMs: number;
  try {
    let answered = 0;
    const attack = Array.from({ length: 300 }, (_, i) =>
      post('/auth/login', { email: u.user.email, password: 'nope-nope' }, `172.16.${i >> 8}.${i & 255}`).then((r) => (answered++, r.status)),
    );
    await until(() => hold.state.held > 0 && hold.state.held + answered >= 300); // every attempt has reached the server
    const t = Date.now();
    owner = await post('/auth/login', { email: u.user.email, password: 'password123' }, home);
    ownerMs = Date.now() - t;
    hold.release();
    codes = await Promise.all(attack);
  } finally {
    hold.release();
  }
  assert.equal(owner.status, 200);
  assert.ok(ownerMs <= 2000, `owner waited ${ownerMs} ms`);
  const reachedBcrypt = codes.filter((c) => c === 401).length;
  assert.ok(reachedBcrypt <= 20, `${reachedBcrypt} of 300 attack attempts reached a password check`);
  assert.equal(codes.filter((c) => c === 429).length, 300 - reachedBcrypt);
  // Wrong passwords one at a time from new IPs use up the account budget (10). Then a new, unknown IP is
  // refused even with the right password, and the known one still works.
  const spend: number[] = [];
  for (let i = 0; i < 12; i++) spend.push((await post('/auth/login', { email: u.user.email, password: 'nope-nope' }, `172.17.0.${i}`)).status);
  assert.ok(spend.includes(429), JSON.stringify(spend));
  assert.equal((await post('/auth/login', { email: u.user.email, password: 'password123' }, '172.30.0.9')).status, 429);
  assert.equal((await post('/auth/login', { email: u.user.email, password: 'password123' }, home)).status, 200);
});

test('server-wide caps on password checks: at most MAX_PASSWORD_CHECKS at once, and a throughput budget', async () => {
  // Real accounts (an unknown email is checked against a dummy hash, but keep it realistic), each attempt from its own IP.
  const users = await Promise.all(Array.from({ length: 12 }, (_, i) => app.signUp(`Cap${i}`)));
  resetRateLimits();
  // 1) Concurrency: 12 accounts in parallel; only MAX_PASSWORD_CHECKS run, the rest are refused at once (not queued).
  // Checks are held open until the others have been answered, so all 12 overlap however slow this machine is.
  const hold = await holdPasswordChecks();
  let parallel: number[];
  try {
    let refused = 0;
    const pending = users.map((u, i) =>
      post('/auth/login', { email: u.user.email, password: 'wrong-pass' }, `198.18.${i}.1`).then((r) => (r.status === 429 && refused++, r.status)),
    );
    await until(() => hold.state.held + refused >= 12);
    hold.release();
    parallel = await Promise.all(pending);
  } finally {
    hold.release();
  }
  assert.equal(parallel.filter((c) => c === 401).length, MAX_PASSWORD_CHECKS, JSON.stringify(parallel));
  assert.equal(parallel.filter((c) => c === 429).length, 12 - MAX_PASSWORD_CHECKS);

  // 2) Throughput: one at a time (no concurrency), with the clock frozen so nothing refills: exactly the burst runs.
  resetRateLimits();
  const frozen = Date.now();
  setRateLimitClock(() => frozen);
  try {
    const seq: number[] = [];
    for (let k = 0; k < 36; k++) {
      const u = users[k % 12];
      seq.push((await post('/auth/login', { email: u.user.email, password: 'wrong-pass' }, `198.19.${k}.1`)).status);
    }
    assert.equal(seq.filter((c) => c === 401).length, 30, 'the server-wide burst');
    assert.equal(seq.filter((c) => c === 429).length, 6);
  } finally {
    setRateLimitClock(undefined);
  }
});

test('password reset: /auth/forgot per IP and per address, /auth/reset per IP', async () => {
  const u = await app.signUp('Resi');
  // Per address: 3 requests for the same inbox, from different IPs, then 429.
  const forgot = (email: string, ip: string) => post('/auth/forgot', { email }, ip).then((r) => r.status);
  const perAddress = [];
  for (let i = 0; i < 4; i++) perAddress.push(await forgot(u.user.email, `100.64.0.${i}`));
  assert.equal(perAddress[3], 429, JSON.stringify(perAddress));
  assert.ok(perAddress.slice(0, 3).every((c) => c !== 429));
  // Per IP: 5 different addresses from one IP, then 429.
  const perIp = [];
  for (let i = 0; i < 6; i++) perIp.push(await forgot(`someone-${i}@example.com`, '100.64.1.1'));
  assert.equal(perIp[5], 429, JSON.stringify(perIp));
  // Reset tokens: 10 tries from one IP, then 429.
  const reset = [];
  for (let i = 0; i < 11; i++) reset.push((await post('/auth/reset', { token: `bad-${i}`, password: 'password1234' }, '100.64.2.1')).status);
  assert.equal(reset[10], 429, JSON.stringify(reset));
  assert.ok(reset.slice(0, 10).every((c) => c !== 429));
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
