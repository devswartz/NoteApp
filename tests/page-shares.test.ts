// Sharing a single page (#98): page_shares grant one page only, never its notebook,
// siblings or workspace; co-editing over /collab; revocation closes the socket (4403);
// people outside the workspace get what the share says (view or edit that one page and the tasks
// living on it, nothing else); tasks there can be assigned between members and share holders;
// email invites become shares, with their rights, on sign-up.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import WS from 'ws';
import * as Y from 'yjs';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';
import { collabClient, synced, waitFor } from './helpers/collab.ts';

let app: TestApp;
let owner: TestUser, teammate: TestUser, viewer: TestUser, outsider: TestUser;
before(async () => {
  app = await startTestApp();
  [owner, teammate, viewer, outsider] = await Promise.all(['PsOwner', 'PsTeammate', 'PsViewer', 'PsOutsider'].map((n) => app.signUp(n)));
});
after(() => app.close());

let seq = 0;
/** A workspace (owner + teammate + viewer) with a private notebook of the owner's holding two pages, and a shared notebook. */
async function fixture() {
  const o = owner.token;
  const ws = (await app.call('POST', '/workspaces', o, { name: `PS ${++seq}` })).data.id as string;
  await app.call('POST', `/workspaces/${ws}/members`, o, { email: teammate.user.email, role: 'member' });
  await app.call('POST', `/workspaces/${ws}/members`, o, { email: viewer.user.email, role: 'viewer' });
  const nb = (await app.call('POST', `/workspaces/${ws}/notebooks`, o, { name: 'Secret notebook', visibility: 'private' })).data.id as string;
  const sec = (await app.call('POST', `/notebooks/${nb}/sections`, o, { name: 'Secret section' })).data.id as string;
  const page = (await app.call('POST', `/sections/${sec}/pages`, o, { title: 'Shared plan' })).data.id as string;
  const sibling = (await app.call('POST', `/sections/${sec}/pages`, o, { title: 'Sibling secret' })).data.id as string;
  const task = (await app.call('POST', `/workspaces/${ws}/tasks`, o, { title: 'Task on the shared page', pageId: page })).data.id as string;
  const siblingTask = (await app.call('POST', `/workspaces/${ws}/tasks`, o, { title: 'Task on the sibling', pageId: sibling })).data.id as string;
  const openNb = (await app.call('POST', `/workspaces/${ws}/notebooks`, o, { name: 'Open notebook' })).data.id as string;
  const openSec = (await app.call('POST', `/notebooks/${openNb}/sections`, o, { name: 'Open section' })).data.id as string;
  const openPage = (await app.call('POST', `/sections/${openSec}/pages`, o, { title: 'Open page' })).data.id as string;
  return { ws, nb, sec, page, sibling, task, siblingTask, openNb, openSec, openPage };
}

const share = (page: string, body: object, token = owner.token) => app.call('POST', `/pages/${page}/shares`, token, body);

