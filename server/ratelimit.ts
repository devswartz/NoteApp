// Rate limiting for authentication endpoints: in-memory token buckets keyed
// per client IP and per account, answering 429 with Retry-After.
// Owner: Collaboration & Access (hardening).
//
// One server process (see PLAN.md), so in-memory state is enough. Each
// limiter keeps at most MAX_KEYS buckets (least recently used are dropped) and
// prunes full buckets every 10 minutes.
//
// Client IP: the socket address, or Cloudflare's `CF-Connecting-IP` header
// only when TRUST_PROXY_HEADER=cf (staging/prod, where the app port is
// reachable only through cloudflared; anyone else could forge the header).
// Direct loopback connections with no trusted header (local dev, the e2e
// suite, health checks) are exempt unless RATE_LIMIT_LOOPBACK=1.
// RATE_LIMIT=off disables limiting.
//
// Login (password checks are synchronous bcrypt, so queued work hurts everyone):
// - per IP and per (account, IP) buckets: one source can't keep guessing;
// - "known-good" (account, IP) pairs — a successful login in the last 30 days,
//   kept in an LRU — skip the account-wide limits below, so the real user is
//   never locked out by someone else's attack;
// - everyone else is refused immediately (429, not queued) when the account
//   already has a password check in flight, when the account's attempt budget
//   (across all IPs) is spent, or when the server-wide password-check budget
//   (LIMITS.passwordChecks, 5/s sustained) or concurrency
//   (MAX_PASSWORD_CHECKS, effective once bcrypt runs async) is exhausted.
//   Sign-ups count toward the server-wide limits too.
import type { Request, RequestHandler, Response } from 'express';

export interface BucketSpec {
  /** Maximum burst. */
  capacity: number;
  /** Tokens added back per minute. */
  perMinute: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

/** Most buckets one limiter keeps; beyond this the least recently used are dropped. */
export const MAX_KEYS = 50_000;

export class Limiter {
  private buckets = new Map<string, Bucket>(); // insertion order = least recently used first
  constructor(readonly spec: BucketSpec, private now: () => number = Date.now, private maxKeys = MAX_KEYS) {}

  private put(key: string, b: Bucket) {
    this.buckets.delete(key); // move to most recent
    this.buckets.set(key, b);
    while (this.buckets.size > this.maxKeys) this.buckets.delete(this.buckets.keys().next().value!);
  }

  /** Take one token for `key`. Returns 0 if allowed, else seconds until one is available. */
  take(key: string): number {
    const t = this.now();
    const refillPerMs = this.spec.perMinute / 60_000;
    const b = this.buckets.get(key) ?? { tokens: this.spec.capacity, at: t };
    b.tokens = Math.min(this.spec.capacity, b.tokens + (t - b.at) * refillPerMs);
    b.at = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.put(key, b);
      return 0;
    }
    this.put(key, b);
    return Math.max(1, Math.ceil((1 - b.tokens) / refillPerMs / 1000));
  }

  /** Give a token back (e.g. a login that succeeded shouldn't count against the account). */
  refund(key: string) {
    const b = this.buckets.get(key);
    if (b) b.tokens = Math.min(this.spec.capacity, b.tokens + 1);
  }

  /** Drop buckets that have refilled completely. */
  prune() {
    const t = this.now();
    const refillPerMs = this.spec.perMinute / 60_000;
    for (const [k, b] of this.buckets) if (b.tokens + (t - b.at) * refillPerMs >= this.spec.capacity) this.buckets.delete(k);
  }

  get size() {
    return this.buckets.size;
  }
}

/** Limits per endpoint group. Generous enough for real use (several tabs, typos), tight against guessing. */
export const LIMITS = {
  loginIp: { capacity: 20, perMinute: 10 },
  loginPair: { capacity: 8, perMinute: 0.5 }, // per (account, IP): ~8 wrong passwords, then one per 2 minutes
  loginAccount: { capacity: 10, perMinute: 5 }, // per account, all IPs; known-good devices are exempt
  // Server-wide password checks (bcrypt is synchronous in auth.ts, so this caps how long the event loop can be tied up).
  passwordChecks: { capacity: 30, perMinute: 300 }, // 5/s sustained: under half of what bcrypt can do, so other requests stay responsive
  registerIp: { capacity: 5, perMinute: 0.2 }, // 5 sign-ups, then one per 5 minutes
  refreshIp: { capacity: 60, perMinute: 60 }, // many tabs refreshing at once
  resetIp: { capacity: 5, perMinute: 0.2 }, // /auth/forgot per IP
  resetAccount: { capacity: 3, perMinute: 0.1 }, // /auth/forgot per address (no mail-bombing one inbox)
  resetConfirmIp: { capacity: 10, perMinute: 1 }, // /auth/reset per IP (tokens are unguessable; this caps scanning)
  inviteIp: { capacity: 20, perMinute: 2 }, // invite lookups + accepts (tokens are unguessable; this caps scanning)
  verifyIp: { capacity: 20, perMinute: 2 }, // /auth/verify-email per IP (tokens are unguessable; this caps scanning)
  // Resending the confirmation email (signed in; see takeResend): no mail-bombing one inbox or the SMTP quota.
  resendUserMinute: { capacity: 1, perMinute: 1 }, // per user: one a minute …
  resendUserHour: { capacity: 5, perMinute: 5 / 60 }, // … and five an hour
  // Re-entering the password to delete an account (signed in): per user, and server-wide with the other bcrypt checks.
  accountDeleteUser: { capacity: 5, perMinute: 1 },
  resendIp: { capacity: 10, perMinute: 0.5 }, // per IP, across accounts: 10, then one every two minutes
} satisfies Record<string, BucketSpec>;

