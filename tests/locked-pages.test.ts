// Locked pages (server/locks.ts): the gate on every route that serves content (a sweep over every registered GET
// route, like tests/authz-audit.test.ts), the collab and event sockets, the AI connector, the locked-notes password,
// unlocking and relocking, the rate limit, devices (biometrics) and the reset flow.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import WS from 'ws';
import * as Y from 'yjs';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';
import { collabClient, synced, waitFor } from './helpers/collab.ts';

// Markers: none may ever reach anyone but the owner, and the content ones not even the owner while locked.
const TITLE = 'Zqx Locked Diary';
const BODY = 'zqxsecretbody';
const TASK = 'zqxsecrettask';
const COMMENT = 'zqxsecretcomment';
const CONTENT = [BODY, TASK, COMMENT];
const LOCK_PW = 'diary-pass-1';

let app: TestApp;
let owner: TestUser, admin: TestUser, member: TestUser;
let ws: string, nb: string, sec: string, page: string, task: string, file: string, fileUrl: string, thread: string, comment: string, version: string;
const mcpTokens = new Map<string, { userId: string; scopes: string[]; clientId: string; clientName: string }>();

before(async () => {
  app = await startTestApp();
  const { setMcpTokenVerifier } = await import('../server/mcp/index.ts');
  setMcpTokenVerifier(async (t) => (mcpTokens.get(t) as never) ?? null);
  [owner, admin, member] = await Promise.all(['LkOwner', 'LkAdmin', 'LkMember'].map((n) => app.signUp(n)));
  ws = owner.wsId;
  await app.call('POST', `/workspaces/${ws}/members`, owner.token, { email: admin.user.email, role: 'admin' });
  await app.call('POST', `/workspaces/${ws}/members`, owner.token, { email: member.user.email, role: 'member' });
  const n = (await app.call('POST', `/workspaces/${ws}/notebooks`, owner.token, { name: 'Shared NB' })).data;
  nb = n.id;
  sec = n.sectionId;
  page = (await app.call('POST', `/sections/${sec}/pages`, owner.token, { title: TITLE })).data.id;
  const { seedPageDoc } = await import('../server/collab.ts');
  seedPageDoc(page, (frag) => {
    const p = new Y.XmlElement('paragraph');
    p.insert(0, [new Y.XmlText(`Dear diary ${BODY}`)]);
    frag.insert(0, [p]);
  });
  task = (await app.call('POST', `/workspaces/${ws}/tasks`, owner.token, { title: TASK, pageId: page, dueDate: '2030-01-02', description: TASK })).data.id;
  // The admin is assigned the task and comments on the page: they lose both when it is locked.
  await app.call('PATCH', `/tasks/${task}`, owner.token, { assigneeId: admin.user.id });
  const t = await app.call('POST', `/pages/${page}/comments`, admin.token, { threadId: crypto.randomUUID(), quote: BODY, body: `${COMMENT} @[LkOwner](${owner.user.id})` });
  thread = t.data.id;
  comment = t.data.comments[0].id;
  version = (await app.call('POST', `/pages/${page}/versions`, owner.token, {})).data.id;
  const up = await fetch(`${app.origin}/api/workspaces/${ws}/files?pageId=${page}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'text/plain', 'x-filename': `${BODY}.txt` },
    body: BODY,
  });
  const upJson = (await up.json()) as { id: string; url: string };
  file = upJson.id;
  fileUrl = upJson.url;
  // An edit page share for the member, so a share doesn't keep the page reachable either.
  await app.call('POST', `/pages/${page}/shares`, owner.token, { userId: member.user.id, canEdit: true });
});
after(() => app.close());

/** Every GET route on the real /api router. */
async function getRoutes(): Promise<string[]> {
  const { api } = await import('../server/routes/index.ts');
  type Layer = { route?: { path: string; methods: Record<string, boolean> }; handle?: { stack?: Layer[] } };
  const out: string[] = [];
  const walk = (stack: Layer[]) => {
    for (const layer of stack) {
      if (layer.route) {
        if (layer.route.methods.get) out.push(layer.route.path);
      } else if (layer.handle?.stack) walk(layer.handle.stack);
    }
  };
  walk((api as unknown as { stack: Layer[] }).stack);
  return out;
}

/** Fill a route's parameters with the fixture: the locked page and what hangs off it. */
function fill(route: string): string[] {
  const base = route
    .replace(/^\/workspaces\/:id/, `/workspaces/${ws}`)
    .replace(/^\/pages\/:id/, `/pages/${page}`)
    .replace(/^\/tasks\/:id/, `/tasks/${task}`)
    .replace(/^\/notebooks\/:id/, `/notebooks/${nb}`)
    .replace(/^\/sections\/:id/, `/sections/${sec}`)
    .replace(/^\/files\/:id/, `/files/${file}`)
    .replace(/^\/comment-threads\/:id/, `/comment-threads/${thread}`)
    .replace(/^\/comments\/:id/, `/comments/${comment}`)
    .replace(':vid', version)
    .replace(/:\w+/g, 'x');
  if (route === '/workspaces/:id/search') return [TITLE, BODY, TASK, 'zqx'].map((q) => `${base}?q=${encodeURIComponent(q)}`);
  return [base];
}

/** Everything a GET returns, as text (zip archives unpacked). */
async function fetchText(path: string, token: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${app.origin}/api${path}`, { headers: { authorization: `Bearer ${token}` } });
  const buf = Buffer.from(await res.arrayBuffer());
  if (res.headers.get('content-type')?.includes('zip')) {
    const { readZip } = await import('../server/zip.ts');
    return { status: res.status, text: (await readZip(buf)).map((e) => `${e.name}\n${e.data.toString('utf8')}`).join('\n') };
  }
  return { status: res.status, text: buf.toString('utf8') };
}

const lockedNotes = (u: TestUser, path: string, body?: unknown) => app.call('POST', `/locked-notes${path}`, u.token, body ?? {});

/** Sweep every GET route as `u`, failing on any of `forbidden`. */
async function sweep(u: TestUser, forbidden: string[], label: string) {
  const routes = await getRoutes();
  assert.ok(routes.length > 40, `found the routes (${routes.length})`);
  for (const r of routes) {
    for (const path of fill(r)) {
      const { text } = await fetchText(path, u.token);
      for (const f of forbidden) assert.ok(!text.toLowerCase().includes(f.toLowerCase()), `${label}: GET ${path} leaked "${f}"`);
    }
  }
}

test('locking needs a locked-notes password, and notebook-level edit access', async () => {
  const noPw = await app.call('POST', `/pages/${page}/lock`, owner.token);
  assert.equal(noPw.status, 409);
  assert.equal(noPw.data.code, 'no_lock_password');
  assert.equal((await lockedNotes(owner, '/password', { password: 'abc' })).status, 400, 'too short');
  const set = await lockedNotes(owner, '/password', { password: LOCK_PW });
  assert.equal(set.status, 200);
  assert.ok(set.data.expiresAt, 'choosing the password unlocks this sign-in');
  // The member's edit share isn't notebook-level access... but they are a member: they could. A page share from
  // outside the workspace never can (tested below with a stranger); here the owner locks it.
  assert.equal((await app.call('POST', `/pages/${page}/lock`, owner.token)).status, 200);
  assert.equal((await app.call('POST', `/pages/${page}/lock`, owner.token)).status, 409, 'already locked');
  assert.equal((await app.call('POST', `/pages/${page}/lock`, admin.token)).status, 404, 'the admin no longer sees it');
  // Lock now.
  assert.equal((await lockedNotes(owner, '/lock')).status, 200);
  assert.equal((await app.call('GET', '/locked-notes', owner.token)).data.unlocked, false);
});

test('a page share from outside the workspace cannot lock the page it was given', async () => {
  const outsider = await app.signUp('LkOutsider');
  const other = (await app.call('POST', `/sections/${sec}/pages`, owner.token, { title: 'Shared out' })).data.id;
  await app.call('POST', `/pages/${other}/shares`, owner.token, { email: outsider.user.email, canEdit: true });
  await app.call('POST', '/locked-notes/password', outsider.token, { password: 'outsider-pw' });
  assert.equal((await app.call('POST', `/pages/${other}/lock`, outsider.token)).status, 403);
});

test('sweep: no GET route serves the locked page, its title or anything on it to the admin or a member', async () => {
  await sweep(admin, [TITLE, ...CONTENT], 'admin');
  await sweep(member, [TITLE, ...CONTENT], 'member');
});

test('sweep: while locked, its owner gets its title (sidebar, title search) and nothing of its content', async () => {
  await sweep(owner, CONTENT, 'owner (locked)');
  const tree = (await app.call('GET', `/workspaces/${ws}/tree`, owner.token)).data;
  const p = tree.pages.find((x: { id: string }) => x.id === page);
  assert.equal(p.title, TITLE);
  assert.equal(p.locked, true);
  const meta = await app.call('GET', `/pages/${page}`, owner.token);
  assert.equal(meta.status, 200);
  assert.deepEqual([meta.data.locked, meta.data.open], [true, false]);
  assert.equal((await app.call('GET', `/pages/${page}/doc`, owner.token)).status, 404);
  const s = (await app.call('GET', `/workspaces/${ws}/search?q=${encodeURIComponent('Locked Diary')}`, owner.token)).data;
  assert.equal(s.pages[0]?.id, page, 'title-searchable for its owner');
  const tasks = (await app.call('GET', `/workspaces/${ws}/tasks`, owner.token)).data as { id: string; title: string; dueDate: string; locked?: boolean }[];
  const t = tasks.find((x) => x.id === task)!;
  assert.deepEqual([t.title, t.dueDate, t.locked], ['Locked task', '2030-01-02', true]);
  assert.equal((await app.call('GET', '/me/export', owner.token)).data.code, 'locked', 'export my data needs an unlock');
  // Nobody else has the task, not even its assignee.
  assert.ok(!((await app.call('GET', `/workspaces/${ws}/tasks`, admin.token)).data as { id: string }[]).some((x) => x.id === task));
  assert.equal((await app.call('PATCH', `/tasks/${task}`, admin.token, { status: 'done' })).status, 404);
});

test('content routes that change or copy the page refuse everyone else, and the owner until unlocked', async () => {
  const writes: [string, string, unknown?][] = [
    ['POST', `/pages/${page}/copy`, {}],
    ['POST', `/pages/${page}/templates`, { name: 'T', content: { type: 'doc', content: [] } }],
    ['POST', `/pages/${page}/versions`, {}],
    ['POST', `/pages/${page}/comments`, { threadId: crypto.randomUUID(), body: 'x' }],
    ['POST', `/comment-threads/${thread}/replies`, { body: 'x' }],
    ['PATCH', `/pages/${page}`, { title: 'Renamed by someone else' }],
    ['DELETE', `/pages/${page}`],
    ['POST', `/pages/${page}/shares`, { userId: member.user.id, canEdit: false }],
    ['POST', `/trash/page/${page}/restore`],
    ['POST', `/pages/${page}/lock/remove`, { password: LOCK_PW }],
  ];
  for (const [m, p, b] of writes) assert.equal((await app.call(m, p, admin.token, b)).status, 404, `admin: ${m} ${p}`);
  for (const [m, p, b] of writes.slice(0, 5)) assert.equal((await app.call(m, p, owner.token, b)).status, 404, `owner (locked): ${m} ${p}`);
});

test('collab: nobody else can connect; the owner only while unlocked, and relocking closes the socket', async () => {
  const other = collabClient(app, page, admin.token);
  await waitFor(() => other.closes.includes(4403), 3000, 'admin refused');
  other.destroy();
  const locked = collabClient(app, page, owner.token);
  await waitFor(() => locked.closes.includes(4403), 3000, 'owner refused while locked');
  locked.destroy();

  assert.equal((await lockedNotes(owner, '/unlock', { password: 'wrong-one' })).status, 400);
  const un = await lockedNotes(owner, '/unlock', { password: LOCK_PW });
  assert.equal(un.status, 200);
  const open = collabClient(app, page, owner.token);
  await synced(open);
  const { extractPage } = await import('../server/collab.ts');
  assert.ok(extractPage(open.doc).text.includes(BODY));
  // The same account on another sign-in is still locked.
  const login = await app.call('POST', '/auth/login', undefined, { email: owner.user.email, password: 'password123' });
  const second = collabClient(app, page, login.data.accessToken);
  await waitFor(() => second.closes.includes(4403), 3000, 'other sign-in refused');
  second.destroy();
  assert.equal((await lockedNotes(owner, '/lock')).status, 200);
  await waitFor(() => open.closes.includes(4403), 3000, 'closed on relock');
  open.destroy();
});

test('events: task changes on a locked page reach nobody else, and its owner redacted unless that sign-in unlocked', async () => {
  const login = await app.call('POST', '/auth/login', undefined, { email: owner.user.email, password: 'password123' });
  const listen = (token: string) => {
    const msgs: string[] = [];
    const s = new WS(`${app.wsOrigin}/api/events`, ['noteapp.v1', `bearer.${token}`]);
    s.on('message', (d) => msgs.push(String(d)));
    return { s, msgs, ready: new Promise((r) => s.once('message', r)) };
  };
  const a = listen(admin.token);
  const lockedSock = listen(login.data.accessToken);
  await lockedNotes(owner, '/unlock', { password: LOCK_PW });
  const openSock = listen(owner.token);
  await Promise.all([a.ready, lockedSock.ready, openSock.ready]);
  assert.equal((await app.call('PATCH', `/tasks/${task}`, owner.token, { description: `${TASK} edited` })).status, 200);
  await waitFor(() => openSock.msgs.some((m) => m.includes('edited')), 3000, 'owner (unlocked) gets the change');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!a.msgs.join('\n').includes(TASK), 'admin gets nothing of it');
  const red = lockedSock.msgs.filter((m) => m.includes(task)).join('\n');
  assert.ok(red.includes('Locked task') && !red.includes(TASK), 'the locked sign-in gets it redacted');
  for (const x of [a, lockedSock, openSock]) x.s.close();
  await lockedNotes(owner, '/lock');
});