test('a teammate with an edit share opens and edits only that page', async () => {
  const f = await fixture();
  // Before: the private notebook is invisible to them.
  assert.equal((await app.call('GET', `/pages/${f.page}`, teammate.token)).status, 404);
  const r = await share(f.page, { userId: teammate.user.id, canEdit: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'shared');
  assert.deepEqual(r.data.shares.map((s: { userId: string; canEdit: boolean; member: boolean }) => [s.userId, s.canEdit, s.member]), [[teammate.user.id, true, true]]);

  const p = await app.call('GET', `/pages/${f.page}`, teammate.token);
  assert.equal(p.status, 200);
  assert.equal(p.data.canEdit, true);
  assert.equal(p.data.canManage, false);
  assert.equal(p.data.viaPageShare, true);
  assert.equal(p.data.canShare, false);
  assert.equal((await app.call('GET', `/pages/${f.page}`, owner.token)).data.canShare, true);

  // Nothing else from the private notebook: no sibling, no notebook or section in the tree.
  assert.equal((await app.call('GET', `/pages/${f.sibling}`, teammate.token)).status, 404);
  const tree = (await app.call('GET', `/workspaces/${f.ws}/tree`, teammate.token)).data;
  assert.ok(!tree.notebooks.some((n: { id: string }) => n.id === f.nb), 'private notebook not in the tree');
  assert.ok(!tree.pages.some((x: { id: string }) => x.id === f.page || x.id === f.sibling), 'its pages not in the tree');

  // Content edits: yes. Structure (move, reorder, copy, delete): no.
  assert.equal((await app.call('PATCH', `/pages/${f.page}`, teammate.token, { title: 'Shared plan v2' })).status, 200);
  assert.equal((await app.call('PATCH', `/pages/${f.page}`, teammate.token, { sectionId: f.openSec })).status, 403);
  assert.equal((await app.call('PATCH', `/pages/${f.page}`, teammate.token, { position: 0 })).status, 403);
  assert.equal((await app.call('POST', `/pages/${f.page}/move`, teammate.token, { sectionId: f.openSec })).status, 403);
  assert.equal((await app.call('POST', `/pages/${f.page}/copy`, teammate.token, { sectionId: f.openSec })).status, 403);
  assert.equal((await app.call('DELETE', `/pages/${f.page}`, teammate.token)).status, 403);
  assert.equal((await app.call('GET', `/pages/${f.page}/shares`, teammate.token)).status, 403, 'only the notebook creator manages shares');
  assert.equal((await app.call('POST', `/pages/${f.page}/templates`, teammate.token, { name: 'T', content: { type: 'doc', content: [] } })).status, 403);

  // Comments: they can read and add.
  assert.equal((await app.call('POST', `/pages/${f.page}/comments`, teammate.token, { threadId: crypto.randomUUID(), quote: 'q', body: 'Looks good' })).status, 200);
  assert.equal((await app.call('GET', `/pages/${f.page}/comments`, teammate.token)).data.length, 1);

  // Tasks on the page show up for them (and only those); they can tick them off.
  const tasks = (await app.call('GET', `/workspaces/${f.ws}/tasks`, teammate.token)).data as { id: string }[];
  assert.ok(tasks.some((t) => t.id === f.task), 'task on the shared page');
  assert.ok(!tasks.some((t) => t.id === f.siblingTask), 'not the sibling page’s task');
  assert.equal((await app.call('PATCH', `/tasks/${f.task}`, teammate.token, { status: 'done' })).status, 200);

  // Search finds the shared page, not its sibling.
  const found = (await app.call('GET', `/workspaces/${f.ws}/search?q=plan`, teammate.token)).data.pages as { id: string }[];
  assert.deepEqual(found.map((x) => x.id), [f.page]);
  assert.equal(((await app.call('GET', `/workspaces/${f.ws}/search?q=sibling`, teammate.token)).data.pages as unknown[]).length, 0);

  // It's in their "Shared with me".
  const mine = ((await app.call('GET', '/shared-pages', teammate.token)).data as { id: string; canEdit: boolean; member: boolean; sharedByName: string }[]).filter((x) => x.id === f.page);
  assert.deepEqual(mine.map((x) => [x.id, x.canEdit, x.member, x.sharedByName]), [[f.page, true, true, owner.user.name]]);
});

test('private_owner_only tasks on a shared page stay hidden', async () => {
  const f = await fixture();
  await share(f.page, { userId: teammate.user.id, canEdit: true });
  const { db } = await import('../server/db.ts');
  db.prepare('UPDATE tasks SET private_owner_only = 1 WHERE id = ?').run(f.task);
  const tasks = (await app.call('GET', `/workspaces/${f.ws}/tasks`, teammate.token)).data as { id: string }[];
  assert.ok(!tasks.some((t) => t.id === f.task));
  assert.equal((await app.call('PATCH', `/tasks/${f.task}`, teammate.token, { title: 'x' })).status, 404);
});

test('co-editing over /collab, then revoking closes the socket with 4403', async () => {
  const f = await fixture();
  await share(f.page, { userId: teammate.user.id, canEdit: true });
  const a = collabClient(app, f.page, owner.token);
  const b = collabClient(app, f.page, teammate.token);
  try {
    await Promise.all([synced(a), synced(b)]);
    const para = new Y.XmlElement('paragraph');
    para.insert(0, [new Y.XmlText('typed by the teammate')]);
    b.doc.getXmlFragment('default').insert(0, [para]);
    await waitFor(() => a.text().includes('typed by the teammate'), 3000, 'owner sees the teammate’s edit');

    assert.equal((await app.call('DELETE', `/pages/${f.page}/shares/${teammate.user.id}`, owner.token)).status, 200);
    await waitFor(() => b.closes.includes(4403), 3000, 'teammate socket closed with 4403');
    assert.equal((await app.call('GET', `/pages/${f.page}`, teammate.token)).status, 404);
    assert.ok(!((await app.call('GET', '/shared-pages', teammate.token)).data as { id: string }[]).some((x) => x.id === f.page));
  } finally {
    a.destroy();
    b.destroy();
  }
});

test('downgrading a share to view-only stops edits from that socket', async () => {
  const f = await fixture();
  await share(f.page, { userId: teammate.user.id, canEdit: true });
  const a = collabClient(app, f.page, owner.token);
  const b = collabClient(app, f.page, teammate.token);
  try {
    await Promise.all([synced(a), synced(b)]);
    assert.equal((await app.call('PATCH', `/pages/${f.page}/shares/${teammate.user.id}`, owner.token, { canEdit: false })).status, 200);
    assert.equal((await app.call('GET', `/pages/${f.page}`, teammate.token)).data.canEdit, false);
    const para = new Y.XmlElement('paragraph');
    para.insert(0, [new Y.XmlText('after the downgrade')]);
    b.doc.getXmlFragment('default').insert(0, [para]);
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(!a.text().includes('after the downgrade'), 'a view-only socket’s edits are dropped');
  } finally {
    a.destroy();
    b.destroy();
  }
});

test('someone outside the workspace with a view share gets read-only access to that page and nothing else', async () => {
  const f = await fixture();
  const r = await share(f.page, { email: outsider.user.email, canEdit: false });
  assert.equal(r.data.status, 'shared');
  const p = await app.call('GET', `/pages/${f.page}`, outsider.token);
  assert.equal(p.status, 200);
  assert.equal(p.data.canEdit, false);
  const mine = ((await app.call('GET', '/shared-pages', outsider.token)).data as { id: string; canEdit: boolean; member: boolean }[]).filter((x) => x.id === f.page);
  assert.deepEqual(mine.map((x) => [x.id, x.canEdit, x.member]), [[f.page, false, false]]);

  for (const path of [`/workspaces/${f.ws}/tree`, `/workspaces/${f.ws}/members`, `/workspaces/${f.ws}/tasks`, `/workspaces/${f.ws}/search?q=open`, `/workspaces/${f.ws}/activity`, `/pages/${f.sibling}`, `/pages/${f.openPage}`])
    assert.equal((await app.call('GET', path, outsider.token)).status, 404, path);
  assert.equal((await app.call('PATCH', `/pages/${f.page}`, outsider.token, { title: 'x' })).status, 403);
  assert.equal((await app.call('POST', `/pages/${f.page}/comments`, outsider.token, { threadId: crypto.randomUUID(), body: 'x' })).status, 403);
  assert.equal((await app.call('PATCH', `/tasks/${f.task}`, outsider.token, { status: 'done' })).status, 403, 'they see it, but view only');
  // The page's tasks, for its task references.
  assert.deepEqual(((await app.call('GET', `/pages/${f.page}/tasks`, outsider.token)).data as { id: string }[]).map((t) => t.id), [f.task]);
  assert.equal((await app.call('GET', `/pages/${f.sibling}/tasks`, outsider.token)).status, 404);

  // Backlinks never name pages they can't see, even ones in the workspace's shared notebooks.
  const { seedPageDoc } = await import('../server/collab.ts');
  seedPageDoc(f.openPage, (frag) => {
    const link = new Y.XmlElement('pageLink');
    link.setAttribute('pageId', f.page);
    const para = new Y.XmlElement('paragraph');
    para.insert(0, [link]);
    frag.insert(0, [para]);
  });
  assert.deepEqual(((await app.call('GET', `/pages/${f.page}/backlinks`, owner.token)).data as { id: string }[]).map((b) => b.id), [f.openPage]);
  assert.deepEqual((await app.call('GET', `/pages/${f.page}/backlinks`, outsider.token)).data, []);

  // The page's collab socket connects, read-only: their edits are dropped.
  const o = collabClient(app, f.page, owner.token);
  const x = collabClient(app, f.page, outsider.token);
  try {
    await Promise.all([synced(o), synced(x)]);
    const para = new Y.XmlElement('paragraph');
    para.insert(0, [new Y.XmlText('outsider typing')]);
    x.doc.getXmlFragment('default').insert(0, [para]);
    await new Promise((res) => setTimeout(res, 400));
    assert.ok(!o.text().includes('outsider typing'));
  } finally {
    o.destroy();
    x.destroy();
  }
  // The open notebook's page socket refuses them.
  const other = collabClient(app, f.openPage, outsider.token);
  try {
    await waitFor(() => other.closes.includes(4403), 3000, '4403 on a page not shared with them');
  } finally {
    other.destroy();
  }
});

/** A taskRef element pointing at `taskId`. */
const taskRef = (taskId: string) => {
  const el = new Y.XmlElement('taskRef');
  el.setAttribute('taskId', taskId);
  return el;
};
/** Task ids referenced from the `default` fragment of a client's doc. */
const refIds = (doc: Y.Doc) =>
  doc
    .getXmlFragment('default')
    .toArray()
    .filter((n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === 'taskRef')
    .map((n) => n.getAttribute('taskId'));

test('someone outside the workspace with an edit share edits that page, and nothing else', async () => {
  const f = await fixture();
  const r = await share(f.page, { email: outsider.user.email, canEdit: true });
  assert.equal(r.data.status, 'shared');
  assert.deepEqual(r.data.shares.map((s: { userId: string; canEdit: boolean; member: boolean }) => [s.userId, s.canEdit, s.member]), [[outsider.user.id, true, false]]);
  const p = await app.call('GET', `/pages/${f.page}`, outsider.token);
  assert.equal(p.status, 200);
  assert.deepEqual([p.data.canEdit, p.data.member, p.data.canManage, p.data.canShare, p.data.viaPageShare], [true, false, false, false, true]);
  const mine = ((await app.call('GET', '/shared-pages', outsider.token)).data as { id: string; canEdit: boolean; member: boolean }[]).filter((x) => x.id === f.page);
  assert.deepEqual(mine.map((x) => [x.id, x.canEdit, x.member]), [[f.page, true, false]]);

  // The page's content: title, icon, comments, versions, uploads into it (stored under the page's workspace).
  assert.equal((await app.call('PATCH', `/pages/${f.page}`, outsider.token, { title: 'Plan, edited from outside', icon: '📝' })).status, 200);
  assert.equal((await app.call('POST', `/pages/${f.page}/comments`, outsider.token, { threadId: crypto.randomUUID(), quote: 'q', body: 'From outside' })).status, 200);
  assert.equal((await app.call('POST', `/pages/${f.page}/versions`, outsider.token, {})).status, 200);
  const upload = (path: string) =>
    fetch(`${app.origin}/api${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${outsider.token}`, 'content-type': 'text/plain', 'x-filename': 'note.txt' },
      body: 'from outside',
    });
  const up = await upload(`/workspaces/${f.ws}/files?pageId=${f.page}`);
  assert.equal(up.status, 200);
  const { db } = await import('../server/db.ts');
  const file = (await up.json()) as { id: string };
  assert.deepEqual({ ...(db.prepare('SELECT workspace_id AS ws, page_id AS page FROM files WHERE id = ?').get(file.id) as object) }, { ws: f.ws, page: f.page }, 'counts against the page’s workspace');
  assert.equal((await upload(`/workspaces/${f.ws}/files`)).status, 404, 'no workspace uploads outside the page');
  assert.equal((await upload(`/workspaces/${f.ws}/files?pageId=${f.sibling}`)).status, 404, 'nor into a sibling');

  // Nothing else: not the notebook, siblings, workspace, structure or sharing.
  for (const path of [`/workspaces/${f.ws}/tree`, `/workspaces/${f.ws}/members`, `/workspaces/${f.ws}/tasks`, `/workspaces/${f.ws}/search?q=plan`, `/workspaces/${f.ws}/activity`, `/pages/${f.sibling}`, `/pages/${f.openPage}`, `/pages/${f.sibling}/tasks`, `/pages/${f.sibling}/doc`])
    assert.equal((await app.call('GET', path, outsider.token)).status, 404, path);
  assert.equal((await app.call('PATCH', `/pages/${f.sibling}`, outsider.token, { title: 'x' })).status, 404);
  assert.equal((await app.call('POST', `/sections/${f.sec}/pages`, outsider.token, { title: 'New sibling' })).status, 404);
  const forbidden: [string, string, object | undefined][] = [
    ['PATCH', `/pages/${f.page}`, { sectionId: f.openSec }],
    ['POST', `/pages/${f.page}/move`, { sectionId: f.sec }],
    ['POST', `/pages/${f.page}/copy`, {}],
    ['DELETE', `/pages/${f.page}`, undefined],
    ['GET', `/pages/${f.page}/shares`, undefined],
    ['POST', `/pages/${f.page}/shares`, { email: `ps-reshare-${++seq}@example.com` }],
    ['POST', `/pages/${f.page}/templates`, { name: 'T', content: { type: 'doc', content: [] } }],
  ];
  for (const [method, path, body] of forbidden) assert.equal((await app.call(method, path, outsider.token, body)).status, 403, `${method} ${path}`);

  // Tasks living on the page are theirs to create, tick, edit and delete (#98 follow-up)...
  const { getTask } = await import('../server/tasks.ts');
  const created = await app.call('POST', `/workspaces/${f.ws}/tasks`, outsider.token, { title: 'Outsider task', pageId: f.page });
  assert.equal(created.status, 200);
  assert.equal(created.data.workspaceId, f.ws);
  for (const body of [{ status: 'done' }, { status: 'open' }, { title: 'Edited from outside' }, { priority: 2, dueDate: '2030-01-02' }])
    assert.equal((await app.call('PATCH', `/tasks/${f.task}`, outsider.token, body)).status, 200, JSON.stringify(body));
  assert.equal(getTask(f.task)!.title, 'Edited from outside');
  assert.equal((await app.call('POST', `/workspaces/${f.ws}/tasks`, outsider.token, { title: 'Sub', parentId: created.data.id })).status, 200, 'subtasks too');
  assert.equal((await app.call('DELETE', `/tasks/${created.data.id}`, outsider.token)).status, 200);
  // ...but they can't take them off the page, or use the workspace's teams and tags.
  assert.equal((await app.call('PATCH', `/tasks/${f.task}`, outsider.token, { pageId: null })).status, 403);
  assert.equal((await app.call('PATCH', `/tasks/${f.task}`, outsider.token, { pageId: f.sibling })).status, 400);
  assert.equal((await app.call('PATCH', `/tasks/${f.task}`, outsider.token, { tagIds: [] })).status, 400);
  assert.equal(getTask(f.task)!.pageId, f.page);
  // Tasks living elsewhere stay out of reach, referenced from the page or not; and no standalone tasks.
  for (const body of [{ status: 'done' }, { title: 'Hijacked' }, { pageId: f.page }])
    assert.equal((await app.call('PATCH', `/tasks/${f.siblingTask}`, outsider.token, body)).status, 404, JSON.stringify(body));
  assert.equal((await app.call('DELETE', `/tasks/${f.siblingTask}`, outsider.token)).status, 404);
  assert.equal((await app.call('POST', `/workspaces/${f.ws}/tasks`, outsider.token, { title: 'Standalone' })).status, 404, 'no standalone tasks');
  assert.equal((await app.call('POST', `/workspaces/${f.ws}/tasks`, outsider.token, { title: 'Elsewhere', pageId: f.sibling })).status, 400);
  const own = (await app.call('POST', '/workspaces', outsider.token, { name: `Outsider own ${seq}` })).data.id as string;
  assert.equal((await app.call('POST', `/workspaces/${own}/tasks`, outsider.token, { title: 'Sneaky', pageId: f.page })).status, 400, 'nor from their own workspace onto the page');
  assert.deepEqual([getTask(f.siblingTask)!.title, getTask(f.siblingTask)!.status], ['Task on the sibling', 'open']);

  // Co-editing over /collab: their text reaches the owner; task references can't move tasks.
  const standalone = (await app.call('POST', `/workspaces/${f.ws}/tasks`, owner.token, { title: 'Owner standalone' })).data.id as string;
  const o = collabClient(app, f.page, owner.token);
  const x = collabClient(app, f.page, outsider.token);
  try {
    await Promise.all([synced(o), synced(x)]);
    o.doc.getXmlFragment('default').insert(0, [taskRef(f.task)]);
    await waitFor(() => refIds(x.doc).includes(f.task), 3000, 'outsider sees the task reference');
    const para = new Y.XmlElement('paragraph');
    para.insert(0, [new Y.XmlText('outsider typing')]);
    x.doc.getXmlFragment('default').insert(1, [para]);
    await waitFor(() => o.text().includes('outsider typing'), 3000, 'owner sees the outsider’s edit');
    // Deleting the page's task reference: the server puts it back.
    x.doc.getXmlFragment('default').delete(0, 1);
    await waitFor(() => refIds(o.doc).includes(f.task) && refIds(x.doc).includes(f.task), 3000, 'the task reference is restored');
    // A task they delete (REST) with its reference: gone for good, not put back.
    const gone = (await app.call('POST', `/workspaces/${f.ws}/tasks`, outsider.token, { title: 'Short-lived', pageId: f.page })).data.id as string;
    x.doc.getXmlFragment('default').insert(0, [taskRef(gone)]);
    await waitFor(() => refIds(o.doc).includes(gone), 3000, 'owner sees the new task');
    x.doc.getXmlFragment('default').delete(0, 1);
    assert.equal((await app.call('DELETE', `/tasks/${gone}`, outsider.token)).status, 200);
    await new Promise((res) => setTimeout(res, 1800));
    assert.ok(!refIds(o.doc).includes(gone), 'a deleted task’s reference stays gone');
    // References to tasks elsewhere (another page's, a standalone one) don't pull them in.
    x.doc.getXmlFragment('default').insert(0, [taskRef(f.siblingTask), taskRef(standalone)]);
    await new Promise((res) => setTimeout(res, 300));
  } finally {
    o.destroy();
    x.destroy();
  }
  await waitFor(() => !!db.prepare("SELECT 1 FROM pages WHERE id = ? AND text LIKE '%outsider typing%'").get(f.page), 3000, 'page saved');
  assert.equal(getTask(f.task)!.pageId, f.page, 'the page’s task stays on the page');
  assert.equal(getTask(f.siblingTask)!.pageId, f.sibling, 'a task on another page stays there');
  assert.equal(getTask(standalone)!.pageId, null, 'a standalone task stays standalone');

  // Their socket on any other page is refused.
  const other = collabClient(app, f.sibling, outsider.token);
  try {
    await waitFor(() => other.closes.includes(4403), 3000, '4403 on a sibling page');
  } finally {
    other.destroy();
  }
});

