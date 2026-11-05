// Load: 10 people editing one page at once through the real server.
// Checks convergence (no lost edits), awareness for everyone, save + reload,
// and that a reconnect storm (everyone drops and comes back) still converges.
// The 10-editor tests take ~9 s, so they run only with LOAD_TEST=1
// (`LOAD_TEST=1 npm test`); the save max-wait test always runs.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';
import { collabClient, synced, waitFor, type CollabClient } from './helpers/collab.ts';

const N = 10;
const EDITS_EACH = 40;
let app: TestApp;
const clients: CollabClient[] = [];
let users: TestUser[];
let pageId: string;

before(async () => {
  app = await startTestApp();
  users = await Promise.all(Array.from({ length: process.env.LOAD_TEST === '1' ? N : 1 }, (_, i) => app.signUp(`Editor${i}`)));
  const owner = users[0];
  for (const u of users.slice(1)) await app.call('POST', `/workspaces/${owner.wsId}/members`, owner.token, { email: u.user.email, role: 'member' });
  const nb = (await app.call('POST', `/workspaces/${owner.wsId}/notebooks`, owner.token, { name: 'Load' })).data.id;
  const sec = (await app.call('POST', `/notebooks/${nb}/sections`, owner.token, { name: 'S' })).data.id;
  pageId = (await app.call('POST', `/sections/${sec}/pages`, owner.token, { title: 'Busy page' })).data.id;
});
after(async () => {
  for (const c of clients) c.destroy();
  await app.close();
});

/** Every paragraph's text, sorted (order of concurrent inserts may differ, content must not). */
const content = (c: CollabClient) =>
  c.doc
    .getXmlFragment('default')
    .toArray()
    .map((p) => ((p as Y.XmlElement).get(0) as Y.XmlText | undefined)?.toString() ?? '');

const LOAD = process.env.LOAD_TEST === '1' ? {} : { skip: 'set LOAD_TEST=1 to run the 10-editor load test' };

test(`${N} editors × ${EDITS_EACH} edits converge with nothing lost`, LOAD, async () => {
  const t0 = Date.now();
  for (const u of users) clients.push(collabClient(app, pageId, u.token, { id: u.user.id, name: u.user.name, color: u.user.color }));
  await Promise.all(clients.map(synced));
  const tSync = Date.now() - t0;

  // Everyone sees everyone else.
  await waitFor(() => clients.every((c) => c.provider.awareness.getStates().size === N), 5000, 'full presence');

  // Shared paragraph everyone types into, plus each editor's own paragraphs.
  const shared = new Y.XmlElement('paragraph');
  shared.insert(0, [new Y.XmlText('')]);
  clients[0].doc.getXmlFragment('default').insert(0, [shared]);
  await waitFor(() => clients.every((c) => c.doc.getXmlFragment('default').length === 1), 5000, 'shared paragraph');

  const t1 = Date.now();
  // Interleave: each round, every client makes one edit without waiting for the network.
  for (let i = 0; i < EDITS_EACH; i++) {
    clients.forEach((c, k) => {
      const frag = c.doc.getXmlFragment('default');
      if (i % 4 === 0) {
        const p = new Y.XmlElement('paragraph');
        p.insert(0, [new Y.XmlText(`e${k}-${i}`)]);
        frag.push([p]);
      } else {
        const text = (frag.get(0) as Y.XmlElement).get(0) as Y.XmlText;
        text.insert(Math.floor((text.length * ((k * 7 + i) % 10)) / 10), `${k}`);
      }
    });
    if (i % 10 === 9) await new Promise((r) => setImmediate(r));
  }
  const ref = () => JSON.stringify(content(clients[0]));
  await waitFor(() => clients.every((c) => JSON.stringify(content(c)) === ref()), 15_000, 'convergence');
  const tConverge = Date.now() - t1;

  const final = content(clients[0]);
  // Own paragraphs: EDITS_EACH/4 per editor, all present.
  for (let k = 0; k < N; k++)
    for (let i = 0; i < EDITS_EACH; i += 4) assert.ok(final.includes(`e${k}-${i}`), `missing e${k}-${i}`);
  // Shared paragraph: every character typed is there (3/4 of the edits per editor were 1-char inserts).
  const typed = final[0];
  for (let k = 0; k < N; k++) assert.equal([...typed].filter((ch) => ch === String(k)).length, EDITS_EACH - EDITS_EACH / 4, `editor ${k}'s keystrokes`);
  console.log(`# load: sync ${tSync} ms, ${N * EDITS_EACH} edits converged in ${tConverge} ms`);

  // Saved: a fresh client loads the same content after the debounced save.
  await new Promise((r) => setTimeout(r, 1300));
  const late = collabClient(app, pageId, users[0].token);
  clients.push(late);
  await synced(late);
  await waitFor(() => JSON.stringify(content(late)) === ref(), 5000, 'reload after save');
});

test('reconnect storm: everyone drops, edits offline, and comes back', LOAD, async () => {
  for (const c of clients) c.provider.disconnect();
  clients.forEach((c, k) => {
    const p = new Y.XmlElement('paragraph');
    p.insert(0, [new Y.XmlText(`offline-${k}`)]);
    c.doc.getXmlFragment('default').push([p]);
  });
  for (const c of clients) c.provider.connect();
  const ref = () => JSON.stringify(content(clients[0]));
  await waitFor(() => clients.every((c) => c.provider.synced && JSON.stringify(content(c)) === ref()), 15_000, 'convergence after storm');
  const final = content(clients[0]);
  for (let k = 0; k < N; k++) assert.ok(final.includes(`offline-${k}`), `offline edit ${k}`);
});

test('continuous typing still saves at least every few seconds (debounce has a max wait)', async () => {
  const { db } = await import('../server/db.ts');
  const c = collabClient(app, pageId, users[0].token);
  clients.push(c);
  await synced(c);
  const frag = c.doc.getXmlFragment('default');
  if (!frag.length) {
    const p = new Y.XmlElement('paragraph');
    p.insert(0, [new Y.XmlText('')]);
    frag.insert(0, [p]);
  }
  const text = (frag.get(0) as Y.XmlElement).get(0) as Y.XmlText;
  const savedAt = () => (db.prepare('SELECT updated_at FROM pages WHERE id = ?').get(pageId) as { updated_at: string }).updated_at;
  const before = savedAt();
  const start = Date.now();
  // A keystroke every 150 ms for 7 s: the 1 s debounce alone would never fire.
  while (Date.now() - start < 7000) {
    text.insert(0, 'k');
    await new Promise((r) => setTimeout(r, 150));
    if (savedAt() !== before) break;
  }
  assert.notEqual(savedAt(), before, 'saved while typing continued');
  assert.ok(Date.now() - start < 6500, `saved within the max wait (${Date.now() - start} ms)`);
});
