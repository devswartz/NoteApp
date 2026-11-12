// Authorization audit: EVERY REST route and both WebSockets, as
//   anon     – no token
//   stranger – signed in, not a member of the workspace
//   viewer   – workspace viewer
//   member   – workspace member
//   private  – the same member, against resources in the owner's PRIVATE notebook
//   pageshare – signed in, NOT a member, holding a view-only page share (#98) on the
//              private notebook's page: that page and what's on it, nothing else
//   pageedit – the same, with an EDIT page share: may change that page's content (text,
//              title, comments, uploads into it) and nothing else; tasks stay member-only
// Each cell runs against fresh resources. A coverage check fails if a route is
// registered that this table doesn't list, so new routes must be audited here.
// (Owner/admin rules are covered in tests/permissions.test.ts.)
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import WS from 'ws';
import crypto from 'node:crypto';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';

type Who = 'anon' | 'stranger' | 'viewer' | 'member' | 'private' | 'pageshare' | 'pageedit';
const WHO: Who[] = ['anon', 'stranger', 'viewer', 'member', 'private', 'pageshare', 'pageedit'];

let app: TestApp;
let owner: TestUser, stranger: TestUser, viewer: TestUser, member: TestUser, target: TestUser, sharee: TestUser, editee: TestUser;
before(async () => {
  // Admin routes: with ADMIN_EMAILS unset the first account would be admin, so name an address no persona uses.
  process.env.ADMIN_EMAILS = 'site-admin@example.com';
  // OneNote import (#117) is hidden without these; turn it on so its routes are audited (no Graph call is made here).
  process.env.MS_CLIENT_ID = 'audit-client-id';
  process.env.MS_CLIENT_SECRET = 'audit-client-secret';
  app = await startTestApp();
  [owner, stranger, viewer, member, target, sharee, editee] = await Promise.all(
    ['Owner', 'Stranger', 'Viewer', 'Member', 'Target', 'Sharee', 'Editee'].map((n) => app.signUp(`Az${n}`)),
  );
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
  /** A tag, a team and a shared saved task view, all made by the owner (migration 014). */
  tag: string;
  team: string;
  view: string;
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
    if ((await registeredRoutes()).has('POST /pages/:id/shares')) {
      // `target` (a member) holds an edit share on both pages; the pageshare persona a view share on the
      // private one, the pageedit persona (also outside the workspace) an edit share on it.
      await app.call('POST', `/pages/${page}/shares`, o, { userId: target.user.id, canEdit: true });
      if (visibility === 'private') {
        await app.call('POST', `/pages/${page}/shares`, o, { email: sharee.user.email, canEdit: false });
        await app.call('POST', `/pages/${page}/shares`, o, { email: editee.user.email, canEdit: true });
      }
    }
    const tag = (await app.call('POST', `/workspaces/${ws}/tags`, o, { name: `Tag ${visibility}` })).data?.id ?? 'no-tag';
    const team = (await app.call('POST', `/workspaces/${ws}/teams`, o, { name: `Team ${visibility}` })).data?.id ?? 'no-team';
    const view = (await app.call('POST', `/workspaces/${ws}/task-views`, o, { name: `View ${visibility}`, shared: true, query: { filters: {}, sort: 'due', group: 'none' } })).data?.id ?? 'no-view';
    return { ws, nb, sec, page, task, file, thread, comment, template, reminder, version, target: target.user.id, email, invite, tag, team, view };
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

// Shorthands: defaults are anon 401, stranger 404, private = member, pageshare = stranger.
const READ: Expect = { viewer: 200, member: 200 };
const WRITE: Expect = { viewer: 403, member: 200 };
const ADMIN: Expect = { viewer: 403, member: 403 };
const inPrivate = (e: Expect, p = 404): Expect => ({ ...e, private: p });
/**
 * For a page-scoped row: what the view-only page share (outside the workspace) gets, and what an
 * edit page share from outside gets when that differs (defaults to the view-only result).
 */
const shared = (e: Expect, ps: number, pe?: number): Expect => ({ ...e, pageshare: ps, ...(pe === undefined ? {} : { pageedit: pe }) });

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
  { method: 'POST', route: '/client-errors', path: () => '/client-errors', body: () => ({ kind: 'error', message: 'audit probe' }), expect: { anon: 204, stranger: 204, viewer: 204, member: 204, private: 204 } }, // public by design: logs only, rate limited, 16 KB cap
  { method: 'POST', route: '/auth/verify-email', path: () => '/auth/verify-email', body: () => ({ token: 'not-a-token' }), expect: { anon: 400, stranger: 400, viewer: 400, member: 400, private: 400 } },

  // ── The signed-in user ──
  { method: 'GET', route: '/me', path: () => '/me', expect: { stranger: 200, ...READ } },
  { method: 'PATCH', route: '/me', path: () => '/me', body: () => ({ name: 'Same Name' }), expect: { stranger: 200, viewer: 200, member: 200 } },
  // Everyone in this table is verified (no SMTP), so resend is a no-op 200 for them; an unverified user is covered below.
  { method: 'POST', route: '/auth/resend-verification', path: () => '/auth/resend-verification', expect: { stranger: 200, viewer: 200, member: 200 } },
  { method: 'GET', route: '/workspaces', path: () => '/workspaces', expect: { stranger: 200, ...READ } },
  // Changing your own password needs the current one (wrong here, so 400 for every signed-in user).
  { method: 'POST', route: '/me/password', path: () => '/me/password', body: () => ({ currentPassword: 'wrong-current', newPassword: 'another-password-1' }), expect: { stranger: 400, viewer: 400, member: 400 } },
  // Account deletion: the wrong password is a 401 for everyone (and deletes nothing), so the table can reuse the same personas.
  { method: 'GET', route: '/auth/account/deletion-preview', path: () => '/auth/account/deletion-preview', expect: { stranger: 200, ...READ } },
  { method: 'DELETE', route: '/auth/account', path: () => '/auth/account', body: () => ({ password: 'wrong-password-123' }), expect: { stranger: 401, viewer: 401, member: 401 } },
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
  // Export is owner/admin only; import makes a new workspace for whoever uploads (garbage here, so 400 once signed in).
  { method: 'GET', route: '/workspaces/:id/export', path: (f) => `/workspaces/${f.ws}/export`, expect: ADMIN },
  // Export my data: anyone signed in, their own data only (scoping: tests/user-export.test.ts).
  { method: 'GET', route: '/me/export', path: () => '/me/export', plain: true, expect: { stranger: 200, viewer: 200, member: 200 } },
  { method: 'POST', route: '/workspaces/import', raw: true, path: () => '/workspaces/import', expect: { stranger: 400, viewer: 400, member: 400 } },
  { method: 'GET', route: '/workspaces/:id/tree', path: (f) => `/workspaces/${f.ws}/tree`, expect: READ },
  // Trash (server/trash.ts): the list is everyone's to ask for (viewers get an empty one); restoring and deleting forever
  // act on a Trash entry, and a live page isn't one (the real permissions are in tests/trash.test.ts); emptying is for admins.
  { method: 'GET', route: '/workspaces/:id/trash', path: (f) => `/workspaces/${f.ws}/trash`, expect: READ },
  { method: 'POST', route: '/trash/:kind/:id/restore', path: (f) => `/trash/page/${f.page}/restore`, expect: { viewer: 404, member: 404 } },
  { method: 'DELETE', route: '/trash/:kind/:id', path: (f) => `/trash/page/${f.page}`, expect: { viewer: 404, member: 404 } },
  { method: 'DELETE', route: '/workspaces/:id/trash', path: (f) => `/workspaces/${f.ws}/trash`, expect: ADMIN },
  { method: 'GET', route: '/workspaces/:id/search', path: (f) => `/workspaces/${f.ws}/search?q=page`, expect: READ },
  { method: 'GET', route: '/workspaces/:id/tasks', path: (f) => `/workspaces/${f.ws}/tasks`, expect: READ },
  { method: 'GET', route: '/workspaces/:id/tasks/completed', path: (f) => `/workspaces/${f.ws}/tasks/completed`, expect: READ },
  { method: 'POST', route: '/workspaces/:id/tasks', path: (f) => `/workspaces/${f.ws}/tasks`, body: () => ({ title: 'New' }), expect: WRITE },
  // Tags (anyone who can edit creates; owners/admins rename/delete), teams (owners/admins), saved views (personal for anyone; shared ones owners/admins).
  { method: 'GET', route: '/workspaces/:id/tags', path: (f) => `/workspaces/${f.ws}/tags`, expect: READ },
  { method: 'POST', route: '/workspaces/:id/tags', path: (f) => `/workspaces/${f.ws}/tags`, body: () => ({ name: `T${++seq}` }), expect: WRITE },
  { method: 'PATCH', route: '/tags/:id', path: (f) => `/tags/${f.tag}`, body: () => ({ color: '#123456' }), expect: ADMIN },
  { method: 'DELETE', route: '/tags/:id', path: (f) => `/tags/${f.tag}`, expect: ADMIN },
  { method: 'GET', route: '/workspaces/:id/teams', path: (f) => `/workspaces/${f.ws}/teams`, expect: READ },
  { method: 'POST', route: '/workspaces/:id/teams', path: (f) => `/workspaces/${f.ws}/teams`, body: () => ({ name: 'New team' }), expect: ADMIN },
  { method: 'PATCH', route: '/teams/:id', path: (f) => `/teams/${f.team}`, body: () => ({ name: 'Renamed' }), expect: ADMIN },
  { method: 'DELETE', route: '/teams/:id', path: (f) => `/teams/${f.team}`, expect: ADMIN },
  { method: 'PUT', route: '/teams/:id/members', path: (f) => `/teams/${f.team}/members`, body: () => ({ userIds: [] }), expect: ADMIN },
  { method: 'GET', route: '/workspaces/:id/task-views', path: (f) => `/workspaces/${f.ws}/task-views`, expect: READ },
  { method: 'POST', route: '/workspaces/:id/task-views', path: (f) => `/workspaces/${f.ws}/task-views`, body: () => ({ name: 'Mine', query: { filters: {}, sort: 'due', group: 'none' } }), expect: READ },
  { method: 'PATCH', route: '/task-views/:id', path: (f) => `/task-views/${f.view}`, body: () => ({ name: 'Renamed' }), expect: ADMIN },
  { method: 'DELETE', route: '/task-views/:id', path: (f) => `/task-views/${f.view}`, expect: ADMIN },
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
  { method: 'GET', route: '/pages/:id', path: (f) => `/pages/${f.page}`, expect: shared(inPrivate(READ), 200) },
  { method: 'GET', route: '/pages/:id/versions', path: (f) => `/pages/${f.page}/versions`, expect: shared(inPrivate(READ), 200) },
  { method: 'GET', route: '/pages/:id/versions/:vid', path: (f) => `/pages/${f.page}/versions/${f.version}`, expect: shared(inPrivate(READ), 200) },
  { method: 'POST', route: '/pages/:id/versions', path: (f) => `/pages/${f.page}/versions`, body: () => ({}), expect: shared(inPrivate(WRITE), 403, 200) },
  { method: 'GET', route: '/pages/:id/doc', path: (f) => `/pages/${f.page}/doc`, expect: shared(inPrivate(READ), 200) },
  { method: 'GET', route: '/pages/:id/backlinks', path: (f) => `/pages/${f.page}/backlinks`, expect: shared(inPrivate(READ), 200) },
  { method: 'PATCH', route: '/pages/:id', path: (f) => `/pages/${f.page}`, body: () => ({ title: 'Renamed' }), expect: shared(inPrivate(WRITE), 403, 200) },
  { method: 'POST', route: '/pages/:id/convert', path: (f) => `/pages/${f.page}/convert`, body: () => ({ kind: 'canvas' }), expect: shared(inPrivate(WRITE), 403, 200) },
  { method: 'POST', route: '/pages/:id/move', path: (f) => `/pages/${f.page}/move`, body: () => ({ index: 0 }), expect: shared(inPrivate(WRITE), 403) },
  { method: 'POST', route: '/pages/:id/copy', path: (f) => `/pages/${f.page}/copy`, body: () => ({}), expect: shared(inPrivate(WRITE), 403) },
  { method: 'DELETE', route: '/pages/:id', path: (f) => `/pages/${f.page}`, expect: shared(inPrivate(WRITE), 403) },
  // The task lives on the shared page: an edit page share covers it, a view share sees it but can't change it (#98 follow-up).
  { method: 'PATCH', route: '/tasks/:id', path: (f) => `/tasks/${f.task}`, body: () => ({ title: 'Renamed' }), expect: shared(inPrivate(WRITE), 403, 200) },
  { method: 'DELETE', route: '/tasks/:id', path: (f) => `/tasks/${f.task}`, expect: shared(inPrivate(WRITE), 403, 200) },
  { method: 'POST', route: '/workspaces/:id/files', path: (f) => `/workspaces/${f.ws}/files?pageId=${f.page}`, raw: true, expect: shared(inPrivate(WRITE), 403, 200) },
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
  { method: 'GET', route: '/tasks/:id/reminders', path: (f) => `/tasks/${f.task}/reminders`, expect: shared(inPrivate(READ), 200) }, // the task is on the shared page
  { method: 'POST', route: '/tasks/:id/reminders', path: (f) => `/tasks/${f.task}/reminders`, body: () => ({ kind: 'before', minutes: 5 }), expect: shared(inPrivate(READ), 200) }, // personal: anyone who sees the task may set their own
  // Someone else's reminder (the owner's): nobody else can touch it.
  { method: 'PATCH', route: '/reminders/:id', path: (f) => `/reminders/${f.reminder}`, body: () => ({ kind: 'before', minutes: 5 }), expect: { viewer: 404, member: 404 } },
  { method: 'DELETE', route: '/reminders/:id', path: (f) => `/reminders/${f.reminder}`, expect: { viewer: 404, member: 404 } },
  // Team view (#18), comments (#28), notifications (#29), activity (#33): audited as soon as they're registered.
  { method: 'GET', route: '/workspaces/:id/team', path: (f) => `/workspaces/${f.ws}/team`, expect: READ },
  { method: 'GET', route: '/workspaces/:id/activity', path: (f) => `/workspaces/${f.ws}/activity`, expect: READ },
  { method: 'GET', route: '/notifications', path: () => '/notifications', expect: { stranger: 200, ...READ } },
  { method: 'POST', route: '/notifications/read-all', path: () => '/notifications/read-all', expect: { stranger: 200, ...READ } },
  { method: 'POST', route: '/notifications/:id/read', path: () => `/notifications/${crypto.randomUUID()}/read`, expect: { stranger: 200, ...READ } }, // only ever touches your own
  { method: 'GET', route: '/pages/:id/comments', path: (f) => `/pages/${f.page}/comments`, expect: shared(inPrivate(READ), 200) },
  { method: 'POST', route: '/pages/:id/comments', path: (f) => `/pages/${f.page}/comments`, body: () => ({ threadId: crypto.randomUUID(), body: 'Hi' }), expect: shared(inPrivate(WRITE), 403, 200) },
  { method: 'POST', route: '/comment-threads/:id/replies', path: (f) => `/comment-threads/${f.thread}/replies`, body: () => ({ body: 'Reply' }), expect: shared(inPrivate(WRITE), 403, 200) },
  { method: 'PATCH', route: '/comment-threads/:id', path: (f) => `/comment-threads/${f.thread}`, body: () => ({ resolved: true }), expect: shared(inPrivate(WRITE), 403, 200) },
  { method: 'DELETE', route: '/comment-threads/:id', path: (f) => `/comment-threads/${f.thread}`, expect: shared(inPrivate(ADMIN), 403) }, // creator or admin
  { method: 'PATCH', route: '/comments/:id', path: (f) => `/comments/${f.comment}`, body: () => ({ body: 'Edit' }), expect: shared(inPrivate(ADMIN), 403) }, // author only
  { method: 'DELETE', route: '/comments/:id', path: (f) => `/comments/${f.comment}`, expect: shared(inPrivate(ADMIN), 403) }, // author or admin
  { method: 'GET', route: '/files/:id', path: (f) => `/files/${f.file}`, expect: shared(inPrivate(READ), 200) }, // AUTHZ-1, fixed in #52
  // Your own upload-link key: any signed-in user (the bytes are checked per file: tests/file-access.test.ts).
  { method: 'GET', route: '/files/key', path: () => '/files/key', expect: { stranger: 200, viewer: 200, member: 200 } },
  // User templates: workspace members list them; a template saved from a private page is visible to its creator (the owner) only.
  { method: 'GET', route: '/workspaces/:id/templates', path: (f) => `/workspaces/${f.ws}/templates`, expect: READ },
  { method: 'POST', route: '/pages/:id/templates', path: (f) => `/pages/${f.page}/templates`, body: () => ({ name: 'T', content: { type: 'doc', content: [] } }), expect: shared(inPrivate(WRITE), 403) },
  { method: 'PATCH', route: '/templates/:id', path: (f) => `/templates/${f.template}`, body: () => ({ name: 'Renamed' }), expect: inPrivate(ADMIN) }, // creator or admin only
  { method: 'DELETE', route: '/templates/:id', path: (f) => `/templates/${f.template}`, expect: inPrivate(ADMIN) }, // creator or admin only
  { method: 'POST', route: '/templates/:id/use', path: (f) => `/templates/${f.template}/use`, body: (f) => ({ pageId: f.page }), expect: shared(inPrivate(WRITE), 404) },
  // Section default template: editors of the notebook only. Claiming a page's pending template: editors with notebook access, never a page share.
  { method: 'PUT', route: '/sections/:id/default-template', path: (f) => `/sections/${f.sec}/default-template`, body: () => ({ templateId: null }), expect: inPrivate(WRITE) },
  { method: 'POST', route: '/pages/:id/pending-template', path: (f) => `/pages/${f.page}/pending-template`, expect: shared(inPrivate(WRITE), 403) },
  // Sharing one page (#98). Managing shares needs edit access to the page's notebook (creator only for a private
  // one); `target` holds a share on both fixture pages. /shared-pages is the caller's own list.
  { method: 'GET', route: '/pages/:id/shares', path: (f) => `/pages/${f.page}/shares`, expect: shared(inPrivate(WRITE), 403) },
  // Members share with members (sharing outside the workspace is for admins: tests/page-shares.test.ts).
  { method: 'POST', route: '/pages/:id/shares', path: (f) => `/pages/${f.page}/shares`, body: (f) => ({ userId: f.target, canEdit: false }), expect: shared(inPrivate(WRITE), 403) },
  { method: 'PATCH', route: '/pages/:id/shares/:userId', path: (f) => `/pages/${f.page}/shares/${f.target}`, body: () => ({ canEdit: false }), expect: shared(inPrivate(WRITE), 403) },
  { method: 'DELETE', route: '/pages/:id/shares/:userId', path: (f) => `/pages/${f.page}/shares/${f.target}`, expect: shared(inPrivate(WRITE), 403) },
  { method: 'DELETE', route: '/pages/:id/invites/:email', path: (f) => `/pages/${f.page}/invites/${encodeURIComponent(f.email)}`, expect: shared(inPrivate(WRITE), 403) },
  { method: 'GET', route: '/pages/:id/tasks', path: (f) => `/pages/${f.page}/tasks`, expect: shared(inPrivate(READ), 200) },
  { method: 'GET', route: '/shared-pages', path: () => '/shared-pages', expect: { stranger: 200, ...READ, pageshare: 200 } },
  { method: 'GET', route: '/pages/:id/people', path: (f) => `/pages/${f.page}/people`, expect: shared(inPrivate(READ), 200) },
  { method: 'GET', route: '/shared-tasks', path: () => '/shared-tasks', expect: { stranger: 200, ...READ, pageshare: 200 } }, // only my own assigned tasks
  // Import from OneNote (#117). The two browser redirects are public (no bearer token on a navigation): a bad ticket or state is a 400 for everyone.
  { method: 'GET', route: '/import/onenote/authorize', plain: true, path: () => '/import/onenote/authorize?ticket=not-a-ticket', expect: { anon: 400, stranger: 400, viewer: 400, member: 400, private: 400 } },
  { method: 'GET', route: '/import/onenote/callback', plain: true, path: () => '/import/onenote/callback?code=c&state=not-a-state', expect: { anon: 400, stranger: 400, viewer: 400, member: 400, private: 400 } },
  { method: 'GET', route: '/import/onenote', path: () => '/import/onenote', expect: { stranger: 200, viewer: 200, member: 200 } },
  { method: 'POST', route: '/import/onenote/start', path: () => '/import/onenote/start', body: (f) => ({ workspaceId: f.ws }), expect: WRITE }, // importing writes notebooks into the workspace
  // Connections and jobs are personal (random ids, checked against the user): nobody else's is reachable.
  { method: 'GET', route: '/import/onenote/connections/:id/notebooks', path: () => `/import/onenote/connections/${crypto.randomUUID()}/notebooks`, expect: { viewer: 404, member: 404 } },
  { method: 'POST', route: '/import/onenote/connections/:id/import', path: () => `/import/onenote/connections/${crypto.randomUUID()}/import`, body: () => ({ notebookIds: ['x'] }), expect: { viewer: 404, member: 404 } },
  { method: 'POST', route: '/import/onenote/jobs/:id/cancel', path: () => `/import/onenote/jobs/${crypto.randomUUID()}/cancel`, expect: { viewer: 404, member: 404 } },
  { method: 'GET', route: '/import/onenote/jobs/:id', path: () => `/import/onenote/jobs/${crypto.randomUUID()}`, expect: { viewer: 404, member: 404 } },
  // Feedback to the admins: any verified, signed-in user (not tied to a workspace).
  { method: 'POST', route: '/feedback', path: () => '/feedback', body: () => ({ message: 'Audit feedback', page: '/w/x/tasks/today', client: { version: 'test', platform: 'web' } }), expect: { stranger: 200, viewer: 200, member: 200 } },
];

const tokenOf = (who: Who) =>
  who === 'anon'
    ? undefined
    : who === 'stranger'
      ? stranger.token
      : who === 'viewer'
        ? viewer.token
        : who === 'pageshare'
          ? sharee.token
          : who === 'pageedit'
            ? editee.token
            : member.token;
const expected = (r: Row, who: Who): number =>
  r.expect[who] ??
  (who === 'anon'
    ? 401
    : who === 'stranger'
      ? 404
      : who === 'private'
        ? (r.expect.member ?? 404)
        : who === 'pageshare'
          ? expected(r, 'stranger')
          : who === 'pageedit'
            ? expected(r, 'pageshare')
            : 404);

async function runWith(r: Row, f: Fx, token: string | undefined): Promise<{ status: number; code?: string }> {
  if (r.raw) {
    const res = await fetch(`${app.origin}/api${r.path(f)}`, {
      method: r.method,
      headers: { 'content-type': 'text/plain', 'x-filename': 'a.txt', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: 'data',
    });
    return { status: res.status, code: (await res.json().catch(() => null))?.code };
  }
  if (r.plain) {
    const res = await fetch(`${app.origin}/api${r.path(f)}`, { method: r.method, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.status, code: res.headers.get('content-type')?.includes('json') ? (await res.json())?.code : (await res.arrayBuffer(), undefined) };
  }
  const res = await app.call(r.method, r.path(f), token, r.body?.(f));
  return { status: res.status, code: res.data?.code };
}
const run = async (r: Row, f: Fx, who: Who) => (await runWith(r, f, tokenOf(who))).status;

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
      const f = who === 'private' || who === 'pageshare' || who === 'pageedit' ? priv : shared;
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

// ── Unverified email ──
// A signed-in user whose email isn't confirmed gets 403 `email_unverified` on every authenticated route, even
// as a member of the workspace (worst case: a membership that predates the check), except the allowlist below.
// Public rows behave as for everyone (anon expectation).

/** Registers a user while mail is "configured", so the account starts unverified. */
async function signUpUnverified(): Promise<TestUser> {
  const { setMailTransport } = await import('../server/mail.ts');
  const nodemailer = (await import('nodemailer')).default;
  process.env.SMTP_HOST = 'smtp.example.test';
  const t = nodemailer.createTransport({ jsonTransport: true });
  setMailTransport(t);
  try {
    // (app.signUp would fail: it lists workspaces, which an unverified user may not.)
    const r = await app.call('POST', '/auth/register', undefined, { name: 'AzUnverified', email: `az-unverified-${++seq}@example.com`, password: 'password123' });
    assert.equal(r.status, 200);
    assert.equal(r.data.user.emailVerified, false, 'the persona must be unverified');
    return { token: r.data.accessToken, refreshToken: r.data.refreshToken, user: r.data.user, wsId: '', fileKey: r.data.fileKey };
  } finally {
    delete process.env.SMTP_HOST;
    setMailTransport(undefined);
  }
}
const UNVERIFIED_OK = new Set(['GET /me', 'POST /auth/resend-verification']);

test('authz: an unverified user is denied on every authenticated route, and only the allowlist works', async (t) => {
  const unv = await signUpUnverified();
  const { db } = await import('../server/db.ts');
  const { shared } = await fixture();
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)").run(shared.ws, unv.user.id, new Date().toISOString());
  const registered = await registeredRoutes();
  const got: string[] = [];
  let denied = 0;
  for (const r of ROWS) {
    const key = `${r.method} ${r.route}`;
    if (!registered.has(key)) continue;
    const isPublic = r.expect.anon !== undefined; // only public rows spell out the anonymous result
    const { status, code } = await runWith(r, shared, unv.token);
    if (isPublic) {
      assert.equal(status, r.expect.anon, `${key} (public) as unverified`);
    } else if (UNVERIFIED_OK.has(key)) {
      assert.equal(status, 200, `${key} (allowlisted) as unverified`);
    } else {
      assert.equal(status, 403, `${key} as unverified: expected 403 email_unverified, got ${status}  [${got.join(' ')}]`);
      assert.equal(code, 'email_unverified', `${key} as unverified: error code`);
      denied++;
    }
    got.push(`${key}=${status}`);
  }
  assert.ok(denied >= 60, `denied ${denied} routes`);
  t.diagnostic(`${denied} authenticated routes denied to an unverified user`);

  // The sign-in routes are public, so an unverified user can always get a session and end it.
  const login = await app.call('POST', '/auth/login', undefined, { email: unv.user.email, password: 'password123' });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.emailVerified, false);
});

test('authz: sockets refuse an unverified user (4403), including for a page they are a member of', async () => {
  const unv = await signUpUnverified();
  const { db } = await import('../server/db.ts');
  const { shared } = await fixture();
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)").run(shared.ws, unv.user.id, new Date().toISOString());
  for (const path of ['/api/events', `/collab/${shared.page}`]) {
    const r = await connect(path, unv.token);
    assert.equal(r.code, 4403, path);
    r.ws.terminate();
  }
  // Uploads too: a correctly signed link from an unverified member is refused.
  const { ext } = db.prepare('SELECT ext FROM files WHERE id = ?').get(shared.file) as { ext: string };
  assert.equal((await app.fetchFile(`/uploads/${shared.file}${ext}`, unv)).status, 403, 'uploads');
});

