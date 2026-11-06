// Account deletion: DELETE /auth/account, GET /auth/account/deletion-preview and deleteAccount().
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';

let app: TestApp;
before(async () => {
  process.env.ADMIN_EMAILS = 'site-admin@example.com';
  app = await startTestApp();
});
const sockets: WebSocket[] = [];
after(() => {
  sockets.forEach((s) => s.terminate());
  return app.close();
});

const PW = 'password123';
const dbm = () => import('../server/db.ts');
const closeCode = (ws: WebSocket) => new Promise<number>((r) => ws.once('close', (c) => r(c)));
const firstMessage = (ws: WebSocket) => new Promise((r) => ws.once('message', r));

async function upload(token: string, ws: string, pageId: string | null, body = 'hello') {
  const r = await fetch(`${app.origin}/api/workspaces/${ws}/files${pageId ? `?pageId=${pageId}` : ''}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain', 'x-filename': 'note.txt' },
    body,
  });
  const data = (await r.json()) as { id: string };
  const { db } = await dbm();
  const row = db.prepare('SELECT id, ext FROM files WHERE id = ?').get(data.id) as { id: string; ext: string };
  const { FILES_DIR } = await import('../server/config.ts');
  return { id: row.id, file: path.join(FILES_DIR, row.id + row.ext) };
}

async function notebook(token: string, ws: string, visibility: 'shared' | 'private', name = 'NB') {
  const nb = (await app.call('POST', `/workspaces/${ws}/notebooks`, token, { name, visibility })).data.id as string;
  const sec = (await app.call('POST', `/notebooks/${nb}/sections`, token, { name: 'Sec' })).data.id as string;
  const page = (await app.call('POST', `/sections/${sec}/pages`, token, { title: `Page in ${name}` })).data.id as string;
  return { nb, sec, page };
}

const count = async (sql: string, ...args: unknown[]) => {
  const { db } = await dbm();
  return (db.prepare(sql).get(...args) as { n: number }).n;
};

async function members(token: string, ws: string) {
  return (await app.call<{ members: { id: string; role: string }[] }>('GET', `/workspaces/${ws}/members`, token)).data.members;
}

test('deleting an account: workspaces, notebooks, files, sockets, integrity and other users', async () => {
  const { db } = await dbm();
  const alice = await app.signUp('Alice');
  const bob = await app.signUp('Bob');
  const carol = await app.signUp('Carol');
  const dave = await app.signUp('Dave');
  const add = (ws: string, token: string, u: TestUser, role: string) => app.call('POST', `/workspaces/${ws}/members`, token, { email: u.user.email, role });

  // A: alice owns, bob is an admin (joined first), carol is a member -> bob becomes owner.
  const A = alice.wsId;
  await add(A, alice.token, bob, 'admin');
  await add(A, alice.token, carol, 'member');
  const aShared = await notebook(alice.token, A, 'shared', 'A shared');
  const aTask = (await app.call('POST', `/workspaces/${A}/tasks`, alice.token, { title: 'Assigned to Alice', pageId: aShared.page, assigneeId: alice.user.id })).data.id as string;
  const aDone = (await app.call('POST', `/workspaces/${A}/tasks`, bob.token, { title: 'Bob made, Alice finished', pageId: aShared.page })).data.id as string;
  await app.call('PATCH', `/tasks/${aDone}`, alice.token, { status: 'done' });
  const aFile = await upload(alice.token, A, aShared.page, 'shared file');
  const thread = (await app.call('POST', `/pages/${aShared.page}/comments`, alice.token, { threadId: crypto.randomUUID(), quote: 'q', body: 'Alice says hi' })).data;
  await app.call('POST', `/comment-threads/${thread.id}/replies`, bob.token, { body: "Bob replies" });
  // Alice's private notebook in A, shared with carol, with a file, a task and a comment.
  const aPriv = await notebook(alice.token, A, 'private', 'A private');
  const privTask = (await app.call('POST', `/workspaces/${A}/tasks`, alice.token, { title: 'Private page task', pageId: aPriv.page })).data.id as string;
  const privFile = await upload(alice.token, A, aPriv.page, 'private file');
  await app.call('PUT', `/notebooks/${aPriv.nb}/shares`, alice.token, { userIds: [carol.user.id] });
  // A standalone task only Alice can see.
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, description, status, priority, created_by, private_owner_only, created_at, updated_at)
     VALUES ('own-private-task', ?, 'Only Alice', '', 'open', 4, ?, 1, ?, ?)`,
  ).run(A, alice.user.id, new Date().toISOString(), new Date().toISOString());

  // B: alice owns, carol member, dave viewer, nobody to hand over to -> deleted with its files.
  const B = (await app.call('POST', '/workspaces', alice.token, { name: 'B plain members' })).data.id as string;
  await add(B, alice.token, carol, 'member');
  await add(B, alice.token, dave, 'viewer');
  const bNb = await notebook(alice.token, B, 'shared', 'B shared');
  const bFile = await upload(alice.token, B, bNb.page, 'b file');

  // C: bob owns, alice is a member with a shared page of her own and an assigned task.
  const C = bob.wsId;
  await add(C, bob.token, alice, 'member');
  await add(C, bob.token, carol, 'member');
  const cShared = await notebook(alice.token, C, 'shared', 'C shared by Alice');
  const cTask = (await app.call('POST', `/workspaces/${C}/tasks`, bob.token, { title: 'Bob task for Alice', pageId: cShared.page, assigneeId: alice.user.id })).data.id as string;
  const cTaskByAlice = (await app.call('POST', `/workspaces/${C}/tasks`, alice.token, { title: 'Alice task in shared page', pageId: cShared.page })).data.id as string;
  const cPriv = await notebook(alice.token, C, 'private', 'C private');
  const cPrivFile = await upload(alice.token, C, cPriv.page, 'c private');
  const cFile = await upload(alice.token, C, cShared.page, 'c shared');
  // Pending invites: one addressed to alice's email by bob, one alice sent.
  db.prepare("INSERT INTO workspace_invites (workspace_id, email, role, invited_by, created_at) VALUES (?, ?, 'member', ?, ?)").run(C, alice.user.email, bob.user.id, new Date().toISOString());
  db.prepare("INSERT INTO workspace_invites (workspace_id, email, role, invited_by, created_at) VALUES (?, 'x-by-alice@example.com', 'member', ?, ?)").run(C, alice.user.id, new Date().toISOString());

  // D: two owners -> the other keeps it.
  const D = (await app.call('POST', '/workspaces', alice.token, { name: 'D co-owned' })).data.id as string;
  await add(D, alice.token, bob, 'owner');

  // Alice's personal workspace is A. Notification/push rows for alice exist too.
  db.prepare("INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES ('ps1', ?, 'https://push.example/1', 'k', 'a', ?)").run(alice.user.id, new Date().toISOString());

  // Other users' data to compare afterwards.
  const carolBefore = (await app.call('GET', `/workspaces/${carol.wsId}/tree`, carol.token)).data;
  const bobNotifications = await count('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?', bob.user.id);

  // Sockets: alice's events and a collab socket on a page of C that stays.
  const events = new WebSocket(`${app.wsOrigin}/api/events`, ['noteapp.v1', `bearer.${alice.token}`]);
  sockets.push(events);
  await firstMessage(events);
  const collab = new WebSocket(`${app.wsOrigin}/collab/${cShared.page}`, ['noteapp.v1', `bearer.${alice.token}`]);
  sockets.push(collab);
  await firstMessage(collab);
  const eventsClosed = closeCode(events);
  const collabClosed = closeCode(collab);
  const bobEvents = new WebSocket(`${app.wsOrigin}/api/events`, ['noteapp.v1', `bearer.${bob.token}`]);
  sockets.push(bobEvents);
  await firstMessage(bobEvents);
  const seen: string[] = [];
  bobEvents.on('message', (m) => seen.push(String(m)));

  // Preview.
  const preview = await app.call('GET', '/auth/account/deletion-preview', alice.token);
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.data.deletedWorkspaces.map((w: { id: string }) => w.id).sort(), [B].sort());
  assert.deepEqual(preview.data.transferredWorkspaces.map((w: { id: string }) => w.id), [A]);
  assert.equal(preview.data.transferredWorkspaces[0].newOwnerName, 'Bob');
  assert.deepEqual(preview.data.sharedOwnership.map((w: { id: string }) => w.id), [D]);
  assert.deepEqual(preview.data.leftWorkspaces.map((w: { id: string }) => w.id), [C]);
  assert.equal(preview.data.privateNotebooks, 2);

  // Wrong password and a missing body: 401, nothing deleted.
  const wrong = await app.call('DELETE', '/auth/account', alice.token, { password: 'not-my-password' });
  assert.equal(wrong.status, 401);
  assert.equal((await app.call('DELETE', '/auth/account', alice.token, {})).status, 401);
  assert.equal(await count('SELECT COUNT(*) AS n FROM users WHERE id = ?', alice.user.id), 1);
  assert.equal(fs.existsSync(privFile.file), true);
  assert.equal((await app.call('GET', '/me', alice.token)).status, 200);

  // The real thing.
  const outbox: unknown[] = [];
  const { setMailTransport } = await import('../server/mail.ts');
  const nodemailer = (await import('nodemailer')).default;
  const t = nodemailer.createTransport({ jsonTransport: true });
  const origSend = t.sendMail.bind(t);
  t.sendMail = ((m: unknown) => (outbox.push(m), origSend(m as never))) as typeof t.sendMail;
  setMailTransport(t);
  let r;
  try {
    r = await app.call('DELETE', '/auth/account', alice.token, { password: PW });
  } finally {
    setMailTransport(undefined);
  }
  assert.equal(r.status, 200);
  assert.equal(outbox.length, 0, 'deleting an account sends no email');

  // Gone: user, sessions, push subscription, login.
  assert.equal(await count('SELECT COUNT(*) AS n FROM users WHERE id = ?', alice.user.id), 0);
  assert.equal(await count('SELECT COUNT(*) AS n FROM refresh_tokens WHERE user_id = ?', alice.user.id), 0);
  assert.equal(await count('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', alice.user.id), 0);
  assert.equal((await app.call('GET', '/me', alice.token)).status, 401);
  assert.equal((await app.call('POST', '/auth/login', undefined, { email: alice.user.email, password: PW })).status, 401);
  assert.equal((await app.call('POST', '/auth/refresh', undefined, { refreshToken: alice.refreshToken })).status, 401);
  assert.equal((await app.call('POST', '/auth/login', undefined, { email: 'deleted-user@invalid.invalid', password: '!' })).status, 401);

  // Sockets closed.
  assert.equal(await eventsClosed, 4401);
  assert.equal(await collabClosed, 4401);

  // A: ownership went to bob (the admin), the workspace and carol's membership survive; alice's shared page stays.
  const aMembers = await members(bob.token, A);
  assert.equal(aMembers.find((m) => m.id === bob.user.id)?.role, 'owner');
  assert.equal(aMembers.some((m) => m.id === alice.user.id), false);
  assert.equal(await count('SELECT COUNT(*) AS n FROM pages WHERE id = ?', aShared.page), 1);
  assert.equal(await count('SELECT COUNT(*) AS n FROM workspaces WHERE id = ?', A), 1);
  assert.equal(await count('SELECT COUNT(*) AS n FROM files WHERE id = ?', aFile.id), 1);
  assert.equal(fs.existsSync(aFile.file), true, 'files in shared notebooks stay');
  const pageRow = db.prepare('SELECT created_by, updated_by FROM pages WHERE id = ?').get(aShared.page) as { created_by: string };
  assert.equal(pageRow.created_by, 'deleted-user');
  const t1 = db.prepare('SELECT assignee_id, created_by FROM tasks WHERE id = ?').get(aTask) as { assignee_id: string | null; created_by: string };
  assert.deepEqual(t1, { assignee_id: null, created_by: 'deleted-user' });
  const t2 = db.prepare('SELECT completed_by, created_by FROM tasks WHERE id = ?').get(aDone) as { completed_by: string; created_by: string };
  assert.deepEqual(t2, { completed_by: 'deleted-user', created_by: bob.user.id });
  assert.equal(await count("SELECT COUNT(*) AS n FROM comments WHERE author_id = 'deleted-user' AND body = 'Alice says hi'"), 1);
  assert.equal(await count('SELECT COUNT(*) AS n FROM comment_threads WHERE id = ?', thread.id), 1);
  // Alice's private notebook in A: gone from the DB and the disk, with its tasks and files.
  assert.equal(await count('SELECT COUNT(*) AS n FROM notebooks WHERE id = ?', aPriv.nb), 0);
  assert.equal(await count('SELECT COUNT(*) AS n FROM pages WHERE id = ?', aPriv.page), 0);
  assert.equal(await count('SELECT COUNT(*) AS n FROM tasks WHERE id IN (?, ?)', privTask, 'own-private-task'), 0);
  assert.equal(await count('SELECT COUNT(*) AS n FROM files WHERE id = ?', privFile.id), 0);
  assert.equal(await count('SELECT COUNT(*) AS n FROM pages_fts WHERE page_id = ?', aPriv.page), 0);
  assert.equal(fs.existsSync(privFile.file), false);
  assert.equal(await count('SELECT COUNT(*) AS n FROM notebook_shares WHERE notebook_id = ?', aPriv.nb), 0);

  // B: deleted with its content and file bytes.
  assert.equal(await count('SELECT COUNT(*) AS n FROM workspaces WHERE id = ?', B), 0);
  assert.equal(await count('SELECT COUNT(*) AS n FROM notebooks WHERE workspace_id = ?', B), 0);
  assert.equal(await count('SELECT COUNT(*) AS n FROM files WHERE id = ?', bFile.id), 0);
  assert.equal(fs.existsSync(bFile.file), false);
  assert.equal(await count('SELECT COUNT(*) AS n FROM pages_fts WHERE page_id = ?', bNb.page), 0);
  assert.equal(((await app.call('GET', '/workspaces', carol.token)).data as { id: string }[]).some((w) => w.id === B), false);

  // C: alice is removed; her shared notebook and page stay; her private one and its file are gone.
  assert.equal((await members(bob.token, C)).some((m) => m.id === alice.user.id), false);
  assert.equal(await count('SELECT COUNT(*) AS n FROM notebooks WHERE id = ?', cShared.nb), 1);
  assert.equal((db.prepare('SELECT created_by FROM notebooks WHERE id = ?').get(cShared.nb) as { created_by: string }).created_by, 'deleted-user');
  assert.equal(await count('SELECT COUNT(*) AS n FROM notebooks WHERE id = ?', cPriv.nb), 0);
  assert.equal(fs.existsSync(cPrivFile.file), false);
  assert.equal(fs.existsSync(cFile.file), true);
  assert.equal((db.prepare('SELECT assignee_id FROM tasks WHERE id = ?').get(cTask) as { assignee_id: string | null }).assignee_id, null);
  assert.equal(await count('SELECT COUNT(*) AS n FROM tasks WHERE id = ?', cTaskByAlice), 1);
  // Invites: the one to alice's email and the one alice sent are gone.
  assert.equal(await count('SELECT COUNT(*) AS n FROM workspace_invites WHERE email = ? OR invited_by = ?', alice.user.email, alice.user.id), 0);
  // D: the co-owner carries on.
  assert.equal((await members(bob.token, D)).find((m) => m.id === bob.user.id)?.role, 'owner');

  // Integrity, and other people's data untouched.
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal((db.pragma('foreign_keys', { simple: true }) as number), 1);
  assert.deepEqual((await app.call('GET', `/workspaces/${carol.wsId}/tree`, carol.token)).data, carolBefore);
  assert.equal(await count('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?', bob.user.id) >= bobNotifications - 0, true);
  assert.equal((await app.call('GET', '/me', bob.token)).status, 200);
  assert.equal(await count('SELECT COUNT(*) AS n FROM users WHERE id = ?', dave.user.id), 1);

  // Bob heard that membership changed.
  await new Promise((res) => setTimeout(res, 100));
  assert.ok(seen.some((m) => JSON.parse(m).type === 'members'), `bob should get a members event, got ${seen.join(' ')}`);
  bobEvents.close();

  // The deleted user is not counted as an account (bootstrap checks, admin stats).
  assert.equal(await count("SELECT COUNT(*) AS n FROM users WHERE id <> 'deleted-user'") > 0, true);
});

