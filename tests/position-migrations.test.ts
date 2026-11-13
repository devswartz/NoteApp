// @tiptap/y-tiptap 3.0.x left a "position migration" record in the doc for every structural
// edit and never removed them (a 4.6 MB doc for 240 KB of text). The server empties those maps:
// in stored docs at startup, when a page's room opens, and before each save.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';
import { collabClient, synced, waitFor, type CollabClient } from './helpers/collab.ts';

let app: TestApp;
let u: TestUser;
let sec: string;
const open: CollabClient[] = [];
before(async () => {
  app = await startTestApp();
  u = await app.signUp('Mig Rations');
  sec = (await app.call('GET', `/workspaces/${u.wsId}/tree`, u.token)).data.sections[0].id;
});
after(async () => {
  for (const c of open) c.destroy();
  await app.close();
});

const STORE = '__tiptap_position_migrations:root:box:a';

/** A doc with one paragraph of text and `n` migration records like y-tiptap 3.0 wrote. */
function bloated(n: number, text = 'Kept text') {
  const doc = new Y.Doc();
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment('box:a').insert(0, [p]);
  const store = doc.getMap(STORE);
  for (let i = 0; i < n; i++) {
    store.set(`${doc.clientID}:${i}`, {
      version: 1,
      client: doc.clientID,
      clock: i,
      seen: [[doc.clientID, i]],
      transfers: Array.from({ length: 20 }, (_, j) => ({ source: { client: doc.clientID, clock: j, length: 1 }, target: { client: 1, clock: j, type: null } })),
    });
  }
  return doc;
}

test('clearPositionMigrations empties the maps, keeps the content and shrinks the doc', async () => {
  const { clearPositionMigrations } = await import('../server/collab.ts');
  const doc = bloated(200);
  const before = Y.encodeStateAsUpdate(doc).length;
  assert.equal(clearPositionMigrations(doc), 200);
  assert.equal(doc.getMap(STORE).size, 0);
  assert.equal(doc.getXmlFragment('box:a').toString(), '<paragraph>Kept text</paragraph>');
  const afterBytes = Y.encodeStateAsUpdate(doc).length;
  assert.ok(afterBytes * 5 < before, `${before} -> ${afterBytes} bytes`);
  assert.equal(clearPositionMigrations(doc), 0, 'nothing left the second time');
});

test('the startup data migration cleans stored pages, only those that need it', async () => {
  const { db } = await import('../server/db.ts');
  const { clearStoredPositionMigrations } = await import('../server/dataMigrations.ts');
  const pageId = (await app.call('POST', `/sections/${sec}/pages`, u.token, { title: 'Stored' })).data.id as string;
  db.prepare('UPDATE pages SET ydoc = ? WHERE id = ?').run(Buffer.from(Y.encodeStateAsUpdate(bloated(50))), pageId);
  assert.equal(clearStoredPositionMigrations(), 1);
  const row = db.prepare('SELECT ydoc FROM pages WHERE id = ?').get(pageId) as { ydoc: Buffer };
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(row.ydoc));
  assert.equal(doc.getMap(STORE).size, 0);
  assert.equal(doc.getXmlFragment('box:a').toString(), '<paragraph>Kept text</paragraph>');
  assert.equal(clearStoredPositionMigrations(), 0, 'idempotent');
});

test('records an outdated client writes into an open page are removed by the next save, for everyone', async () => {
  const { db } = await import('../server/db.ts');
  const pageId = (await app.call('POST', `/sections/${sec}/pages`, u.token, { title: 'Live' })).data.id as string;
  const a = collabClient(app, pageId, u.token);
  const b = collabClient(app, pageId, u.token);
  open.push(a, b);
  await Promise.all([synced(a), synced(b)]);
  a.doc.getMap(STORE).set(`${a.doc.clientID}:1`, { version: 1, client: a.doc.clientID, clock: 1, seen: [], transfers: [] });
  await waitFor(() => b.doc.getMap(STORE).size === 1, 3000, 'record reaches b');
  await waitFor(() => a.doc.getMap(STORE).size === 0 && b.doc.getMap(STORE).size === 0, 8000, 'server clears it for both');
  await waitFor(() => {
    const row = db.prepare('SELECT ydoc FROM pages WHERE id = ?').get(pageId) as { ydoc: Buffer | null };
    if (!row.ydoc) return false;
    const d = new Y.Doc();
    Y.applyUpdate(d, new Uint8Array(row.ydoc));
    return d.share.has(STORE) && d.getMap(STORE).size === 0;
  }, 8000, 'saved cleared');
});
