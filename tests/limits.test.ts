// Input limits: JSON body size, oversized collab messages.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import WS from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import { startTestApp, type TestApp } from './helpers/app.ts';

let app: TestApp;
before(async () => {
  app = await startTestApp();
});
after(() => app.close());

test('oversized JSON bodies get a 413 with a JSON error (not a 500); a maximal task description fits', async () => {
  const u = await app.signUp('Lim');
  const big = await fetch(`${app.origin}/api/workspaces/${u.wsId}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${u.token}` },
    body: JSON.stringify({ title: 'x', description: 'a'.repeat(600 * 1024) }),
  });
  assert.equal(big.status, 413);
  assert.equal((await big.json()).error, 'That is too large to upload');
  // 50 000 characters (the description limit), multibyte, still fits.
  const ok = await app.call('POST', `/workspaces/${u.wsId}/tasks`, u.token, { title: 'x', description: '日本'.repeat(25_000) });
  assert.equal(ok.status, 200);
});

async function openCollab(token: string, pageId: string) {
  const ws = new WS(`${app.wsOrigin}/collab/${pageId}`, ['noteapp.v1', `bearer.${token}`]);
  ws.binaryType = 'arraybuffer';
  await new Promise((r, j) => (ws.on('open', r), ws.on('error', j)));
  return ws;
}
const closed = (ws: WS) => new Promise<number>((r) => ws.on('close', (code) => r(code)));

test('/collab refuses a giant Yjs update (1009) without applying it, and a huge awareness message', async () => {
  const u = await app.signUp('Big');
  const tree = await app.call('GET', `/workspaces/${u.wsId}/tree`, u.token);
  const pageId = (await app.call('POST', `/sections/${tree.data.sections[0].id}/pages`, u.token, { title: 'Target' })).data.id;

  // One update carrying ~5 MB of text.
  const doc = new Y.Doc();
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText('z'.repeat(5 * 1024 * 1024))]);
  doc.getXmlFragment('default').push([p]);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0); // sync
  syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(doc));
  const ws = await openCollab(u.token, pageId);
  const code = closed(ws);
  ws.send(encoding.toUint8Array(enc));
  assert.equal(await code, 1009);
  await new Promise((r) => setTimeout(r, 1300)); // past the save debounce
  const { db } = await import('../server/db.ts');
  const row = db.prepare('SELECT length(ydoc) AS n, text FROM pages WHERE id = ?').get(pageId) as { n: number | null; text: string };
  assert.ok((row.n ?? 0) < 100_000, 'nothing applied or saved');

  // A normal-size update still works on a new connection.
  const small = new Y.Doc();
  const q = new Y.XmlElement('paragraph');
  q.insert(0, [new Y.XmlText('fine')]);
  small.getXmlFragment('default').push([q]);
  const e2 = encoding.createEncoder();
  encoding.writeVarUint(e2, 0);
  syncProtocol.writeUpdate(e2, Y.encodeStateAsUpdate(small));
  const ws2 = await openCollab(u.token, pageId);
  ws2.send(encoding.toUint8Array(e2));
  await new Promise((r) => setTimeout(r, 1300));
  assert.match((db.prepare('SELECT text FROM pages WHERE id = ?').get(pageId) as { text: string }).text, /fine/);

  // Awareness over 64 KB.
  const a = encoding.createEncoder();
  encoding.writeVarUint(a, 1);
  encoding.writeVarUint8Array(a, new Uint8Array(100 * 1024));
  const code2 = closed(ws2);
  ws2.send(encoding.toUint8Array(a));
  assert.equal(await code2, 1009);
});

test('ACCESS_TOKEN_TTL_S: bad values use the default; production clamps to 60–3600 s', async () => {
  const { accessTtlFromEnv } = await import('../server/auth.ts');
  for (const v of [undefined, '', '0', '-5', 'abc', 'Infinity']) assert.equal(accessTtlFromEnv(v, true), 900, String(v));
  assert.equal(accessTtlFromEnv('5', true), 60);
  assert.equal(accessTtlFromEnv('999999', true), 3600);
  assert.equal(accessTtlFromEnv('1800', true), 1800);
  assert.equal(accessTtlFromEnv('5', false), 5, 'tests may use short tokens outside production');
});

test('/collab: a frame far over the size limit closes that socket (1009) and does not crash the server', async () => {
  const u = await app.signUp('Frame');
  const tree = await app.call('GET', `/workspaces/${u.wsId}/tree`, u.token);
  const pageId = (await app.call('POST', `/sections/${tree.data.sections[0].id}/pages`, u.token, { title: 'T' })).data.id;
  // ws emits 'error' on the server's socket for an oversized frame; unhandled, that killed the process.
  for (const token of [u.token, 'not-a-token']) {
    const ws = await openCollab(token, pageId);
    const code = closed(ws);
    ws.send(new Uint8Array(20 * 1024 * 1024));
    await code;
  }
  assert.equal((await app.call('GET', '/workspaces', u.token)).status, 200, 'server still up');
});
