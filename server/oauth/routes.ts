// OAuth 2.1 authorization server for AI connectors (ChatGPT, Claude and other remote MCP clients), following
// the MCP authorization spec (2026-07-28). The MCP endpoint itself (/mcp) checks tokens with verify.ts.
//
//   GET  /.well-known/oauth-authorization-server        RFC 8414 metadata (server/wellKnown.ts)
//   GET  /.well-known/oauth-protected-resource[/mcp]    RFC 9728 metadata; resource = <origin>/mcp
//   POST /oauth/register     Dynamic Client Registration (RFC 7591), public clients only, rate limited
//   GET  /oauth/authorize    authorization code + PKCE (S256 only); client_id may be a metadata-document URL
//   POST /oauth/token        authorization_code and refresh_token (rotated) grants
//   POST /oauth/revoke       RFC 7009
//
// Consent: /oauth/authorize validates the request, stores it, and sends the browser to the web app's
// /oauth/consent?request=<id> page. That page signs the user in if needed (the app's own sign-in; it uses
// bearer tokens, not cookies), then shows the request from GET /api/oauth/requests/:id and posts the decision to
// POST /api/oauth/requests/:id, which answers with the client redirect (code or access_denied, plus state and iss).
// Problems that make the redirect untrustworthy (unknown client, unregistered redirect_uri) never redirect:
// the page shows /oauth/consent?error=<code> instead.
//
// Tokens: opaque, hashed at rest. Access tokens last ACCESS_TOKEN_TTL_S and are bound to the resource;
// refresh tokens rotate on every use and a replayed one revokes the connection. Settings → Connected apps
// lists connections (GET /api/me/connected-apps) and revokes them (DELETE /api/me/connected-apps/:clientId).
import express, { Router, type Request, type Response } from 'express';
import { h, param } from '../http.ts';
import { HttpError } from '../access.ts';
import { takeOAuth } from '../ratelimit.ts';
import { APP_NAME } from '../../shared/config.ts';
import type { ConnectedApp, OAuthConsentInfo } from '../../shared/types.ts';
import { SCOPES, canonicalResource, originFor, parseScopes, resourceFor, scopeList, type Scope } from './config.ts';
import { OAuthError, getStoredClient, redirectMatches, registerClient, resolveClient } from './clients.ts';
import { approveRequest, connectedApps, createRequest, denyRequest, exchangeCode, openRequest, refresh, revokeClientForUser, revokeToken } from './store.ts';

