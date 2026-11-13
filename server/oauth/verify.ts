// What the MCP endpoint (/mcp) uses to check the bearer token of each request, and the 401 challenge
// that sends clients to the protected-resource metadata (RFC 9728 §5.1).
import { db, now } from '../db.ts';
import { ACCESS_PREFIX, MCP_PATH, SCOPES, hashToken, isOwnResource, scopeList } from './config.ts';

/** last_used_at is written at most this often per connection. */
const LAST_USED_EVERY_MS = 60_000;

/**
 * The user, scopes and client behind an OAuth access token, or null if it is unknown, expired, revoked
 * (the token or its connection), or was issued for a resource other than this server's /mcp.
 * Records when the connection was last used (at most once a minute). User ids are strings (UUIDs).
 */
export async function verifyAccessToken(
  token: string,
): Promise<{ userId: string; scopes: ('notes:read' | 'notes:write')[]; clientId: string; clientName: string } | null> {
  if (typeof token !== 'string' || !token.startsWith(ACCESS_PREFIX) || token.length > 200) return null;
  const r = db
    .prepare(
      `SELECT t.scopes, t.expires_at, t.revoked_at, g.id AS grant_id, g.user_id, g.client_id, g.resource, g.revoked_at AS grant_revoked,
              g.last_used_at, c.name AS client_name
         FROM oauth_tokens t
         JOIN oauth_grants g ON g.id = t.grant_id
         JOIN oauth_clients c ON c.id = g.client_id
         JOIN users u ON u.id = g.user_id
        WHERE t.token_hash = ? AND t.kind = 'access'`,
    )
    .get(hashToken(token)) as
    | {
        scopes: string;
        expires_at: string;
        revoked_at: string | null;
        grant_id: string;
        user_id: string;
        client_id: string;
        resource: string;
        grant_revoked: string | null;
        last_used_at: string | null;
        client_name: string;
      }
    | undefined;
  if (!r || r.revoked_at || r.grant_revoked) return null;
  const ts = now();
  if (r.expires_at <= ts) return null;
  if (!isOwnResource(r.resource)) return null;
  if (!r.last_used_at || Date.parse(ts) - Date.parse(r.last_used_at) >= LAST_USED_EVERY_MS)
    db.prepare('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?').run(ts, r.grant_id);
  return { userId: r.user_id, scopes: scopeList(r.scopes), clientId: r.client_id, clientName: r.client_name };
}

/**
 * The WWW-Authenticate value for a 401 or 403 from /mcp (one Bearer challenge): where the protected-resource
 * metadata is, and the scopes to ask for. `origin` is the public origin, e.g. "https://notes.example.com".
 * `opts.error` adds an RFC 6750 error code (invalid_token, insufficient_scope); `opts.scope` replaces the
 * default scope list (e.g. the scopes a step-up needs).
 */
export function buildWwwAuthenticate(origin: string, opts: { error?: string; scope?: string } = {}): string {
  const base = origin.replace(/\/+$/, '');
  const params = [`resource_metadata="${base}/.well-known/oauth-protected-resource${MCP_PATH}"`, `scope="${opts.scope ?? SCOPES.join(' ')}"`];
  if (opts.error) params.push(`error="${opts.error}"`);
  return `Bearer ${params.join(', ')}`;
}