test('an email invite with edit becomes an edit share on sign-up, or through its link', async () => {
  const f = await fixture();
  const email = `ps-editor-${++seq}@example.com`;
  const r = await share(f.page, { email, canEdit: true });
  assert.equal(r.data.status, 'invited');
  assert.deepEqual(r.data.invites.map((i: { email: string; canEdit: boolean }) => [i.email, i.canEdit]), [[email, true]]);
  const token = r.data.inviteUrl.split('/invite/')[1];
  assert.equal((await app.call('GET', `/invites/${token}`)).data.page.canEdit, true);
  const newcomer = await app.signUp('PsEditorNewcomer', email);
  const p = await app.call('GET', `/pages/${f.page}`, newcomer.token);
  assert.equal(p.status, 200);
  assert.deepEqual([p.data.canEdit, p.data.member], [true, false]);
  assert.equal((await app.call('GET', `/workspaces/${f.ws}/tree`, newcomer.token)).status, 404);

  const linkUser = await app.signUp('PsEditorLink');
  const { upsertPageInvite } = await import('../server/workspaces.ts');
  const t2 = upsertPageInvite(f.page, linkUser.user.email, true, owner.user.id);
  assert.equal((await app.call('POST', `/invites/${t2}/accept`, linkUser.token)).status, 200);
  assert.equal((await app.call('GET', `/pages/${f.page}`, linkUser.token)).data.canEdit, true);
});

