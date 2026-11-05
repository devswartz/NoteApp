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
// Login: limited per (account, IP) pair and per IP, so one source can't keep
// guessing. The per-account bucket never refuses (that would let anyone lock
// a user out from many IPs); once it runs dry it only slows failed-prone
// logins down by ACCOUNT_DELAY_MS.
import type { Request, RequestHandler } from 'express';

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
  loginAccount: { capacity: 30, perMinute: 2 }, // per account, all IPs: never refuses, only slows down (ACCOUNT_DELAY_MS)
  registerIp: { capacity: 5, perMinute: 0.2 }, // 5 sign-ups, then one per 5 minutes
  refreshIp: { capacity: 60, perMinute: 60 }, // many tabs refreshing at once
  resetIp: { capacity: 5, perMinute: 0.2 },
  resetAccount: { capacity: 3, perMinute: 0.1 },
  inviteIp: { capacity: 20, perMinute: 2 }, // invite lookups + accepts (tokens are unguessable; this caps scanning)
} satisfies Record<string, BucketSpec>;

const limiters = Object.fromEntries(Object.entries(LIMITS).map(([k, v]) => [k, new Limiter(v)])) as Record<keyof typeof LIMITS, Limiter>;
setInterval(() => Object.values(limiters).forEach((l) => l.prune()), 10 * 60_000).unref();

/** Tests only: start from full buckets. */
export function resetRateLimits() {
  for (const k of Object.keys(limiters) as (keyof typeof LIMITS)[]) limiters[k] = new Limiter(LIMITS[k]);
}

/** Delay for logins to an account under a distributed guessing attack. */
export const ACCOUNT_DELAY_MS = 2000;

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
    case '/auth/password-reset':
    case '/auth/password-reset/request':
    case '/auth/password-reset/confirm': {
      const email = emailKey(body.email);
      return [{ limiter: 'resetIp', key: ip }, ...(email ? [{ limiter: 'resetAccount' as const, key: email }] : [])];
    }
  }
  if (/^\/invites\/[^/]+(\/accept)?$/.test(p)) return [{ limiter: 'inviteIp', key: ip }];
  return [];
}

/**
 * Mount on /api after the JSON body parser and before the auth routes.
 * Successful logins refund their (account, IP) and account tokens, so only failures count.
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
  if (wait) {
    for (const c of taken) limiters[c.limiter].refund(c.key); // a refused request costs nothing
    res.setHeader('Retry-After', String(wait));
    res.status(429).json({ error: `Too many attempts. Try again in ${wait < 60 ? `${wait} seconds` : `${Math.ceil(wait / 60)} minutes`}.` });
    return;
  }
  const pair = checks.find((c) => c.limiter === 'loginPair');
  if (!pair) return next();
  // Per-account: never refuse (no lock-out), just slow down once many failures arrive from anywhere.
  const email = emailKey((req.body as Record<string, unknown>).email);
  const slow = limiters.loginAccount.take(email) > 0;
  res.on('finish', () => {
    if (res.statusCode >= 300) return;
    limiters.loginPair.refund(pair.key);
    if (!slow) limiters.loginAccount.refund(email);
  });
  if (slow) setTimeout(next, ACCOUNT_DELAY_MS);
  else next();
};
