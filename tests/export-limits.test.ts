// Import/export hold whole archives in memory, so they are capped and rate limited (server/ratelimit.ts,
// server/routes/export.ts): per user, server-wide, one import at a time, and a 100 MB body cap that is
// enforced before the body is read.
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestApp, type TestApp } from './helpers/app.ts';
// Server modules are imported after startTestApp() has pointed the DB at memory (a static import would open the real one).
let app: TestApp;
let LIMITS: typeof import('../server/ratelimit.ts').LIMITS;
let resetRateLimits: () => void;
let MAX_IMPORT_BYTES: number;
let writeZip: typeof import('../server/zip.ts').writeZip;
let garbage: Buffer;
before(async () => {
  app = await startTestApp();
  ({ LIMITS, resetRateLimits } = await import('../server/ratelimit.ts'));
  ({ MAX_IMPORT_BYTES } = await import('../server/routes/export.ts'));
  ({ writeZip } = await import('../server/zip.ts'));
  garbage = writeZip([{ name: 'workspace.json', data: Buffer.from('{"format":"not-ours"}') }]);
});
after(() => app.close());
beforeEach(() => resetRateLimits());

const importZip = async (token: string, body: Buffer = garbage) => {
  const r = await fetch(`${app.origin}/api/workspaces/import`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/zip' }, body: new Uint8Array(body) });
  return { status: r.status, retryAfter: r.headers.get('retry-after'), text: await r.text() };
};

/** Start an import whose body never finishes arriving: it holds the import slot until `abort()`. */
function stalledImport(token: string) {
  const u = new URL(`${app.origin}/api/workspaces/import`);
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/zip', 'content-length': 1000 } });
  req.on('error', () => {});
  req.write(Buffer.alloc(10));
  return { abort: () => req.destroy() };
}
const until = async (cond: () => Promise<boolean>, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (await cond()) return true;
  return false;
};

test('import: three an hour per user, refusals cost nothing, other users unaffected', async () => {
  const a = await app.signUp('Ingrid');
  const b = await app.signUp('Jasper');
  const codes = [];
  for (let i = 0; i < LIMITS.importUser.capacity + 1; i++) codes.push((await importZip(a.token)).status);
  assert.deepEqual(codes, [...Array(LIMITS.importUser.capacity).fill(400), 429], 'garbage still costs an attempt; then 429');
  const r = await importZip(a.token);
  assert.equal(r.status, 429);
  assert.ok(Number(r.retryAfter) >= 60, `Retry-After ${r.retryAfter}`);
  assert.equal((await importZip(b.token)).status, 400, 'another user can still import');
});

test('import: a small server-wide budget across users', async () => {
  const users = await Promise.all(Array.from({ length: 5 }, (_, i) => app.signUp(`Glob${i}`)));
  const codes: number[] = [];
  for (let i = 0; i < LIMITS.importGlobal.capacity + 2; i++) codes.push((await importZip(users[i % users.length].token)).status);
  assert.equal(codes.filter((c) => c === 400).length, LIMITS.importGlobal.capacity, JSON.stringify(codes));
  assert.equal(codes.filter((c) => c === 429).length, 2);
});

test('import: one at a time server-wide; the slot frees when the upload ends or is abandoned', async () => {
  const a = await app.signUp('Slow');
  const b = await app.signUp('Next');
  const held = stalledImport(a.token);
  try {
    assert.ok(await until(async () => (await importZip(b.token)).status === 429), 'a second import is refused while one runs');
    const r = await importZip(b.token);
    assert.equal(r.status, 429);
    assert.ok(Number(r.retryAfter) >= 1);
    assert.match(r.text, /Another import is running/);
  } finally {
    held.abort();
  }
  assert.ok(await until(async () => (await importZip(b.token)).status === 400), 'after the stalled upload is dropped, imports work again');
});

test('import: a body over the cap is refused from its Content-Length, without reading it', async () => {
  const u = await app.signUp('Huge');
  assert.equal(MAX_IMPORT_BYTES, 100 * 1024 * 1024);
  const url = new URL(`${app.origin}/api/workspaces/import`);
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request({
      host: url.hostname, port: url.port, path: url.pathname, method: 'POST',
      headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/zip', 'content-length': MAX_IMPORT_BYTES + 1 },
    }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    req.on('error', reject);
    req.write(Buffer.alloc(1024)); // a token amount; the rest never comes
  });
  assert.equal(status, 413);
});

test('import: a truncated archive is a clean 400', async () => {
  const u = await app.signUp('Trunc');
  const good = writeZip([{ name: 'workspace.json', data: Buffer.from(JSON.stringify({ format: 'noteapp-workspace', version: 1 })) }, { name: 'files/x', data: Buffer.from('x'.repeat(5000)) }]);
  for (const cut of [good.length - 5, good.length - 30, Math.floor(good.length / 2), 40]) {
    resetRateLimits();
    const r = await importZip(u.token, good.subarray(0, cut));
    assert.equal(r.status, 400, `cut at ${cut}: ${r.text}`);
    assert.match(JSON.parse(r.text).error, /isn't a valid export/);
  }
});

test('export: six an hour per user', async () => {
  const u = await app.signUp('Exp');
  const codes: number[] = [];
  for (let i = 0; i < LIMITS.exportUser.capacity + 1; i++) {
    const r = await fetch(`${app.origin}/api/workspaces/${u.wsId}/export`, { headers: { authorization: `Bearer ${u.token}` } });
    await r.arrayBuffer();
    codes.push(r.status);
  }
  assert.deepEqual(codes, [...Array(LIMITS.exportUser.capacity).fill(200), 429]);
});