test('tasks on a shared page can be assigned between the workspace and the people it is shared with', async () => {
  const f = await fixture();
  const other = await app.signUp(`PsOtherOutsider${++seq}`);
  await share(f.page, { email: outsider.user.email, canEdit: true });
  await share(f.page, { email: other.user.email, canEdit: false });
  const assign = (id: string, assigneeId: string | null, token = owner.token) => app.call('PATCH', `/tasks/${id}`, token, { assigneeId });
  const { getTask } = await import('../server/tasks.ts');

  // Owner → a grantee, on that page only.
  assert.equal((await assign(f.task, outsider.user.id)).status, 200);
  assert.equal((await assign(f.siblingTask, outsider.user.id)).status, 400, 'not on a page they can’t open');
  const standalone = (await app.call('POST', `/workspaces/${f.ws}/tasks`, owner.token, { title: 'Standalone' })).data.id as string;
  assert.equal((await assign(standalone, outsider.user.id)).status, 400, 'not a standalone task');
  // It shows in their own task list, nothing else from the workspace.
  const mine = (await app.call('GET', '/shared-tasks', outsider.token)).data as { id: string }[];
  assert.deepEqual(mine.map((t) => t.id), [f.task]);
  assert.deepEqual((await app.call('GET', '/shared-tasks', other.token)).data, []);

  // Who they can pick: the people who can open the page, names only; never the member list.
  const people = (await app.call('GET', `/pages/${f.page}/people`, outsider.token)).data as Record<string, unknown>[];
  assert.deepEqual(people.map((p) => p.id).sort(), [owner.user.id, outsider.user.id, other.user.id].sort(), 'not the teammate or viewer, who can’t open it');
  assert.ok(people.every((p) => !('email' in p) && !('role' in p)), 'no emails or roles');
  assert.equal((await app.call('GET', `/workspaces/${f.ws}/members`, outsider.token)).status, 404);
  assert.equal((await app.call('GET', `/pages/${f.sibling}/people`, outsider.token)).status, 404);

  // Grantee → the owner, or another person with access; not someone who can't open the page.
  assert.equal((await assign(f.task, owner.user.id, outsider.token)).status, 200);
  assert.equal((await assign(f.task, other.user.id, outsider.token)).status, 200, 'another grantee (view share)');
  assert.equal((await assign(f.task, teammate.user.id, outsider.token)).status, 400, 'a member who can’t open the page');
  const created = await app.call('POST', `/workspaces/${f.ws}/tasks`, outsider.token, { title: 'For the owner', pageId: f.page, assigneeId: owner.user.id });
  assert.equal(created.status, 200);
  assert.equal((await app.call('POST', `/workspaces/${f.ws}/tasks`, outsider.token, { title: 'For the viewer', pageId: f.page, assigneeId: viewer.user.id })).status, 400);
  await share(f.page, { userId: teammate.user.id, canEdit: false });
  assert.equal((await assign(f.task, teammate.user.id, outsider.token)).status, 200, 'once it’s shared with them');
  // Not on other pages, whoever the assignee.
  assert.equal((await assign(f.siblingTask, owner.user.id, outsider.token)).status, 404);
  // The view-share grantee assigned a task may tick it off, nothing else.
  await assign(created.data.id, other.user.id);
  assert.equal((await app.call('PATCH', `/tasks/${created.data.id}`, other.token, { status: 'done' })).status, 200);
  assert.equal((await app.call('PATCH', `/tasks/${created.data.id}`, other.token, { title: 'x' })).status, 403);

  // Unsharing unassigns them from the page's tasks; others' assignments stay.
  await assign(f.task, outsider.user.id);
  assert.equal((await app.call('DELETE', `/pages/${f.page}/shares/${outsider.user.id}`, owner.token)).status, 200);
  assert.equal(getTask(f.task)!.assigneeId, null);
  assert.equal(getTask(created.data.id)!.assigneeId, other.user.id);
  assert.deepEqual((await app.call('GET', '/shared-tasks', outsider.token)).data, []);
  // A task leaving the page drops a grantee assignee too.
  assert.equal((await app.call('PATCH', `/tasks/${created.data.id}`, owner.token, { pageId: null })).status, 200);
  assert.equal(getTask(created.data.id)!.assigneeId, null);
});

