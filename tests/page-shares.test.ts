// Sharing a single page (#98): page_shares grant one page only, never its notebook,
// siblings or workspace; co-editing over /collab; revocation closes the socket (4403);
// people outside the workspace are view-only; email invites become shares on sign-up.
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

test('someone outside the workspace gets view-only access to that page and nothing else', async () => {
  const f = await fixture();
  // They asked for edit; outside the workspace it's view only.
  const r = await share(f.page, { email: outsider.user.email, canEdit: true });
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
  assert.equal((await app.call('PATCH', `/tasks/${f.task}`, outsider.token, { status: 'done' })).status, 404);
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

test('who may share: the private notebook’s creator; for a shared notebook, anyone who can edit it', async () => {
  const f = await fixture();
  // Teammate can't see the private notebook at all.
  assert.equal((await share(f.page, { userId: viewer.user.id }, teammate.token)).status, 404);
  // Even with the notebook shared with them, only its creator shares single pages from it.
  await app.call('PUT', `/notebooks/${f.nb}/shares`, owner.token, { userIds: [teammate.user.id] });
  assert.equal((await share(f.page, { userId: viewer.user.id }, teammate.token)).status, 403);
  // In a shared notebook: members yes, viewers no.
  assert.equal((await share(f.openPage, { email: outsider.user.email }, teammate.token)).status, 200);
  assert.equal((await share(f.openPage, { email: outsider.user.email }, viewer.token)).status, 403);
  // Not with yourself, and userId must be a member.
  assert.equal((await share(f.page, { userId: owner.user.id })).status, 400);
  assert.equal((await share(f.page, { userId: outsider.user.id })).status, 400);
});

test('a viewer can be given edit rights on one page', async () => {
  const f = await fixture();
  assert.equal((await app.call('GET', `/pages/${f.openPage}`, viewer.token)).data.canEdit, false);
  await share(f.openPage, { userId: viewer.user.id, canEdit: true });
  const p = (await app.call('GET', `/pages/${f.openPage}`, viewer.token)).data;
  assert.equal(p.canEdit, true);
  assert.equal(p.canManage, false, 'still no structural changes');
  assert.equal((await app.call('DELETE', `/pages/${f.openPage}`, viewer.token)).status, 403);
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