test('every foreign key to users is either cascading/nulling or handled by deleteAccount', async () => {
  const { db } = await dbm();
  const { USER_FK_DECISIONS } = await import('../server/accounts.ts');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  const handled = new Set(USER_FK_DECISIONS.map((d) => `${d.table}.${d.column}`));
  const blocking: string[] = [];
  for (const { name } of tables) {
    for (const fk of db.pragma(`foreign_key_list(${name})`) as { table: string; from: string; on_delete: string }[]) {
      if (fk.table !== 'users') continue;
      if (fk.on_delete === 'CASCADE' || fk.on_delete === 'SET NULL') {
        assert.equal(handled.has(`${name}.${fk.from}`), false, `${name}.${fk.from} cascades; it doesn't belong in USER_FK_DECISIONS`);
      } else blocking.push(`${name}.${fk.from}`);
    }
  }
  assert.deepEqual(blocking.sort(), [...handled].sort(), 'a table gained a foreign key to users: decide what deleteAccount does with it (and document it in ARCHITECTURE.md)');
});

test('deleteAccount() is reusable: no password, false for unknown ids and for the stand-in user', async () => {
  const { deleteAccount } = await import('../server/accounts.ts');
  const { db } = await dbm();
  const u = await app.signUp('Solo');
  assert.equal(deleteAccount(u.user.id), true);
  assert.equal(deleteAccount(u.user.id), false, 'already gone');
  assert.equal(deleteAccount('deleted-user'), false, 'the stand-in is not an account');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('unauthenticated requests are refused', async () => {
  assert.equal((await app.call('DELETE', '/auth/account', undefined, { password: PW })).status, 401);
  assert.equal((await app.call('GET', '/auth/account/deletion-preview')).status, 401);
});

test('wrong passwords are rate limited per user', async () => {
  const { resetRateLimits } = await import('../server/ratelimit.ts');
  resetRateLimits();
  const u = await app.signUp('Guesser');
  const codes: number[] = [];
  for (let i = 0; i < 7; i++) codes.push((await app.call('DELETE', '/auth/account', u.token, { password: 'nope-nope-nope' })).status);
  assert.deepEqual(codes.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.equal(codes[6], 429);
  resetRateLimits();
});
