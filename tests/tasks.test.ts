// Task server tests: CRUD, permissions, list queries, note ↔ task reconciliation
// and live events. Owner: Tasks & Dashboard.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';
import type { ServerEvent, Task } from '../shared/types.ts';

let app: TestApp;
before(async () => {
  app = await startTestApp();
});
after(() => app.close());

/** Owner + a second user added to the owner's workspace with `role`. */
async function team(role: 'member' | 'viewer' | 'admin' = 'member') {
  const owner = await app.signUp('Owner');
  const other = await app.signUp(role === 'viewer' ? 'Viewer' : 'Mate');
  const r = await app.call('POST', `/workspaces/${owner.wsId}/members`, owner.token, { email: other.user.email, role });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { owner, other, wsId: owner.wsId };
}

async function makePage(u: TestUser, wsId: string, visibility: 'shared' | 'private' = 'shared') {
  const nb = await app.call('POST', `/workspaces/${wsId}/notebooks`, u.token, { name: `NB ${visibility}`, visibility });
  const sec = await app.call('POST', `/notebooks/${nb.data.id}/sections`, u.token, { name: 'S' });
  const pg = await app.call('POST', `/sections/${sec.data.id}/pages`, u.token, { title: 'P' });
  return { notebookId: nb.data.id as string, sectionId: sec.data.id as string, pageId: pg.data.id as string };
}

const create = (u: TestUser, wsId: string, body: Record<string, unknown>) =>
  app.call<Task>('POST', `/workspaces/${wsId}/tasks`, u.token, body);
const list = (u: TestUser, wsId: string) => app.call<Task[]>('GET', `/workspaces/${wsId}/tasks`, u.token);

// ───────────── CRUD ─────────────

test('create → list → update → delete', async () => {
  const u = await app.signUp('Crud');
  const c = await create(u, u.wsId, { title: '  Write spec  ', priority: 2, dueDate: '2026-11-10', dueTime: '15:00' });
  assert.equal(c.status, 200);
  assert.equal(c.data.title, 'Write spec', 'title is trimmed');
  assert.equal(c.data.priority, 2);
  assert.equal(c.data.pageId, null, 'standalone by default');
  assert.equal(c.data.createdBy, u.user.id);

  assert.ok((await list(u, u.wsId)).data.some((t) => t.id === c.data.id));

  const p = await app.call<Task>('PATCH', `/tasks/${c.data.id}`, u.token, { title: 'Write the spec', priority: 1, assigneeId: u.user.id, dueDate: null });
  assert.equal(p.status, 200);
  assert.equal(p.data.title, 'Write the spec');
  assert.equal(p.data.priority, 1);
  assert.equal(p.data.assigneeId, u.user.id);
  assert.equal(p.data.dueDate, null);
  assert.equal(p.data.dueTime, '15:00', 'fields not in the patch are untouched');
  assert.ok(p.data.updatedAt >= c.data.updatedAt);

  assert.equal((await app.call('DELETE', `/tasks/${c.data.id}`, u.token)).status, 200);
  assert.ok(!(await list(u, u.wsId)).data.some((t) => t.id === c.data.id));
  assert.equal((await app.call('PATCH', `/tasks/${c.data.id}`, u.token, { title: 'x' })).status, 404);
});

test('client-chosen ids are idempotent and cannot be hijacked', async () => {
  const u = await app.signUp('Ids');
  const v = await app.signUp('Thief');
  const id = randomUUID();
  const a = await create(u, u.wsId, { id, title: 'One' });
  const b = await create(u, u.wsId, { id, title: 'Retry' });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(b.data.title, 'One', 'retry returns the existing task');
  assert.equal((await create(v, v.wsId, { id, title: 'Mine now' })).status, 409);
  assert.equal((await create(u, u.wsId, { id: 'not-a-uuid', title: 'x' })).status, 400);
});

