// Authentication: short-lived JWT access tokens plus rotating refresh tokens.
//
// - Access token: JWT {sub, typ:'access'}, ACCESS_TTL_S lifetime, sent as
//   `Authorization: Bearer …` (REST) or in the WebSocket subprotocol list (see
//   tokenFromUpgrade). Never stored server-side.
// - Refresh token: random opaque string, REFRESH_TTL_DAYS lifetime, stored as a
//   hash. Each use returns a new pair and retires the old token (rotation).
//   Presenting a retired token again within REUSE_GRACE_S (a lost response, a
//   retry, two windows racing) returns the *same* replacement token, so no
//   second chain is ever created. After that, reuse revokes the whole sign-in
//   (family), since the token may have been stolen.
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

const MIN_SECRET_BYTES = 32;

function loadSecret(): string {
  const env = process.env.JWT_SECRET;
  if (IS_PROD && (!env || Buffer.byteLength(env) < MIN_SECRET_BYTES)) {
    console.error(`JWT_SECRET must be set to at least ${MIN_SECRET_BYTES} bytes in production`);
    process.exit(1);
  }
  if (env) return env;
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
  replacement_enc: string | null;
}

// The replacement token is encrypted with a key only the holder of the old token can derive.
const replayKey = (oldToken: string) => crypto.createHash('sha256').update(`noteapp-refresh-replay:${oldToken}`).digest();

function sealReplacement(oldToken: string, replacement: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', replayKey(oldToken), iv);
  const ct = Buffer.concat([c.update(replacement, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

function openReplacement(oldToken: string, sealed: string): string | null {
  try {
    const b = Buffer.from(sealed, 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', replayKey(oldToken), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Exchange a refresh token for a new pair. Returns null if it is invalid, expired, revoked or replayed. */
export function rotateRefreshToken(token: unknown, userAgent: string | null = null): (Omit<AuthSession, 'user'> & { userId: string }) | null {
  if (typeof token !== 'string' || !token) return null;
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(hash(token)) as RefreshRow | undefined;
    if (!row || row.revoked_at || row.expires_at < now()) return null;
    if (!getUser(row.user_id)) return null;
    if (row.used_at) {
      // Already rotated. Inside the grace window, hand back the current head of
      // the chain (no new chain); otherwise assume theft and end the sign-in.
      const inGrace = Date.now() - Date.parse(row.used_at) <= REUSE_GRACE_S * 1000;
      const head = inGrace ? chainHead(token, row) : null;
      if (!head) {
        revokeFamily(row.family_id);
        return null;
      }
      return { userId: row.user_id, ...session(row.user_id, head) };
    }
    const next = insertRefreshToken(row.user_id, row.family_id, userAgent);
    db.prepare('UPDATE refresh_tokens SET used_at = ?, replacement_enc = ? WHERE id = ?').run(now(), sealReplacement(token, next), row.id);
    return { userId: row.user_id, ...session(row.user_id, next) };
  })();
}

/**
 * Follow a rotated token's replacements to the newest one that hasn't been
 * used yet. Each replacement is sealed with the token before it, so only the
 * holder of the replayed token can walk the chain. Null if any link is
 * missing, revoked or expired.
 */
function chainHead(token: string, row: RefreshRow): string | null {
  let current = token;
  let r: RefreshRow | undefined = row;
  for (let i = 0; i < 20 && r; i++) {
    if (r.revoked_at || r.expires_at < now()) return null;
    if (!r.used_at) return current;
    const next = r.replacement_enc ? openReplacement(current, r.replacement_enc) : null;
    if (!next) return null;
    current = next;
    r = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(hash(current)) as RefreshRow | undefined;
  }
  return null;
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

/** Verify an access token. `expiresAt` (ms) lets long-lived sockets close when it lapses. */
export function verifyAccessToken(token: string | undefined | null): { user: User; expiresAt: number } | null {
  if (!token) return null;
  try {
    const p = jwt.verify(token, SECRET) as { sub: string; typ?: string; exp: number };
    if (p.typ !== 'access') return null;
    const user = getUser(p.sub);
    return user ? { user, expiresAt: p.exp * 1000 } : null;
  } catch {
    return null;
  }
}

export function verifyToken(token: string | undefined | null): User | null {
  return verifyAccessToken(token)?.user ?? null;
}

export function getUser(id: string): User | null {
  return (db.prepare('SELECT id, email, name, color FROM users WHERE id = ?').get(id) as User) ?? null;
}

/**
 * Access token for a WebSocket upgrade. Browsers can't set headers on
 * WebSockets, so clients send `Sec-WebSocket-Protocol: noteapp.v1, bearer.<jwt>`
 * (keeps the token out of URLs and proxy logs). `?token=` is accepted in
 * development only, for scripts.
 */
export function tokenFromUpgrade(req: IncomingMessage): string | null {
  const protocols = String(req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((s) => s.trim());
  const p = protocols.find((s) => s.startsWith(WS_TOKEN_PREFIX));
  if (p) return p.slice(WS_TOKEN_PREFIX.length);
  return IS_PROD ? null : new URL(req.url ?? '', 'http://x').searchParams.get('token');
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
