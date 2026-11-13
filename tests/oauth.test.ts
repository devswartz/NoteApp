// OAuth authorization server for AI connectors (server/oauth/): register → authorize → consent → token →
// refresh rotation → revoke → verify, plus the ways each step must fail.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';

let app: TestApp;
let verify: typeof import('../server/oauth/verify.ts');
let clients: typeof import('../server/oauth/clients.ts');
let db: typeof import('../server/db.ts').db;
const ORIGIN = 'http://localhost:5173'; // PUBLIC_URL outside production
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = 'https://client.example/callback';

before(async () => {
  app = await startTestApp();
  verify = await import('../server/oauth/verify.ts');
  clients = await import('../server/oauth/clients.ts');
  db = (await import('../server/db.ts')).db;
});
after(() => app.close());

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

async function register(body: Record<string, unknown> = {}) {
  const res = await fetch(`${app.origin}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test Assistant', redirect_uris: [REDIRECT], ...body }),
  });
  return { status: res.status, data: await res.json() };
}

async function authorize(params: Record<string, string | undefined>) {
  const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined));
  const res = await fetch(`${app.origin}/oauth/authorize?${q}`, { redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location') ?? '' };
}

async function token(form: Record<string, string | undefined>) {
  const body = new URLSearchParams(Object.entries(form).filter((e): e is [string, string] => e[1] !== undefined));
  const res = await fetch(`${app.origin}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  return { status: res.status, data: await res.json(), cache: res.headers.get('cache-control') };
}

/** register (unless given) → authorize → allow → code. */
async function getCode(user: TestUser, opts: { clientId?: string; scope?: string; allowScopes?: string[]; state?: string } = {}) {
  const clientId = opts.clientId ?? (await register()).data.client_id;
  const { verifier, challenge } = pkce();
  const a = await authorize({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: opts.scope ?? 'notes:read notes:write',
    state: opts.state ?? 'st-123',
    resource: RESOURCE,
  });
  assert.equal(a.status, 302);
  const m = /^\/oauth\/consent\?request=([\w-]+)$/.exec(a.location);
  assert.ok(m, `redirects to the consent page, got ${a.location}`);
  const requestId = m[1];
  const d = await app.call('POST', `/oauth/requests/${requestId}`, user.token, { allow: true, ...(opts.allowScopes ? { scopes: opts.allowScopes } : {}) });
  assert.equal(d.status, 200, JSON.stringify(d.data));
  const back = new URL(d.data.redirect);
  assert.equal(back.origin + back.pathname, REDIRECT);
  return { clientId, verifier, code: back.searchParams.get('code')!, back, requestId };
}

async function connect(user: TestUser, opts: Parameters<typeof getCode>[1] = {}) {
  const c = await getCode(user, opts);
  const t = await token({ grant_type: 'authorization_code', code: c.code, client_id: c.clientId, redirect_uri: REDIRECT, code_verifier: c.verifier, resource: RESOURCE });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  return { ...c, tokens: t.data };
}

test('metadata: authorization server (RFC 8414) and protected resource (RFC 9728)', async () => {
  const as = await (await fetch(`${app.origin}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.issuer, ORIGIN);
  assert.equal(as.token_endpoint, `${ORIGIN}/oauth/token`);
  assert.equal(as.registration_endpoint, `${ORIGIN}/oauth/register`);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(as.scopes_supported, ['notes:read', 'notes:write']);
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.equal(as.authorization_response_iss_parameter_supported, true);
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const res = await fetch(app.origin + path);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const pr = await res.json();
    assert.equal(pr.resource, RESOURCE);
    assert.deepEqual(pr.authorization_servers, [ORIGIN]);
  }
  assert.equal(
    verify.buildWwwAuthenticate('https://notes.example.com'),
    'Bearer resource_metadata="https://notes.example.com/.well-known/oauth-protected-resource/mcp", scope="notes:read notes:write"',
  );
});

test('full flow: register → authorize → consent → token → refresh rotation → revoke → verify', async () => {
  const u = await app.signUp('Flo');
  const reg = await register();
  assert.equal(reg.status, 201);
  assert.equal(reg.data.token_endpoint_auth_method, 'none');
  assert.ok(!('client_secret' in reg.data));

  // The consent page sees the request.
  const { challenge, verifier } = pkce();
  const a = await authorize({
    response_type: 'code', client_id: reg.data.client_id, redirect_uri: REDIRECT, code_challenge: challenge,
    code_challenge_method: 'S256', scope: 'notes:write', state: 'xyz', resource: RESOURCE,
  });
  const requestId = new URL(a.location, ORIGIN).searchParams.get('request')!;
  assert.equal((await app.call('GET', `/oauth/requests/${requestId}`)).status, 401, 'signed in only');
  const info = await app.call('GET', `/oauth/requests/${requestId}`, u.token);
  assert.equal(info.data.client.name, 'Test Assistant');
  assert.deepEqual(info.data.scopes, ['notes:read', 'notes:write'], 'write implies read');
  assert.equal(info.data.redirectHost, 'client.example');

  const d = await app.call('POST', `/oauth/requests/${requestId}`, u.token, { allow: true });
  const back = new URL(d.data.redirect);
  assert.equal(back.searchParams.get('state'), 'xyz');
  assert.equal(back.searchParams.get('iss'), ORIGIN);
  // A request is answered once.
  assert.equal((await app.call('POST', `/oauth/requests/${requestId}`, u.token, { allow: true })).status, 404);

  const t = await token({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, client_id: reg.data.client_id, redirect_uri: REDIRECT, code_verifier: verifier, resource: RESOURCE });
  assert.equal(t.status, 200);
  assert.equal(t.cache, 'no-store');
  assert.equal(t.data.token_type, 'Bearer');
  assert.equal(t.data.expires_in, 3600);
  assert.equal(t.data.scope, 'notes:read notes:write');
  // Hashed at rest.
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM oauth_tokens WHERE token_hash = ? OR token_hash = ?').get(t.data.access_token, t.data.refresh_token) as { n: number }).n, 0);

  const v = await verify.verifyAccessToken(t.data.access_token);
  assert.deepEqual(v, { userId: u.user.id, scopes: ['notes:read', 'notes:write'], clientId: reg.data.client_id, clientName: 'Test Assistant' });
  assert.equal(await verify.verifyAccessToken('nvo_at_nope'), null);
  // An app session token is not an OAuth token.
  assert.equal(await verify.verifyAccessToken(u.token), null);

  // Connected apps lists it, with last-used set by verify.
  const list = await app.call('GET', '/me/connected-apps', u.token);
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].name, 'Test Assistant');
  assert.deepEqual(list.data[0].scopes, ['notes:read', 'notes:write']);
  assert.ok(list.data[0].lastUsedAt);

  // Refresh rotates.
  const r1 = await token({ grant_type: 'refresh_token', refresh_token: t.data.refresh_token, client_id: reg.data.client_id, resource: RESOURCE });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.data.refresh_token, t.data.refresh_token);
  assert.ok(await verify.verifyAccessToken(r1.data.access_token));
  const r2 = await token({ grant_type: 'refresh_token', refresh_token: r1.data.refresh_token, client_id: reg.data.client_id });
  assert.equal(r2.status, 200);

  // RFC 7009: revoking the refresh token ends the connection, access tokens included.
  const rv = await fetch(`${app.origin}/oauth/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: r2.data.refresh_token, token_type_hint: 'refresh_token', client_id: reg.data.client_id }),
  });
  assert.equal(rv.status, 200);
  assert.equal(await verify.verifyAccessToken(r2.data.access_token), null);
  assert.equal(await verify.verifyAccessToken(r1.data.access_token), null);
  assert.equal((await token({ grant_type: 'refresh_token', refresh_token: r2.data.refresh_token, client_id: reg.data.client_id })).data.error, 'invalid_grant');
  assert.equal((await app.call('GET', '/me/connected-apps', u.token)).data.length, 0);
});

