// Tags, teams, "assigned by" and saved task views (migration 014).
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';

let app: TestApp;
let owner: TestUser, admin: TestUser, member: TestUser, viewer: TestUser, stranger: TestUser;
let ws: string;

before(async () => {
  app = await startTestApp();
  [owner, admin, member, viewer, stranger] = await Promise.all(['TOwner', 'TAdmin', 'TMember', 'TViewer', 'TStranger'].map((n) => app.signUp(n)));
  ws = (await app.call('POST', '/workspaces', owner.token, { name: 'Teams WS' })).data.id;
  await app.call('POST', `/workspaces/${ws}/members`, owner.token, { email: admin.user.email, role: 'admin' });
  await app.call('POST', `/workspaces/${ws}/members`, owner.token, { email: member.user.email, role: 'member' });
  await app.call('POST', `/workspaces/${ws}/members`, owner.token, { email: viewer.user.email, role: 'viewer' });
});
after(() => app.close());

test('owners and admins manage teams; members and viewers only see them', async () => {
  const elders = await app.call('POST', `/workspaces/${ws}/teams`, admin.token, { name: 'Elders', memberIds: [member.user.id] });
  assert.equal(elders.status, 200);
  assert.deepEqual(elders.data.memberIds, [member.user.id]);
  const sub = await app.call('POST', `/workspaces/${ws}/teams`, owner.token, { name: 'Shepherds', parentId: elders.data.id });
  assert.equal(sub.data.parentId, elders.data.id);
  // One level of subteams only.
  assert.equal((await app.call('POST', `/workspaces/${ws}/teams`, owner.token, { name: 'Deeper', parentId: sub.data.id })).status, 400);
  assert.equal((await app.call('PATCH', `/teams/${elders.data.id}`, owner.token, { parentId: sub.data.id })).status, 400);

  for (const u of [member, viewer]) {
    assert.equal((await app.call('POST', `/workspaces/${ws}/teams`, u.token, { name: 'Nope' })).status, 403);
    assert.equal((await app.call('PATCH', `/teams/${elders.data.id}`, u.token, { name: 'Nope' })).status, 403);
    assert.equal((await app.call('PUT', `/teams/${elders.data.id}/members`, u.token, { userIds: [] })).status, 403);
    assert.equal((await app.call('DELETE', `/teams/${elders.data.id}`, u.token)).status, 403);
    const list = await app.call('GET', `/workspaces/${ws}/teams`, u.token);
    assert.equal(list.status, 200);
    assert.ok(list.data.some((t: { name: string }) => t.name === 'Elders'));
  }
  assert.equal((await app.call('GET', `/workspaces/${ws}/teams`, stranger.token)).status, 404);
  assert.equal((await app.call('PATCH', `/teams/${elders.data.id}`, stranger.token, { name: 'x' })).status, 404);
  // Only workspace members can join.
  assert.equal((await app.call('PUT', `/teams/${elders.data.id}/members`, owner.token, { userIds: [stranger.user.id] })).status, 400);
  const put = await app.call('PUT', `/teams/${elders.data.id}/members`, owner.token, { userIds: [member.user.id, admin.user.id] });
  assert.deepEqual([...put.data.memberIds].sort(), [member.user.id, admin.user.id].sort());

  // Deleting a team takes its subteams and clears the team on their tasks.
  const task = (await app.call('POST', `/workspaces/${ws}/tasks`, member.token, { title: 'Sub task', teamId: sub.data.id })).data;
  assert.equal(task.teamId, sub.data.id);
  assert.equal((await app.call('DELETE', `/teams/${elders.data.id}`, owner.token)).status, 200);
  const after = (await app.call('GET', `/workspaces/${ws}/tasks`, member.token)).data.find((t: { id: string }) => t.id === task.id);
  assert.equal(after.teamId, null);
  assert.equal((await app.call('GET', `/workspaces/${ws}/teams`, owner.token)).data.length, 0);
});

