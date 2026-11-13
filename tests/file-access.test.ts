// Uploaded files are served only through signed links, and only to someone who may see them
// (server/routes/files.ts, shared/fileLinks.ts).
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as Y from 'yjs';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';
import { hmacSha256Hex, signFileName, signUploadPath, unsignedUploadPath, fileKeyExpiry, FILE_KEY_BUCKET_S } from '../shared/fileLinks.ts';
import { safeFileUrl, safeImageUrl } from '../shared/urls.ts';

let app: TestApp;
let owner: TestUser, teammate: TestUser, outsider: TestUser, stranger: TestUser;
let fileKeySecret: (u: string, e: number) => string;
let clearFileReadCache: () => void;
let db: typeof import('../server/db.ts').db;
before(async () => {
  app = await startTestApp();
  ({ fileKeySecret } = await import('../server/auth.ts'));
  ({ clearFileReadCache } = await import('../server/routes/files.ts'));
  ({ db } = await import('../server/db.ts'));
  [owner, teammate, outsider, stranger] = await Promise.all(['FaOwner', 'FaTeammate', 'FaOutsider', 'FaStranger'].map((n) => app.signUp(n)));
});
after(() => app.close());
beforeEach(() => clearFileReadCache());

let seq = 0;
/** A workspace (owner + teammate) with a private notebook of the owner's holding two pages, each with an image. */
async function fixture() {
  const o = owner.token;
  const ws = (await app.call('POST', '/workspaces', o, { name: `FA ${++seq}` })).data.id as string;
  await app.call('POST', `/workspaces/${ws}/members`, o, { email: teammate.user.email, role: 'member' });
  const nb = (await app.call('POST', `/workspaces/${ws}/notebooks`, o, { name: 'Private', visibility: 'private' })).data.id as string;
  const sec = (await app.call('POST', `/notebooks/${nb}/sections`, o, { name: 'S' })).data.id as string;
  const page = (await app.call('POST', `/sections/${sec}/pages`, o, { title: 'Shared page' })).data.id as string;
  const sibling = (await app.call('POST', `/sections/${sec}/pages`, o, { title: 'Sibling' })).data.id as string;
  const pageFile = await upload(ws, `?pageId=${page}`);
  const siblingFile = await upload(ws, `?pageId=${sibling}`);
  const wsFile = await upload(ws, ''); // workspace-wide, no page
  return { ws, nb, sec, page, sibling, pageFile, siblingFile, wsFile };
}

async function upload(ws: string, query: string, who = owner): Promise<{ id: string; url: string }> {
  const r = await fetch(`${app.origin}/api/workspaces/${ws}/files${query}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${who.token}`, 'content-type': 'application/octet-stream', 'x-filename': 'photo.png' },
    body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
  });
  assert.equal(r.status, 200);
  return (await r.json()) as { id: string; url: string };
}

/** A signed link for `url` as user `u`, expiring at `e` (signed with the server's own key derivation). */
function linkAt(url: string, u: string, e: number) {
  const name = url.slice('/uploads/'.length);
  return `${app.origin}${url}?u=${u}&e=${e}&s=${signFileName(fileKeySecret(u, e), name)}`;
}

test('HMAC-SHA-256 in shared/fileLinks.ts matches node:crypto', () => {
  for (const [k, m] of [['a', 'b'], ['x'.repeat(100), 'y'.repeat(200)], ['', 'é😀'], ['k'.repeat(64), 'z'.repeat(55)], ['k', 'z'.repeat(56)], ['k', 'z'.repeat(64)]])
    assert.equal(hmacSha256Hex(k, m), crypto.createHmac('sha256', k).update(m).digest('hex'), `${k.length}/${m.length}`);
});

test('keys expire on fixed boundaries, 6 to 12 hours out', () => {
  const t = 1_800_000_000;
  const e = fileKeyExpiry(t);
  assert.equal(e % FILE_KEY_BUCKET_S, 0);
  assert.ok(e - t > FILE_KEY_BUCKET_S && e - t <= 2 * FILE_KEY_BUCKET_S);
  assert.equal(fileKeyExpiry(t + 60), e, 'stable within a bucket, so URLs (and the browser cache) are too');
});