test('invalid fields are rejected', async () => {
  const u = await app.signUp('Bad');
  const t = (await create(u, u.wsId, { title: 'T' })).data;
  for (const body of [
    { priority: 5 },
    { status: 'archived' },
    { dueDate: '05/11/2026' },
    { dueTime: '3pm' },
    { recurrence: { freq: 'hour', interval: 1 } },
    { recurrence: { freq: 'day', interval: 0 } },
    { title: 42 },
    { title: 'x'.repeat(1001) },
  ]) {
    const r = await app.call('PATCH', `/tasks/${t.id}`, u.token, body);
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
  assert.equal((await create(u, u.wsId, { title: 'x', priority: 0 })).status, 400);
});

test('completing and reopening a task sets and clears completion fields', async () => {
  const u = await app.signUp('Done');
  const t = (await create(u, u.wsId, { title: 'Finish' })).data;
  const d = (await app.call<Task>('PATCH', `/tasks/${t.id}`, u.token, { status: 'done' })).data;
  assert.equal(d.status, 'done');
  assert.equal(d.completedBy, u.user.id);
  assert.ok(d.completedAt);
  const o = (await app.call<Task>('PATCH', `/tasks/${t.id}`, u.token, { status: 'open' })).data;
  assert.equal(o.status, 'open');
  assert.equal(o.completedAt, null);
  assert.equal(o.completedBy, null);
});

test('completing a recurring task keeps it open, rolls it forward and records history', async () => {
  const u = await app.signUp('Recur');
  const t = (await create(u, u.wsId, { title: 'Standup', dueDate: '2020-01-01', recurrence: { freq: 'day', interval: 1 } })).data;
  const r = (await app.call<Task>('PATCH', `/tasks/${t.id}`, u.token, { status: 'done' })).data;
  assert.equal(r.status, 'open');
  assert.ok(r.dueDate! > '2020-01-01');
  const done = (await app.call<Task[]>('GET', `/workspaces/${u.wsId}/tasks/completed`, u.token)).data;
  assert.ok(done.some((x) => x.title === 'Standup' && x.status === 'done' && x.dueDate === '2020-01-01'));
});

// ───────────── Permissions ─────────────

test('viewers can read tasks but not write them', async () => {
  const { owner, other: viewer, wsId } = await team('viewer');
  const t = (await create(owner, wsId, { title: 'Owner task' })).data;
  assert.ok((await list(viewer, wsId)).data.some((x) => x.id === t.id));
  assert.equal((await create(viewer, wsId, { title: 'nope' })).status, 403);
  assert.equal((await app.call('PATCH', `/tasks/${t.id}`, viewer.token, { status: 'done' })).status, 403);
  assert.equal((await app.call('DELETE', `/tasks/${t.id}`, viewer.token)).status, 403);
});

test('non-members cannot see or touch a workspace’s tasks', async () => {
  const owner = await app.signUp('Alone');
  const stranger = await app.signUp('Stranger');
  const t = (await create(owner, owner.wsId, { title: 'Secret' })).data;
  assert.equal((await list(stranger, owner.wsId)).status, 404);
  assert.equal((await app.call('GET', `/workspaces/${owner.wsId}/tasks/completed`, stranger.token)).status, 404);
  assert.equal((await create(stranger, owner.wsId, { title: 'x' })).status, 404);
  assert.equal((await app.call('PATCH', `/tasks/${t.id}`, stranger.token, { title: 'pwned' })).status, 404);
  assert.equal((await app.call('DELETE', `/tasks/${t.id}`, stranger.token)).status, 404);
});

test('assignee must be a workspace member', async () => {
  const u = await app.signUp('Assigner');
  const outsider = await app.signUp('Outsider');
  assert.equal((await create(u, u.wsId, { title: 'x', assigneeId: outsider.user.id })).status, 400);
});

test('tasks in a private notebook are hidden from other members, except the assignee', async () => {
  const { owner, other, wsId } = await team('member');
  const { pageId } = await makePage(owner, wsId, 'private');
  const hidden = (await create(owner, wsId, { title: 'Private', pageId })).data;
  const assigned = (await create(owner, wsId, { title: 'For you', pageId, assigneeId: other.user.id })).data;
  const seen = (await list(other, wsId)).data.map((t) => t.id);
  assert.ok(!seen.includes(hidden.id));
  assert.ok(seen.includes(assigned.id));
  assert.equal((await app.call('PATCH', `/tasks/${hidden.id}`, other.token, { title: 'x' })).status, 404);
  assert.equal((await app.call('PATCH', `/tasks/${assigned.id}`, other.token, { status: 'done' })).status, 200);
  // Can't attach a task to a page you can't see.
  assert.equal((await create(other, wsId, { title: 'x', pageId })).status, 400);
});

test('a task cannot be linked to a page in another workspace', async () => {
  const a = await app.signUp('WsA');
  const { pageId } = await makePage(a, a.wsId);
  const ws2 = (await app.call('POST', '/workspaces', a.token, { name: 'Second' })).data.id as string;
  assert.equal((await create(a, ws2, { title: 'x', pageId })).status, 400);
  const t = (await create(a, ws2, { title: 'y' })).data;
  assert.equal((await app.call('PATCH', `/tasks/${t.id}`, a.token, { pageId })).status, 400);
});

// ───────────── List queries ─────────────

test('the task list holds open tasks and recent completions; completed pages backwards', async () => {
  const u = await app.signUp('Lister');
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const t = (await create(u, u.wsId, { title: `Done ${i}` })).data;
    await app.call('PATCH', `/tasks/${t.id}`, u.token, { status: 'done' });
    ids.push(t.id);
    await new Promise((r) => setTimeout(r, 5)); // distinct completed_at
  }
  const open = (await create(u, u.wsId, { title: 'Open' })).data;
  const all = (await list(u, u.wsId)).data.map((t) => t.id);
  assert.ok(all.includes(open.id));
  for (const id of ids) assert.ok(all.includes(id), 'recently completed tasks are included');

  const page1 = (await app.call<Task[]>('GET', `/workspaces/${u.wsId}/tasks/completed`, u.token)).data;
  assert.deepEqual(page1.filter((t) => ids.includes(t.id)).map((t) => t.id), [...ids].reverse(), 'newest first');
  assert.ok(!page1.some((t) => t.id === open.id));
  const before = page1.find((t) => t.id === ids[1])!.completedAt!;
  const page2 = (await app.call<Task[]>('GET', `/workspaces/${u.wsId}/tasks/completed?before=${encodeURIComponent(before)}`, u.token)).data;
  assert.deepEqual(page2.filter((t) => ids.includes(t.id)).map((t) => t.id), [ids[0]]);
});

