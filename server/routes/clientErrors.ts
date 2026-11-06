// POST /api/client-errors: errors caught in the browser or a native shell (src/lib/errorReporting.ts).
// Public, because a crash can happen before sign-in; a valid access token only adds the user id. Nothing is
// stored: each report becomes one structured `warn` log line (event "client_error"), read with `docker logs`.
// Only the fields below are kept, truncated; the request body is never logged verbatim.
import express, { Router } from 'express';
import { verifyToken } from '../auth.ts';
import { VERSION } from '../config.ts';
import { HttpError } from '../access.ts';
import { log } from '../log.ts';
import { refuse, takeClientError } from '../ratelimit.ts';

export const CLIENT_ERROR_BODY_LIMIT = '16kb';
export const KINDS = ['error', 'unhandledrejection', 'react'] as const;
export type ClientErrorKind = (typeof KINDS)[number];

const MAX = { message: 500, stack: 4000, componentStack: 2000, source: 300, url: 300, userAgent: 300, version: 40 };

const trunc = (v: unknown, max: number): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000_000 ? v : null);

/** Remove query strings and fragments from URLs inside free text (stack traces, messages). */
export function stripUrlsInText(s: string): string {
  return s.replace(/((?:https?|chrome-extension|moz-extension|capacitor|tauri):\/\/[^\s)?#'"]+)[?#][^\s)'"]*/g, '$1');
}

/** A page or script URL without its query string and fragment; invite tokens in the path are masked. */
export function cleanUrl(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  let out = v.slice(0, 2000).split('#')[0]!.split('?')[0]!;
  out = out.replace(/(\/invite\/)[^/]+/, '$1:token');
  return out.slice(0, MAX.url);
}

function viewer(req: express.Request): string | null {
  const m = /^Bearer (\S+)$/i.exec(req.get('authorization') ?? '');
  if (!m) return null;
  try {
    return verifyToken(m[1])?.id ?? null; // a bad or expired token is just anonymous
  } catch {
    return null;
  }
}

export const clientErrorRoutes = Router();

clientErrorRoutes.post(
  '/client-errors',
  (req, res, next) => {
    const wait = takeClientError(req);
    return wait ? refuse(res, wait) : next();
  },
  express.json({ limit: CLIENT_ERROR_BODY_LIMIT }), // oversize -> 413 via the API error handler
  (req, res, next) => {
    try {
      const b = req.body as Record<string, unknown> | undefined;
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'Expected a JSON object');
      const kind = b.kind;
      if (!KINDS.includes(kind as ClientErrorKind)) throw new HttpError(400, 'kind must be error, unhandledrejection or react');
      const message = trunc(b.message, 4 * MAX.message);
      if (!message) throw new HttpError(400, 'message is required');
      const stack = trunc(b.stack, 4 * MAX.stack);
      const componentStack = trunc(b.componentStack, 4 * MAX.componentStack);
      log.warn('client_error', {
        event: 'client_error',
        serverVersion: VERSION,
        clientVersion: trunc(b.version, MAX.version),
        userId: viewer(req),
        requestId: req.id,
        kind,
        message: stripUrlsInText(message).slice(0, MAX.message),
        stack: stack && stripUrlsInText(stack).slice(0, MAX.stack),
        componentStack: componentStack && stripUrlsInText(componentStack).slice(0, MAX.componentStack),
        source: cleanUrl(b.source),
        line: num(b.line),
        col: num(b.col),
        url: cleanUrl(b.url),
        userAgent: trunc(b.userAgent, MAX.userAgent),
      });
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  },
);
