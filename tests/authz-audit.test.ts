// Authorization audit: EVERY REST route and both WebSockets, as
//   anon     – no token
//   stranger – signed in, not a member of the workspace
//   viewer   – workspace viewer
//   member   – workspace member
//   private  – the same member, against resources in the owner's PRIVATE notebook
// Each cell runs against fresh resources. A coverage check fails if a route is
// registered that this table doesn't list, so new routes must be audited here.
// (Owner/admin rules are covered in tests/permissions.test.ts.)
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import WS from 'ws';
import crypto from 'node:crypto';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';

type Who = 'anon' | 'stranger' | 'viewer' | 'member' | 'private';
const WHO: Who[] = ['anon', 'stranger', 'viewer', 'member', 'private'];

let app: TestApp;
let owner: TestUser, stranger: TestUser, viewer: TestUser, member: TestUser, target: TestUser;
before(async () => {
  // Admin routes: with ADMIN_EMAILS unset the first account would be admin, so name an address no persona uses.
  process.env.ADMIN_EMAILS = 'site-admin@example.com';
  app = await startTestApp();
  [owner, stranger, viewer, member, target] = await Promise.all(['Owner', 'Stranger', 'Viewer', 'Member', 'Target'].map((n) => app.signUp(`Az${n}`)));
});
after(() => app.close());

interface Fx {
  /** A saved version of `page` (when the versions routes exist). */
  version: string;
  /** The owner's own reminder on `task` (reminders are personal). */
  reminder: string;
  /** Comment thread + its first comment on `page` (when the comments routes exist). */
  thread: string;
  comment: string;
  /** The owner's template saved from `page` (visible to everyone for the shared notebook, owner-only for the private one). */
  template: string;
  ws: string;
  nb: string;
  sec: string;
  page: string;
  task: string;
  file: string;
  target: string;
  email: string;
  invite: string;
}