test('old completed tasks drop out of the main list but stay in Completed', async () => {
  const u = await app.signUp('Old');
  const t = (await create(u, u.wsId, { title: 'Ancient' })).data;
  await app.call('PATCH', `/tasks/${t.id}`, u.token, { status: 'done' });
  const { db } = await import('../server/db.ts');
  db.prepare('UPDATE tasks SET completed_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', t.id);
  assert.ok(!(await list(u, u.wsId)).data.some((x) => x.id === t.id));
  assert.ok((await app.call<Task[]>('GET', `/workspaces/${u.wsId}/tasks/completed`, u.token)).data.some((x) => x.id === t.id));
});

// ───────────── Reconciliation with taskRef nodes ─────────────

test('reconcile: moving a taskRef between notes relinks it; foreign ids are ignored', async () => {
  const u = await app.signUp('Mover');
  const other = await app.signUp('OtherWs');
  const { syncPageTasks, getTask } = await import('../server/tasks.ts');
  const p1 = (await makePage(u, u.wsId)).pageId;
  const p2 = (await makePage(u, u.wsId)).pageId;
  const t = (await create(u, u.wsId, { title: 'Move me', pageId: p1 })).data;
  const foreign = (await create(other, other.wsId, { title: 'Not yours' })).data;

  // Pasted into p2 and removed from p1 (p2 saves first).
  syncPageTasks(p2, u.wsId, new Set([t.id, foreign.id]));
  assert.equal(getTask(t.id)!.pageId, p2);
  assert.equal(getTask(foreign.id)!.pageId, null, 'a task from another workspace is never linked');
  syncPageTasks(p1, u.wsId, new Set());
  assert.equal(getTask(t.id)!.pageId, p2, 'saving the old note does not detach a task that now lives elsewhere');
});

test('reconcile: completed recurrence history is not touched', async () => {
  const u = await app.signUp('History');
  const { syncPageTasks, getTask } = await import('../server/tasks.ts');
  const { pageId } = await makePage(u, u.wsId);
  const t = (await create(u, u.wsId, { title: 'Weekly', pageId, dueDate: '2026-11-05', recurrence: { freq: 'week', interval: 1 } })).data;
  await app.call('PATCH', `/tasks/${t.id}`, u.token, { status: 'done' });
  syncPageTasks(pageId, u.wsId, new Set([t.id]));
  assert.equal(getTask(t.id)!.pageId, pageId);
});

