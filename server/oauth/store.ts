// Database side of the OAuth server: authorization requests and codes, grants (connections) and tokens.
// Codes and tokens are random, opaque and stored only as SHA-256 hashes.
import crypto from 'node:crypto';
import { db, newId, now } from '../db.ts';
import {
  ACCESS_PREFIX,
  ACCESS_TOKEN_TTL_S,
  CODE_TTL_S,
  REFRESH_PREFIX,
  REFRESH_TOKEN_TTL_DAYS,
  REQUEST_TTL_S,
  hashToken,
  randomToken,
  scopeList,
  scopeString,
  type Scope,
} from './config.ts';
import { OAuthError } from './clients.ts';

export interface PendingRequest {
  id: string;
  client_id: string;
  redirect_uri: string;
  scopes: string;
  state: string | null;
  code_challenge: string;
  resource: string;
  created_at: string;
  expires_at: string;
  user_id: string | null;
  code_hash: string | null;
  code_expires_at: string | null;
  grant_id: string | null;
  used_at: string | null;
}

const later = (s: number) => new Date(Date.now() + s * 1000).toISOString();

export function createRequest(r: { clientId: string; redirectUri: string; scopes: Scope[]; state: string | null; codeChallenge: string; resource: string }): string {
  const id = crypto.randomBytes(24).toString('base64url');
  db.prepare(
    `INSERT INTO oauth_requests (id, client_id, redirect_uri, scopes, state, code_challenge, resource, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, r.clientId, r.redirectUri, scopeString(r.scopes), r.state, r.codeChallenge, r.resource, now(), later(REQUEST_TTL_S));
  return id;
}

/** A request still waiting for the user's decision. */
export function openRequest(id: unknown): PendingRequest | null {
  if (typeof id !== 'string' || !id || id.length > 100) return null;
  const r = db.prepare('SELECT * FROM oauth_requests WHERE id = ?').get(id) as PendingRequest | undefined;
  if (!r || r.code_hash || r.used_at || r.expires_at < now()) return null;
  return r;
}

/** The user allowed the request with `scopes` (a subset of what was asked): create the grant and a one-time code. */
export function approveRequest(req: PendingRequest, userId: string, scopes: Scope[]): string {
  const code = randomToken();
  return db.transaction(() => {
    // Single decision per request: refuse if it was decided meanwhile (another tab).
    const fresh = openRequest(req.id);
    if (!fresh) throw new OAuthError('invalid_request', 'This request was already answered or has expired', 409);
    const grantId = newId();
    db.prepare('INSERT INTO oauth_grants (id, user_id, client_id, scopes, resource, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      grantId,
      userId,
      req.client_id,
      scopeString(scopes),
      req.resource,
      now(),
    );
    db.prepare('UPDATE oauth_requests SET user_id = ?, code_hash = ?, code_expires_at = ?, grant_id = ? WHERE id = ?').run(
      userId,
      hashToken(code),
      later(CODE_TTL_S),
      grantId,
      req.id,
    );
    return code;
  })();
}

/** The user said no (or the request is abandoned): it can't be answered again. */
export function denyRequest(id: string) {
  db.prepare('UPDATE oauth_requests SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now(), id);
}

export interface TokenSet {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

function issue(grantId: string, accessScopes: Scope[], refreshScopes: Scope[]): TokenSet {
  const access = randomToken(ACCESS_PREFIX);
  const refresh = randomToken(REFRESH_PREFIX);
  const ins = db.prepare('INSERT INTO oauth_tokens (id, grant_id, kind, token_hash, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  ins.run(newId(), grantId, 'access', hashToken(access), scopeString(accessScopes), now(), later(ACCESS_TOKEN_TTL_S));
  ins.run(newId(), grantId, 'refresh', hashToken(refresh), scopeString(refreshScopes), now(), later(REFRESH_TOKEN_TTL_DAYS * 86_400));
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_S, refresh_token: refresh, scope: scopeString(accessScopes) };
}

/** A replayed code or refresh token: the connection is revoked after the (rolled back) transaction. */
class ReplayError extends OAuthError {
  constructor(
    readonly grantId: string,
    description: string,
  ) {
    super('invalid_grant', description);
  }
}
function revokingOnReplay<T>(fn: () => T): T {
  try {
    return db.transaction(fn)();
  } catch (e) {
    if (e instanceof ReplayError) revokeGrant(e.grantId);
    throw e;
  }
}

const s256 = (verifier: string) => crypto.createHash('sha256').update(verifier).digest('base64url');
const safeEqual = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function revokeGrant(grantId: string) {
  const ts = now();
  db.prepare('UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(ts, grantId);
  db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL').run(ts, grantId);
}

/** authorization_code grant. The code is single use: presenting it twice revokes everything issued from it (RFC 6749 §4.1.2). */
export function exchangeCode(p: { code: unknown; clientId: unknown; redirectUri: unknown; verifier: unknown; resource: string | null }): TokenSet {
  const bad = (msg: string) => new OAuthError('invalid_grant', msg);
  if (typeof p.code !== 'string' || !p.code) throw new OAuthError('invalid_request', 'code is required');
  if (typeof p.verifier !== 'string' || !/^[A-Za-z0-9\-._~]{43,128}$/.test(p.verifier)) throw new OAuthError('invalid_request', 'A valid code_verifier is required (PKCE)');
  return revokingOnReplay(() => {
    const r = db.prepare('SELECT * FROM oauth_requests WHERE code_hash = ?').get(hashToken(p.code as string)) as PendingRequest | undefined;
    if (!r || !r.grant_id) throw bad('Invalid authorization code');
    if (r.used_at) throw new ReplayError(r.grant_id, 'Authorization code already used');
    if (r.client_id !== p.clientId) throw bad('The code was issued to another client');
    if (r.redirect_uri !== p.redirectUri) throw bad('redirect_uri does not match the authorization request');
    if (!r.code_expires_at || r.code_expires_at < now()) throw bad('Authorization code expired');
    if (p.resource !== null && p.resource !== r.resource) throw new OAuthError('invalid_target', 'resource does not match the authorization request');
    if (!safeEqual(s256(p.verifier as string), r.code_challenge)) throw bad('PKCE verification failed');
    db.prepare('UPDATE oauth_requests SET used_at = ? WHERE id = ?').run(now(), r.id);
    const grant = db.prepare('SELECT scopes, revoked_at FROM oauth_grants WHERE id = ?').get(r.grant_id) as { scopes: string; revoked_at: string | null } | undefined;
    if (!grant || grant.revoked_at) throw bad('This authorization was revoked');
    const scopes = scopeList(grant.scopes);
    return issue(r.grant_id, scopes, scopes);
  });
}

interface TokenRow {
  id: string;
  grant_id: string;
  kind: 'access' | 'refresh';
  scopes: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
}

/**
 * refresh_token grant with rotation: the old refresh token is retired and a new pair issued. Presenting a
 * retired refresh token again revokes the whole connection (it may have been stolen). `scope` may narrow the
 * new access token, never widen it; the new refresh token keeps the old one's scopes (RFC 6749 §6).
 */
export function refresh(p: { token: unknown; clientId: unknown; scope: unknown; resource: string | null }): TokenSet {
  const bad = (msg: string) => new OAuthError('invalid_grant', msg);
  if (typeof p.token !== 'string' || !p.token) throw new OAuthError('invalid_request', 'refresh_token is required');
  return revokingOnReplay(() => {
    const t = db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'").get(hashToken(p.token as string)) as TokenRow | undefined;
    if (!t) throw bad('Invalid refresh token');
    const g = db.prepare('SELECT * FROM oauth_grants WHERE id = ?').get(t.grant_id) as { client_id: string; resource: string; revoked_at: string | null } | undefined;
    if (!g || g.revoked_at || t.revoked_at) throw bad('Refresh token revoked');
    if (g.client_id !== p.clientId) throw bad('The refresh token was issued to another client');
    if (t.used_at) throw new ReplayError(t.grant_id, 'Refresh token already used; the connection has been revoked');
    if (t.expires_at < now()) throw bad('Refresh token expired');
    if (p.resource !== null && p.resource !== g.resource) throw new OAuthError('invalid_target', 'resource does not match this grant');
    const held = scopeList(t.scopes);
    let accessScopes = held;
    if (typeof p.scope === 'string' && p.scope.trim()) {
      const asked = p.scope.split(/\s+/).filter(Boolean);
      if (asked.some((s) => !held.includes(s as Scope))) throw new OAuthError('invalid_scope', 'Refresh can’t add scopes that weren’t granted');
      accessScopes = scopeList(p.scope);
    }
    db.prepare('UPDATE oauth_tokens SET used_at = ? WHERE id = ?').run(now(), t.id);
    return issue(t.grant_id, accessScopes, held);
  });
}

/** RFC 7009. A refresh token ends the whole connection; an access token only itself. Unknown tokens are ignored. */
export function revokeToken(token: unknown, clientId: unknown) {
  if (typeof token !== 'string' || !token) throw new OAuthError('invalid_request', 'token is required');
  const t = db.prepare('SELECT t.*, g.client_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = ?').get(hashToken(token)) as
    | (TokenRow & { client_id: string })
    | undefined;
  if (!t) return;
  // Public clients identify themselves only by client_id; a token presented by another client is left alone.
  if (t.client_id !== clientId) return;
  if (t.kind === 'refresh') revokeGrant(t.grant_id);
  else db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), t.id);
}

export interface ConnectedAppRow {
  clientId: string;
  name: string;
  clientUri: string | null;
  kind: 'dcr' | 'cimd';
  scopes: Scope[];
  connectedAt: string;
  lastUsedAt: string | null;
}

/** Live connections of a user, one row per app (a live connection has an unrevoked, unexpired refresh token). */
export function connectedApps(userId: string): ConnectedAppRow[] {
  const rows = db
    .prepare(
      `SELECT g.client_id, c.name, c.client_uri, c.kind, g.scopes, g.created_at, g.last_used_at
         FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
        WHERE g.user_id = ? AND g.revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = g.id AND t.kind = 'refresh' AND t.revoked_at IS NULL AND t.expires_at > ?)
        ORDER BY g.created_at`,
    )
    .all(userId, now()) as { client_id: string; name: string; client_uri: string | null; kind: 'dcr' | 'cimd'; scopes: string; created_at: string; last_used_at: string | null }[];
  const byClient = new Map<string, ConnectedAppRow>();
  for (const r of rows) {
    const prev = byClient.get(r.client_id);
    const scopes = scopeList(r.scopes);
    if (!prev) {
      byClient.set(r.client_id, { clientId: r.client_id, name: r.name, clientUri: r.client_uri, kind: r.kind, scopes, connectedAt: r.created_at, lastUsedAt: r.last_used_at });
      continue;
    }
    prev.scopes = scopeList(scopeString([...prev.scopes, ...scopes]));
    if (r.last_used_at && (!prev.lastUsedAt || r.last_used_at > prev.lastUsedAt)) prev.lastUsedAt = r.last_used_at;
  }
  return [...byClient.values()];
}

/** Settings → Connected apps → Revoke: end every connection between this user and this app. */
export function revokeClientForUser(userId: string, clientId: string): number {
  const grants = db.prepare('SELECT id FROM oauth_grants WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL').all(userId, clientId) as { id: string }[];
  db.transaction(() => grants.forEach((g) => revokeGrant(g.id)))();
  return grants.length;
}

/** Housekeeping: finished requests, expired or long-revoked tokens, and connections with nothing left. */
export function pruneOAuth() {
  const ts = now();
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const dayAgo = new Date(Date.now() - 864e5).toISOString();
  db.prepare('DELETE FROM oauth_requests WHERE expires_at < ? AND (code_expires_at IS NULL OR code_expires_at < ?)').run(ts, ts);
  db.prepare('DELETE FROM oauth_tokens WHERE expires_at < ? OR revoked_at < ?').run(ts, weekAgo);
  db.prepare(
    `DELETE FROM oauth_grants WHERE (revoked_at < ? OR created_at < ?)
       AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = oauth_grants.id)
       AND NOT EXISTS (SELECT 1 FROM oauth_requests r WHERE r.grant_id = oauth_grants.id)`,
  ).run(weekAgo, dayAgo);
}
