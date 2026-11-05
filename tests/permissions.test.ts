// Permission matrix: every REST route × every role (plus a stranger), and
// private-notebook visibility. Each cell runs against fresh resources.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';

type Who = 'owner' | 'admin' | 'member' | 'viewer' | 'stranger';
const WHO: Who[] = ['owner', 'admin', 'member', 'viewer', 'stranger'];
const RANK: Record<Who, number> = { stranger: -1, viewer: 0, member: 1, admin: 2, owner: 3 };

let app: TestApp;
let people: Record<Who, TestUser>;
before(async () => {
  app = await startTestApp();
  const [owner, admin, member, viewer, stranger] = await Promise.all(WHO.map((w) => app.signUp(`P-${w}`)));
  people = { owner, admin, member, viewer, stranger };
});
after(() => app.close());

interface Fx {
  wsId: string;
  notebookId: string;
  sectionId: string;
  pageId: string;
  taskId: string;
  target: TestUser; // a plain member others can act on
}

let fxSeq = 0;
async function fixture(): Promise<Fx> {
  const o = people.owner.token;
  const wsId = (await app.call('POST', '/workspaces', o, { name: `WS ${++fxSeq}` })).data.id;
  for (const w of ['admin', 'member', 'viewer'] as const)
    assert.equal((await app.call('POST', `/workspaces/${wsId}/members`, o, { email: people[w].user.email, role: w })).status, 200);
  const target = await app.signUp(`Target${fxSeq}`);
  await app.call('POST', `/workspaces/${wsId}/members`, o, { email: target.user.email, role: 'member' });
  const notebookId = (await app.call('POST', `/workspaces/${wsId}/notebooks`, o, { name: 'NB' })).data.id;
  const sectionId = (await app.call('POST', `/notebooks/${notebookId}/sections`, o, { name: 'Sec' })).data.id;
  const pageId = (await app.call('POST', `/sections/${sectionId}/pages`, o, { title: 'Pg' })).data.id;
  const taskId = (await app.call('POST', `/workspaces/${wsId}/tasks`, o, { title: 'T', pageId })).data.id;
  await app.call('POST', `/workspaces/${wsId}/members`, o, { email: `pending-${fxSeq}@example.com`, role: 'member' });
  return { wsId, notebookId, sectionId, pageId, taskId, target };
}

interface Op {
  name: string;
  min: Exclude<Who, 'stranger'>;
  run: (f: Fx, token: string) => Promise<{ status: number }>;
}