test('deleting a page keeps its tasks as standalone tasks', async () => {
  const u = await app.signUp('PageDel');
  const { pageId } = await makePage(u, u.wsId);
  const t = (await create(u, u.wsId, { title: 'Survivor', pageId })).data;
  assert.equal((await app.call('DELETE', `/pages/${pageId}`, u.token)).status, 200);
  const after = (await list(u, u.wsId)).data.find((x) => x.id === t.id);
  assert.ok(after, 'task still exists');
  assert.equal(after!.pageId, null);
});

// ───────────── Live events ─────────────

function listen(token: string) {
  const ws = new WebSocket(`${app.wsOrigin}/api/events`, ['noteapp.v1', `bearer.${token}`]);
  const events: ServerEvent[] = [];
  ws.on('message', (d) => events.push(JSON.parse(String(d))));
  const opened = new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  async function waitFor(pred: (e: ServerEvent) => boolean, ms = 2000): Promise<ServerEvent> {
    const start = Date.now();
    for (;;) {
      const e = events.find(pred);
      if (e) return e;
      if (Date.now() - start > ms) throw new Error('timed out waiting for event');
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  return { opened, events, waitFor, close: () => ws.close() };
}

test('task changes are pushed live to other members; hidden tasks arrive as task-deleted', async () => {
  const { owner, other, wsId } = await team('member');
  const sock = listen(other.token);
  await sock.opened;
  try {
    const t = (await create(owner, wsId, { title: 'Live' })).data;
    await sock.waitFor((e) => e.type === 'task' && e.task.id === t.id);
    await app.call('PATCH', `/tasks/${t.id}`, owner.token, { priority: 1 });
    await sock.waitFor((e) => e.type === 'task' && e.task.id === t.id && e.task.priority === 1);
    await app.call('DELETE', `/tasks/${t.id}`, owner.token);
    await sock.waitFor((e) => e.type === 'task-deleted' && e.id === t.id);

    const { pageId } = await makePage(owner, wsId, 'private');
    const p = (await create(owner, wsId, { title: 'Private live', pageId })).data;
    await sock.waitFor((e) => e.type === 'task-deleted' && e.id === p.id);
    assert.ok(!sock.events.some((e) => e.type === 'task' && e.task.id === p.id), 'private task contents never leak');
  } finally {
    sock.close();
  }
});

test('reconcile through the collab socket: removing a taskRef detaches it, adding one links it', async () => {
  const u = await app.signUp('Collab');
  const Y = await import('yjs');
  const { WebsocketProvider } = await import('y-websocket');
  const { seedPageDoc, flushAll } = await import('../server/collab.ts');
  const { getTask } = await import('../server/tasks.ts');
  const { pageId } = await makePage(u, u.wsId);
  const inNote = (await create(u, u.wsId, { title: 'In note', pageId })).data;
  const loose = (await create(u, u.wsId, { title: 'Loose' })).data;
  seedPageDoc(pageId, (frag) => {
    const ref = new Y.XmlElement('taskRef');
    ref.setAttribute('taskId', inNote.id);
    frag.insert(0, [ref]);
  });

  const token = u.token;
  class AuthedWS extends WebSocket {
    constructor(url: string) {
      super(url, ['noteapp.v1', `bearer.${token}`]);
    }
  }
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`${app.wsOrigin}/collab`, pageId, doc, {
    WebSocketPolyfill: AuthedWS as unknown as typeof globalThis.WebSocket,
    disableBc: true,
  });
  try {
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('collab sync timed out')), 3000);
      provider.once('sync', () => (clearTimeout(t), res()));
    });
    const { mainFragment } = await import('../shared/pageDoc.ts');
    const frag = mainFragment(doc); // seeded pages are canvases: the content is in their one box
    assert.equal((frag.get(0) as InstanceType<typeof Y.XmlElement>).getAttribute('taskId'), inNote.id);
    doc.transact(() => {
      frag.delete(0, 1);
      const ref = new Y.XmlElement('taskRef');
      ref.setAttribute('taskId', loose.id);
      frag.insert(0, [ref]);
    });
    // Wait for the server to receive the update, then save without waiting for the debounce.
    for (let i = 0; i < 50 && getTask(loose.id)!.pageId !== pageId; i++) {
      await new Promise((r) => setTimeout(r, 20));
      flushAll();
    }
    assert.equal(getTask(loose.id)!.pageId, pageId, 'task added to the note is linked to it');
    assert.equal(getTask(inNote.id)!.pageId, null, 'task removed from the note becomes standalone');
  } finally {
    const sock = provider.ws as unknown as WebSocket | null;
    provider.destroy();
    provider.awareness.destroy(); // its check interval would keep the test process alive
    doc.destroy();
    if (sock && sock.readyState !== WebSocket.CLOSED) await new Promise((r) => sock.once('close', r));
  }
});