test('live events: an outsider gets comments and tasks for the shared page only', async () => {
  const f = await fixture();
  await share(f.page, { email: outsider.user.email });
  const ws = new WS(`${app.wsOrigin}/api/events`, ['noteapp.v1', `bearer.${outsider.token}`]);
  const msgs: { type: string; pageId?: string; task?: { id: string } }[] = [];
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
  try {
    await waitFor(() => msgs.some((m) => m.type === 'hello'), 3000, 'hello');
    await app.call('POST', `/pages/${f.page}/comments`, owner.token, { threadId: crypto.randomUUID(), body: 'on the shared page' });
    await app.call('POST', `/pages/${f.sibling}/comments`, owner.token, { threadId: crypto.randomUUID(), body: 'on the sibling' });
    await app.call('PATCH', `/tasks/${f.task}`, owner.token, { title: 'Renamed shared' });
    await app.call('PATCH', `/tasks/${f.siblingTask}`, owner.token, { title: 'Renamed sibling' });
    await app.call('PATCH', `/notebooks/${f.openNb}`, owner.token, { name: 'Renamed open' });
    await waitFor(() => msgs.some((m) => m.type === 'task'), 3000, 'task event');
    await new Promise((r) => setTimeout(r, 200));
    const got = msgs.filter((m) => m.type !== 'hello').map((m) => (m.type === 'comments' ? `comments:${m.pageId}` : m.type === 'task' ? `task:${m.task!.id}` : m.type));
    assert.deepEqual(got, [`comments:${f.page}`, `task:${f.task}`]);

    // Sharing or unsharing tells them to refresh "Shared with me".
    msgs.length = 0;
    await app.call('DELETE', `/pages/${f.page}/shares/${outsider.user.id}`, owner.token);
    await waitFor(() => msgs.some((m) => m.type === 'shared-pages'), 3000, 'shared-pages');
  } finally {
    ws.terminate();
  }
});