let seq = 0;
const upload = async (token: string, ws: string, pageId: string | null) => {
  const r = await fetch(`${app.origin}/api/workspaces/${ws}/files${pageId ? `?pageId=${pageId}` : ''}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain', 'x-filename': 'note.txt' },
    body: 'hello',
  });
  return { status: r.status, data: await r.json().catch(() => null) };
};

/** A workspace with viewer + member, and the same resource set in a shared and in a private (owner's) notebook. */
async function fixture(): Promise<{ shared: Fx; priv: Fx }> {
  const o = owner.token;
  const n = ++seq;
  const ws = (await app.call('POST', '/workspaces', o, { name: `Audit ${n}` })).data.id as string;
  await app.call('POST', `/workspaces/${ws}/members`, o, { email: viewer.user.email, role: 'viewer' });
  await app.call('POST', `/workspaces/${ws}/members`, o, { email: member.user.email, role: 'member' });
  await app.call('POST', `/workspaces/${ws}/members`, o, { email: target.user.email, role: 'member' });
  const email = `pending-${n}@example.com`;
  const invite = (await app.call('POST', `/workspaces/${ws}/members`, o, { email, role: 'member' })).data.inviteUrl.split('/invite/')[1] as string;
  const make = async (visibility: 'shared' | 'private'): Promise<Fx> => {
    const nb = (await app.call('POST', `/workspaces/${ws}/notebooks`, o, { name: `NB ${visibility}`, visibility })).data.id;
    const sec = (await app.call('POST', `/notebooks/${nb}/sections`, o, { name: 'Sec' })).data.id;
    const page = (await app.call('POST', `/sections/${sec}/pages`, o, { title: 'Page' })).data.id;
    const task = (await app.call('POST', `/workspaces/${ws}/tasks`, o, { title: 'Task', pageId: page })).data.id;
    const file = (await upload(o, ws, page)).data.id;
    let thread = 'no-comments-route';
    let comment = 'no-comments-route';
    if ((await registeredRoutes()).has('POST /pages/:id/comments')) {
      const t = await app.call('POST', `/pages/${page}/comments`, o, { threadId: crypto.randomUUID(), quote: 'q', body: 'Owner comment' });
      thread = t.data.id;
      comment = t.data.comments[0].id;
    }
    const reminder = (await app.call('POST', `/tasks/${task}/reminders`, o, { kind: 'before', minutes: 10 })).data?.id ?? 'no-reminders-route';
    let version = 'no-versions-route';
    if ((await registeredRoutes()).has('POST /pages/:id/versions')) {
      // Versions snapshot real content, so give the page some first.
      const { seedPageDoc } = await import('../server/collab.ts');
      const Y = await import('yjs');
      seedPageDoc(page, (frag) => {
        const p = new Y.XmlElement('paragraph');
        p.insert(0, [new Y.XmlText('Versioned content')]);
        frag.insert(0, [p]);
      });
      version = (await app.call('POST', `/pages/${page}/versions`, o, {})).data?.id ?? 'no-version';
    }
    let template = 'no-templates-route';
    if ((await registeredRoutes()).has('POST /pages/:id/templates')) {
      template = (await app.call('POST', `/pages/${page}/templates`, o, { name: 'Tpl', content: { type: 'doc', content: [{ type: 'paragraph' }] } })).data?.id ?? 'no-template';
    }
    return { ws, nb, sec, page, task, file, thread, comment, template, reminder, version, target: target.user.id, email, invite };
  };
  return { shared: await make('shared'), priv: await make('private') };
}

type Expect = Partial<Record<Who, number>>;
interface Row {
  /** Known hole, routed to the owning area: reported as a TODO instead of failing CI. */
  known?: string;
  method: string;
  /** Route path exactly as registered (used for the coverage check). */
  route: string;
  /** Fill in the path for a fixture. */
  path: (f: Fx) => string;
  body?: (f: Fx) => unknown;
  raw?: boolean;
  /** Response isn't JSON: only the status is checked. */
  plain?: boolean;
  expect: Expect;
}

// Shorthands: defaults are anon 401, stranger 404, private = member.
const READ: Expect = { viewer: 200, member: 200 };
const WRITE: Expect = { viewer: 403, member: 200 };
const ADMIN: Expect = { viewer: 403, member: 403 };
const inPrivate = (e: Expect, p = 404): Expect => ({ ...e, private: p });

const ROWS: Row[] = [
  // ── Public (no token needed; identical for everyone) ──
  { method: 'GET', route: '/health', path: () => '/health', expect: { anon: 200, stranger: 200, viewer: 200, member: 200, private: 200 } },
  { method: 'POST', route: '/auth/register', path: () => '/auth/register', body: () => ({ name: 'New', email: `reg-${++seq}@example.com`, password: 'password123' }), expect: { anon: 200, stranger: 200, viewer: 200, member: 200, private: 200 } },
  { method: 'POST', route: '/auth/login', path: () => '/auth/login', body: () => ({ email: 'nobody@example.com', password: 'wrong-password' }), expect: { anon: 401, stranger: 401, viewer: 401, member: 401, private: 401 } },
  { method: 'POST', route: '/auth/refresh', path: () => '/auth/refresh', body: () => ({ refreshToken: 'not-a-token' }), expect: { anon: 401, stranger: 401, viewer: 401, member: 401, private: 401 } },
  { method: 'POST', route: '/auth/logout', path: () => '/auth/logout', body: () => ({ refreshToken: 'not-a-token' }), expect: { anon: 200, stranger: 200, viewer: 200, member: 200, private: 200 } },
  { method: 'GET', route: '/auth/config', path: () => '/auth/config', expect: { anon: 200, stranger: 200, viewer: 200, member: 200, private: 200 } },
  { method: 'POST', route: '/auth/forgot', path: () => '/auth/forgot', body: () => ({ email: 'nobody@example.com' }), expect: { anon: 200, stranger: 200, viewer: 200, member: 200, private: 200 } }, // never reveals whether the email exists
  { method: 'POST', route: '/auth/reset', path: () => '/auth/reset', body: () => ({ token: 'not-a-token', password: 'password1234' }), expect: { anon: 400, stranger: 400, viewer: 400, member: 400, private: 400 } },
  { method: 'GET', route: '/invites/:token', path: (f) => `/invites/${f.invite}`, expect: { anon: 200, stranger: 200, viewer: 200, member: 200, private: 200 } },

  // ── The signed-in user ──
  { method: 'GET', route: '/me', path: () => '/me', expect: { stranger: 200, ...READ } },
  { method: 'PATCH', route: '/me', path: () => '/me', body: () => ({ name: 'Same Name' }), expect: { stranger: 200, viewer: 200, member: 200 } },
  { method: 'GET', route: '/workspaces', path: () => '/workspaces', expect: { stranger: 200, ...READ } },
  // Changing your own password needs the current one (wrong here, so 400 for every signed-in user).
  { method: 'POST', route: '/me/password', path: () => '/me/password', body: () => ({ currentPassword: 'wrong-current', newPassword: 'another-password-1' }), expect: { stranger: 400, viewer: 400, member: 400 } },
  { method: 'POST', route: '/workspaces', path: () => '/workspaces', body: () => ({ name: 'Mine' }), expect: { stranger: 200, viewer: 200, member: 200 } },
  { method: 'POST', route: '/uploads', path: () => '/uploads', raw: true, expect: { stranger: 200, viewer: 200, member: 200 } }, // personal, unscoped upload
  // Invite acceptance requires the invited email: nobody in this table has it.
  { method: 'POST', route: '/invites/:token/accept', path: (f) => `/invites/${f.invite}/accept`, expect: { stranger: 403, viewer: 403, member: 403 } },

  // ── Site admin (ADMIN_EMAILS): nobody in this table is one ──
  { method: 'GET', route: '/admin/stats', path: () => '/admin/stats', expect: { stranger: 403, viewer: 403, member: 403 } },
  { method: 'GET', route: '/admin/me', path: () => '/admin/me', expect: { stranger: 403, viewer: 403, member: 403 } },

  // ── Workspace ──
  { method: 'PATCH', route: '/workspaces/:id', path: (f) => `/workspaces/${f.ws}`, body: () => ({ name: 'Renamed' }), expect: ADMIN },
  { method: 'DELETE', route: '/workspaces/:id', path: (f) => `/workspaces/${f.ws}`, expect: ADMIN },
  { method: 'GET', route: '/workspaces/:id/members', path: (f) => `/workspaces/${f.ws}/members`, expect: READ },
  { method: 'POST', route: '/workspaces/:id/members', path: (f) => `/workspaces/${f.ws}/members`, body: () => ({ email: `x${++seq}@example.com` }), expect: ADMIN },
  { method: 'PATCH', route: '/workspaces/:id/members/:userId', path: (f) => `/workspaces/${f.ws}/members/${f.target}`, body: () => ({ role: 'viewer' }), expect: ADMIN },
  { method: 'DELETE', route: '/workspaces/:id/members/:userId', path: (f) => `/workspaces/${f.ws}/members/${f.target}`, expect: ADMIN },
  { method: 'POST', route: '/workspaces/:id/invites/:email/resend', path: (f) => `/workspaces/${f.ws}/invites/${encodeURIComponent(f.email)}/resend`, expect: ADMIN },
  { method: 'DELETE', route: '/workspaces/:id/invites/:email', path: (f) => `/workspaces/${f.ws}/invites/${encodeURIComponent(f.email)}`, expect: ADMIN },
  { method: 'GET', route: '/workspaces/:id/tree', path: (f) => `/workspaces/${f.ws}/tree`, expect: READ },
  { method: 'GET', route: '/workspaces/:id/search', path: (f) => `/workspaces/${f.ws}/search?q=page`, expect: READ },
  { method: 'GET', route: '/workspaces/:id/tasks', path: (f) => `/workspaces/${f.ws}/tasks`, expect: READ },
  { method: 'GET', route: '/workspaces/:id/tasks/completed', path: (f) => `/workspaces/${f.ws}/tasks/completed`, expect: READ },
  { method: 'POST', route: '/workspaces/:id/tasks', path: (f) => `/workspaces/${f.ws}/tasks`, body: () => ({ title: 'New' }), expect: WRITE },
  { method: 'POST', route: '/workspaces/:id/notebooks', path: (f) => `/workspaces/${f.ws}/notebooks`, body: () => ({ name: 'New' }), expect: WRITE },

  // ── Notebook-scoped (private: the member can't see the owner's private notebook → 404) ──
  { method: 'PATCH', route: '/notebooks/:id', path: (f) => `/notebooks/${f.nb}`, body: () => ({ name: 'Renamed' }), expect: inPrivate(WRITE) },
  { method: 'DELETE', route: '/notebooks/:id', path: (f) => `/notebooks/${f.nb}`, expect: inPrivate(ADMIN) }, // creator or admin only
  { method: 'POST', route: '/notebooks/:id/move', path: (f) => `/notebooks/${f.nb}/move`, body: () => ({ index: 0 }), expect: inPrivate(WRITE) },
  { method: 'POST', route: '/notebooks/:id/sections', path: (f) => `/notebooks/${f.nb}/sections`, body: () => ({ name: 'S2' }), expect: inPrivate(WRITE) },
  { method: 'GET', route: '/notebooks/:id/shares', path: (f) => `/notebooks/${f.nb}/shares`, expect: inPrivate(READ) },
  { method: 'PUT', route: '/notebooks/:id/shares', path: (f) => `/notebooks/${f.nb}/shares`, body: () => ({ userIds: [] }), expect: inPrivate(ADMIN) }, // creator only
  { method: 'PATCH', route: '/sections/:id', path: (f) => `/sections/${f.sec}`, body: () => ({ name: 'Renamed' }), expect: inPrivate(WRITE) },
  { method: 'DELETE', route: '/sections/:id', path: (f) => `/sections/${f.sec}`, expect: inPrivate(WRITE) },
  { method: 'POST', route: '/sections/:id/move', path: (f) => `/sections/${f.sec}/move`, body: () => ({ index: 0 }), expect: inPrivate(WRITE) },
  { method: 'POST', route: '/sections/:id/copy', path: (f) => `/sections/${f.sec}/copy`, body: () => ({}), expect: inPrivate(WRITE) },
  { method: 'POST', route: '/sections/:id/pages', path: (f) => `/sections/${f.sec}/pages`, body: () => ({ title: 'P2' }), expect: inPrivate(WRITE) },
  { method: 'GET', route: '/pages/:id', path: (f) => `/pages/${f.page}`, expect: inPrivate(READ) },
  { method: 'GET', route: '/pages/:id/versions', path: (f) => `/pages/${f.page}/versions`, expect: inPrivate(READ) },
  { method: 'GET', route: '/pages/:id/versions/:vid', path: (f) => `/pages/${f.page}/versions/${f.version}`, expect: inPrivate(READ) },
  { method: 'POST', route: '/pages/:id/versions', path: (f) => `/pages/${f.page}/versions`, body: () => ({}), expect: inPrivate(WRITE) },
  { method: 'GET', route: '/pages/:id/backlinks', path: (f) => `/pages/${f.page}/backlinks`, expect: inPrivate(READ) },
  { method: 'PATCH', route: '/pages/:id', path: (f) => `/pages/${f.page}`, body: () => ({ title: 'Renamed' }), expect: inPrivate(WRITE) },
  { method: 'POST', route: '/pages/:id/move', path: (f) => `/pages/${f.page}/move`, body: () => ({ index: 0 }), expect: inPrivate(WRITE) },
  { method: 'POST', route: '/pages/:id/copy', path: (f) => `/pages/${f.page}/copy`, body: () => ({}), expect: inPrivate(WRITE) },
  { method: 'DELETE', route: '/pages/:id', path: (f) => `/pages/${f.page}`, expect: inPrivate(WRITE) },
  { method: 'PATCH', route: '/tasks/:id', path: (f) => `/tasks/${f.task}`, body: () => ({ title: 'Renamed' }), expect: inPrivate(WRITE) },
  { method: 'DELETE', route: '/tasks/:id', path: (f) => `/tasks/${f.task}`, expect: inPrivate(WRITE) },
  { method: 'POST', route: '/workspaces/:id/files', path: (f) => `/workspaces/${f.ws}/files?pageId=${f.page}`, raw: true, expect: inPrivate(WRITE) },
  // ── Reminders & notification settings (#4). Reminders and settings are personal. ──
  { method: 'POST', route: '/reminders/snooze', path: () => '/reminders/snooze', body: () => ({ token: 'not-a-token', option: '1h' }), expect: { anon: 404, stranger: 404, viewer: 404, member: 404, private: 404 } }, // public: the token is the credential
  { method: 'GET', route: '/calendar/:file', plain: true, path: () => '/calendar/not-a-feed.ics', expect: { anon: 404, stranger: 404, viewer: 404, member: 404, private: 404 } }, // public: the token is the credential
  { method: 'GET', route: '/notifications/settings', path: () => '/notifications/settings', expect: { stranger: 200, ...READ } },
  { method: 'PATCH', route: '/notifications/settings', path: () => '/notifications/settings', body: () => ({}), expect: { stranger: 200, ...READ } },
  { method: 'GET', route: '/notifications/push', path: () => '/notifications/push', expect: { stranger: 200, ...READ } },
  { method: 'POST', route: '/notifications/push-subscriptions', path: () => '/notifications/push-subscriptions', body: () => ({ endpoint: 'https://push.example.com/x' }), expect: { stranger: 400, viewer: 400, member: 400 } }, // auth first, then validation
  { method: 'DELETE', route: '/notifications/push-subscriptions', path: () => '/notifications/push-subscriptions', body: () => ({ endpoint: 'https://push.example.com/x' }), expect: { stranger: 200, ...READ } },
  { method: 'GET', route: '/calendar-feed', path: () => '/calendar-feed', expect: { stranger: 200, ...READ } },
  { method: 'POST', route: '/calendar-feed', path: () => '/calendar-feed', expect: { stranger: 200, ...READ } },
  { method: 'DELETE', route: '/calendar-feed', path: () => '/calendar-feed', expect: { stranger: 200, ...READ } },
  { method: 'GET', route: '/notifications/quiet-hours', path: () => '/notifications/quiet-hours', expect: { stranger: 200, ...READ } },
  { method: 'PUT', route: '/workspaces/:id/quiet-hours', path: (f) => `/workspaces/${f.ws}/quiet-hours`, body: () => ({ start: '22:00', end: '07:00' }), expect: READ },
  { method: 'DELETE', route: '/workspaces/:id/quiet-hours', path: (f) => `/workspaces/${f.ws}/quiet-hours`, expect: READ },
  { method: 'POST', route: '/notifications/devices', path: () => '/notifications/devices', body: () => ({ platform: 'ios', token: 'x' }), expect: { stranger: 400, viewer: 400, member: 400 } }, // auth first, then validation
  { method: 'DELETE', route: '/notifications/devices', path: () => '/notifications/devices', body: () => ({ token: 'x' }), expect: { stranger: 200, ...READ } },
  // Its own per-user 10 s limit: `private` is the member again, so it gets 429.
  { method: 'POST', route: '/notifications/test', path: () => '/notifications/test', expect: { stranger: 200, ...READ, private: 429 } },
  { method: 'GET', route: '/workspaces/:id/reminders', path: (f) => `/workspaces/${f.ws}/reminders`, expect: READ },
  { method: 'GET', route: '/tasks/:id/reminders', path: (f) => `/tasks/${f.task}/reminders`, expect: inPrivate(READ) },
  { method: 'POST', route: '/tasks/:id/reminders', path: (f) => `/tasks/${f.task}/reminders`, body: () => ({ kind: 'before', minutes: 5 }), expect: inPrivate(READ) }, // personal: viewers may set their own
  // Someone else's reminder (the owner's): nobody else can touch it.
  { method: 'PATCH', route: '/reminders/:id', path: (f) => `/reminders/${f.reminder}`, body: () => ({ kind: 'before', minutes: 5 }), expect: { viewer: 404, member: 404 } },
  { method: 'DELETE', route: '/reminders/:id', path: (f) => `/reminders/${f.reminder}`, expect: { viewer: 404, member: 404 } },
  // Team view (#18), comments (#28), notifications (#29), activity (#33): audited as soon as they're registered.
  { method: 'GET', route: '/workspaces/:id/team', path: (f) => `/workspaces/${f.ws}/team`, expect: READ },
  { method: 'GET', route: '/workspaces/:id/activity', path: (f) => `/workspaces/${f.ws}/activity`, expect: READ },
  { method: 'GET', route: '/notifications', path: () => '/notifications', expect: { stranger: 200, ...READ } },
  { method: 'POST', route: '/notifications/read-all', path: () => '/notifications/read-all', expect: { stranger: 200, ...READ } },
  { method: 'POST', route: '/notifications/:id/read', path: () => `/notifications/${crypto.randomUUID()}/read`, expect: { stranger: 200, ...READ } }, // only ever touches your own
  { method: 'GET', route: '/pages/:id/comments', path: (f) => `/pages/${f.page}/comments`, expect: inPrivate(READ) },
  { method: 'POST', route: '/pages/:id/comments', path: (f) => `/pages/${f.page}/comments`, body: () => ({ threadId: crypto.randomUUID(), body: 'Hi' }), expect: inPrivate(WRITE) },
  { method: 'POST', route: '/comment-threads/:id/replies', path: (f) => `/comment-threads/${f.thread}/replies`, body: () => ({ body: 'Reply' }), expect: inPrivate(WRITE) },
  { method: 'PATCH', route: '/comment-threads/:id', path: (f) => `/comment-threads/${f.thread}`, body: () => ({ resolved: true }), expect: inPrivate(WRITE) },
  { method: 'DELETE', route: '/comment-threads/:id', path: (f) => `/comment-threads/${f.thread}`, expect: inPrivate(ADMIN) }, // creator or admin
  { method: 'PATCH', route: '/comments/:id', path: (f) => `/comments/${f.comment}`, body: () => ({ body: 'Edit' }), expect: inPrivate(ADMIN) }, // author only
  { method: 'DELETE', route: '/comments/:id', path: (f) => `/comments/${f.comment}`, expect: inPrivate(ADMIN) }, // author or admin
  { method: 'GET', route: '/files/:id', path: (f) => `/files/${f.file}`, expect: inPrivate(READ) }, // AUTHZ-1, fixed in #52
  // User templates: workspace members list them; a template saved from a private page is visible to its creator (the owner) only.
  { method: 'GET', route: '/workspaces/:id/templates', path: (f) => `/workspaces/${f.ws}/templates`, expect: READ },
  { method: 'POST', route: '/pages/:id/templates', path: (f) => `/pages/${f.page}/templates`, body: () => ({ name: 'T', content: { type: 'doc', content: [] } }), expect: inPrivate(WRITE) },
  { method: 'PATCH', route: '/templates/:id', path: (f) => `/templates/${f.template}`, body: () => ({ name: 'Renamed' }), expect: inPrivate(ADMIN) }, // creator or admin only
  { method: 'DELETE', route: '/templates/:id', path: (f) => `/templates/${f.template}`, expect: inPrivate(ADMIN) }, // creator or admin only
  { method: 'POST', route: '/templates/:id/use', path: (f) => `/templates/${f.template}/use`, body: (f) => ({ pageId: f.page }), expect: inPrivate(WRITE) },
];

const tokenOf = (who: Who) => (who === 'anon' ? undefined : who === 'stranger' ? stranger.token : who === 'viewer' ? viewer.token : member.token);
const expected = (r: Row, who: Who) => r.expect[who] ?? (who === 'anon' ? 401 : who === 'stranger' ? 404 : who === 'private' ? (r.expect.member ?? 404) : 404);

async function run(r: Row, f: Fx, who: Who): Promise<number> {
  const token = tokenOf(who);
  if (r.raw) {
    const res = await fetch(`${app.origin}/api${r.path(f)}`, {
      method: r.method,
      headers: { 'content-type': 'text/plain', 'x-filename': 'a.txt', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: 'data',
    });
    return res.status;
  }
  if (r.plain) return (await fetch(`${app.origin}/api${r.path(f)}`, { method: r.method, headers: token ? { authorization: `Bearer ${token}` } : {} })).status;
  return (await app.call(r.method, r.path(f), token, r.body?.(f))).status;
}

/** Every (METHOD path) registered on the real /api router, walking mounted routers recursively. */
async function registeredRoutes(): Promise<Set<string>> {
  const { api } = await import('../server/routes/index.ts');
  type Layer = { route?: { path: string; methods: Record<string, boolean> }; handle?: { stack?: Layer[] } };
  const out = new Set<string>();
  const walk = (stack: Layer[]) => {
    for (const layer of stack) {
      if (layer.route) for (const m of Object.keys(layer.route.methods)) out.add(`${m.toUpperCase()} ${layer.route.path}`);
      else if (layer.handle?.stack) walk(layer.handle.stack);
    }
  };
  walk((api as unknown as { stack: Layer[] }).stack);
  return out;
}

for (const r of ROWS) {
  test(`authz: ${r.method} ${r.route}`, { todo: r.known }, async (t) => {
    if (!(await registeredRoutes()).has(`${r.method} ${r.route}`)) return t.skip('route not registered on this branch');
    const got: string[] = [];
    for (const who of WHO) {
      const { shared, priv } = await fixture();
      const f = who === 'private' ? priv : shared;
      const status = await run(r, f, who);
      got.push(`${who}=${status}`);
      assert.equal(status, expected(r, who), `${r.method} ${r.route} as ${who}: expected ${expected(r, who)}, got ${status}  [${got.join(' ')}]`);
    }
  });
}

test('authz: every route registered on the /api router is in the audit table', async () => {
  const registered = await registeredRoutes();
  const audited = new Set(ROWS.map((r) => `${r.method} ${r.route}`));
  const missing = [...registered].filter((r) => !audited.has(r));
  assert.deepEqual(missing, [], `routes missing from the authorization audit: ${missing.join(', ')}`);
  assert.ok(registered.size >= 45, `found ${registered.size} routes`);
});

// ── WebSockets ──

function connect(path: string, token?: string): Promise<{ code: number | null; ws: WS }> {
  return new Promise((resolve) => {
    const ws = new WS(`${app.wsOrigin}${path}`, token ? ['noteapp.v1', `bearer.${token}`] : ['noteapp.v1']);
    let opened = false;
    ws.on('open', () => {
      opened = true;
      setTimeout(() => resolve({ code: null, ws }), 150); // still open after the auth check
    });
    ws.on('close', (code) => resolve({ code, ws }));
    ws.on('error', () => !opened && resolve({ code: -1, ws }));
  });
}

test('authz: /collab/<page> socket', async () => {
  const { shared, priv } = await fixture();
  const cases: [Who, string, number | null][] = [
    ['anon', shared.page, 4401],
    ['stranger', shared.page, 4403],
    ['viewer', shared.page, null], // connects (read-only: updates dropped, covered in collab tests)
    ['member', shared.page, null],
    ['private', priv.page, 4403],
  ];
  for (const [who, page, code] of cases) {
    const r = await connect(`/collab/${page}`, tokenOf(who));
    assert.equal(r.code, code, `/collab as ${who}`);
    r.ws.terminate();
  }
  const bad = await connect(`/collab/${shared.page}`, 'garbage');
  assert.equal(bad.code, 4401);
  bad.ws.terminate();
});

test('authz: /api/events socket only delivers what each user may see', async () => {
  const { shared, priv } = await fixture();
  const anon = await connect('/api/events');
  assert.equal(anon.code, 4401);
  const listeners = await Promise.all((['stranger', 'viewer', 'member'] as Who[]).map(async (who) => {
    const r = await connect('/api/events', tokenOf(who));
    assert.equal(r.code, null, `events as ${who}`);
    const msgs: { type: string; task?: { id: string }; id?: string }[] = [];
    r.ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    return { who, ws: r.ws, msgs };
  }));
  // Owner edits a task in the shared notebook and one in the private notebook.
  await app.call('PATCH', `/tasks/${shared.task}`, owner.token, { title: 'Shared edit' });
  await app.call('PATCH', `/tasks/${priv.task}`, owner.token, { title: 'Private edit' });
  await new Promise((r) => setTimeout(r, 300));
  const by = Object.fromEntries(listeners.map((l) => [l.who, l.msgs]));
  const sawTask = (who: string, id: string) => by[who].some((m) => m.type === 'task' && m.task?.id === id);
  assert.equal(by.stranger.filter((m) => m.type !== 'hello').length, 0, 'stranger gets nothing');
  assert.ok(sawTask('viewer', shared.task) && sawTask('member', shared.task));
  assert.ok(!sawTask('viewer', priv.task) && !sawTask('member', priv.task), 'private task never sent');
  for (const l of listeners) l.ws.terminate();
});

test('authz: the configured site admin can use the admin routes', async () => {
  const admin = await app.signUp('SiteAdmin', 'site-admin@example.com');
  assert.equal((await app.call('GET', '/admin/me', admin.token)).status, 200);
  assert.equal((await app.call('GET', '/admin/stats', admin.token)).status, 200);
});