test('tasks expose parentId (migration 007); top-level tasks have none', async () => {
  const u = await app.signUp('Parent');
  const t = (await create(u, u.wsId, { title: 'Top' })).data;
  assert.equal(t.parentId, null);
  const { db } = await import('../server/db.ts');
  const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks'").all() as { name: string }[]).map((r) => r.name);
  assert.ok(idx.includes('tasks_parent') && idx.includes('tasks_ws_completed'));
});

// ───────────── Subtasks ─────────────

test('subtasks: one level, follow the parent’s note, deleted with the parent', async () => {
  const u = await app.signUp('Subber');
  const { syncPageTasks, getTask } = await import('../server/tasks.ts');
  const p1 = (await makePage(u, u.wsId)).pageId;
  const p2 = (await makePage(u, u.wsId)).pageId;
  const parent = (await create(u, u.wsId, { title: 'Parent', pageId: p1 })).data;
  const child = (await create(u, u.wsId, { title: 'Child', parentId: parent.id, pageId: p2 })).data;
  assert.equal(child.parentId, parent.id);
  assert.equal(child.pageId, p1, 'a subtask lives in its parent’s note, whatever the client sent');

  assert.equal((await create(u, u.wsId, { title: 'Grandchild', parentId: child.id })).status, 400, 'one level only');
  assert.equal((await app.call('PATCH', `/tasks/${parent.id}`, u.token, { parentId: parent.id })).status, 400);
  const other = (await create(u, u.wsId, { title: 'Other' })).data;
  assert.equal((await app.call('PATCH', `/tasks/${parent.id}`, u.token, { parentId: other.id })).status, 400, 'a parent cannot become a subtask');
  assert.equal((await app.call('PATCH', `/tasks/${child.id}`, u.token, { pageId: p2 })).status, 400, 'a subtask cannot leave its parent’s note');

  // Saving p1 (which embeds only the parent) must not detach the subtask.
  syncPageTasks(p1, u.wsId, new Set([parent.id]));
  assert.equal(getTask(child.id)!.pageId, p1);
  // Moving the parent to p2 moves the subtask too.
  syncPageTasks(p2, u.wsId, new Set([parent.id]));
  syncPageTasks(p1, u.wsId, new Set());
  assert.equal(getTask(parent.id)!.pageId, p2);
  assert.equal(getTask(child.id)!.pageId, p2);

  // Promote back to a top-level standalone task.
  const promoted = await app.call<Task>('PATCH', `/tasks/${child.id}`, u.token, { parentId: null });
  assert.equal(promoted.data.parentId, null);
  assert.equal(promoted.data.pageId, null);
  // Re-parent onto `other`, then delete `other`: the subtask goes with it.
  assert.equal((await app.call<Task>('PATCH', `/tasks/${child.id}`, u.token, { parentId: other.id })).data.parentId, other.id);
  assert.equal((await app.call('DELETE', `/tasks/${other.id}`, u.token)).status, 200);
  assert.equal(getTask(child.id), null);
});