test('sharing with a new email address sends an invite that becomes a share on sign-up', async () => {
  const f = await fixture();
  const email = `ps-new-${++seq}@example.com`;
  const r = await share(f.page, { email, canEdit: false });
  assert.equal(r.data.status, 'invited');
  assert.deepEqual(r.data.invites.map((i: { email: string }) => i.email), [email]);
  const token = r.data.inviteUrl.split('/invite/')[1];
  const info = await app.call('GET', `/invites/${token}`);
  assert.equal(info.status, 200);
  assert.equal(info.data.page.id, f.page);
  assert.equal(info.data.page.title, 'Shared plan');
  assert.equal(info.data.role, 'viewer');
  // Accepting needs the invited address.
  assert.equal((await app.call('POST', `/invites/${token}/accept`, outsider.token)).status, 403);

  const newcomer = await app.signUp('PsNewcomer', email);
  const mine = (await app.call('GET', '/shared-pages', newcomer.token)).data as { id: string }[];
  assert.deepEqual(mine.map((x) => x.id), [f.page]);
  assert.equal((await app.call('GET', `/pages/${f.page}`, newcomer.token)).status, 200);
  assert.deepEqual((await app.call('GET', `/pages/${f.page}/shares`, owner.token)).data.invites, [], 'invite consumed');
  assert.equal((await app.call('GET', `/invites/${token}`)).status, 404);
});

test('in invite-only mode, a page invite lets that address sign up', async () => {
  const f = await fixture();
  const email = `ps-invite-only-${++seq}@example.com`;
  await share(f.page, { email });
  process.env.SIGNUP_MODE = 'invite';
  try {
    const r = await app.call('POST', '/auth/register', undefined, { name: 'Invited', email, password: 'password123' });
    assert.equal(r.status, 200);
    const refused = await app.call('POST', '/auth/register', undefined, { name: 'Uninvited', email: `ps-uninvited-${seq}@example.com`, password: 'password123' });
    assert.equal(refused.status, 403);
  } finally {
    process.env.SIGNUP_MODE = 'open';
  }
});

test('who may share: the private notebook’s creator; for a shared notebook, its editors, with members only unless admin', async () => {
  const f = await fixture();
  // Teammate can't see the private notebook at all.
  assert.equal((await share(f.page, { userId: viewer.user.id }, teammate.token)).status, 404);
  // Even with the notebook shared with them, only its creator shares single pages from it.
  await app.call('PUT', `/notebooks/${f.nb}/shares`, owner.token, { userIds: [teammate.user.id] });
  assert.equal((await share(f.page, { userId: viewer.user.id }, teammate.token)).status, 403);
  // In a shared notebook: members may share with members, not outside the workspace; viewers not at all.
  assert.equal((await share(f.openPage, { userId: viewer.user.id }, teammate.token)).status, 200);
  assert.equal((await share(f.openPage, { email: viewer.user.email }, teammate.token)).status, 200, 'by email, but a member');
  assert.equal((await share(f.openPage, { email: outsider.user.email }, teammate.token)).status, 403, 'an account outside the workspace');
  assert.equal((await share(f.openPage, { email: `ps-nobody-${++seq}@example.com` }, teammate.token)).status, 403, 'an email invite');
  assert.equal((await share(f.openPage, { userId: teammate.user.id }, viewer.token)).status, 403);
  // Owners and admins may share outside the workspace.
  assert.equal((await share(f.openPage, { email: outsider.user.email })).status, 200);
  // Not with yourself, and userId must be a member.
  assert.equal((await share(f.page, { userId: owner.user.id })).status, 400);
  assert.equal((await share(f.page, { userId: outsider.user.id })).status, 400);
});

