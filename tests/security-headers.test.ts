// Security headers on API, web app and uploads responses.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers/app.ts';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { appCsp, securityHeaders } from '../server/security.ts';

let app: TestApp;
before(async () => {
  app = await startTestApp();
});
after(() => app.close());

test('every response gets nosniff, no framing, referrer and permissions policies', async () => {
  for (const path of ['/api/health', '/some/app/route', '/api/me']) {
    const r = await fetch(app.origin + path);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', path);
    assert.match(r.headers.get('permissions-policy') ?? '', /camera=\(\)/, path);
    assert.equal(r.headers.get('strict-transport-security'), null, 'no HSTS outside production');
  }
});

test('API responses get a deny-all CSP; the web app gets the strict app CSP; CORS stays open for the shells', async () => {
  const api = await fetch(`${app.origin}/api/health`);
  assert.equal(api.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'");
  const pre = await fetch(`${app.origin}/api/me`, { method: 'OPTIONS', headers: { origin: 'capacitor://localhost' } });
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');

  // The web app (dist/) isn't built when unit tests run, so serve a stub page through the same middleware.
  const web = express();
  web.use(securityHeaders);
  web.get(/.*/, (_req, res) => res.type('html').send('<!doctype html><div id="root"></div>'));
  const srv = web.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const page = await fetch(`${origin}/w/x/p/y`);
  srv.close();
  const csp = page.headers.get('content-security-policy') ?? '';
  const host = new URL(origin).host;
  for (const d of ["script-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'", `wss://${host}`, `ws://${host}`])
    assert.ok(csp.includes(d), `CSP has ${d}: ${csp}`);
  assert.ok(!/script-src[^;]*unsafe/.test(csp), 'no unsafe script sources');
});

test('uploads keep their own sandbox CSP', async () => {
  const u = await app.signUp('Hdr');
  const up = await fetch(`${app.origin}/api/workspaces/${u.wsId}/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${u.token}`, 'content-type': 'text/plain', 'x-filename': 'a.txt' },
    body: 'hi',
  });
  const { url } = await up.json();
  const r = await fetch(app.origin + url);
  assert.match(r.headers.get('content-security-policy') ?? '', /^sandbox/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('production: HSTS, and the CSP allows the PUBLIC_URL socket origin', () => {
  const env = { NODE_ENV: process.env.NODE_ENV, PUBLIC_URL: process.env.PUBLIC_URL };
  try {
    process.env.PUBLIC_URL = 'https://notes.example.com';
    const csp = appCsp('evil"; script-src *');
    assert.ok(csp.includes('wss://notes.example.com'));
    assert.ok(!csp.includes('evil'), 'a malformed Host header is ignored');
  } finally {
    process.env.NODE_ENV = env.NODE_ENV;
    if (env.PUBLIC_URL === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = env.PUBLIC_URL;
  }
});