test('subtasks of a private-notebook task are as private as their parent', async () => {
  const { owner, other, wsId } = await team('member');
  const { pageId } = await makePage(owner, wsId, 'private');
  const parent = (await create(owner, wsId, { title: 'Secret parent', pageId })).data;
  const child = (await create(owner, wsId, { title: 'Secret child', parentId: parent.id })).data;
  const seen = (await list(other, wsId)).data.map((t) => t.id);
  assert.ok(!seen.includes(parent.id) && !seen.includes(child.id));
  assert.equal((await create(other, wsId, { title: 'Sneaky', parentId: parent.id })).status, 400, 'cannot attach to an invisible parent');
});

test('completion history of a recurring private-note task stays private', async () => {
  const { owner, other, wsId } = await team('member');
  const { pageId } = await makePage(owner, wsId, 'private');
  const t = (await create(owner, wsId, { title: 'Secret recurring', pageId, dueDate: '2026-11-05', recurrence: { freq: 'week', interval: 1 } })).data;
  assert.equal((await app.call('PATCH', `/tasks/${t.id}`, owner.token, { status: 'done' })).status, 200);
  const mine = (await app.call<Task[]>('GET', `/workspaces/${wsId}/tasks/completed`, owner.token)).data;
  const history = mine.find((x) => x.title === 'Secret recurring' && x.status === 'done');
  assert.ok(history, 'the owner sees the completed occurrence');
  assert.equal(history!.pageId, pageId, 'history keeps the note');
  for (const path of [`/workspaces/${wsId}/tasks`, `/workspaces/${wsId}/tasks/completed`]) {
    const seen = (await app.call<Task[]>('GET', path, other.token)).data;
    assert.ok(!seen.some((x) => x.title === 'Secret recurring'), `hidden from other members in ${path}`);
  }
  // Reconciling the note doesn't detach the history row (it isn't embedded).
  const { syncPageTasks, getTask } = await import('../server/tasks.ts');
  syncPageTasks(pageId, wsId, new Set([t.id]));
  assert.equal(getTask(history!.id)!.pageId, pageId);
});

test('subtasks need edit access to the parent’s note; recurring parents reopen their subtasks', async () => {
  const { owner, other, wsId } = await team('member');
  const { pageId } = await makePage(owner, wsId, 'private');
  const assigned = (await create(owner, wsId, { title: 'Yours, in my private note', pageId, assigneeId: other.user.id })).data;
  assert.equal((await create(other, wsId, { title: 'Sneaky sub', parentId: assigned.id })).status, 400, 'same rule as a top-level task in that note');
  assert.equal((await create(owner, wsId, { title: 'Owner sub', parentId: assigned.id })).status, 200);

  const parent = (await create(owner, wsId, { title: 'Weekly review', dueDate: '2026-11-05', recurrence: { freq: 'week', interval: 1 } })).data;
  const sub = (await create(owner, wsId, { title: 'Collect numbers', parentId: parent.id })).data;
  await app.call('PATCH', `/tasks/${sub.id}`, owner.token, { status: 'done' });
  const rolled = (await app.call<Task>('PATCH', `/tasks/${parent.id}`, owner.token, { status: 'done' })).data;
  assert.equal(rolled.status, 'open');
  assert.ok(rolled.dueDate! > '2026-11-05');
  const { getTask } = await import('../server/tasks.ts');
  assert.equal(getTask(sub.id)!.status, 'open', 'subtask reopened for the next occurrence');
  assert.equal(getTask(sub.id)!.completedAt, null);
});

// ───────────── Private tasks that leave their note (migration 010) ─────────────