let clock: () => number = Date.now;
const now = () => clock();
/** Tests only: freeze or move the limiters' clock (undefined restores Date.now). */
export function setRateLimitClock(fn: (() => number) | undefined) {
  clock = fn ?? Date.now;
}

const limiters = Object.fromEntries(Object.entries(LIMITS).map(([k, v]) => [k, new Limiter(v, now)])) as Record<keyof typeof LIMITS, Limiter>;
setInterval(() => Object.values(limiters).forEach((l) => l.prune()), 10 * 60_000).unref();

/** Tests only: start from full buckets. */
export function resetRateLimits() {
  for (const k of Object.keys(limiters) as (keyof typeof LIMITS)[]) limiters[k] = new Limiter(LIMITS[k], now);
  knownGood.clear();
}

/** Most password checks (bcrypt) running at once, server-wide; more are refused rather than queued. */
export const MAX_PASSWORD_CHECKS = 6;
let passwordChecks = 0;
const accountChecks = new Map<string, number>(); // email -> password checks in flight

/** (account, IP) pairs that logged in successfully recently: exempt from the account-wide limits. */
const KNOWN_TTL_MS = 30 * 86_400_000;
const KNOWN_MAX = 50_000;
const knownGood = new Map<string, number>(); // `${email} ${ip}` -> last success (LRU order)
const isKnownGood = (key: string) => {
  const at = knownGood.get(key);
  return at !== undefined && Date.now() - at < KNOWN_TTL_MS;
};
function rememberGood(key: string) {
  knownGood.delete(key);
  knownGood.set(key, Date.now());
  while (knownGood.size > KNOWN_MAX) knownGood.delete(knownGood.keys().next().value!);
}

/** Track one password check until the response is done (finished or aborted). */
function trackCheck(res: Response, email: string | null) {
  passwordChecks++;
  if (email) accountChecks.set(email, (accountChecks.get(email) ?? 0) + 1);
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    passwordChecks--;
    if (email) {
      const n = (accountChecks.get(email) ?? 1) - 1;
      if (n > 0) accountChecks.set(email, n);
      else accountChecks.delete(email);
    }
  };
  res.on('finish', end);
  res.on('close', end);
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function clientIp(req: Request): { ip: string; loopback: boolean } {
  if (process.env.TRUST_PROXY_HEADER === 'cf') {
    const cf = req.get('cf-connecting-ip');
    if (cf && /^[0-9a-f.:]{2,45}$/i.test(cf.trim())) return { ip: cf.trim(), loopback: false };
  }
  const ip = req.socket.remoteAddress ?? 'unknown';
  return { ip, loopback: LOOPBACK.has(ip) };
}

const emailKey = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase().slice(0, 200) : '');

interface Check {
  limiter: keyof typeof LIMITS;
  key: string;
}

/** Which buckets a request draws from (none = not rate limited). */
function checksFor(req: Request, ip: string): Check[] {
  if (req.method !== 'POST' && !(req.method === 'GET' && req.path.startsWith('/invites/'))) return [];
  const p = req.path.replace(/\/+$/, '');
  const body = (req.body ?? {}) as Record<string, unknown>;
  switch (p) {
    case '/auth/login': {
      const email = emailKey(body.email);
      return [{ limiter: 'loginIp', key: ip }, ...(email ? [{ limiter: 'loginPair' as const, key: `${email} ${ip}` }] : [])];
    }
    case '/auth/register':
      return [{ limiter: 'registerIp', key: ip }];
    case '/auth/refresh':
      return [{ limiter: 'refreshIp', key: ip }];
    // Password reset (server/routes/auth.ts): request a link by email, then set a new password with its token.
    case '/auth/forgot': {
      const email = emailKey(body.email);
      return [{ limiter: 'resetIp', key: ip }, ...(email ? [{ limiter: 'resetAccount' as const, key: email }] : [])];
    }
    case '/auth/reset':
      return [{ limiter: 'resetConfirmIp', key: ip }];
    case '/auth/verify-email':
      return [{ limiter: 'verifyIp', key: ip }];
  }
  if (/^\/invites\/[^/]+(\/accept)?$/.test(p)) return [{ limiter: 'inviteIp', key: ip }];
  return [];
}