test('effective rights: a member gets min(share, role), so a viewer stays view-only; an outsider gets the share', async () => {
  const f = await fixture();
  await share(f.openPage, { userId: viewer.user.id, canEdit: true });
  const p = (await app.call('GET', `/pages/${f.openPage}`, viewer.token)).data;
  assert.equal(p.canEdit, false, 'a viewer role caps the share');
  assert.equal((await app.call('PATCH', `/pages/${f.openPage}`, viewer.token, { title: 'x' })).status, 403);
  const viewerShared = ((await app.call('GET', '/shared-pages', viewer.token)).data as { id: string; canEdit: boolean }[]).find((x) => x.id === f.openPage);
  assert.equal(viewerShared?.canEdit, false, '"Shared with me" shows what the viewer can actually do');
  // Outside the workspace, the share is stored as asked and can be switched both ways.
  await share(f.page, { email: outsider.user.email, canEdit: true });
  const { db } = await import('../server/db.ts');
  const stored = () => (db.prepare('SELECT can_edit FROM page_shares WHERE page_id = ? AND user_id = ?').get(f.page, outsider.user.id) as { can_edit: number }).can_edit;
  assert.equal(stored(), 1);
  assert.equal((await app.call('GET', `/pages/${f.page}`, outsider.token)).data.canEdit, true);
  assert.equal((await app.call('PATCH', `/pages/${f.page}/shares/${outsider.user.id}`, owner.token, { canEdit: false })).status, 200);
  assert.equal(stored(), 0);
  assert.equal((await app.call('GET', `/pages/${f.page}`, outsider.token)).data.canEdit, false);
  assert.equal((await app.call('PATCH', `/pages/${f.page}`, outsider.token, { title: 'x' })).status, 403);
  // Joining the workspace as a viewer caps an outsider's edit share too.
  assert.equal((await app.call('PATCH', `/pages/${f.page}/shares/${outsider.user.id}`, owner.token, { canEdit: true })).status, 200);
  await app.call('POST', `/workspaces/${f.ws}/members`, owner.token, { email: outsider.user.email, role: 'viewer' });
  assert.equal((await app.call('GET', `/pages/${f.page}`, outsider.token)).data.canEdit, false, 'now a viewer: view only');
  // A share never adds to notebook-level access, nor lowers it.
  await share(f.openPage, { userId: teammate.user.id, canEdit: false });
  assert.equal((await app.call('GET', `/pages/${f.openPage}`, teammate.token)).data.canEdit, true, 'a view share doesn’t lower notebook access');
});

test('tasks on a page shared view-only: the assignee may only tick theirs off', async () => {
  const f = await fixture();
  await share(f.page, { userId: teammate.user.id, canEdit: false });
  await app.call('PATCH', `/tasks/${f.task}`, owner.token, { assigneeId: teammate.user.id });
  assert.equal((await app.call('PATCH', `/tasks/${f.task}`, teammate.token, { status: 'done' })).status, 200);
  assert.equal((await app.call('PATCH', `/tasks/${f.task}`, teammate.token, { status: 'done', title: 'and rename' })).status, 403);
  assert.equal((await app.call('PATCH', `/tasks/${f.task}`, teammate.token, { pageId: null })).status, 403);
  assert.equal((await app.call('DELETE', `/tasks/${f.task}`, teammate.token)).status, 403);
});

test('a task reference only moves a task onto the page if whoever inserted it can see that task', async () => {
  const f = await fixture();
  await share(f.page, { userId: teammate.user.id, canEdit: true });
  const { db } = await import('../server/db.ts');
  // The owner's private standalone task (left a private page): the teammate can't see it.
  const secret = (await app.call('POST', `/workspaces/${f.ws}/tasks`, owner.token, { title: 'Owner secret' })).data.id as string;
  db.prepare('UPDATE tasks SET private_owner_only = 1 WHERE id = ?').run(secret);
  const mine = (await app.call('POST', `/workspaces/${f.ws}/tasks`, teammate.token, { title: 'Teammate standalone' })).data.id as string;
  const b = collabClient(app, f.page, teammate.token);
  try {
    await synced(b);
    const refs = [secret, f.siblingTask, mine].map((id) => {
      const el = new Y.XmlElement('taskRef');
      el.setAttribute('taskId', id);
      return el;
    });
    b.doc.getXmlFragment('default').insert(0, refs);
  } finally {
    // Leaving the page saves it.
    await new Promise((r) => setTimeout(r, 300));
    b.destroy();
  }
  const { getTask } = await import('../server/tasks.ts');
  await waitFor(() => getTask(mine)?.pageId === f.page, 3000, 'their own task attached');
  assert.equal(getTask(secret)!.pageId, null, 'a task they can’t see is not pulled in');
  assert.equal((db.prepare('SELECT private_owner_only AS v FROM tasks WHERE id = ?').get(secret) as { v: number }).v, 1, 'and stays private');
  assert.equal(getTask(f.siblingTask)!.pageId, f.sibling, 'a task on a page they can’t see stays there');
});