test('deleting a private page keeps its tasks, subtasks and history private', async () => {
  const { owner, other, wsId } = await team('member');
  const third = await app.signUp('Third');
  await app.call('POST', `/workspaces/${wsId}/members`, owner.token, { email: third.user.email, role: 'member' });
  const { pageId } = await makePage(owner, wsId, 'private');
  const plain = (await create(owner, wsId, { title: 'Private plain', pageId })).data;
  const forOther = (await create(owner, wsId, { title: 'Private for other', pageId, assigneeId: other.user.id })).data;
  const sub = (await create(owner, wsId, { title: 'Private sub', parentId: plain.id })).data;
  const rec = (await create(owner, wsId, { title: 'Private weekly', pageId, dueDate: '2026-11-05', recurrence: { freq: 'week', interval: 1 } })).data;
  await app.call('PATCH', `/tasks/${rec.id}`, owner.token, { status: 'done' }); // creates a history row

  assert.equal((await app.call('DELETE', `/pages/${pageId}`, owner.token)).status, 200);

  const titles = async (u: TestUser) => {
    const open = (await list(u, wsId)).data;
    const done = (await app.call<Task[]>('GET', `/workspaces/${wsId}/tasks/completed`, u.token)).data;
    return new Set([...open, ...done].map((t) => t.title));
  };
  const mine = await titles(owner);
  for (const t of ['Private plain', 'Private for other', 'Private sub', 'Private weekly']) assert.ok(mine.has(t), `creator still sees ${t}`);
  const theirs = await titles(other);
  assert.ok(theirs.has('Private for other'), 'the assignee still sees their task');
  for (const t of ['Private plain', 'Private sub', 'Private weekly']) assert.ok(!theirs.has(t), `${t} stays hidden from other members`);
  const third_ = await titles(third);
  assert.equal([...third_].filter((t) => t.startsWith('Private')).length, 0);

  // Still standalone (not deleted), and still editable by the creator.
  const after = (await list(owner, wsId)).data.find((t) => t.id === plain.id)!;
  assert.equal(after.pageId, null);
  assert.equal((await app.call('PATCH', `/tasks/${sub.id}`, other.token, { title: 'x' })).status, 404);
  assert.equal((await app.call('PATCH', `/tasks/${forOther.id}`, other.token, { status: 'done' })).status, 200);
});

test('removing a task from a private note keeps it private; putting it in a shared note makes it visible', async () => {
  const { owner, other, wsId } = await team('member');
  const { syncPageTasks } = await import('../server/tasks.ts');
  const priv = (await makePage(owner, wsId, 'private')).pageId;
  const shared = (await makePage(owner, wsId, 'shared')).pageId;
  const t = (await create(owner, wsId, { title: 'Was private', pageId: priv })).data;
  syncPageTasks(priv, wsId, new Set()); // the taskRef was deleted from the note
  assert.ok(!(await list(other, wsId)).data.some((x) => x.id === t.id), 'stays hidden after leaving the private note');
  // A new subtask of a private standalone task is private too.
  const sub = (await create(owner, wsId, { title: 'Sub of private', parentId: t.id })).data;
  assert.ok(!(await list(other, wsId)).data.some((x) => x.id === sub.id));
  // Pasting it into a shared note is a deliberate share: visible again, subtasks included.
  syncPageTasks(shared, wsId, new Set([t.id]));
  const seen = (await list(other, wsId)).data.map((x) => x.id);
  assert.ok(seen.includes(t.id) && seen.includes(sub.id));
});

test('tasks from a deleted shared page are still visible to everyone', async () => {
  const { owner, other, wsId } = await team('member');
  const { pageId } = await makePage(owner, wsId, 'shared');
  const t = (await create(owner, wsId, { title: 'Was shared', pageId })).data;
  await app.call('DELETE', `/pages/${pageId}`, owner.token);
  assert.ok((await list(other, wsId)).data.some((x) => x.id === t.id));
});

test('history of a private standalone recurring task (one that left its private note) stays private', async () => {
  const { owner, other, wsId } = await team('member');
  const { syncPageTasks } = await import('../server/tasks.ts');
  const { pageId } = await makePage(owner, wsId, 'private');
  const t = (await create(owner, wsId, { title: 'Private daily', pageId, dueDate: '2026-11-05', recurrence: { freq: 'day', interval: 1 } })).data;
  syncPageTasks(pageId, wsId, new Set()); // removed from the note: now private standalone
  await app.call('PATCH', `/tasks/${t.id}`, owner.token, { status: 'done' });
  await app.call('PATCH', `/tasks/${t.id}`, owner.token, { status: 'done' });
  const own = (await app.call<Task[]>('GET', `/workspaces/${wsId}/tasks/completed`, owner.token)).data.filter((x) => x.title === 'Private daily');
  assert.equal(own.length, 2, 'the owner sees both completed occurrences');
  for (const path of [`/workspaces/${wsId}/tasks`, `/workspaces/${wsId}/tasks/completed`]) {
    const seen = (await app.call<Task[]>('GET', path, other.token)).data;
    assert.ok(!seen.some((x) => x.title === 'Private daily'), `no leak in ${path}`);
  }
});