const OPS: Op[] = [
  { name: 'GET tree', min: 'viewer', run: (f, t) => app.call('GET', `/workspaces/${f.wsId}/tree`, t) },
  { name: 'GET members', min: 'viewer', run: (f, t) => app.call('GET', `/workspaces/${f.wsId}/members`, t) },
  { name: 'GET tasks', min: 'viewer', run: (f, t) => app.call('GET', `/workspaces/${f.wsId}/tasks`, t) },
  { name: 'GET search', min: 'viewer', run: (f, t) => app.call('GET', `/workspaces/${f.wsId}/search?q=pg`, t) },
  { name: 'GET page', min: 'viewer', run: (f, t) => app.call('GET', `/pages/${f.pageId}`, t) },
  { name: 'GET notebook shares', min: 'viewer', run: (f, t) => app.call('GET', `/notebooks/${f.notebookId}/shares`, t) },
  { name: 'POST notebook', min: 'member', run: (f, t) => app.call('POST', `/workspaces/${f.wsId}/notebooks`, t, { name: 'x' }) },
  { name: 'PATCH notebook', min: 'member', run: (f, t) => app.call('PATCH', `/notebooks/${f.notebookId}`, t, { name: 'y' }) },
  { name: 'DELETE notebook (someone else’s)', min: 'admin', run: (f, t) => app.call('DELETE', `/notebooks/${f.notebookId}`, t) },
  { name: 'POST section', min: 'member', run: (f, t) => app.call('POST', `/notebooks/${f.notebookId}/sections`, t, { name: 'x' }) },
  { name: 'PATCH section', min: 'member', run: (f, t) => app.call('PATCH', `/sections/${f.sectionId}`, t, { name: 'y' }) },
  { name: 'DELETE section', min: 'member', run: (f, t) => app.call('DELETE', `/sections/${f.sectionId}`, t) },
  { name: 'POST page', min: 'member', run: (f, t) => app.call('POST', `/sections/${f.sectionId}/pages`, t, { title: 'x' }) },
  { name: 'PATCH page', min: 'member', run: (f, t) => app.call('PATCH', `/pages/${f.pageId}`, t, { title: 'y' }) },
  { name: 'DELETE page', min: 'member', run: (f, t) => app.call('DELETE', `/pages/${f.pageId}`, t) },
  { name: 'POST task', min: 'member', run: (f, t) => app.call('POST', `/workspaces/${f.wsId}/tasks`, t, { title: 'x' }) },
  { name: 'PATCH task', min: 'member', run: (f, t) => app.call('PATCH', `/tasks/${f.taskId}`, t, { status: 'done' }) },
  { name: 'DELETE task', min: 'member', run: (f, t) => app.call('DELETE', `/tasks/${f.taskId}`, t) },
  { name: 'PATCH workspace', min: 'admin', run: (f, t) => app.call('PATCH', `/workspaces/${f.wsId}`, t, { name: 'z' }) },
  { name: 'POST invite', min: 'admin', run: (f, t) => app.call('POST', `/workspaces/${f.wsId}/members`, t, { email: `new-${Math.random()}@example.com` }) },
  { name: 'POST resend invite', min: 'admin', run: (f, t) => app.call('POST', `/workspaces/${f.wsId}/invites/pending-${fxSeq}%40example.com/resend`, t) },
  { name: 'DELETE invite', min: 'admin', run: (f, t) => app.call('DELETE', `/workspaces/${f.wsId}/invites/pending-${fxSeq}%40example.com`, t) },
  { name: 'PATCH member role', min: 'admin', run: (f, t) => app.call('PATCH', `/workspaces/${f.wsId}/members/${f.target.user.id}`, t, { role: 'viewer' }) },
  { name: 'DELETE member', min: 'admin', run: (f, t) => app.call('DELETE', `/workspaces/${f.wsId}/members/${f.target.user.id}`, t) },
  { name: 'DELETE workspace', min: 'owner', run: (f, t) => app.call('DELETE', `/workspaces/${f.wsId}`, t) },
];

for (const op of OPS) {
  test(`matrix: ${op.name} needs ${op.min}`, async () => {
    const results: string[] = [];
    for (const who of WHO) {
      const f = await fixture();
      const { status } = await op.run(f, people[who].token);
      const expected = who === 'stranger' ? 404 : RANK[who] >= RANK[op.min] ? 200 : 403;
      results.push(`${who}:${status}`);
      assert.equal(status, expected, `${op.name} as ${who}: expected ${expected}, got ${status} (${results.join(' ')})`);
    }
  });
}

test('everyone may leave a workspace (DELETE themselves), except the last owner', async () => {
  for (const who of ['admin', 'member', 'viewer'] as const) {
    const f = await fixture();
    assert.equal((await app.call('DELETE', `/workspaces/${f.wsId}/members/${people[who].user.id}`, people[who].token)).status, 200, who);
  }
  const f = await fixture();
  assert.equal((await app.call('DELETE', `/workspaces/${f.wsId}/members/${people.owner.user.id}`, people.owner.token)).status, 400);
});

test('admins cannot change or remove owners; owners can', async () => {
  const f = await fixture();
  const ownerId = people.owner.user.id;
  assert.equal((await app.call('PATCH', `/workspaces/${f.wsId}/members/${ownerId}`, people.admin.token, { role: 'member' })).status, 403);
  assert.equal((await app.call('DELETE', `/workspaces/${f.wsId}/members/${ownerId}`, people.admin.token)).status, 403);
  assert.equal((await app.call('PATCH', `/workspaces/${f.wsId}/members/${people.admin.user.id}`, people.admin.token, { role: 'owner' })).status, 403);
  assert.equal((await app.call('PATCH', `/workspaces/${f.wsId}/members/${people.admin.user.id}`, people.owner.token, { role: 'owner' })).status, 200);
});

