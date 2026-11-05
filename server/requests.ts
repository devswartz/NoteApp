// Per-request id, access log and in-memory request metrics.
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { log } from './log.ts';

declare module 'express-serve-static-core' {
  interface Request {
    /** Correlates the access log, error logs and the client's error message. */
    id: string;
  }
}

const SAMPLE = 1000; // latency samples kept for percentiles
const latencies: number[] = [];
const byStatus: Record<string, number> = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
let total = 0;
const startedAt = Date.now();

/** Assigns req.id (accepting a sane incoming X-Request-Id), echoes it, logs and counts the request. */
export function requestLog(req: Request, res: Response, next: NextFunction) {
  const incoming = req.get('x-request-id');
  req.id = incoming && /^[\w.-]{8,64}$/.test(incoming) ? incoming : crypto.randomBytes(8).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    total++;
    byStatus[`${Math.floor(res.statusCode / 100)}xx`] = (byStatus[`${Math.floor(res.statusCode / 100)}xx`] ?? 0) + 1;
    latencies.push(ms);
    if (latencies.length > SAMPLE) latencies.shift();
    const fields = {
      id: req.id,
      method: req.method,
      path: req.originalUrl.split('?')[0], // no query strings: they can carry tokens
      status: res.statusCode,
      ms: Math.round(ms * 10) / 10,
      user: req.user?.id,
    };
    if (res.statusCode >= 500) log.error('request', fields);
    else if (req.path !== '/health') log.debug('request', fields);
  });
  next();
}

const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);

export function requestStats() {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    since: new Date(startedAt).toISOString(),
    total,
    byStatus: { ...byStatus },
    latencyMs: { p50: Math.round(pct(sorted, 50)), p95: Math.round(pct(sorted, 95)), p99: Math.round(pct(sorted, 99)), samples: sorted.length },
  };
}
