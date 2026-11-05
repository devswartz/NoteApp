// Co-editing through the real server: two (or more) Yjs clients on one page.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';
import { collabClient, paragraphText, synced, waitFor, type CollabClient } from './helpers/collab.ts';

let app: TestApp;
const open: CollabClient[] = [];
before(async () => {
  app = await startTestApp();
});
after(async () => {
  for (const c of open) c.destroy();
  await app.close();
});

const client = (pageId: string, u: TestUser) => {
  const c = collabClient(app, pageId, u.token, { id: u.user.id, name: u.user.name, color: u.user.color });
  open.push(c);
  return c;
};

/** A workspace owned by `owner` with `others` added at `role`, and a fresh page in a shared notebook. */
async function setup(names: string[], role = 'member') {
  const [owner, ...others] = await Promise.all(names.map((n) => app.signUp(n)));
  for (const o of others) await app.call('POST', `/workspaces/${owner.wsId}/members`, owner.token, { email: o.user.email, role });
  const nb = await app.call('POST', `/workspaces/${owner.wsId}/notebooks`, owner.token, { name: 'Team' });
  const sec = await app.call('POST', `/notebooks/${nb.data.id}/sections`, owner.token, { name: 'S' });
  const pg = await app.call('POST', `/sections/${sec.data.id}/pages`, owner.token, { title: 'Shared page' });
  return { owner, others, notebookId: nb.data.id as string, pageId: pg.data.id as string };
}

