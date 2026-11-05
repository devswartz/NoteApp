// Notification inbox: comment mentions/replies, page @mentions via the collab socket, read state, live push.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import WS from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';
import type { AppNotification } from '../shared/types.ts';

const waitFor = (cond: () => boolean, ms: number, what: string) =>
  new Promise<void>((resolve, reject) => {
    const end = Date.now() + ms;
    const tick = () => (cond() ? resolve() : Date.now() > end ? reject(new Error(`timed out: ${what}`)) : setTimeout(tick, 15));
    tick();
  });

let app: TestApp;
const cleanup: (() => void)[] = [];
before(async () => {
  app = await startTestApp();
});
after(async () => {
  for (const c of cleanup) c();
  await app.close();
});

async function team() {
  const [ann, bob, cat] = await Promise.all(['Ann', 'Bob', 'Cat'].map((n) => app.signUp(n)));
  for (const u of [bob, cat]) await app.call('POST', `/workspaces/${ann.wsId}/members`, ann.token, { email: u.user.email, role: 'member' });
  const nb = (await app.call('POST', `/workspaces/${ann.wsId}/notebooks`, ann.token, { name: 'N' })).data.id;
  const sec = (await app.call('POST', `/notebooks/${nb}/sections`, ann.token, { name: 'S' })).data.id;
  const pageId = (await app.call('POST', `/sections/${sec}/pages`, ann.token, { title: 'Roadmap' })).data.id as string;
  return { ann, bob, cat, pageId, notebookId: nb as string };
}
const inbox = async (u: TestUser) => (await app.call('GET', '/notifications', u.token)).data as { items: AppNotification[]; unread: number };
const mention = (u: TestUser) => `@[${u.user.name}](${u.user.id})`;

test('mentioning someone in a comment notifies them; replies notify the other participants', async () => {
  const { ann, bob, cat, pageId } = await team();
  const t = (await app.call('POST', `/pages/${pageId}/comments`, ann.token, { threadId: crypto.randomUUID(), quote: 'q', body: `Thoughts ${mention(bob)}?` })).data;
  const b = await inbox(bob);
  assert.equal(b.unread, 1);
  assert.equal(b.items[0].kind, 'mention');
  assert.equal(b.items[0].title, 'Ann mentioned you in a comment on “Roadmap”');
  assert.equal(b.items[0].body, 'Thoughts @Bob?');
  assert.equal(b.items[0].link, `/w/${ann.wsId}/p/${pageId}`);
  assert.equal(b.items[0].actorId, ann.user.id);
  assert.equal((await inbox(ann)).unread, 0, 'no self-notification');
  assert.equal((await inbox(cat)).unread, 0);

  // Cat replies: Ann (creator) and Bob (only mentioned, not a participant yet) — Ann gets a reply notification.
  await app.call('POST', `/comment-threads/${t.id}/replies`, cat.token, { body: 'Looks fine' });
  const a = await inbox(ann);
  assert.equal(a.items[0].kind, 'comment');
  assert.equal(a.items[0].title, 'Cat replied on “Roadmap”');
  assert.equal((await inbox(bob)).unread, 1, 'Bob only mentioned, not a participant');

  // Read state.
  assert.equal((await app.call('POST', `/notifications/${a.items[0].id}/read`, bob.token)).status, 200); // someone else's: no-op
  assert.equal((await inbox(ann)).unread, 1);
  await app.call('POST', `/notifications/${a.items[0].id}/read`, ann.token);
  assert.equal((await inbox(ann)).unread, 0);
  await app.call('POST', '/notifications/read-all', bob.token);
  assert.equal((await inbox(bob)).unread, 0);
});

test('mentions of people who cannot see the page are dropped', async () => {
  const { ann, bob, pageId, notebookId } = await team();
  await app.call('PATCH', `/notebooks/${notebookId}`, ann.token, { visibility: 'private' });
  await app.call('POST', `/pages/${pageId}/comments`, ann.token, { threadId: crypto.randomUUID(), body: `hey ${mention(bob)}` });
  assert.equal((await inbox(bob)).unread, 0);
});

test('notifications are pushed live to the recipient only', async () => {
  const { ann, bob, cat, pageId } = await team();
  const got: Record<string, unknown[]> = { bob: [], cat: [] };
  for (const [k, u] of [['bob', bob], ['cat', cat]] as const) {
    const ws = new WS(`${app.wsOrigin}/api/events`, ['noteapp.v1', `bearer.${u.token}`]);
    cleanup.push(() => ws.terminate());
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.type === 'notification') got[k].push(m);
    });
    await new Promise((r) => ws.on('open', r));
  }
  await app.call('POST', `/pages/${pageId}/comments`, ann.token, { threadId: crypto.randomUUID(), body: `ping ${mention(bob)}` });
  await waitFor(() => got.bob.length === 1, 2000, 'live notification');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(got.cat.length, 0);
});

test('an @mention node added to a page notifies once, when the page is saved', async () => {
  const { ann, bob, pageId } = await team();
  class AuthedWS extends WS {
    constructor(url: string | URL) {
      super(url, ['noteapp.v1', `bearer.${ann.token}`]);
    }
  }
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`${app.wsOrigin}/collab`, pageId, doc, { WebSocketPolyfill: AuthedWS as unknown as typeof WebSocket, disableBc: true });
  cleanup.push(() => {
    provider.destroy();
    doc.destroy();
  });
  await waitFor(() => provider.synced, 3000, 'sync');
  const p = new Y.XmlElement('paragraph');
  const m = new Y.XmlElement('mention');
  m.setAttribute('id', bob.user.id);
  m.setAttribute('label', 'Bob');
  p.insert(0, [new Y.XmlText('Owner: '), m]);
  doc.getXmlFragment('default').push([p]);
  await new Promise((r) => setTimeout(r, 1400)); // debounced save
  let b = await inbox(bob);
  assert.equal(b.unread, 1);
  assert.equal(b.items[0].title, 'Ann mentioned you in “Roadmap”');
  // Further edits don't re-notify for the same mention.
  p.insert(0, [new Y.XmlText('Note. ')]);
  await new Promise((r) => setTimeout(r, 1400));
  b = await inbox(bob);
  assert.equal(b.unread, 1);
  // Page text includes the mention label (search).
  const search = await app.call('GET', `/workspaces/${ann.wsId}/search?q=Owner`, ann.token);
  assert.ok(search.data.pages.some((x: { id: string }) => x.id === pageId));
});
