// Shared pieces of the OAuth authorization server for AI connectors: scopes, lifetimes, and the issuer and
// resource identifiers. See server/oauth/routes.ts for the flow.
import type { Request } from 'express';
import crypto from 'node:crypto';
import { PUBLIC_URL } from '../config.ts';

export const SCOPES = ['notes:read', 'notes:write'] as const;
export type Scope = (typeof SCOPES)[number];

/** Path of the MCP endpoint; the protected resource is `<origin>/mcp`. */
export const MCP_PATH = '/mcp';

export const ACCESS_TOKEN_TTL_S = 60 * 60;
export const REFRESH_TOKEN_TTL_DAYS = 30;
/** A rotated refresh token still works this long (a client retrying after a lost response); after that, reuse revokes the connection. */
export const REFRESH_REUSE_GRACE_S = 30;
export const CODE_TTL_S = 120;
/** How long a sign-in + consent may take after /oauth/authorize (the user may need to sign in or sign up first). */
export const REQUEST_TTL_S = 30 * 60;

export const ACCESS_PREFIX = 'nvo_at_';
export const REFRESH_PREFIX = 'nvo_rt_';

export const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
export const randomToken = (prefix = '') => prefix + crypto.randomBytes(32).toString('base64url');

/**
 * Parse a space-separated scope string. Unknown scopes (e.g. offline_access, openid) are ignored rather than
 * refused, for compatibility. notes:write implies notes:read. Nothing recognised → notes:read (least privilege).
 */
export function parseScopes(raw: unknown): Scope[] {
  const asked = typeof raw === 'string' ? raw.split(/\s+/).filter(Boolean) : [];
  const set = new Set(asked.filter((s): s is Scope => (SCOPES as readonly string[]).includes(s)));
  if (set.has('notes:write')) set.add('notes:read');
  if (!set.size) set.add('notes:read');
  return SCOPES.filter((s) => set.has(s));
}

/** Normalise a stored scope string (already validated). */
export const scopeList = (s: string): Scope[] => parseScopes(s);
export const scopeString = (s: Scope[]) => SCOPES.filter((x) => s.includes(x)).join(' ');

/**
 * The public origin: PUBLIC_URL when configured (always in production), else the request's own origin
 * (local runs without PUBLIC_URL). The issuer, every endpoint URL and the resource are built from it.
 */
export function originFor(req: Request): string {
  if (PUBLIC_URL) return PUBLIC_URL;
  return `${req.protocol}://${req.get('host')}`;
}

export const resourceFor = (origin: string) => origin + MCP_PATH;

/**
 * Canonical form of a resource indicator (RFC 8707): lowercase scheme and host, no trailing slash, no fragment.
 * Null when it isn't an absolute http(s) URL without a fragment.
 */
export function canonicalResource(raw: string): string | null {
  try {
    const u = new URL(raw);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.hash || raw.includes('#') || u.username || u.password) return null;
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host}${path}${u.search}`;
  } catch {
    return null;
  }
}

/**
 * Whether a token's resource is this server's MCP endpoint. With PUBLIC_URL set it must be exactly
 * `<PUBLIC_URL>/mcp`; without it (local runs only) the origin isn't known outside a request, so only the path is checked.
 */
export function isOwnResource(resource: string): boolean {
  if (PUBLIC_URL) return resource === canonicalResource(resourceFor(PUBLIC_URL));
  try {
    return new URL(resource).pathname === MCP_PATH;
  } catch {
    return false;
  }
}