/**
 * Rate limit for POST /auth/resend-verification, called by the handler (the user is only known after sign-in).
 * Returns 0 if allowed, else seconds to wait. The per-user caps always apply; the per-IP cap follows the
 * usual loopback exemption. A refused request costs nothing.
 */
export function takeResend(req: Request, userId: string): number {
  if (process.env.RATE_LIMIT === 'off') return 0;
  const { ip, loopback } = clientIp(req);
  const checks: Check[] = [
    { limiter: 'resendUserMinute', key: userId },
    { limiter: 'resendUserHour', key: userId },
    ...(loopback && process.env.RATE_LIMIT_LOOPBACK !== '1' ? [] : [{ limiter: 'resendIp' as const, key: ip }]),
  ];
  let wait = 0;
  const taken: Check[] = [];
  for (const c of checks) {
    const w = limiters[c.limiter].take(c.key);
    if (w) wait = Math.max(wait, w);
    else taken.push(c);
  }
  if (wait) taken.forEach((c) => limiters[c.limiter].refund(c.key));
  return wait;
}

/**
 * Rate limit for DELETE /auth/account (a password check). Returns 0 if allowed, else seconds to wait.
 * The per-user bucket always applies; the server-wide password-check budget follows the loopback exemption.
 */
export function takeAccountDelete(req: Request, userId: string): number {
  if (process.env.RATE_LIMIT === 'off') return 0;
  const { loopback } = clientIp(req);
  const wait = limiters.accountDeleteUser.take(userId);
  if (wait) return wait;
  if (loopback && process.env.RATE_LIMIT_LOOPBACK !== '1') return 0;
  const g = passwordChecks >= MAX_PASSWORD_CHECKS ? 1 : limiters.passwordChecks.take('all');
  if (g) limiters.accountDeleteUser.refund(userId);
  return g;
}

export function refuse(res: Response, wait: number) {
  res.setHeader('Retry-After', String(wait));
  res.status(429).json({ error: `Too many attempts. Try again in ${wait < 60 ? `${wait} seconds` : `${Math.ceil(wait / 60)} minutes`}.` });
}

/**
 * Mount on /api after the JSON body parser and before the auth routes.
 * Successful logins refund their tokens and mark the (account, IP) pair as known-good.
 */
export const authRateLimit: RequestHandler = (req, res, next) => {
  if (process.env.RATE_LIMIT === 'off') return next();
  const { ip, loopback } = clientIp(req);
  if (loopback && process.env.RATE_LIMIT_LOOPBACK !== '1') return next();
  const checks = checksFor(req, ip);
  if (!checks.length) return next();
  let wait = 0;
  const taken: Check[] = [];
  for (const c of checks) {
    const w = limiters[c.limiter].take(c.key);
    if (w) wait = Math.max(wait, w);
    else taken.push(c);
  }
  const giveBack = () => taken.forEach((c) => limiters[c.limiter].refund(c.key)); // a refused request costs nothing
  if (wait) {
    giveBack();
    return refuse(res, wait);
  }
  const path = req.path.replace(/\/+$/, '');
  if (path === '/auth/register') {
    const g = passwordChecks >= MAX_PASSWORD_CHECKS ? 1 : limiters.passwordChecks.take('all');
    if (g) {
      giveBack();
      return refuse(res, g);
    }
    trackCheck(res, null);
    return next();
  }
  const pair = checks.find((c) => c.limiter === 'loginPair');
  if (!pair) return next();
  const email = emailKey((req.body as Record<string, unknown>).email);
  const known = isKnownGood(pair.key);
  let tookAccount = false;
  if (!known) {
    // Unknown device: refuse immediately rather than queue behind other checks for this account or the server.
    if ((accountChecks.get(email) ?? 0) > 0 || passwordChecks >= MAX_PASSWORD_CHECKS) {
      giveBack();
      return refuse(res, 1);
    }
    const w = limiters.loginAccount.take(email);
    if (w) {
      giveBack();
      return refuse(res, w);
    }
    const g = limiters.passwordChecks.take('all');
    if (g) {
      limiters.loginAccount.refund(email);
      giveBack();
      return refuse(res, g);
    }
    tookAccount = true;
  }
  trackCheck(res, email);
  res.on('finish', () => {
    if (res.statusCode >= 300) return;
    limiters.loginPair.refund(pair.key);
    if (tookAccount) limiters.loginAccount.refund(email);
    rememberGood(pair.key);
  });
  next();
};
