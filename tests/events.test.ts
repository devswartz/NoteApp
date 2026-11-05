// The /api/events channel: delivery, per-user filtering, and catch-up after a reconnect.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import WS from 'ws';
import crypto from 'node:crypto';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';
import { waitFor } from './helpers/collab.ts';
import type { EventMessage } from '../shared/types.ts';

let app: TestApp;
const sockets: WS[] = [];
before(async () => {
  app = await startTestApp();
});
after(async () => {
  for (const s of sockets) s.terminate();
  await app.close();
});

interface Listener {
  ws: WS;
  msgs: EventMessage[];
  closed: Promise<number>;
  hello: () => { boot: string; seq: number } | undefined;
}
function listen(u: TestUser | string, since?: string): Promise<Listener> {
  const token = typeof u === 'string' ? u : u.token;
  const ws = new WS(`${app.wsOrigin}/api/events${since ? `?since=${since}` : ''}`, ['noteapp.v1', `bearer.${token}`]);
  sockets.push(ws);
  const msgs: EventMessage[] = [];
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  const l: Listener = {
    ws,
    msgs,
    closed,
    hello: () => {
      const h = msgs.findLast((m) => m.type === 'hello');
      return h && h.type === 'hello' ? { boot: h.boot, seq: h.seq } : undefined;
    },
  };
  return new Promise((resolve) => {
    const t: ReturnType<typeof setInterval> = setInterval(() => {
      if (l.hello()) {
        clearInterval(t);
        resolve(l);
      }
    }, 5);
    ws.on('close', () => {
      clearInterval(t);
      resolve(l);
    });
  });
}
const cursorOf = (l: Listener) => `${l.hello()!.boot}:${l.hello()!.seq}`;
const taskEvents = (l: Listener) => l.msgs.filter((m) => m.type === 'task').map((m) => (m.type === 'task' ? m.task.title : ''));

async function team(names: string[]) {
  const [owner, ...others] = await Promise.all(names.map((n) => app.signUp(n)));
  for (const o of others) await app.call('POST', `/workspaces/${owner.wsId}/members`, owner.token, { email: o.user.email, role: 'member' });
  return { owner, others };
}

test('bad tokens are closed with 4401', async () => {
  const l = await listen('nope');
  assert.equal(await l.closed, 4401);
});

test('task and tree events reach other members live, with sequence numbers', async () => {
  const { owner, others } = await team(['Ada', 'Bo']);
  const b = await listen(others[0]);
  await app.call('POST', `/workspaces/${owner.wsId}/tasks`, owner.token, { title: 'live one' });
  await app.call('POST', `/workspaces/${owner.wsId}/notebooks`, owner.token, { name: 'New NB' });
  await waitFor(() => taskEvents(b).includes('live one') && b.msgs.some((m) => m.type === 'tree'), 2000, 'events');
  const seqs = b.msgs.filter((m) => m.type !== 'hello').map((m) => ('seq' in m ? m.seq : undefined));
  assert.ok(seqs.every((s) => typeof s === 'number'));
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x! - y!));
});

test('reconnecting with ?since= replays exactly what was missed', async () => {
  const { owner, others } = await team(['Cy', 'Di']);
  const first = await listen(others[0]);
  await app.call('POST', `/workspaces/${owner.wsId}/tasks`, owner.token, { title: 'before drop' });
  await waitFor(() => taskEvents(first).includes('before drop'));
  // Cursor = last seq seen.
  const last = Math.max(...first.msgs.map((m) => ('seq' in m && typeof m.seq === 'number' ? m.seq : 0)));
  const since = `${first.hello()!.boot}:${last}`;
  first.ws.terminate(); // network loss

  await app.call('POST', `/workspaces/${owner.wsId}/tasks`, owner.token, { title: 'while offline 1' });
  await app.call('POST', `/workspaces/${owner.wsId}/tasks`, owner.token, { title: 'while offline 2' });
  await app.call('PATCH', `/workspaces/${owner.wsId}/members/${others[0].user.id}`, owner.token, { role: 'viewer' });

  const again = await listen(others[0], since);
  assert.deepEqual(taskEvents(again), ['while offline 1', 'while offline 2']);
  assert.ok(again.msgs.some((m) => m.type === 'members'));
  assert.ok(again.msgs.some((m) => m.type === 'workspaces'), 'targeted events are replayed to their target');
  assert.equal(again.msgs.at(-1)!.type, 'hello', 'hello comes after the replay');
  assert.ok(!again.msgs.some((m) => m.type === 'resync'));

  // Nothing missed → nothing replayed.
  const third = await listen(others[0], cursorOf(again));
  assert.deepEqual(third.msgs.map((m) => m.type), ['hello']);
});

test('replay is filtered by current permissions; strangers get nothing', async () => {
  const { owner, others } = await team(['Ed', 'Flo']);
  const stranger = await app.signUp('Gia');
  const s0 = await listen(stranger);
  const f0 = await listen(others[0]);
  const since = cursorOf(f0);
  const sinceS = cursorOf(s0);
  f0.ws.terminate();
  s0.ws.terminate();

  // A private notebook task the member can't see.
  const nb = (await app.call('POST', `/workspaces/${owner.wsId}/notebooks`, owner.token, { name: 'Mine', visibility: 'private' })).data.id;
  const sec = (await app.call('POST', `/notebooks/${nb}/sections`, owner.token, { name: 's' })).data.id;
  const pg = (await app.call('POST', `/sections/${sec}/pages`, owner.token, { title: 'p' })).data.id;
  const t = (await app.call('POST', `/workspaces/${owner.wsId}/tasks`, owner.token, { title: 'secret', pageId: pg })).data.id;

  const f1 = await listen(others[0], since);
  assert.ok(!taskEvents(f1).includes('secret'));
  assert.ok(f1.msgs.some((m) => m.type === 'task-deleted' && m.id === t), 'invisible task arrives as task-deleted');
  const s1 = await listen(stranger, sinceS);
  assert.deepEqual(s1.msgs.map((m) => m.type), ['hello']);
});