// ── Metadata ──

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    scopes_supported: [...SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${origin}/support`,
  };
}

export function protectedResourceMetadata(origin: string) {
  return {
    resource: resourceFor(origin),
    authorization_servers: [origin],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: APP_NAME,
    resource_documentation: `${origin}/support`,
  };
}

/** Mounted under /.well-known by server/wellKnown.ts. */
export function oauthWellKnownRoutes() {
  const r = Router();
  const send = (body: (origin: string) => unknown) => (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(body(originFor(req)));
  };
  r.get('/oauth-authorization-server', send(authorizationServerMetadata));
  r.get('/oauth-protected-resource', send(protectedResourceMetadata));
  r.get('/oauth-protected-resource/mcp', send(protectedResourceMetadata));
  return r;
}

// ── Public endpoints (/oauth) ──

const noStore = (res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
};

function oauthError(res: Response, e: unknown) {
  noStore(res);
  if (e instanceof OAuthError) {
    if (e.status === 401) res.setHeader('WWW-Authenticate', 'Basic realm="oauth"');
    return res.status(e.status).json({ error: e.error, error_description: e.description });
  }
  throw e;
}

/** One value of a parameter; repeated parameters are refused (RFC 6749 §3.1). */
function single(v: unknown, name: string): string | null {
  if (v === undefined || v === '') return null;
  if (typeof v !== 'string') throw new OAuthError('invalid_request', `${name} must be given once`);
  return v;
}

/** The client of a token or revocation request: client_id in the body, or the user name of HTTP Basic auth. */
function clientIdOf(req: Request): string | null {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.client_id === 'string' && body.client_id) return body.client_id;
  const auth = req.get('authorization');
  if (auth?.startsWith('Basic ')) {
    const raw = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const i = raw.indexOf(':');
    try {
      return decodeURIComponent(i < 0 ? raw : raw.slice(0, i)) || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Add parameters to a client redirect URI (it may already have a query). */
export function withParams(uri: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
}

const consentError = (res: Response, code: string) => res.redirect(302, `/oauth/consent?error=${encodeURIComponent(code)}`);

function rateLimited(req: Request, res: Response, kind: Parameters<typeof takeOAuth>[1]): boolean {
  const wait = takeOAuth(req, kind);
  if (!wait) return false;
  res.setHeader('Retry-After', String(wait));
  res.status(429).json({ error: 'slow_down', error_description: 'Too many requests. Try again later.' });
  return true;
}

export function oauthRoutes() {
  const r = Router();
  const form = express.urlencoded({ extended: false, limit: '16kb' });
  const json = express.json({ limit: '64kb' });

  // Browser-based clients (e.g. MCP inspectors) call these cross-origin. No cookies are involved.
  r.use((req, res, next) => {
    if (req.path === '/authorize') return next();
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method !== 'OPTIONS') return next();
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
  });

  r.post('/register', json, (req, res) => {
    if (rateLimited(req, res, 'register')) return;
    try {
      noStore(res);
      res.status(201).json(registerClient(req.body));
    } catch (e) {
      oauthError(res, e);
    }
  });

  r.get('/authorize', async (req, res, next) => {
    if (rateLimited(req, res, 'authorize')) return;
    try {
      const q = req.query as Record<string, unknown>;
      let clientId: string | null, redirectParam: string | null;
      try {
        clientId = single(q.client_id, 'client_id');
        redirectParam = single(q.redirect_uri, 'redirect_uri');
      } catch {
        return consentError(res, 'invalid_request');
      }
      let client;
      try {
        client = await resolveClient(clientId);
      } catch (e) {
        if (e instanceof OAuthError) return consentError(res, 'invalid_client');
        throw e;
      }
      if (!client) return consentError(res, 'invalid_client');
      // OAuth 2.1: redirect_uri may be left out only when exactly one is registered.
      const redirectUri = redirectParam ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : null);
      if (!redirectUri || !redirectMatches(client, redirectUri)) return consentError(res, 'invalid_redirect_uri');

      // From here on, errors go back to the client.
      const origin = originFor(req);
      let state: string | null = null;
      const back = (error: string, description: string) =>
        res.redirect(302, withParams(redirectUri, { error, error_description: description, state, iss: origin }));
      try {
        state = single(q.state, 'state');
        if (state && state.length > 2000) return back('invalid_request', 'state is too long');
        if (single(q.response_type, 'response_type') !== 'code') return back('unsupported_response_type', 'Only response_type=code is supported');
        const challenge = single(q.code_challenge, 'code_challenge');
        const method = single(q.code_challenge_method, 'code_challenge_method');
        if (!challenge || method !== 'S256') return back('invalid_request', 'PKCE is required: code_challenge with code_challenge_method=S256');
        if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return back('invalid_request', 'code_challenge must be a base64url SHA-256 hash');
        const ownResource = canonicalResource(resourceFor(origin))!;
        const resourceParam = single(q.resource, 'resource');
        if (resourceParam !== null && canonicalResource(resourceParam) !== ownResource) return back('invalid_target', `resource must be ${ownResource}`);
        const scopes = parseScopes(single(q.scope, 'scope'));
        const id = createRequest({ clientId: client.id, redirectUri, scopes, state, codeChallenge: challenge, resource: ownResource });
        res.setHeader('Cache-Control', 'no-store');
        res.redirect(302, `/oauth/consent?request=${encodeURIComponent(id)}`);
      } catch (e) {
        if (e instanceof OAuthError) return back(e.error, e.description);
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  r.post('/token', form, json, (req, res) => {
    if (rateLimited(req, res, 'token')) return;
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const clientId = clientIdOf(req);
      if (!clientId || !getStoredClient(clientId)) throw new OAuthError('invalid_client', 'Unknown client', 401);
      const resourceRaw = single(body.resource, 'resource');
      const resource = resourceRaw === null ? null : canonicalResource(resourceRaw);
      if (resourceRaw !== null && !resource) throw new OAuthError('invalid_target', 'resource must be an absolute URI without a fragment');
      let tokens;
      if (body.grant_type === 'authorization_code')
        tokens = exchangeCode({ code: body.code, clientId, redirectUri: body.redirect_uri, verifier: body.code_verifier, resource });
      else if (body.grant_type === 'refresh_token') tokens = refresh({ token: body.refresh_token, clientId, scope: body.scope, resource });
      else throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
      noStore(res);
      res.json(tokens);
    } catch (e) {
      oauthError(res, e);
    }
  });

  r.post('/revoke', form, json, (req, res) => {
    if (rateLimited(req, res, 'token')) return;
    try {
      revokeToken((req.body ?? {}).token, clientIdOf(req));
      noStore(res);
      res.status(200).json({});
    } catch (e) {
      oauthError(res, e);
    }
  });

  return r;
}

// ── Signed-in endpoints (/api), used by the consent page and Settings ──

export const oauthApiRoutes = Router();

function requestInfo(id: string, origin: string): OAuthConsentInfo {
  const r = openRequest(id);
  if (!r) throw new HttpError(404, 'This request has expired or was already answered. Go back to the app and connect again.');
  const client = getStoredClient(r.client_id);
  if (!client) throw new HttpError(404, 'This app is no longer registered. Go back to the app and connect again.');
  const host = (u: string | null) => {
    try {
      return u ? new URL(u).host : null;
    } catch {
      return null;
    }
  };
  return {
    client: { id: client.id, name: client.name, kind: client.kind, uri: client.clientUri, idHost: client.kind === 'cimd' ? host(client.id) : null },
    redirectHost: host(r.redirect_uri) ?? '',
    scopes: scopeList(r.scopes),
    resource: r.resource,
    origin,
  };
}

oauthApiRoutes.get(
  '/oauth/requests/:id',
  h((req) => requestInfo(param(req, 'id'), originFor(req))),
);

oauthApiRoutes.post(
  '/oauth/requests/:id',
  h((req) => {
    const id = param(req, 'id');
    const r = openRequest(id);
    if (!r) throw new HttpError(404, 'This request has expired or was already answered. Go back to the app and connect again.');
    const origin = originFor(req);
    const body = (req.body ?? {}) as { allow?: unknown; scopes?: unknown };
    if (body.allow !== true) {
      denyRequest(id);
      return { redirect: withParams(r.redirect_uri, { error: 'access_denied', error_description: 'The user declined', state: r.state, iss: origin }) };
    }
    // The user may allow less than was asked (e.g. read only), never more.
    const asked = scopeList(r.scopes);
    const chosen = Array.isArray(body.scopes) ? parseScopes(body.scopes.filter((s) => typeof s === 'string').join(' ')) : asked;
    const granted = chosen.filter((s) => asked.includes(s)) as Scope[];
    if (!granted.length) throw new HttpError(400, 'Choose at least one permission');
    try {
      const code = approveRequest(r, req.user.id, granted);
      return { redirect: withParams(r.redirect_uri, { code, state: r.state, iss: origin }) };
    } catch (e) {
      if (e instanceof OAuthError) throw new HttpError(e.status === 409 ? 409 : 400, e.description);
      throw e;
    }
  }),
);

oauthApiRoutes.get(
  '/me/connected-apps',
  h((req): ConnectedApp[] => connectedApps(req.user.id)),
);

oauthApiRoutes.delete(
  '/me/connected-apps/:clientId',
  h((req) => {
    const n = revokeClientForUser(req.user.id, param(req, 'clientId'));
    if (!n) throw new HttpError(404, 'That app isn’t connected');
    return { ok: true };
  }),
);