test('a view-only share holder can’t pull a task off the shared page by referencing it from their own page', async () => {
  const f = await fixture();
  await share(f.page, { userId: teammate.user.id, canEdit: false });
  const nb = (await app.call('POST', `/workspaces/${f.ws}/notebooks`, teammate.token, { name: 'Teammate notebook' })).data.id;
  const sec = (await app.call('POST', `/notebooks/${nb}/sections`, teammate.token, { name: 'S' })).data.id;
  const own = (await app.call('POST', `/sections/${sec}/pages`, teammate.token, { title: 'Own page' })).data.id as string;
  const mine = (await app.call('POST', `/workspaces/${f.ws}/tasks`, teammate.token, { title: 'Teammate standalone 2' })).data.id as string;
  const b = collabClient(app, own, teammate.token);
  try {
    await synced(b);
    const refs = [f.task, mine].map((id) => {
      const el = new Y.XmlElement('taskRef');
      el.setAttribute('taskId', id);
      return el;
    });
    b.doc.getXmlFragment('default').insert(0, refs);
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    b.destroy();
  }
  const { getTask } = await import('../server/tasks.ts');
  await waitFor(() => getTask(mine)?.pageId === own, 3000, 'their own task attached');
  assert.equal(getTask(f.task)!.pageId, f.page, 'the shared page’s task stays where it is');
});

test('moving a page into a private notebook ends page shares its creator didn’t grant', async () => {
  const f = await fixture();
  await share(f.openPage, { userId: viewer.user.id }, teammate.token); // granted by the teammate
  await app.call('PUT', `/notebooks/${f.nb}/shares`, owner.token, { userIds: [teammate.user.id] });
  assert.equal((await app.call('POST', `/pages/${f.openPage}/move`, teammate.token, { sectionId: f.sec })).status, 200);
  assert.equal((await app.call('GET', `/pages/${f.openPage}`, viewer.token)).status, 404);
});

test('an invite accepted through its link records who sent it, so the share survives the notebook going private', async () => {
  const f = await fixture();
  const invitee = await app.signUp('PsLinkInvitee');
  const { upsertPageInvite } = await import('../server/workspaces.ts');
  const token = upsertPageInvite(f.openPage, invitee.user.email, false, owner.user.id);
  assert.equal((await app.call('POST', `/invites/${token}/accept`, invitee.token)).status, 200);
  const { db } = await import('../server/db.ts');
  assert.equal((db.prepare('SELECT created_by FROM page_shares WHERE page_id = ? AND user_id = ?').get(f.openPage, invitee.user.id) as { created_by: string }).created_by, owner.user.id);
  assert.equal((await app.call('PATCH', `/notebooks/${f.openNb}`, owner.token, { visibility: 'private' })).data.removedPageShares, 0);
  assert.equal((await app.call('GET', `/pages/${f.openPage}`, invitee.token)).status, 200);
});

test('making a notebook private ends page shares others granted on its pages', async () => {
  const f = await fixture();
  await share(f.openPage, { userId: viewer.user.id }, teammate.token); // granted by a member
  await share(f.openPage, { userId: teammate.user.id }); // granted by the creator: stays
  const r = await app.call('PATCH', `/notebooks/${f.openNb}`, owner.token, { visibility: 'private' });
  assert.equal(r.status, 200);
  assert.equal(r.data.removedPageShares, 1);
  assert.equal((await app.call('GET', `/pages/${f.openPage}`, viewer.token)).status, 404);
  assert.equal((await app.call('GET', `/pages/${f.openPage}`, teammate.token)).status, 200);
  // Making it private again (already private) removes nothing.
  assert.equal((await app.call('PATCH', `/notebooks/${f.openNb}`, owner.token, { visibility: 'private' })).data.removedPageShares, 0);
});

test('invite-only sign-up counts a page invite only while its sender is an owner or admin', async () => {
  const f = await fixture();
  const admin = await app.signUp('PsAdmin');
  await app.call('POST', `/workspaces/${f.ws}/members`, owner.token, { email: admin.user.email, role: 'admin' });
  const email = `ps-demoted-${++seq}@example.com`;
  assert.equal((await share(f.openPage, { email }, admin.token)).data.status, 'invited');
  await app.call('PATCH', `/workspaces/${f.ws}/members/${admin.user.id}`, owner.token, { role: 'member' });
  process.env.SIGNUP_MODE = 'invite';
  try {
    assert.equal((await app.call('POST', '/auth/register', undefined, { name: 'Late', email, password: 'password123' })).status, 403);
  } finally {
    process.env.SIGNUP_MODE = 'open';
  }
});

test('moving the page keeps its shares; deleting it or removing the member drops them', async () => {
  const f = await fixture();
  await share(f.page, { userId: teammate.user.id, canEdit: true });
  const sec2 = (await app.call('POST', `/notebooks/${f.nb}/sections`, owner.token, { name: 'Another secret section' })).data.id;
  assert.equal((await app.call('POST', `/pages/${f.page}/move`, owner.token, { sectionId: sec2 })).status, 200);
  assert.equal((await app.call('GET', `/pages/${f.page}`, teammate.token)).status, 200, 'still shared after the move');

  await app.call('DELETE', `/workspaces/${f.ws}/members/${teammate.user.id}`, owner.token);
  assert.equal((await app.call('GET', `/pages/${f.page}`, teammate.token)).status, 404, 'removed from the workspace: share gone too');

  await share(f.page, { email: outsider.user.email });
  assert.equal((await app.call('DELETE', `/pages/${f.page}`, owner.token)).status, 200);
  assert.ok(!((await app.call('GET', '/shared-pages', outsider.token)).data as { id: string }[]).some((x) => x.id === f.page));
});

test('the holder can remove a page from their own "Shared with me"', async () => {
  const f = await fixture();
  await share(f.page, { email: outsider.user.email });
  assert.equal((await app.call('DELETE', `/pages/${f.page}/shares/${outsider.user.id}`, outsider.token)).status, 200);
  assert.equal((await app.call('GET', `/pages/${f.page}`, outsider.token)).status, 404);
});
