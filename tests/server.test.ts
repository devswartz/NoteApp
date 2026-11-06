import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { startTestApp, type TestApp } from './helpers/app.ts';

let app: TestApp;
before(async () => {
  app = await startTestApp();
});
after(() => app.close());

test('sign-up creates a personal workspace with an onboarding tree', async () => {
  const { token, wsId } = await app.signUp('Alice');
  const tree = await app.call('GET', `/workspaces/${wsId}/tree`, token);
  assert.equal(tree.status, 200);
  assert.ok(tree.data.notebooks.length >= 1);
  assert.ok(tree.data.pages.length >= 1);
});

test('requests without a token are rejected', async () => {
  assert.equal((await app.call('GET', '/workspaces')).status, 401);
});

test('a task can be created with an empty title (inline /task tasks)', async () => {
  const { token, wsId } = await app.signUp('Bob');
  const r = await app.call('POST', `/workspaces/${wsId}/tasks`, token, { title: '' });
  assert.equal(r.status, 200);
  assert.equal(r.data.title, '');
});

test('notebook → section → page can be created and appear in the tree', async () => {
  const { token, wsId } = await app.signUp('Erin');
  const nb = await app.call('POST', `/workspaces/${wsId}/notebooks`, token, { name: 'Work' });
  const sec = await app.call('POST', `/notebooks/${nb.data.id}/sections`, token, { name: 'Projects' });
  const pg = await app.call('POST', `/sections/${sec.data.id}/pages`, token, { title: 'Roadmap' });
  const tree = await app.call('GET', `/workspaces/${wsId}/tree`, token);
  assert.ok(tree.data.pages.some((p: { id: string; title: string }) => p.id === pg.data.id && p.title === 'Roadmap'));
});

test("other users can't see a workspace they don't belong to", async () => {
  const owner = await app.signUp('Fay');
  const stranger = await app.signUp('Gus');
  assert.equal((await app.call('GET', `/workspaces/${owner.wsId}/tree`, stranger.token)).status, 404);
});

test('saving a page reconciles which tasks it references', async () => {
  const { token, wsId } = await app.signUp('Carol');
  const { syncPageTasks, getTask } = await import('../server/tasks.ts');
  const { extractDoc } = await import('../server/collab.ts');
  const tree = await app.call('GET', `/workspaces/${wsId}/tree`, token);
  const sectionId = tree.data.sections[0].id;
  const pageId = (await app.call('POST', `/sections/${sectionId}/pages`, token, { title: 'Plan' })).data.id as string;

  const a = (await app.call('POST', `/workspaces/${wsId}/tasks`, token, { title: 'A', pageId })).data.id as string;
  const b = (await app.call('POST', `/workspaces/${wsId}/tasks`, token, { title: 'B' })).data.id as string;

  // The note now embeds B (e.g. pasted in) but no longer contains A.
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('default');
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText('Hello')]);
  const ref = new Y.XmlElement('taskRef');
  ref.setAttribute('taskId', b);
  frag.insert(0, [p, ref]);
  const { text, taskIds } = extractDoc(frag);
  assert.equal(text, 'Hello');
  assert.deepEqual([...taskIds], [b]);

  syncPageTasks(pageId, wsId, taskIds);
  assert.equal(getTask(a)!.pageId, null, 'removed task becomes standalone, not deleted');
  assert.equal(getTask(b)!.pageId, pageId, 'referenced task is linked to the page');
});

test('completing a task records who completed it', async () => {
  const { token, wsId, user } = await app.signUp('Dan');
  const t = (await app.call('POST', `/workspaces/${wsId}/tasks`, token, { title: 'Ship it' })).data;
  const done = await app.call('PATCH', `/tasks/${t.id}`, token, { status: 'done' });
  assert.equal(done.data.status, 'done');
  assert.equal(done.data.completedBy, user.id);
});

test('invalid JSON gets a 400, not a 500', async () => {
  const res = await fetch(`${app.origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(res.status, 400);
});