function paragraph(doc: Y.Doc, text: string) {
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment('default').push([p]);
}
const firstText = (doc: Y.Doc) => (doc.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText;

test('two clients typing in the same paragraph converge without losing edits, and it is saved', async () => {
  const { owner, others, pageId } = await setup(['Ann', 'Ben']);
  const a = client(pageId, owner);
  const b = client(pageId, others[0]);
  await Promise.all([synced(a), synced(b)]);

  paragraph(a.doc, 'Hello world');
  await waitFor(() => b.text() === 'Hello world', 3000, 'B to receive A');

  // Both type at once in the same paragraph (no round trip in between).
  firstText(a.doc).insert(5, ' brave');
  firstText(b.doc).insert(11, '!');
  firstText(b.doc).insert(0, '>> ');
  await waitFor(() => a.text() === b.text() && a.text().includes('brave') && a.text().includes('!'), 3000, 'convergence');
  assert.equal(a.text(), '>> Hello brave world!');

  // Persisted (debounced 1 s): the page text is searchable and survives a fresh load.
  await new Promise((r) => setTimeout(r, 1300));
  const page = await app.call('GET', `/pages/${pageId}`, owner.token);
  assert.equal(page.status, 200);
  const late = client(pageId, owner);
  await synced(late);
  await waitFor(() => late.text() === '>> Hello brave world!', 3000, 'late joiner to load saved state');
});

test('presence: each client sees the others with name and colour, and they disappear on leave', async () => {
  const { owner, others, pageId } = await setup(['Cat', 'Dev']);
  const a = client(pageId, owner);
  const b = client(pageId, others[0]);
  await Promise.all([synced(a), synced(b)]);
  const peersOf = (c: CollabClient) =>
    [...c.provider.awareness.getStates().entries()]
      .filter(([id]) => id !== c.doc.clientID)
      .map(([, s]) => (s as { user?: { name: string; color: string } }).user);
  await waitFor(() => peersOf(a).some((u) => u?.name === 'Dev'), 3000, 'A to see B');
  assert.equal(peersOf(b).find((u) => u?.name === 'Cat')?.color, owner.user.color);
  b.destroy();
  await waitFor(() => peersOf(a).length === 0, 3000, 'B to leave');
});

test('reconnect after network loss: offline edits on both sides merge', async () => {
  const { owner, others, pageId } = await setup(['Eve', 'Fin']);
  const a = client(pageId, owner);
  const b = client(pageId, others[0]);
  await Promise.all([synced(a), synced(b)]);
  paragraph(a.doc, 'base');
  await waitFor(() => b.text() === 'base');

  a.provider.disconnect(); // A goes offline
  firstText(a.doc).insert(4, ' from-A');
  firstText(b.doc).insert(0, 'from-B ');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(b.text(), 'from-B base', 'B has not seen offline edits yet');
  a.provider.connect();
  await waitFor(() => a.text() === b.text() && a.text() === 'from-B base from-A', 3000, 'merge after reconnect');
});

test('viewers receive edits but their own updates are dropped by the server', async () => {
  const { owner, others, pageId } = await setup(['Gil', 'Hal'], 'viewer');
  const a = client(pageId, owner);
  const v = client(pageId, others[0]);
  await Promise.all([synced(a), synced(v)]);
  paragraph(a.doc, 'by owner');
  await waitFor(() => v.text() === 'by owner');
  paragraph(v.doc, 'by viewer');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(a.text(), 'by owner');
  const fresh = client(pageId, owner);
  await synced(fresh);
  await waitFor(() => fresh.text() === 'by owner');
});

test('demoting a member to viewer makes their open socket read-only immediately', async () => {
  const { owner, others, pageId } = await setup(['Ida', 'Jon']);
  const a = client(pageId, owner);
  const m = client(pageId, others[0]);
  await Promise.all([synced(a), synced(m)]);
  paragraph(m.doc, 'allowed');
  await waitFor(() => a.text() === 'allowed');
  await app.call('PATCH', `/workspaces/${owner.wsId}/members/${others[0].user.id}`, owner.token, { role: 'viewer' });
  paragraph(m.doc, 'blocked');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(a.text(), 'allowed');
});

test('strangers (4403) and bad tokens (4401) are refused; making a notebook private kicks only those who lost access', async () => {
  const { owner, others, pageId, notebookId } = await setup(['Kim', 'Lou']);
  const stranger = await app.signUp('Max');
  const s = client(pageId, stranger);
  const bad = collabClient(app, pageId, 'not-a-token');
  open.push(bad);
  // A valid user without access gets 4403; an invalid token gets 4401 (the client refreshes on 4401).
  await waitFor(() => s.closes.includes(4403) && bad.closes.includes(4401), 3000, 'refusals');

  const a = client(pageId, owner);
  const m = client(pageId, others[0]);
  await Promise.all([synced(a), synced(m)]);
  await app.call('PATCH', `/notebooks/${notebookId}`, owner.token, { visibility: 'private' });
  await waitFor(() => m.closes.includes(4403), 3000, 'member kicked');
  assert.deepEqual(a.closes, [], 'the creator stays connected');
  paragraph(a.doc, 'still live');
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(a.provider.wsconnected);
});

test('sharing a private notebook with someone lets them co-edit; unsharing disconnects them', async () => {
  const { owner, others, pageId, notebookId } = await setup(['Ned', 'Oli', 'Pia']);
  const [oli, pia] = others;
  await app.call('PATCH', `/notebooks/${notebookId}`, owner.token, { visibility: 'private' });
  assert.equal((await app.call('GET', `/pages/${pageId}`, oli.token)).status, 404);

  const r = await app.call('PUT', `/notebooks/${notebookId}/shares`, owner.token, { userIds: [oli.user.id] });
  assert.deepEqual(r.data.userIds, [oli.user.id]);
  assert.equal((await app.call('GET', `/pages/${pageId}`, oli.token)).status, 200);
  assert.equal((await app.call('GET', `/pages/${pageId}`, pia.token)).status, 404);

  const a = client(pageId, owner);
  const o = client(pageId, oli);
  await Promise.all([synced(a), synced(o)]);
  paragraph(o.doc, 'shared edit');
  await waitFor(() => a.text() === 'shared edit');

  await app.call('PUT', `/notebooks/${notebookId}/shares`, owner.token, { userIds: [] });
  await waitFor(() => o.closes.includes(4403), 3000, 'unshared user kicked');
  assert.equal(paragraphText(a.doc), 'shared edit');
});