test('signed links are stored unsigned when pasted or imported', () => {
  const plain = `/uploads/${'a'.repeat(32)}.png`;
  const signed = signUploadPath(plain, { u: 'user-1', e: 2_000_000_000, k: 'key' });
  assert.match(signed, /\?u=user-1&e=2000000000&s=[0-9a-f]{32}$/);
  assert.equal(unsignedUploadPath(signed), plain);
  assert.equal(unsignedUploadPath(`https://notes.example.com${signed}`), plain);
  assert.equal(safeImageUrl(signed), plain);
  assert.equal(safeImageUrl(`http://127.0.0.1:4317${signed}`), plain);
  assert.equal(safeFileUrl(signed), plain);
  assert.equal(unsignedUploadPath(plain), null, 'nothing to strip');
  assert.equal(unsignedUploadPath(`/uploads/${'a'.repeat(32)}.png?x=1`), null, 'only our signature is stripped');
  assert.equal(signUploadPath('https://example.com/a.png', { u: 'u', e: 1, k: 'k' }), 'https://example.com/a.png', 'other URLs are left alone');
});

test('no signature: 401 (and a browser tab is sent to the app to sign it)', async () => {
  const f = await fixture();
  const r = await app.fetchFile(f.pageFile.url);
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const tab = await app.fetchFile(f.pageFile.url, undefined, { redirect: 'manual', headers: { 'sec-fetch-dest': 'document', accept: 'text/html' } });
  assert.equal(tab.status, 302);
  assert.equal(tab.headers.get('location'), `/open-file/${f.pageFile.url.slice('/uploads/'.length)}`);
  const img = await app.fetchFile(f.pageFile.url, undefined, { redirect: 'manual', headers: { 'sec-fetch-dest': 'image' } });
  assert.equal(img.status, 401, 'an <img> is not redirected');
  // A bearer token is not enough either: only the signature counts.
  assert.equal((await app.fetchFile(f.pageFile.url, undefined, { headers: { authorization: `Bearer ${owner.token}` } })).status, 401);
});

test('the owner opens their file with a signed link; private and short-lived caching', async () => {
  const f = await fixture();
  const r = await app.fetchFile(f.pageFile.url, owner);
  assert.equal(r.status, 200);
  const cc = r.headers.get('cache-control') ?? '';
  assert.match(cc, /^private, max-age=\d+$/);
  assert.ok(Number(cc.split('=')[1]) <= 6 * 3600);
});

test('a forged, tampered or expired signature is rejected', async () => {
  const f = await fixture();
  const now = Math.floor(Date.now() / 1000);
  const good = linkAt(f.pageFile.url, owner.user.id, fileKeyExpiry(now));
  assert.equal((await fetch(good)).status, 200);
  assert.equal((await fetch(good.replace(/s=[0-9a-f]/, (m) => (m.endsWith('0') ? 's=1' : 's=0')))).status, 403, 'tampered signature');
  assert.equal((await fetch(good.replace(`u=${owner.user.id}`, `u=${teammate.user.id}`))).status, 403, 'someone else’s user id');
  assert.equal((await fetch(linkAt(f.siblingFile.url, owner.user.id, fileKeyExpiry(now)).replace(/s=.*/, `s=${good.split('s=')[1]}`))).status, 403, 'signature for another file');
  assert.equal((await fetch(linkAt(f.pageFile.url, owner.user.id, now - 5))).status, 403, 'expired');
  assert.equal((await fetch(linkAt(f.pageFile.url, owner.user.id, now + 30 * 86400))).status, 403, 'expiry further out than any key we issue');
  const wrongKey = `${app.origin}${f.pageFile.url}?u=${owner.user.id}&e=${fileKeyExpiry(now)}&s=${signFileName('not-the-key', f.pageFile.url.slice(9))}`;
  assert.equal((await fetch(wrongKey)).status, 403, 'signed with a key the server never issued');
});