test('a replayed refresh token revokes the whole connection', async () => {
  const u = await app.signUp('Rex');
  const c = await connect(u);
  const r1 = await token({ grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token, client_id: c.clientId });
  assert.equal(r1.status, 200);
  const replay = await token({ grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token, client_id: c.clientId });
  assert.equal(replay.status, 400);
  assert.equal(replay.data.error, 'invalid_grant');
  assert.equal(await verify.verifyAccessToken(r1.data.access_token), null, 'the newer access token dies too');
  assert.equal((await token({ grant_type: 'refresh_token', refresh_token: r1.data.refresh_token, client_id: c.clientId })).status, 400);
});

test('an authorization code works once; a second use revokes what it issued', async () => {
  const u = await app.signUp('Cody');
  const c = await connect(u);
  const again = await token({ grant_type: 'authorization_code', code: c.code, client_id: c.clientId, redirect_uri: REDIRECT, code_verifier: c.verifier });
  assert.equal(again.data.error, 'invalid_grant');
  assert.equal(await verify.verifyAccessToken(c.tokens.access_token), null);
});

test('PKCE: required, S256 only, and the verifier must match', async () => {
  const u = await app.signUp('Pia');
  const clientId = (await register()).data.client_id;
  const base = { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 's1' };
  for (const extra of [{}, { code_challenge: pkce().challenge, code_challenge_method: 'plain' }, { code_challenge: 'short', code_challenge_method: 'S256' }]) {
    const a = await authorize({ ...base, ...extra });
    const back = new URL(a.location);
    assert.equal(back.origin + back.pathname, REDIRECT, 'errors after the redirect is validated go back to the client');
    assert.equal(back.searchParams.get('error'), 'invalid_request');
    assert.equal(back.searchParams.get('state'), 's1');
  }
  const c = await getCode(u, { clientId });
  const wrong = await token({ grant_type: 'authorization_code', code: c.code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: pkce().verifier });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.data.error, 'invalid_grant');
  const missing = await token({ grant_type: 'authorization_code', code: c.code, client_id: clientId, redirect_uri: REDIRECT });
  assert.equal(missing.data.error, 'invalid_request');
});

