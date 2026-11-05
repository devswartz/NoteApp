// Rate limiting for authentication endpoints: in-memory token buckets keyed
// per client IP and per account, answering 429 with Retry-After.
// Owner: Collaboration & Access (hardening).
//
// One server process (see PLAN.md), so in-memory state is enough; buckets
// are pruned once full again. The client IP is Cloudflare's
// `CF-Connecting-IP` (the app is only reachable through the tunnel, see
// docs/DEPLOY_CONTRACT.md), else the socket address. Direct loopback
// connections without that header (local dev, the e2e suite, health checks)
// are exempt unless RATE_LIMIT_LOOPBACK=1. RATE_LIMIT=off disables limiting.
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

export class Limiter {
  private buckets = new Map<string, Bucket>();
  constructor(readonly spec: BucketSpec, private now: () => number = Date.now) {}

  /** Take one token for `key`. Returns 0 if allowed, else seconds until one is available. */
  take(key: string): number {
    const t = this.now();
    const refillPerMs = this.spec.perMinute / 60_000;
    const b = this.buckets.get(key) ?? { tokens: this.spec.capacity, at: t };
    b.tokens = Math.min(this.spec.capacity, b.tokens + (t - b.at) * refillPerMs);
    b.at = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(key, b);
      return 0;
    }
    this.buckets.set(key, b);
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
  loginAccount: { capacity: 8, perMinute: 0.5 }, // ~8 wrong passwords, then one per 2 minutes
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

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function clientIp(req: Request): { ip: string; loopback: boolean } {
  const cf = req.get('cf-connecting-ip');
  if (cf) return { ip: cf.trim(), loopback: false };
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
      return [{ limiter: 'loginIp', key: ip }, ...(email ? [{ limiter: 'loginAccount' as const, key: email }] : [])];
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
 * A successful login refunds the per-account token, so only failures count against an account.
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
  const account = checks.find((c) => c.limiter === 'loginAccount');
  if (account) res.on('finish', () => res.statusCode < 300 && limiters.loginAccount.refund(account.key));
  next();
};