test('an unknown boot id or a gap beyond the buffer gets a resync', async () => {
  const { others } = await team(['Hu', 'Ivy']);
  const a = await listen(others[0], 'otherboot:5');
  assert.deepEqual(a.msgs.map((m) => m.type), ['resync', 'hello']);
  const boot = a.hello()!.boot;
  const b = await listen(others[0], `${boot}:999999`);
  assert.deepEqual(b.msgs.map((m) => m.type), ['resync', 'hello']);
  // Push the buffer past its limit, then ask for seq 0.
  const { publish } = await import('../server/events.ts');
  for (let i = 0; i < 2100; i++) publish({ type: 'workspaces' }, { userIds: ['nobody'] });
  const c = await listen(others[0], `${boot}:0`);
  assert.deepEqual(c.msgs.map((m) => m.type), ['resync', 'hello']);
});

test('team endpoint: members with open, overdue and due-today counts (visible tasks only)', async () => {
  const { owner, others } = await team(['Jo', 'Kai']);
  const kai = others[0];
  const baseline = (await app.call('GET', `/workspaces/${owner.wsId}/team?today=2026-03-10`, owner.token)).data.find(
    (r: { id: string }) => r.id === owner.user.id,
  ).openTasks as number; // onboarding tasks
  const add = (title: string, extra: object, who = owner) => app.call('POST', `/workspaces/${owner.wsId}/tasks`, who.token, { title, ...extra });
  await add('k1', { assigneeId: kai.user.id, dueDate: '2026-01-01' });
  await add('k2', { assigneeId: kai.user.id, dueDate: '2026-03-10' });
  await add('k3', { assigneeId: kai.user.id });
  const done = (await add('k4', { assigneeId: kai.user.id })).data.id;
  await app.call('PATCH', `/tasks/${done}`, owner.token, { status: 'done' });
  await add('j1', { assigneeId: owner.user.id, dueDate: '2026-03-10' });
  // A task in Jo's private notebook assigned to Jo: Kai can't see it, so it isn't counted for Kai.
  const nb = (await app.call('POST', `/workspaces/${owner.wsId}/notebooks`, owner.token, { name: 'P', visibility: 'private' })).data.id;
  const sec = (await app.call('POST', `/notebooks/${nb}/sections`, owner.token, { name: 's' })).data.id;
  const pg = (await app.call('POST', `/sections/${sec}/pages`, owner.token, { title: 'p' })).data.id;
  await add('j-private', { assigneeId: owner.user.id, pageId: pg });

  const asJo = await app.call('GET', `/workspaces/${owner.wsId}/team?today=2026-03-10`, owner.token);
  assert.equal(asJo.status, 200);
  const row = (rows: { id: string }[], id: string) => rows.find((r) => r.id === id) as unknown as Record<string, unknown>;
  assert.deepEqual(
    (({ openTasks, overdueTasks, dueTodayTasks, role, name }) => ({ openTasks, overdueTasks, dueTodayTasks, role, name }))(row(asJo.data, kai.user.id) as never),
    { openTasks: 3, overdueTasks: 1, dueTodayTasks: 1, role: 'member', name: 'Kai' },
  );
  assert.equal(row(asJo.data, owner.user.id).openTasks, baseline + 2);
  const asKai = await app.call('GET', `/workspaces/${owner.wsId}/team?today=2026-03-10`, kai.token);
  assert.equal(row(asKai.data, owner.user.id).openTasks, baseline + 1, 'private task not counted for someone who cannot see it');
  const stranger = await app.signUp('Lee');
  assert.equal((await app.call('GET', `/workspaces/${owner.wsId}/team`, stranger.token)).status, 404);
});

test('replay withholds comment events on private pages and notifications meant for someone else', async () => {
  const { owner, others } = await team(['Mia', 'Ned']);
  const ned = others[0];
  const nb = (await app.call('POST', `/workspaces/${owner.wsId}/notebooks`, owner.token, { name: 'Private', visibility: 'private' })).data.id;
  const sec = (await app.call('POST', `/notebooks/${nb}/sections`, owner.token, { name: 's' })).data.id;
  const pg = (await app.call('POST', `/sections/${sec}/pages`, owner.token, { title: 'p' })).data.id;
  const n0 = await listen(ned);
  const o0 = await listen(owner);
  const nedSince = cursorOf(n0);
  const ownerSince = cursorOf(o0);
  n0.ws.terminate();
  o0.ws.terminate();

  await app.call('POST', `/pages/${pg}/comments`, owner.token, { threadId: crypto.randomUUID(), body: 'secret comment' });
  const { publish } = await import('../server/events.ts');
  const notification = { id: 'n1', kind: 'mention', workspaceId: owner.wsId, actorId: null, title: 'for the owner', body: '', link: null, data: null, createdAt: '', readAt: null } as const;
  publish({ type: 'notification', notification }, { userIds: [owner.user.id] });
  publish({ type: 'notification', notification }); // no recipients: delivered to nobody

  const n1 = await listen(ned, nedSince);
  assert.ok(!n1.msgs.some((m) => m.type === 'comments'), 'private comment event not replayed');
  assert.ok(!n1.msgs.some((m) => m.type === 'notification'), 'someone else’s notification not replayed');
  const o1 = await listen(owner, ownerSince);
  assert.ok(o1.msgs.some((m) => m.type === 'comments'), 'the owner gets the comment event on replay');
  assert.equal(o1.msgs.filter((m) => m.type === 'notification').length, 1, 'only the targeted notification');
});