test('redirect URIs: https or loopback only at registration, exact match at authorization', async () => {
  for (const bad of [['http://evil.example/cb'], ['javascript:alert(1)'], ['https://x.example/cb#frag'], ['myapp://cb'], [], 'https://x.example']) {
    const r = await register({ redirect_uris: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.data.error, 'invalid_redirect_uri');
  }
  assert.equal((await register({ redirect_uris: ['http://127.0.0.1:33418/cb', 'http://localhost/cb'] })).status, 201);
  assert.equal((await register({ grant_types: ['client_credentials'] })).data.error, 'invalid_client_metadata');

  const clientId = (await register()).data.client_id;
  const { challenge } = pkce();
  for (const redirect_uri of ['https://client.example/other', 'https://attacker.example/callback', 'https://client.example/callback?x=1']) {
    const a = await authorize({ response_type: 'code', client_id: clientId, redirect_uri, code_challenge: challenge, code_challenge_method: 'S256' });
    assert.equal(a.location, '/oauth/consent?error=invalid_redirect_uri', 'never redirects to an unregistered URI');
  }
  const unknown = await authorize({ response_type: 'code', client_id: 'nope', redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' });
  assert.equal(unknown.location, '/oauth/consent?error=invalid_client');

  // A loopback redirect may use any port (RFC 8252); the token request must repeat the exact URI.
  const loop = (await register({ redirect_uris: ['http://127.0.0.1/cb'] })).data.client_id;
  const a = await authorize({ response_type: 'code', client_id: loop, redirect_uri: 'http://127.0.0.1:5555/cb', code_challenge: challenge, code_challenge_method: 'S256' });
  assert.match(a.location, /^\/oauth\/consent\?request=/);
});

test('scope downgrade: the user can allow read only, and refresh can narrow but never widen', async () => {
  const u = await app.signUp('Sid');
  const ro = await connect(u, { allowScopes: ['notes:read'] });
  assert.equal(ro.tokens.scope, 'notes:read');
  assert.deepEqual((await verify.verifyAccessToken(ro.tokens.access_token))!.scopes, ['notes:read']);
  const widen = await token({ grant_type: 'refresh_token', refresh_token: ro.tokens.refresh_token, client_id: ro.clientId, scope: 'notes:read notes:write' });
  assert.equal(widen.data.error, 'invalid_scope');

  const rw = await connect(u);
  const narrow = await token({ grant_type: 'refresh_token', refresh_token: rw.tokens.refresh_token, client_id: rw.clientId, scope: 'notes:read' });
  assert.equal(narrow.status, 200);
  assert.equal(narrow.data.scope, 'notes:read');
  assert.deepEqual((await verify.verifyAccessToken(narrow.data.access_token))!.scopes, ['notes:read']);
  // The refresh token keeps what was granted.
  const back = await token({ grant_type: 'refresh_token', refresh_token: narrow.data.refresh_token, client_id: rw.clientId });
  assert.equal(back.data.scope, 'notes:read notes:write');

  // A client can't be given more than it asked for, and unknown scopes are ignored (read only).
  const asked = await connect(u, { scope: 'notes:read offline_access', allowScopes: ['notes:read', 'notes:write'] });
  assert.equal(asked.tokens.scope, 'notes:read');
});

test('resource indicators: only this server’s /mcp, and tokens are bound to it', async () => {
  const u = await app.signUp('Res');
  const clientId = (await register()).data.client_id;
  const { challenge } = pkce();
  const a = await authorize({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', resource: 'https://other.example/mcp', state: 'r' });
  assert.equal(new URL(a.location).searchParams.get('error'), 'invalid_target');
  // Uppercase host and a trailing slash are the same resource.
  const ok = await authorize({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', resource: 'HTTP://LOCALHOST:5173/mcp/' });
  assert.match(ok.location, /^\/oauth\/consent/);

  const c = await getCode(u, { clientId });
  const t = await token({ grant_type: 'authorization_code', code: c.code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: c.verifier, resource: 'https://other.example/mcp' });
  assert.equal(t.data.error, 'invalid_target');

  const live = await connect(u);
  db.prepare("UPDATE oauth_grants SET resource = 'https://other.example/mcp' WHERE id = (SELECT grant_id FROM oauth_tokens WHERE token_hash = ?)").run(
    crypto.createHash('sha256').update(live.tokens.access_token).digest('hex'),
  );
  assert.equal(await verify.verifyAccessToken(live.tokens.access_token), null, 'a token for another resource is refused');
});

test('verify refuses expired tokens and tokens used by the wrong client', async () => {
  const u = await app.signUp('Exa');
  const c = await connect(u);
  db.prepare("UPDATE oauth_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token_hash = ?").run(crypto.createHash('sha256').update(c.tokens.access_token).digest('hex'));
  assert.equal(await verify.verifyAccessToken(c.tokens.access_token), null);
  const other = (await register()).data.client_id;
  const r = await token({ grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token, client_id: other });
  assert.equal(r.data.error, 'invalid_grant');
  assert.equal((await token({ grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token, client_id: 'unknown' })).status, 401);
});

test('Deny sends access_denied back to the client with state and iss', async () => {
  const u = await app.signUp('Dee');
  const clientId = (await register()).data.client_id;
  const { challenge } = pkce();
  const a = await authorize({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'abc' });
  const id = new URL(a.location, ORIGIN).searchParams.get('request')!;
  const d = await app.call('POST', `/oauth/requests/${id}`, u.token, { allow: false });
  const back = new URL(d.data.redirect);
  assert.equal(back.searchParams.get('error'), 'access_denied');
  assert.equal(back.searchParams.get('state'), 'abc');
  assert.equal(back.searchParams.get('iss'), ORIGIN);
  assert.equal(back.searchParams.get('code'), null);
});

test('Settings → Connected apps: revoke ends every connection to that app, for that user only', async () => {
  const u = await app.signUp('Rue');
  const other = await app.signUp('Oli');
  const clientId = (await register({ client_name: 'Shared App' })).data.client_id;
  const a1 = await connect(u, { clientId });
  const a2 = await connect(u, { clientId });
  const o = await connect(other, { clientId });
  const list = await app.call('GET', '/me/connected-apps', u.token);
  assert.equal(list.data.length, 1, 'one row per app');
  assert.equal((await app.call('DELETE', `/me/connected-apps/${encodeURIComponent(clientId)}`, u.token)).status, 200);
  assert.equal(await verify.verifyAccessToken(a1.tokens.access_token), null);
  assert.equal(await verify.verifyAccessToken(a2.tokens.access_token), null);
  assert.ok(await verify.verifyAccessToken(o.tokens.access_token), 'another user’s connection is untouched');
  assert.equal((await app.call('DELETE', `/me/connected-apps/${encodeURIComponent(clientId)}`, u.token)).status, 404);
});

test('changing the password disconnects every app', async () => {
  const u = await app.signUp('Pam');
  const c = await connect(u);
  const r = await app.call('POST', '/me/password', u.token, { currentPassword: 'password123', newPassword: 'password456' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(await verify.verifyAccessToken(c.tokens.access_token), null);
});

test('Client ID Metadata Documents: fetched, validated and cached', async () => {
  const u = await app.signUp('Cim');
  const url = 'https://assistant.example/oauth/client.json';
  let fetches = 0;
  let doc: Record<string, unknown> = { client_id: url, client_name: 'Metadata Assistant', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' };
  clients.setMetadataFetcher(async (u2) => {
    fetches++;
    assert.equal(u2, url);
    return { body: JSON.stringify(doc), maxAge: 600 };
  });
  try {
    const c = await connect(u, { clientId: url });
    assert.ok(await verify.verifyAccessToken(c.tokens.access_token));
    const info = (await app.call('GET', '/me/connected-apps', u.token)).data[0];
    assert.equal(info.kind, 'cimd');
    assert.equal(info.name, 'Metadata Assistant');
    await getCode(u, { clientId: url });
    assert.equal(fetches, 1, 'cached for its max-age');

    // A document whose client_id doesn't match its URL is refused.
    const url2 = 'https://assistant.example/oauth/other.json';
    clients.setMetadataFetcher(async () => ({ body: JSON.stringify({ ...doc, client_id: url }), maxAge: null }));
    const { challenge } = pkce();
    const bad = await authorize({ response_type: 'code', client_id: url2, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' });
    assert.equal(bad.location, '/oauth/consent?error=invalid_client');
    doc = { ...doc, client_id: url2, redirect_uris: ['http://evil.example/cb'] };
    clients.setMetadataFetcher(async () => ({ body: JSON.stringify(doc), maxAge: null }));
    assert.equal((await authorize({ response_type: 'code', client_id: url2, redirect_uri: 'http://evil.example/cb', code_challenge: challenge, code_challenge_method: 'S256' })).location, '/oauth/consent?error=invalid_client');
  } finally {
    clients.setMetadataFetcher(undefined);
  }
  // The real fetcher never connects to private addresses or literal IPs.
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1', '0.0.0.0'])
    assert.equal(clients.isBlockedAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '2606:4700:4700::1111']) assert.equal(clients.isBlockedAddress(ip), false, ip);
  assert.equal(clients.isMetadataUrl('https://a.example/'), false, 'needs a path');
  assert.equal(clients.isMetadataUrl('http://a.example/c.json'), false, 'https only');
  assert.equal(clients.isMetadataUrl('https://a.example/c.json'), true);
});

test('token endpoint errors use the OAuth error format', async () => {
  const clientId = (await register()).data.client_id;
  assert.equal((await token({ grant_type: 'password', client_id: clientId })).data.error, 'unsupported_grant_type');
  assert.equal((await token({ grant_type: 'authorization_code', client_id: clientId, code: 'nope', code_verifier: pkce().verifier, redirect_uri: REDIRECT })).data.error, 'invalid_grant');
});