test('private notebooks: only the creator and people it is shared with see it, its pages and its tasks', async () => {
  const f = await fixture();
  const m = people.member;
  // The member creates a private notebook with a page and a task in it.
  const nb = (await app.call('POST', `/workspaces/${f.wsId}/notebooks`, m.token, { name: 'Secret', visibility: 'private' })).data.id;
  const sec = (await app.call('POST', `/notebooks/${nb}/sections`, m.token, { name: 's' })).data.id;
  const pg = (await app.call('POST', `/sections/${sec}/pages`, m.token, { title: 'Diary uniqueword' })).data.id;
  const task = (await app.call('POST', `/workspaces/${f.wsId}/tasks`, m.token, { title: 'private task', pageId: pg })).data.id;

  const sees = async (u: TestUser) => {
    const tree = await app.call('GET', `/workspaces/${f.wsId}/tree`, u.token);
    const tasks = await app.call('GET', `/workspaces/${f.wsId}/tasks`, u.token);
    const search = await app.call('GET', `/workspaces/${f.wsId}/search?q=uniqueword`, u.token);
    return {
      tree: tree.data.notebooks.some((n: { id: string }) => n.id === nb),
      page: (await app.call('GET', `/pages/${pg}`, u.token)).status === 200,
      task: tasks.data.some((t: { id: string }) => t.id === task),
      search: search.data.pages.some((p: { id: string }) => p.id === pg),
    };
  };
  const all = { tree: true, page: true, task: true, search: true };
  const none = { tree: false, page: false, task: false, search: false };
  assert.deepEqual(await sees(m), all, 'creator');
  for (const who of ['owner', 'admin', 'viewer'] as const) assert.deepEqual(await sees(people[who]), none, who);
  assert.equal((await app.call('PATCH', `/tasks/${task}`, people.owner.token, { title: 'x' })).status, 404);
  assert.equal((await app.call('PATCH', `/pages/${pg}`, people.admin.token, { title: 'x' })).status, 404);

  // Only the creator manages shares, and only with workspace members.
  assert.equal((await app.call('PUT', `/notebooks/${nb}/shares`, people.owner.token, { userIds: [] })).status, 404);
  assert.equal((await app.call('PUT', `/notebooks/${nb}/shares`, m.token, { userIds: [people.stranger.user.id] })).status, 400);
  assert.equal((await app.call('PUT', `/notebooks/${nb}/shares`, m.token, { userIds: 'nope' })).status, 400);
  assert.equal((await app.call('PUT', `/notebooks/${nb}/shares`, m.token, { userIds: [people.viewer.user.id, people.admin.user.id] })).status, 200);
  assert.deepEqual(await sees(people.viewer), all, 'shared viewer');
  assert.deepEqual(await sees(people.admin), all, 'shared admin');
  assert.deepEqual(await sees(people.owner), none, 'owner still not shared');
  // Shared viewers still can't edit; a shared admin can.
  assert.equal((await app.call('PATCH', `/pages/${pg}`, people.viewer.token, { title: 'x' })).status, 403);
  assert.equal((await app.call('PATCH', `/pages/${pg}`, people.admin.token, { title: 'Diary uniqueword 2' })).status, 200);
  // Recipients can't reshare.
  assert.equal((await app.call('PUT', `/notebooks/${nb}/shares`, people.admin.token, { userIds: [people.owner.user.id] })).status, 403);
  const shares = await app.call('GET', `/notebooks/${nb}/shares`, people.admin.token);
  assert.deepEqual(new Set(shares.data.userIds), new Set([people.viewer.user.id, people.admin.user.id]));

  // Removing someone from the workspace drops their shares.
  await app.call('DELETE', `/workspaces/${f.wsId}/members/${people.viewer.user.id}`, people.owner.token);
  await app.call('POST', `/workspaces/${f.wsId}/members`, people.owner.token, { email: people.viewer.user.email, role: 'viewer' });
  assert.deepEqual(await sees(people.viewer), none, 're-added viewer loses old share');

  // Unshare.
  await app.call('PUT', `/notebooks/${nb}/shares`, m.token, { userIds: [] });
  assert.deepEqual(await sees(people.admin), none, 'unshared admin');
  // Assigned tasks stay visible to their assignee even in a private notebook.
  await app.call('PATCH', `/tasks/${task}`, m.token, { assigneeId: people.owner.user.id });
  assert.equal((await sees(people.owner)).task, true, 'assignee sees task');
});
