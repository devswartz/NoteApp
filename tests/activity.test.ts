// Workspace activity feed: recorded from mutating requests, filtered by visibility.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import WS from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';
import type { ActivityItem } from '../shared/types.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
  const [ann, bob] = await Promise.all(['Ann', 'Bob'].map((n) => app.signUp(n)));
  await app.call('POST', `/workspaces/${ann.wsId}/members`, ann.token, { email: bob.user.email, role: 'member' });
  return { ann, bob };
}
const feed = async (u: TestUser, wsId: string) => (await app.call('GET', `/workspaces/${wsId}/activity`, u.token)).data as ActivityItem[];
const lines = (items: ActivityItem[]) => items.map((i) => i.summary).reverse();

test('tree, task and member changes appear in the feed with who did them', async () => {
  const { ann, bob } = await team();
  const ws = ann.wsId;
  const nb = (await app.call('POST', `/workspaces/${ws}/notebooks`, ann.token, { name: 'Projects' })).data.id;
  const sec = (await app.call('POST', `/notebooks/${nb}/sections`, ann.token, { name: 'Q4' })).data.id;
  const pg = (await app.call('POST', `/sections/${sec}/pages`, bob.token, { title: 'Plan' })).data.id;
  await app.call('PATCH', `/pages/${pg}`, bob.token, { title: 'Launch plan' });
  await app.call('PATCH', `/pages/${pg}`, bob.token, { icon: '🚀' }); // not interesting: no entry
  const t = (await app.call('POST', `/workspaces/${ws}/tasks`, ann.token, { title: 'Write brief', assigneeId: bob.user.id })).data.id;
  await app.call('PATCH', `/tasks/${t}`, bob.token, { status: 'done' });
  const inline = (await app.call('POST', `/workspaces/${ws}/tasks`, bob.token, { title: '' })).data.id;
  await app.call('PATCH', `/tasks/${inline}`, bob.token, { title: 'Book venue' });
  await app.call('DELETE', `/pages/${pg}`, ann.token);
  await app.call('POST', `/workspaces/${ws}/members`, ann.token, { email: 'newbie@example.com', role: 'viewer' });
  await app.call('PATCH', `/workspaces/${ws}/members/${bob.user.id}`, ann.token, { role: 'admin' });
  // A failed request records nothing.
  assert.equal((await app.call('DELETE', `/notebooks/${nb}`, 'bad-token')).status, 401);

  const items = await feed(bob, ws);
  assert.deepEqual(lines(items), [
    'added Bob as member',
    'created notebook “Projects”',
    'added section “Q4” to “Projects”',
    'created page “Plan”',
    'renamed page “Plan” to “Launch plan”',
    'added task “Write brief” for Bob',
    'completed “Write brief”',
    'added task “Book venue”',
    'deleted page “Launch plan”',
    'invited newbie@example.com as viewer',
    'made Bob an admin',
  ]);
  const byActor = Object.fromEntries(items.map((i) => [i.summary, i.actorId]));
  assert.equal(byActor['created page “Plan”'], bob.user.id);
  assert.equal(byActor['created notebook “Projects”'], ann.user.id);
  // Paging.
  const page2 = (await app.call('GET', `/workspaces/${ws}/activity?limit=3&before=${items[2].id}`, bob.token)).data as ActivityItem[];
  assert.deepEqual(page2.map((i) => i.id), items.slice(3, 6).map((i) => i.id));
});

test('activity in private notebooks is visible only to people who can see them', async () => {
  const { ann, bob } = await team();
  const ws = ann.wsId;
  const nb = (await app.call('POST', `/workspaces/${ws}/notebooks`, ann.token, { name: 'Secret', visibility: 'private' })).data.id;
  const sec = (await app.call('POST', `/notebooks/${nb}/sections`, ann.token, { name: 'S' })).data.id;
  const pg = (await app.call('POST', `/sections/${sec}/pages`, ann.token, { title: 'Diary' })).data.id;
  await app.call('POST', `/workspaces/${ws}/tasks`, ann.token, { title: 'Hidden task', pageId: pg });
  const visible = (await feed(ann, ws)).map((i) => i.summary);
  assert.ok(visible.length, JSON.stringify(visible));
  assert.ok(visible.includes('created notebook “Secret”') && visible.includes('added task “Hidden task”'), JSON.stringify(visible));
  const forBob = (await feed(bob, ws)).map((i) => i.summary).join('\n');
  assert.ok(!/Secret|Diary|Hidden/.test(forBob), forBob);
  // Deleting the private notebook doesn't reveal its history. (Its tasks become standalone
  // workspace tasks, visible to everyone, so their entries do become visible — like the tasks.)
  await app.call('DELETE', `/notebooks/${nb}`, ann.token);
  assert.ok(!/Secret|Diary/.test((await feed(bob, ws)).map((i) => i.summary).join('\n')));
  // Strangers can't read the feed.
  const stranger = await app.signUp('Zed');
  assert.equal((await app.call('GET', `/workspaces/${ws}/activity`, stranger.token)).status, 404);
});

test('page edits over the collab socket are recorded once per person per burst, and announced live', async () => {
  const { ann, bob } = await team();
  const ws = ann.wsId;
  const nb = (await app.call('POST', `/workspaces/${ws}/notebooks`, ann.token, { name: 'N' })).data.id;
  const sec = (await app.call('POST', `/notebooks/${nb}/sections`, ann.token, { name: 'S' })).data.id;
  const pg = (await app.call('POST', `/sections/${sec}/pages`, ann.token, { title: 'Notes' })).data.id;
  const events: string[] = [];
  const sock = new WS(`${app.wsOrigin}/api/events`, ['noteapp.v1', `bearer.${bob.token}`]);
  cleanup.push(() => sock.terminate());
  sock.on('message', (d) => events.push(JSON.parse(String(d)).type));
  await new Promise((r) => sock.on('open', r));

  class AuthedWS extends WS {
    constructor(url: string | URL) {
      super(url, ['noteapp.v1', `bearer.${ann.token}`]);
    }
  }
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`${app.wsOrigin}/collab`, pg, doc, { WebSocketPolyfill: AuthedWS as unknown as typeof WebSocket, disableBc: true });
  cleanup.push(() => {
    provider.destroy();
    doc.destroy();
  });
  while (!provider.synced) await sleep(20);
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText('first')]);
  doc.getXmlFragment('default').push([p]);
  await sleep(1300);
  (p.get(0) as Y.XmlText).insert(5, ' and second');
  await sleep(1300);
  const edits = (await feed(bob, ws)).filter((i) => i.verb === 'edited');
  assert.equal(edits.length, 1);
  assert.equal(edits[0].summary, 'edited “Notes”');
  assert.equal(edits[0].actorId, ann.user.id);
  assert.ok(events.includes('activity'));
});