test('anyone who can edit creates tags; only owners and admins rename or delete them', async () => {
  const t = await app.call('POST', `/workspaces/${ws}/tags`, member.token, { name: '#Waiting' });
  assert.equal(t.status, 200);
  assert.equal(t.data.name, 'Waiting');
  // Same name in another case returns the same tag.
  assert.equal((await app.call('POST', `/workspaces/${ws}/tags`, admin.token, { name: 'waiting' })).data.id, t.data.id);
  assert.equal((await app.call('POST', `/workspaces/${ws}/tags`, viewer.token, { name: 'Viewer tag' })).status, 403);
  assert.equal((await app.call('POST', `/workspaces/${ws}/tags`, stranger.token, { name: 'X' })).status, 404);
  assert.equal((await app.call('PATCH', `/tags/${t.data.id}`, member.token, { name: 'Renamed' })).status, 403);
  assert.equal((await app.call('DELETE', `/tags/${t.data.id}`, member.token)).status, 403);
  const other = (await app.call('POST', `/workspaces/${ws}/tags`, member.token, { name: 'Urgent' })).data;
  assert.equal((await app.call('PATCH', `/tags/${other.id}`, admin.token, { name: 'WAITING' })).status, 409);
  const renamed = await app.call('PATCH', `/tags/${other.id}`, admin.token, { name: 'Soon', color: '#112233' });
  assert.equal(renamed.data.name, 'Soon');
  assert.equal(renamed.data.color, '#112233');

  // Tagging a task; unknown ids are ignored.
  const task = (await app.call('POST', `/workspaces/${ws}/tasks`, member.token, { title: 'Tagged', tagIds: [t.data.id, 'nope'] })).data;
  assert.deepEqual(task.tagIds, [t.data.id]);
  const patched = (await app.call('PATCH', `/tasks/${task.id}`, member.token, { tagIds: [t.data.id, other.id] })).data;
  assert.deepEqual([...patched.tagIds].sort(), [t.data.id, other.id].sort());
  assert.equal((await app.call('DELETE', `/tags/${other.id}`, owner.token)).status, 200);
  const listed = (await app.call('GET', `/workspaces/${ws}/tasks`, member.token)).data.find((x: { id: string }) => x.id === task.id);
  assert.deepEqual(listed.tagIds, [t.data.id]);
  // A team from another workspace is refused.
  const otherWs = (await app.call('POST', '/workspaces', member.token, { name: 'Elsewhere' })).data.id;
  const foreign = (await app.call('POST', `/workspaces/${otherWs}/teams`, member.token, { name: 'Foreign' })).data.id;
  assert.equal((await app.call('PATCH', `/tasks/${task.id}`, member.token, { teamId: foreign })).status, 400);
});

test('assigned by is set by the server when the assignee changes and cleared when unassigned', async () => {
  const created = (await app.call('POST', `/workspaces/${ws}/tasks`, owner.token, { title: 'Assign me', assigneeId: member.user.id })).data;
  assert.equal(created.assignedBy, owner.user.id);
  const unassigned = (await app.call('POST', `/workspaces/${ws}/tasks`, owner.token, { title: 'Nobody' })).data;
  assert.equal(unassigned.assignedBy, null);
  // Changing something else keeps it; reassigning records the new person; the client can't set it.
  let t = (await app.call('PATCH', `/tasks/${created.id}`, admin.token, { title: 'Renamed', assignedBy: admin.user.id })).data;
  assert.equal(t.assignedBy, owner.user.id);
  t = (await app.call('PATCH', `/tasks/${created.id}`, admin.token, { assigneeId: owner.user.id })).data;
  assert.equal(t.assignedBy, admin.user.id);
  t = (await app.call('PATCH', `/tasks/${created.id}`, member.token, { assigneeId: null })).data;
  assert.equal(t.assignedBy, null);
});