test('the AI connector never sees a locked page, its title or its tasks, even while unlocked', async () => {
  await lockedNotes(owner, '/unlock', { password: LOCK_PW });
  const tok = `mcp-${crypto.randomUUID()}`;
  mcpTokens.set(tok, { userId: owner.user.id, scopes: ['notes:read', 'notes:write'], clientId: 'c', clientName: 'Test AI' });
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await fetch(`${app.origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return res.text();
  };
  const out = [
    await call('list_workspaces', {}),
    await call('list_sections', { workspace_id: ws }),
    await call('list_pages', { section_id: sec }),
    await call('search_pages', { query: 'Locked Diary' }),
    await call('search_pages', { query: BODY }),
    await call('read_page', { page_id: page }),
    await call('list_tasks', {}),
    await call('list_tasks', { workspace_id: ws }),
    await call('list_tasks', { page_id: page }),
    await call('get_task', { task_id: task }),
    await call('append_box', { page_id: page, content: 'from ai' }),
  ].join('\n');
  for (const f of [TITLE, ...CONTENT]) assert.ok(!out.includes(f), `mcp leaked "${f}"`);
  assert.ok(out.includes('Shared out'), 'other pages are listed as usual');
  await lockedNotes(owner, '/lock');
});

test('unlocked: the owner gets content (doc, versions, export, task text); keepalive extends; other users still nothing', async () => {
  await lockedNotes(owner, '/unlock', { password: LOCK_PW });
  assert.equal((await app.call('GET', `/pages/${page}/doc`, owner.token)).status, 200);
  assert.equal((await app.call('GET', `/pages/${page}/versions/${version}`, owner.token)).status, 200);
  const meta = (await app.call('GET', `/pages/${page}`, owner.token)).data;
  assert.deepEqual([meta.locked, meta.open], [true, true]);
  const tasks = (await app.call('GET', `/workspaces/${ws}/tasks`, owner.token)).data as { id: string; title: string }[];
  assert.equal(tasks.find((x) => x.id === task)?.title, TASK);
  const exp = await fetchText('/me/export', owner.token);
  assert.equal(exp.status, 200);
  assert.ok(exp.text.includes(BODY), 'export my data includes it once unlocked');
  const ka = await lockedNotes(owner, '/keepalive');
  assert.equal(ka.data.unlocked, true);
  // Body search: never indexed, even unlocked.
  const s = (await app.call('GET', `/workspaces/${ws}/search?q=${BODY}`, owner.token)).data;
  assert.equal(s.pages.length, 0);
  await sweep(admin, [TITLE, ...CONTENT], 'admin while owner unlocked');
  // Copy and save-as-template stay refused: they would make unlocked copies.
  assert.equal((await app.call('POST', `/pages/${page}/copy`, owner.token, {})).status, 400);
  assert.equal((await app.call('POST', `/pages/${page}/templates`, owner.token, { name: 'T', content: { type: 'doc', content: [] } })).status, 400);
  await lockedNotes(owner, '/lock');
  assert.equal((await app.call('GET', `/pages/${page}/doc`, owner.token)).status, 404);
});

test('unlocks lapse after idle time; sign-out locks that sign-in', async () => {
  await lockedNotes(owner, '/unlock', { password: LOCK_PW });
  const { db } = await import('../server/db.ts');
  db.prepare("UPDATE lock_unlocks SET expires_at = '2000-01-01T00:00:00.000Z'").run();
  assert.equal((await app.call('GET', `/pages/${page}/doc`, owner.token)).status, 404, 'lapsed');
  assert.equal((await lockedNotes(owner, '/keepalive')).data.unlocked, false, 'keepalive does not revive it');
  const login = await app.call('POST', '/auth/login', undefined, { email: owner.user.email, password: 'password123' });
  const t2 = { ...owner, token: login.data.accessToken };
  await lockedNotes(t2, '/unlock', { password: LOCK_PW });
  assert.equal((await app.call('GET', `/pages/${page}/doc`, t2.token)).status, 200);
  await app.call('POST', '/auth/logout', undefined, { refreshToken: login.data.refreshToken });
  assert.equal((await app.call('GET', `/pages/${page}/doc`, t2.token)).status, 404, 'signed out: locked again');
});

const INSTALL = 'install-0123456789abcdef';

test('devices: a device secret unlocks like the password, only while issued, and dies with a password change', async () => {
  assert.equal((await lockedNotes(owner, '/devices', { label: 'iPhone', installId: INSTALL })).status, 403, 'needs an unlock first');
  await lockedNotes(owner, '/unlock', { password: LOCK_PW });
  const dev = (await lockedNotes(owner, '/devices', { label: 'iPhone', installId: INSTALL })).data as { id: string; secret: string };
  await lockedNotes(owner, '/lock');
  assert.equal((await lockedNotes(owner, '/unlock', { deviceId: dev.id, secret: 'nope', installId: INSTALL })).status, 401);
  assert.equal((await lockedNotes(owner, '/unlock', { deviceId: dev.id, secret: dev.secret, installId: 'another-install-0000' })).status, 401, 'another app install');
  // Another sign-in of the same account can't use it.
  const login = await app.call('POST', '/auth/login', undefined, { email: owner.user.email, password: 'password123' });
  assert.equal((await app.call('POST', '/locked-notes/unlock', login.data.accessToken, { deviceId: dev.id, secret: dev.secret, installId: INSTALL })).status, 401, 'another sign-in');
  assert.equal((await lockedNotes(owner, '/unlock', { deviceId: dev.id, secret: dev.secret, installId: INSTALL })).status, 200);
  assert.equal((await app.call('GET', `/pages/${page}/doc`, owner.token)).status, 200);
  assert.equal((await app.call('GET', '/locked-notes', owner.token)).data.devices.length, 1);
  // Change the password: the device and every unlock end.
  assert.equal((await lockedNotes(owner, '/password', { password: 'new-pass-2', currentPassword: 'wrong' })).status, 400);
  assert.equal((await lockedNotes(owner, '/password', { password: 'new-pass-2', currentPassword: LOCK_PW })).status, 200);
  await lockedNotes(owner, '/lock');
  assert.equal((await lockedNotes(owner, '/unlock', { deviceId: dev.id, secret: dev.secret, installId: INSTALL })).status, 401);
  assert.equal((await lockedNotes(owner, '/password', { password: LOCK_PW, currentPassword: 'new-pass-2' })).status, 200);
  await lockedNotes(owner, '/lock');
});

test('devices: sign-out, a login-password change and 30 days each end a device secret', async () => {
  const { db } = await import('../server/db.ts');
  const u = await app.signUp('LkDevices');
  await app.call('POST', '/locked-notes/password', u.token, { password: 'device-pass' }); // unlocks this sign-in
  const mk = async (token: string) => (await app.call('POST', '/locked-notes/devices', token, { installId: INSTALL })).data as { id: string; secret: string };
  const use = (token: string, d: { id: string; secret: string }) => app.call('POST', '/locked-notes/unlock', token, { deviceId: d.id, secret: d.secret, installId: INSTALL });
  // 30 days.
  const d1 = await mk(u.token);
  db.prepare("UPDATE lock_devices SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(d1.id);
  assert.equal((await use(u.token, d1)).status, 401, 'lapsed');
  // Sign-out of that sign-in.
  const login = await app.call('POST', '/auth/login', undefined, { email: u.user.email, password: 'password123' });
  await app.call('POST', '/locked-notes/unlock', login.data.accessToken, { password: 'device-pass' });
  await mk(login.data.accessToken);
  await app.call('POST', '/auth/logout', undefined, { refreshToken: login.data.refreshToken });
  assert.equal(db.prepare('SELECT COUNT(*) FROM lock_devices WHERE user_id = ?').pluck().get(u.user.id), 0, 'gone with the sign-in');
  // Login-password change.
  const d3 = await mk(u.token);
  assert.equal((await use(u.token, d3)).status, 200);
  const changed = await app.call('POST', '/me/password', u.token, { currentPassword: 'password123', newPassword: 'password456' });
  assert.equal(changed.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) FROM lock_devices WHERE user_id = ?').pluck().get(u.user.id), 0, 'gone with a password change');
});

test('lockout: 5 wrong tries pause unlocking for 15 minutes (doubling up to 24 h), the owner is emailed, a right password resets', async () => {
  const { db } = await import('../server/db.ts');
  const { outbox } = await import('../server/mail.ts');
  const { lockoutMs } = await import('../server/locks.ts');
  assert.deepEqual([1, 4, 5, 6, 7, 20].map(lockoutMs), [0, 0, 15 * 60_000, 30 * 60_000, 60 * 60_000, 24 * 3600_000]);
  const u = await app.signUp('LkLockout');
  await app.call('POST', '/locked-notes/password', u.token, { password: 'lockout-pass' });
  await app.call('POST', '/locked-notes/lock', u.token);
  const statuses: number[] = [];
  let last: { error: string; code: string } = { error: '', code: '' };
  for (let i = 0; i < 5; i++) {
    const r = await app.call('POST', '/locked-notes/unlock', u.token, { password: `wrong-${i}` });
    statuses.push(r.status);
    last = r.data;
  }
  assert.deepEqual(statuses, [400, 400, 400, 400, 429]);
  assert.equal(last.code, 'locked_out');
  const status = (await app.call('GET', '/locked-notes', u.token)).data;
  assert.ok(status.blockedUntil && Date.parse(status.blockedUntil) - Date.now() > 14 * 60_000, 'about 15 minutes');
  assert.equal((await app.call('POST', '/locked-notes/unlock', u.token, { password: 'lockout-pass' })).status, 429, 'even the right one waits');
  const mail = outbox.filter((m) => m.to === u.user.email && /Someone tried to unlock/.test(m.subject));
  assert.equal(mail.length, 1, 'one email at the fifth failure');
  assert.match(mail[0].text, /When: .+\nDevice: /);
  // Time passes: the right password works and the count starts over.
  db.prepare("UPDATE users SET lock_blocked_until = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(u.user.id);
  (await import('../server/ratelimit.ts')).resetRateLimits();
  assert.equal((await app.call('POST', '/locked-notes/unlock', u.token, { password: 'lockout-pass' })).status, 200);
  assert.equal((await app.call('GET', '/locked-notes', u.token)).data.failures, 0);
  // Too short a password is refused.
  assert.equal((await app.call('POST', '/locked-notes/password', u.token, { password: '12345', currentPassword: 'lockout-pass' })).status, 400);
});

test('reset: login password, then the emailed code; it sets a new password and reveals nothing', async () => {
  const { resetRateLimits } = await import('../server/ratelimit.ts');
  resetRateLimits(); // the tests above spent the owner's wrong-password budget
  const { outbox } = await import('../server/mail.ts');
  assert.equal((await lockedNotes(owner, '/reset/start', { password: 'wrong-login' })).status, 400);
  assert.equal((await lockedNotes(owner, '/reset/start', { password: 'password123' })).status, 200);
  const mail = outbox.filter((m) => m.to === owner.user.email).at(-1)!;
  const code = mail.text.match(/\b(\d{6})\b/)![1];
  assert.ok(!mail.text.includes(BODY) && !mail.text.includes(TITLE));
  assert.equal((await lockedNotes(owner, '/reset', { code: code === '000000' ? '111111' : '000000', newPassword: 'reset-pass-3' })).status, 400);
  const r = await lockedNotes(owner, '/reset', { code, newPassword: 'reset-pass-3' });
  assert.equal(r.status, 200);
  assert.equal((await app.call('GET', `/pages/${page}/doc`, owner.token)).status, 404, 'a reset does not unlock');
  assert.equal((await lockedNotes(owner, '/reset', { code, newPassword: 'again-pass-4' })).status, 400, 'the code works once');
  assert.equal((await lockedNotes(owner, '/unlock', { password: LOCK_PW })).status, 400, 'old password is gone');
  assert.equal((await lockedNotes(owner, '/unlock', { password: 'reset-pass-3' })).status, 200);
  await lockedNotes(owner, '/lock');
});

test('upload links: a file on a locked page opens only with a link signed for an unlocked sign-in; old links stop working', async () => {
  const { signUploadPath } = await import('../shared/fileLinks.ts');
  const { clearFileReadCache } = await import('../server/routes/files.ts');
  (await import('../server/ratelimit.ts')).resetRateLimits();
  const plainKey = (await app.call('GET', '/files/key', owner.token)).data;
  const get = (key: unknown) => fetch(app.origin + signUploadPath(fileUrl, key as never)).then((r) => r.status);
  clearFileReadCache();
  assert.equal(await get(plainKey), 403, 'locked: the ordinary link is refused, owner or not');
  assert.equal(await get(admin.fileKey), 403);
  assert.equal((await app.call('GET', '/locked-notes/file-key', owner.token)).status, 403, 'no key while locked');
  await lockedNotes(owner, '/unlock', { password: 'reset-pass-3' });
  const lockedKey = (await app.call('GET', '/locked-notes/file-key', owner.token)).data;
  assert.ok(lockedKey.l, 'tagged');
  assert.equal(await get(lockedKey), 200, 'unlocked sign-in');
  assert.equal(await get(plainKey), 403, 'still not with an ordinary link');
  // Another sign-in's tag, or a forged one, doesn't help.
  assert.equal(await get({ ...lockedKey, l: '0'.repeat(24) }), 403);
  await lockedNotes(owner, '/lock');
  assert.equal(await get(lockedKey), 403, 'relocked: the link stops working');
});

test('locking a page tells every device that had it (all members and share holders) to drop it', async () => {
  const p = (await app.call('POST', `/sections/${sec}/pages`, owner.token, { title: 'Soon locked' })).data.id;
  const msgs: string[] = [];
  const s = new WS(`${app.wsOrigin}/api/events`, ['noteapp.v1', `bearer.${member.token}`]);
  s.on('message', (d) => msgs.push(String(d)));
  await new Promise((r) => s.once('message', r));
  await lockedNotes(owner, '/unlock', { password: 'reset-pass-3' });
  assert.equal((await app.call('POST', `/pages/${p}/lock`, owner.token)).status, 200);
  await waitFor(() => msgs.some((m) => m.includes('"page-locked"') && m.includes(p)), 3000, 'page-locked event');
  s.close();
  await app.call('POST', `/pages/${p}/lock/remove`, owner.token, { password: 'reset-pass-3' });
  await lockedNotes(owner, '/lock');
});

test('removing the lock needs the password; then the page is everyone’s again', async () => {
  (await import('../server/ratelimit.ts')).resetRateLimits();
  assert.equal((await app.call('POST', `/pages/${page}/lock/remove`, owner.token, { password: 'nope' })).status, 400);
  assert.equal((await app.call('POST', `/pages/${page}/lock/remove`, owner.token, { password: 'reset-pass-3' })).status, 200);
  const tree = (await app.call('GET', `/workspaces/${ws}/tree`, admin.token)).data;
  assert.ok(tree.pages.some((p: { id: string }) => p.id === page));
  assert.ok(((await app.call('GET', `/workspaces/${ws}/tasks`, admin.token)).data as { id: string }[]).some((x) => x.id === task));
  const s = (await app.call('GET', `/workspaces/${ws}/search?q=${BODY}`, admin.token)).data;
  assert.equal(s.pages[0]?.id, page, 'body searchable again');
});

test('rate limit: wrong locked-notes passwords run out, then 429', async () => {
  const u = await app.signUp('LkLimiter');
  await app.call('POST', '/locked-notes/password', u.token, { password: 'limit-pass' });
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await app.call('POST', '/locked-notes/unlock', u.token, { password: `wrong-${i}` })).status;
  assert.equal(last, 429);
  const right = await app.call('POST', '/locked-notes/unlock', u.token, { password: 'limit-pass' });
  assert.equal(right.status, 429, 'even the right one waits');
});

test('deleting the account deletes the pages it locked', async () => {
  const u = await app.signUp('LkLeaver');
  await app.call('POST', `/workspaces/${ws}/members`, owner.token, { email: u.user.email, role: 'member' });
  const p = (await app.call('POST', `/sections/${sec}/pages`, u.token, { title: 'Leaver locked' })).data.id;
  await app.call('POST', '/locked-notes/password', u.token, { password: 'leaver-pw' });
  assert.equal((await app.call('POST', `/pages/${p}/lock`, u.token)).status, 200);
  assert.equal((await app.call('DELETE', '/auth/account', u.token, { password: 'password123' })).status, 200);
  const { db } = await import('../server/db.ts');
  assert.equal(db.prepare('SELECT COUNT(*) FROM pages WHERE id = ?').pluck().get(p), 0);
});