test('authz: nothing is mounted outside the audited /api router except uploads and /.well-known', async () => {
  // Express layers on the app itself. A new top-level mount fails here, so it has to be looked at: unverified
  // users must not reach it. /uploads/* checks its own signed links (tests/file-access.test.ts) and
  // /.well-known/* is public app-link metadata with no user data.
  const { createServer } = await import('../server/app.ts');
  const { app: express, server } = createServer({ serveWeb: false });
  try {
    const names = (express as unknown as { router: { stack: { name: string }[] } }).router.stack.map((l) => l.name);
    assert.deepEqual(names, ['securityHeaders', 'requestLog', '<anonymous>', 'router', 'router', 'serveUploads']);
  } finally {
    server.close();
  }
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
    ['pageshare', priv.page, null], // the page shared with them (view-only)
    ['pageshare', shared.page, 4403], // not shared with them
    ['pageedit', priv.page, null], // the page shared with them to edit
    ['pageedit', shared.page, 4403],
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
  const listeners = await Promise.all((['stranger', 'viewer', 'member', 'pageshare'] as Who[]).map(async (who) => {
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
  // The page share holder gets the task on the page shared with them, and nothing else from the workspace.
  assert.ok(sawTask('pageshare', priv.task), 'task on the shared page reaches its page share holder');
  assert.deepEqual(by.pageshare.filter((m) => m.type !== 'hello' && !(m.type === 'task' && m.task?.id === priv.task)), [], 'pageshare gets nothing else');
  for (const l of listeners) l.ws.terminate();
});

test('authz: a member with a view-only page share cannot change, delete or take over tasks on that page', async () => {
  // #98 review: seeing a task through a view-only share isn't edit access to it.
  const { priv } = await fixture();
  await app.call('POST', `/pages/${priv.page}/shares`, owner.token, { userId: member.user.id, canEdit: false });
  assert.equal((await app.call('GET', `/pages/${priv.page}`, member.token)).data.canEdit, false);
  assert.ok(((await app.call('GET', `/workspaces/${priv.ws}/tasks`, member.token)).data as { id: string }[]).some((t) => t.id === priv.task), 'the task is visible');
  for (const body of [{ title: 'Hijacked' }, { assigneeId: member.user.id }, { pageId: null }, { status: 'done' }, { dueDate: '2030-01-01' }])
    assert.equal((await app.call('PATCH', `/tasks/${priv.task}`, member.token, body)).status, 403, JSON.stringify(body));
  assert.equal((await app.call('DELETE', `/tasks/${priv.task}`, member.token)).status, 403);
  assert.equal((await app.call('POST', `/workspaces/${priv.ws}/tasks`, member.token, { title: 'Sub', parentId: priv.task })).status, 400, 'no subtasks either');
  // Unchanged after all that.
  const { getTask } = await import('../server/tasks.ts');
  const t = getTask(priv.task)!;
  assert.deepEqual([t.title, t.assigneeId, t.pageId, t.status], ['Task', null, priv.page, 'open']);
});

test('authz: the configured site admin can use the admin routes', async () => {
  const admin = await app.signUp('SiteAdmin', 'site-admin@example.com');
  assert.equal((await app.call('GET', '/admin/me', admin.token)).status, 200);
  assert.equal((await app.call('GET', '/admin/stats', admin.token)).status, 200);
});
