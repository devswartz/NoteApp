// REDIRECT_HOSTS: page loads on an old host name get a 301 to PUBLIC_URL; API, sockets,
// files, the AI connector and /.well-known keep working there (server/redirectHosts.ts).
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { startTestApp, type TestApp } from './helpers/app.ts';
import { isPageLoad, parseRedirectHosts } from '../server/redirectHosts.ts';

let app: TestApp;
const saved = { PUBLIC_URL: process.env.PUBLIC_URL, REDIRECT_HOSTS: process.env.REDIRECT_HOSTS };
before(async () => {
  // Before the server modules load: server/config.ts reads PUBLIC_URL once.
  process.env.PUBLIC_URL = 'https://app.example.test';
  process.env.REDIRECT_HOSTS = 'old.example.test, https://older.example.test/';
  app = await startTestApp();
});
after(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await app.close();
});

/** A raw request with an arbitrary Host header (fetch can't set it). */
function request(method: string, path: string, host: string, headers: Record<string, string> = {}) {
  const { port } = new URL(app.origin);
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('REDIRECT_HOSTS parsing and what counts as a page load', () => {
  assert.deepEqual(parseRedirectHosts(' Old.Example.com, https://older.example/x , ,a.b:8443'), ['old.example.com', 'older.example', 'a.b']);
  assert.deepEqual(parseRedirectHosts(undefined), []);
  for (const p of ['/', '/w/ws/p/pg', '/privacy', '/invite/abc', '/index.html']) assert.ok(isPageLoad('GET', p), p);
  assert.ok(isPageLoad('HEAD', '/support'));
  for (const p of ['/api/health', '/api', '/mcp', '/oauth/authorize', '/oauth/consent', '/.well-known/assetlinks.json', '/uploads/x.png', '/collab/x', '/assets/i.js', '/sw.js', '/og-image.png', '/manifest.webmanifest'])
    assert.ok(!isPageLoad('GET', p), p);
  assert.ok(!isPageLoad('POST', '/'));
});

test('page loads on an old host get a 301 to the same path and query on PUBLIC_URL', async () => {
  const r = await request('GET', '/w/ws1/p/pg?x=1', 'old.example.test');
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, 'https://app.example.test/w/ws1/p/pg?x=1');
  const r2 = await request('HEAD', '/', 'OLDER.example.test:443');
  assert.equal(r2.status, 301);
  assert.equal(r2.headers.location, 'https://app.example.test/');
  // Security headers are still on the redirect.
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  // Behind the proxy (loopback is trusted) the forwarded host counts.
  const r3 = await request('GET', '/privacy', '127.0.0.1', { 'x-forwarded-host': 'old.example.test' });
  assert.equal(r3.status, 301);
  assert.equal(r3.headers.location, 'https://app.example.test/privacy');
});

test('other hosts, POSTs and the new host itself are not redirected', async () => {
  assert.notEqual((await request('GET', '/w/x', 'app.example.test')).status, 301);
  assert.notEqual((await request('GET', '/w/x', 'elsewhere.example.test')).status, 301);
  assert.notEqual((await request('POST', '/w/x', 'old.example.test')).status, 301);
  process.env.REDIRECT_HOSTS = 'app.example.test';
  try {
    assert.notEqual((await request('GET', '/', 'app.example.test')).status, 301, 'never redirects onto itself');
  } finally {
    process.env.REDIRECT_HOSTS = 'old.example.test, https://older.example.test/';
  }
});

test('API, CORS, well-known, OAuth metadata, uploads and sockets keep working on an old host', async () => {
  const health = await request('GET', '/api/health', 'old.example.test', { origin: 'capacitor://localhost' });
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).ok, true);
  assert.equal(health.headers['access-control-allow-origin'], '*');
  assert.match(String(health.headers['content-security-policy']), /default-src 'none'/);

  const preflight = await request('OPTIONS', '/api/auth/login', 'old.example.test', { origin: 'tauri://localhost', 'access-control-request-method': 'POST' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], '*');

  // OAuth metadata names PUBLIC_URL as the issuer whichever host it was asked on.
  const meta = await request('GET', '/.well-known/oauth-authorization-server', 'old.example.test');
  assert.equal(meta.status, 200);
  assert.equal(JSON.parse(meta.body).issuer, 'https://app.example.test');
  const prm = await request('GET', '/.well-known/oauth-protected-resource/mcp', 'old.example.test');
  assert.equal(JSON.parse(prm.body).resource, 'https://app.example.test/mcp');

  // App-link files: not redirected (they must be served without redirects); 404 here as they aren't configured.
  assert.equal((await request('GET', '/.well-known/apple-app-site-association', 'old.example.test')).status, 404);
  assert.equal((await request('GET', '/.well-known/assetlinks.json', 'old.example.test')).status, 404);

  assert.notEqual((await request('GET', '/uploads/nothing.png', 'old.example.test')).status, 301);
  assert.notEqual((await request('GET', '/oauth/authorize', 'old.example.test')).status, 301);
  const mcp = await request('POST', '/mcp', 'old.example.test');
  assert.equal(mcp.status, 401, 'the connector answers (asks for a token) instead of redirecting');

  // Sign in through the old host, then open the events socket there.
  const alice = await app.signUp('Alice');
  const ws = new WebSocket(`${app.wsOrigin}/api/events`, ['noteapp.v1', `bearer.${alice.token}`], { headers: { host: 'old.example.test' } });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.close();
});