test('someone from another workspace gets 403, even with a validly signed link of their own', async () => {
  const f = await fixture();
  for (const file of [f.pageFile, f.siblingFile, f.wsFile]) assert.equal((await app.fetchFile(file.url, stranger)).status, 403, file.url);
});

test('a workspace member sees workspace files, but not files in someone else’s private notebook', async () => {
  const f = await fixture();
  assert.equal((await app.fetchFile(f.wsFile.url, teammate)).status, 200);
  assert.equal((await app.fetchFile(f.pageFile.url, teammate)).status, 403);
});

test('a page-share grantee outside the workspace gets that page’s files only, until the share is removed', async () => {
  const f = await fixture();
  assert.equal((await app.fetchFile(f.pageFile.url, outsider)).status, 403, 'before the share');
  assert.equal((await app.call('POST', `/pages/${f.page}/shares`, owner.token, { email: outsider.user.email, canEdit: false })).status, 200);
  assert.equal((await app.fetchFile(f.pageFile.url, outsider)).status, 200, 'the shared page’s image');
  assert.equal((await app.fetchFile(f.siblingFile.url, outsider)).status, 403, 'not the sibling page’s');
  assert.equal((await app.fetchFile(f.wsFile.url, outsider)).status, 403, 'not workspace files');
  // The link already in their hands stops working as soon as the share goes (no stale cache).
  assert.equal((await app.call('DELETE', `/pages/${f.page}/shares/${outsider.user.id}`, owner.token)).status, 200);
  assert.equal((await app.fetchFile(f.pageFile.url, outsider)).status, 403, 'after the share is removed');
});

test('a file embedded in a page the user can open is readable even if it was uploaded elsewhere', async () => {
  const f = await fixture();
  await app.call('POST', `/pages/${f.page}/shares`, owner.token, { email: outsider.user.email, canEdit: false });
  assert.equal((await app.fetchFile(f.siblingFile.url, outsider)).status, 403);
  // Copy the sibling's image into the shared page (as the editor would when pasting).
  const doc = new Y.Doc();
  const img = new Y.XmlElement('image');
  img.setAttribute('src', f.siblingFile.url);
  doc.getXmlFragment('default').insert(0, [img]);
  db.prepare('UPDATE pages SET ydoc = ? WHERE id = ?').run(Buffer.from(Y.encodeStateAsUpdate(doc)), f.page);
  clearFileReadCache();
  assert.equal((await app.fetchFile(f.siblingFile.url, outsider)).status, 200, 'now part of a page they can open');
  assert.equal((await app.fetchFile(f.siblingFile.url, stranger)).status, 403, 'still not for anyone else');
});

test('GET /api/files/key needs a session and returns a working key', async () => {
  assert.equal((await app.call('GET', '/files/key')).status, 401);
  const r = await app.call('GET', '/files/key', owner.token);
  assert.equal(r.status, 200);
  assert.equal(r.data.u, owner.user.id);
  assert.match(r.data.k, /^[0-9a-f]{64}$/);
  const f = await fixture();
  assert.equal((await app.fetchFile(f.pageFile.url, { fileKey: r.data })).status, 200);
  // Every session (sign-in and refresh) carries one too.
  const refreshed = await app.call('POST', '/auth/refresh', undefined, { refreshToken: owner.refreshToken });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.data.fileKey.u, owner.user.id);
  owner = { ...owner, token: refreshed.data.accessToken, refreshToken: refreshed.data.refreshToken, fileKey: refreshed.data.fileKey };
});

test('deleting a workspace removes its uploaded files from disk, not just their rows', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { FILES_DIR } = await import('../server/config.ts');
  const f = await fixture();
  const onDisk = (u: { url: string }) => fs.existsSync(path.join(FILES_DIR, u.url.slice('/uploads/'.length)));
  assert.ok(onDisk(f.pageFile) && onDisk(f.siblingFile) && onDisk(f.wsFile), 'uploaded');
  assert.equal((await app.call('DELETE', `/workspaces/${f.ws}`, owner.token)).status, 200);
  assert.ok(!onDisk(f.pageFile) && !onDisk(f.siblingFile) && !onDisk(f.wsFile), 'bytes are gone with the workspace');
});
