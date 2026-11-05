// Pure decision logic for client error reporting (no DOM, no network), unit-tested in tests/errorFilter.test.ts.
// The wiring (listeners, fetch) is in errorReporting.ts.

export type ErrorKind = 'error' | 'unhandledrejection' | 'react';

export interface ErrorInfo {
  kind: ErrorKind;
  message: string;
  stack?: string;
  name?: string;
  source?: string;
}

/** True for noise that isn't actionable: observer loops, opaque cross-origin errors, aborts, extension code. */
export function shouldIgnore(e: ErrorInfo): boolean {
  const msg = e.message ?? '';
  if (!msg.trim()) return true;
  if (/ResizeObserver loop (limit exceeded|completed with undelivered notifications)/i.test(msg)) return true;
  if (/^Script error\.?$/i.test(msg.trim()) && !e.stack) return true; // cross-origin script, details withheld by the browser
  if (e.name === 'AbortError' || (/\babort(ed)?\b/i.test(msg) && /operation|request|signal|fetch/i.test(msg))) return true;
  if (/^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?|Network request failed)$/i.test(msg.trim())) return true;
  if (/(chrome|moz|safari-web)-extension:\/\//.test(`${e.source ?? ''}\n${e.stack ?? ''}`)) return true;
  return false;
}

export interface ThrottleOptions {
  /** Reports allowed per window (default 5). */
  max?: number;
  /** Window and de-duplication period in ms (default 60 000). */
  windowMs?: number;
  now?: () => number;
}

/** Key for "the same error": message plus the first lines of the stack. */
export const dedupeKey = (e: Pick<ErrorInfo, 'message' | 'stack'>) => `${e.message}\n${(e.stack ?? '').split('\n').slice(0, 6).join('\n')}`.slice(0, 1000);

/**
 * Sliding-window throttle with de-duplication. `allow` returns true (and records the report) when at most `max`
 * reports went out in the last `windowMs` and the same message+stack wasn't reported in that window.
 * A de-duplicated report doesn't use up budget.
 */
export function createThrottle({ max = 5, windowMs = 60_000, now = Date.now }: ThrottleOptions = {}) {
  let sent: number[] = [];
  const seen = new Map<string, number>();
  return {
    allow(e: Pick<ErrorInfo, 'message' | 'stack'>): boolean {
      const t = now();
      sent = sent.filter((s) => t - s < windowMs);
      for (const [k, at] of seen) if (t - at >= windowMs) seen.delete(k);
      const key = dedupeKey(e);
      if (seen.has(key)) return false;
      if (sent.length >= max) return false;
      seen.set(key, t);
      sent.push(t);
      return true;
    },
  };
}

/** Page URL without query string and fragment (the server strips again; this keeps them off the wire). */
export function stripUrl(u: string): string {
  return u.split('#')[0]!.split('?')[0]!;
}

/** Turn whatever was thrown or rejected into message/stack/name. Never throws. */
export function describeThrown(v: unknown): { message: string; stack?: string; name?: string } {
  try {
    if (v && typeof v === 'object') {
      const o = v as { message?: unknown; stack?: unknown; name?: unknown };
      const message = typeof o.message === 'string' ? o.message : safeString(v);
      return { message, stack: typeof o.stack === 'string' ? o.stack : undefined, name: typeof o.name === 'string' ? o.name : undefined };
    }
    return { message: safeString(v) };
  } catch {
    return { message: 'Unknown error' };
  }
}

function safeString(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
