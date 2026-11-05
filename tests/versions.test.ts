// Page version history.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { startTestApp, type TestApp } from './helpers/app.ts';

let app: TestApp;
before(async () => {
  app = await startTestApp();
});
after(() => app.close());

/** Store new page content the way the collab server's save does (new state + updated_at). */
async function save(pageId: string, text: string, updatedAt: string) {
  const { db } = await import('../server/db.ts');
  const doc = new Y.Doc();
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment('default').insert(0, [p]);
  db.prepare('UPDATE pages SET ydoc = ?, updated_at = ? WHERE id = ?').run(Buffer.from(Y.encodeStateAsUpdate(doc)), updatedAt, pageId);
}

const textOf = (b64: string) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(Buffer.from(b64, 'base64')));
  return doc.getXmlFragment('default').toString();
};

test('snapshots: auto respects the gap and skips unchanged content; manual and restore always land', async () => {
  const u = await app.signUp('Historian');
  const tree = (await app.call('GET', `/workspaces/${u.wsId}/tree`, u.token)).data;
  const pageId = (await app.call('POST', `/sections/${tree.sections[0].id}/pages`, u.token, { title: 'Draft' })).data.id as string;
  const { snapshot, MIN_GAP_MS } = await import('../server/versions.ts');

  const t0 = Date.parse('2026-01-05T08:00:00Z'); // in the past, so the real-time restore snapshot is newest
  await save(pageId, 'first', new Date(t0).toISOString());
  assert.ok(snapshot(pageId, 'auto', t0));
  assert.equal(snapshot(pageId, 'auto', t0 + MIN_GAP_MS * 2), null, 'nothing changed');
  await save(pageId, 'second', new Date(t0 + 60_000).toISOString());
  assert.equal(snapshot(pageId, 'auto', t0 + 60_000), null, 'too soon after the last one');
  assert.ok(snapshot(pageId, 'auto', t0 + MIN_GAP_MS + 60_000));

  const list = (await app.call('GET', `/pages/${pageId}/versions`, u.token)).data as { id: string; reason: string; authorId: string }[];
  assert.equal(list.length, 2);
  const newest = (await app.call('GET', `/pages/${pageId}/versions/${list[0].id}`, u.token)).data;
  assert.match(textOf(newest.ydoc), /second/);
  const oldest = (await app.call('GET', `/pages/${pageId}/versions/${list[1].id}`, u.token)).data;
  assert.match(textOf(oldest.ydoc), /first/);

  // Before a restore the client snapshots the current state; identical content isn't duplicated.
  const r = await app.call('POST', `/pages/${pageId}/versions`, u.token, { reason: 'restore' });
  assert.equal(r.status, 200);
  assert.equal(r.data.id, list[0].id, 'unchanged content reuses the latest snapshot');
  await save(pageId, 'third', new Date(t0 + MIN_GAP_MS + 120_000).toISOString());
  const r2 = await app.call('POST', `/pages/${pageId}/versions`, u.token, { reason: 'restore' });
  assert.notEqual(r2.data.id, list[0].id);
  const after = (await app.call('GET', `/pages/${pageId}/versions`, u.token)).data as { reason: string }[];
  assert.equal(after[0].reason, 'restore');
});

test('versions: access control', async () => {
  const owner = await app.signUp('Owner');
  const tree = (await app.call('GET', `/workspaces/${owner.wsId}/tree`, owner.token)).data;
  const pageId = (await app.call('POST', `/sections/${tree.sections[0].id}/pages`, owner.token, { title: 'Mine' })).data.id as string;
  await save(pageId, 'hello', new Date().toISOString());
  const stranger = await app.signUp('Stranger');
  assert.equal((await app.call('GET', `/pages/${pageId}/versions`, stranger.token)).status, 404);
  const viewer = await app.signUp('Viewer');
  await app.call('POST', `/workspaces/${owner.wsId}/members`, owner.token, { email: viewer.user.email, role: 'viewer' });
  assert.equal((await app.call('GET', `/pages/${pageId}/versions`, viewer.token)).status, 200);
  assert.equal((await app.call('POST', `/pages/${pageId}/versions`, viewer.token, {})).status, 403);
  assert.equal((await app.call('GET', `/pages/${pageId}/versions/nope`, owner.token)).status, 404);
});

test('prune keeps everything from the last day, hourly for a week, daily after', async () => {
  const u = await app.signUp('Pruner');
  const tree = (await app.call('GET', `/workspaces/${u.wsId}/tree`, u.token)).data;
  const pageId = (await app.call('POST', `/sections/${tree.sections[0].id}/pages`, u.token, { title: 'Old' })).data.id as string;
  const { db } = await import('../server/db.ts');
  const { prune, listVersions } = await import('../server/versions.ts');
  const at = Date.parse('2026-11-05T12:00:00Z');
  const ins = db.prepare("INSERT INTO page_versions (id, page_id, ydoc, page_updated_at, created_at) VALUES (?, ?, x'00', '', ?)");
  const minutes = [5, 30, 60 * 30, 60 * 30 - 10, 60 * 30 - 20, 60 * 24 * 10, 60 * 24 * 10 + 30];
  minutes.forEach((m, i) => ins.run(`v${i}`, pageId, new Date(at - m * 60_000).toISOString()));
  prune(pageId, at);
  // < 24 h: both kept; 30 h ago: three in one hour → one; 10 days ago: two on one day → one.
  assert.equal(listVersions(pageId).length, 4);
});