test('saved views are personal unless an owner or admin shares them', async () => {
  const query = { filters: { status: 'open' }, sort: 'due', group: 'none' };
  const mine = await app.call('POST', `/workspaces/${ws}/task-views`, member.token, { name: 'Mine', query });
  assert.equal(mine.status, 200);
  assert.equal(mine.data.shared, false);
  assert.equal((await app.call('POST', `/workspaces/${ws}/task-views`, member.token, { name: 'Share', query, shared: true })).status, 403);
  // Viewers can keep personal views.
  assert.equal((await app.call('POST', `/workspaces/${ws}/task-views`, viewer.token, { name: 'Viewer view', query })).status, 200);
  const shared = await app.call('POST', `/workspaces/${ws}/task-views`, admin.token, { name: 'Team view', query, shared: true });
  assert.equal(shared.data.shared, true);

  const names = async (u: TestUser) => ((await app.call('GET', `/workspaces/${ws}/task-views`, u.token)).data as { name: string }[]).map((v) => v.name).sort();
  assert.deepEqual(await names(member), ['Mine', 'Team view']);
  assert.deepEqual(await names(owner), ['Team view']);
  assert.deepEqual(await names(viewer), ['Team view', 'Viewer view']);
  assert.equal((await app.call('GET', `/workspaces/${ws}/task-views`, stranger.token)).status, 404);

  // Someone else's personal view is invisible; a shared view can only be changed by owners/admins (or its owner).
  assert.equal((await app.call('PATCH', `/task-views/${mine.data.id}`, owner.token, { name: 'Hijack' })).status, 404);
  assert.equal((await app.call('DELETE', `/task-views/${mine.data.id}`, admin.token)).status, 404);
  assert.equal((await app.call('PATCH', `/task-views/${shared.data.id}`, member.token, { name: 'Hijack' })).status, 403);
  assert.equal((await app.call('PATCH', `/task-views/${shared.data.id}`, owner.token, { name: 'Renamed shared' })).status, 200);
  assert.equal((await app.call('PATCH', `/task-views/${mine.data.id}`, member.token, { shared: true })).status, 403);
  // Idempotent upload with a client id.
  const id = 'device-view-123456';
  assert.equal((await app.call('POST', `/workspaces/${ws}/task-views`, member.token, { id, name: 'Device', query })).data.id, id);
  assert.equal((await app.call('POST', `/workspaces/${ws}/task-views`, member.token, { id, name: 'Device', query })).status, 200);
  assert.equal((await app.call('POST', `/workspaces/${ws}/task-views`, admin.token, { id, name: 'Device', query })).status, 409);
  assert.equal((await app.call('POST', `/workspaces/${ws}/task-views`, member.token, { name: 'Bad', query: { filters: [] } })).status, 400);
  assert.equal((await app.call('DELETE', `/task-views/${mine.data.id}`, member.token)).status, 200);
});

test('export and import keep tags, teams, task tags, assigned by and saved views', async () => {
  const { exportWorkspace, importWorkspace } = await import('../server/export.ts');
  const { db } = await import('../server/db.ts');
  const team = (await app.call('POST', `/workspaces/${ws}/teams`, owner.token, { name: 'Staff', memberIds: [owner.user.id] })).data;
  const sub = (await app.call('POST', `/workspaces/${ws}/teams`, owner.token, { name: 'Worship', parentId: team.id })).data;
  const tag = (await app.call('POST', `/workspaces/${ws}/tags`, owner.token, { name: 'Export tag' })).data;
  await app.call('POST', `/workspaces/${ws}/tasks`, owner.token, { title: 'Exported', teamId: sub.id, tagIds: [tag.id], assigneeId: owner.user.id });
  await app.call('POST', `/workspaces/${ws}/task-views`, owner.token, { name: 'Staff view', query: { filters: { teamId: team.id, tagsAny: [tag.id] }, sort: 'due', group: 'none' } });

  const { zip } = exportWorkspace(ws, owner.user.id);
  const { workspaceId } = await importWorkspace(zip, owner.user.id);
  const teams = (await app.call('GET', `/workspaces/${workspaceId}/teams`, owner.token)).data as { id: string; name: string; parentId: string | null; memberIds: string[] }[];
  const staff = teams.find((t) => t.name === 'Staff')!;
  const worship = teams.find((t) => t.name === 'Worship')!;
  assert.equal(worship.parentId, staff.id);
  assert.deepEqual(staff.memberIds, [owner.user.id]);
  const tags = (await app.call('GET', `/workspaces/${workspaceId}/tags`, owner.token)).data as { id: string; name: string }[];
  const newTag = tags.find((t) => t.name === 'Export tag')!;
  const tasks = (await app.call('GET', `/workspaces/${workspaceId}/tasks`, owner.token)).data as { title: string; teamId: string; tagIds: string[]; assignedBy: string }[];
  const task = tasks.find((t) => t.title === 'Exported')!;
  assert.equal(task.teamId, worship.id);
  assert.deepEqual(task.tagIds, [newTag.id]);
  assert.equal(task.assignedBy, owner.user.id);
  const views = (await app.call('GET', `/workspaces/${workspaceId}/task-views`, owner.token)).data as { name: string; query: { filters: { teamId: string; tagsAny: string[] } } }[];
  const v = views.find((x) => x.name === 'Staff view')!;
  assert.equal(v.query.filters.teamId, staff.id);
  assert.deepEqual(v.query.filters.tagsAny, [newTag.id]);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
