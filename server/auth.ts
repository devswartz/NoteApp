// Authentication: short-lived JWT access tokens plus rotating refresh tokens.
//
// - Access token: JWT {sub, typ:'access'}, ACCESS_TTL_S lifetime, sent as
//   `Authorization: Bearer …` (REST) or in the WebSocket subprotocol list (see
//   tokenFromUpgrade). Never stored server-side.
// - Refresh token: random opaque string, REFRESH_TTL_DAYS lifetime, stored as a
//   hash. Each use returns a new pair and retires the old token (rotation).
//   Reusing a retired token after REUSE_GRACE_S revokes the whole sign-in
//   (family), since it may have been stolen. The grace window covers two tabs
//   or a flaky network refreshing at the same moment.
// No cookies are used anywhere, so native shells and other origins work the same.
import type { NextFunction, Request, Response } from 'express';
import type { IncomingMessage } from 'node:http';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, newId, now } from './db.ts';
import { DATA_DIR, IS_PROD } from './config.ts';
import type { AuthSession, User } from '../shared/types.ts';

// ACCESS_TOKEN_TTL_S is a testing knob (e.g. short tokens to exercise refresh); not part of the deploy contract.
export const ACCESS_TTL_S = Number(process.env.ACCESS_TOKEN_TTL_S) || 15 * 60;
export const REFRESH_TTL_DAYS = 30;
const REUSE_GRACE_S = 60;
/** WebSocket subprotocol carrying the access token: `bearer.<jwt>`. */
export const WS_TOKEN_PREFIX = 'bearer.';
/** Subprotocol the server selects; clients offer it alongside the token. */
export const WS_PROTOCOL = 'noteapp.v1';

function loadSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (IS_PROD) {
    console.error('JWT_SECRET must be set in production');
    process.exit(1);
  }
  // Dev: persist a generated secret next to the database so sessions survive restarts.
  const file = path.join(DATA_DIR, '.jwt-secret');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    const s = crypto.randomBytes(48).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, s, { mode: 0o600 });
    return s;
  }
}
const SECRET = loadSecret();

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId, typ: 'access' }, SECRET, { expiresIn: ACCESS_TTL_S });
}

function insertRefreshToken(userId: string, familyId: string, userAgent: string | null): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const ts = new Date();
  db.prepare(
    `INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, created_at, expires_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId(), userId, familyId, hash(token), ts.toISOString(), new Date(ts.getTime() + REFRESH_TTL_DAYS * 864e5).toISOString(), userAgent?.slice(0, 200) ?? null);
  return token;
}

function session(userId: string, refreshToken: string): Omit<AuthSession, 'user'> {
  return { accessToken: signAccessToken(userId), refreshToken, expiresIn: ACCESS_TTL_S };
}

/** Start a new sign-in (new token family). */
export function issueSession(userId: string, userAgent: string | null = null): Omit<AuthSession, 'user'> {
  return session(userId, insertRefreshToken(userId, newId(), userAgent));
}

interface RefreshRow {
  id: string;
  user_id: string;
  family_id: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
}

/** Exchange a refresh token for a new pair. Returns null if it is invalid, expired, revoked or replayed. */
export function rotateRefreshToken(token: unknown, userAgent: string | null = null): (Omit<AuthSession, 'user'> & { userId: string }) | null {
  if (typeof token !== 'string' || !token) return null;
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(hash(token)) as RefreshRow | undefined;
    if (!row || row.revoked_at || row.expires_at < now()) return null;
    if (row.used_at && Date.now() - Date.parse(row.used_at) > REUSE_GRACE_S * 1000) {
      // Replay of a token that was rotated a while ago: assume theft and end the sign-in.
      revokeFamily(row.family_id);
      return null;
    }
    if (!row.used_at) db.prepare('UPDATE refresh_tokens SET used_at = ? WHERE id = ?').run(now(), row.id);
    if (!getUser(row.user_id)) return null;
    return { userId: row.user_id, ...session(row.user_id, insertRefreshToken(row.user_id, row.family_id, userAgent)) };
  })();
}

export function revokeFamily(familyId: string) {
  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL').run(now(), familyId);
}

/** Sign out: revoke the sign-in this refresh token belongs to. */
export function revokeRefreshToken(token: unknown) {
  if (typeof token !== 'string' || !token) return;
  const row = db.prepare('SELECT family_id FROM refresh_tokens WHERE token_hash = ?').get(hash(token)) as { family_id: string } | undefined;
  if (row) revokeFamily(row.family_id);
}

/** Housekeeping: drop expired and long-revoked tokens. */
export function pruneRefreshTokens() {
  const cutoff = new Date(Date.now() - 7 * 864e5).toISOString();
  db.prepare('DELETE FROM refresh_tokens WHERE expires_at < ? OR revoked_at < ?').run(now(), cutoff);
}

export function verifyToken(token: string | undefined | null): User | null {
  if (!token) return null;
  try {
    const p = jwt.verify(token, SECRET) as { sub: string; typ?: string };
    if (p.typ !== 'access') return null;
    return getUser(p.sub);
  } catch {
    return null;
  }
}

export function getUser(id: string): User | null {
  return (db.prepare('SELECT id, email, name, color FROM users WHERE id = ?').get(id) as User) ?? null;
}

/**
 * Access token for a WebSocket upgrade. Browsers can't set headers on
 * WebSockets, so clients send `Sec-WebSocket-Protocol: noteapp.v1, bearer.<jwt>`
 * (keeps the token out of URLs and proxy logs). `?token=` is still accepted
 * for simple clients and scripts.
 */
export function tokenFromUpgrade(req: IncomingMessage): string | null {
  const protocols = String(req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((s) => s.trim());
  const p = protocols.find((s) => s.startsWith(WS_TOKEN_PREFIX));
  if (p) return p.slice(WS_TOKEN_PREFIX.length);
  return new URL(req.url ?? '', 'http://x').searchParams.get('token');
}

/** For `new WebSocketServer({ handleProtocols })`: never echo the token back. */
export function handleProtocols(protocols: Set<string>): string | false {
  return protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false;
}

declare module 'express-serve-static-core' {
  interface Request {
    user: User;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const user = verifyToken(header?.startsWith('Bearer ') ? header.slice(7) : null);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  next();
}
