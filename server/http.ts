// Small helpers shared by every route module.
import type { NextFunction, Request, Response } from 'express';
import { HttpError } from './access.ts';
import { log } from './log.ts';
import type { Role } from '../shared/types.ts';

export { HttpError };

/** Wrap a handler so its return value is sent as JSON and thrown errors reach the error handler. */
export type Handler = (req: Request, res: Response) => unknown;
export const h = (fn: Handler) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) {
    next(e);
  }
};

/** Required, trimmed, length-limited string field. */
export const str = (v: unknown, field: string, max = 500): string => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${field} is required`);
  if (v.length > max) throw new HttpError(400, `${field} is too long`);
  return v.trim();
};

/** Route param as a string (Express 5 types params as string | string[]). */
export const param = (req: Request, name: string): string => String(req.params[name]);

export const ROLES: Role[] = ['owner', 'admin', 'member', 'viewer'];

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err && typeof err === 'object' && 'type' in err && err.type === 'entity.parse.failed')
    return res.status(400).json({ error: 'Invalid JSON' });
  if (err && typeof err === 'object' && 'type' in err && err.type === 'entity.too.large')
    return res.status(413).json({ error: 'That is too large to upload' });
  log.error('unhandled error', { id: req.id, method: req.method, path: req.originalUrl.split('?')[0], err });
  // The request id lets a user's report be matched to the server log.
  res.status(500).json({ error: 'Something went wrong', requestId: req.id });
}
