// Workspaces, members and invites. Owner: Collaboration & Access.
import { Router } from 'express';
import { db, now } from '../db.ts';
import { TASK_VISIBLE, accessChanged, mustAccess, mustManage, notebookAccess, pageAccess, requireRole, roleIn } from '../access.ts';
import { refreshTasksForNotebook } from '../tree.ts';
import { publish } from '../events.ts';
import { rowToTask } from '../tasks.ts';
import { removeFiles, templateFilePaths } from '../templates.ts';
import {
  createWorkspace,
  findInvite,
  findPageInvite,
  grantPageShare,
  sendPageSharedEmail,
  upsertPageInvite,
  memberIds,
  publicUrl,
  sendAddedEmail,
  sendInviteEmail,
  upsertInvite,
} from '../workspaces.ts';
import { HttpError, ROLES, h, param, str } from '../http.ts';
import type { InviteInfo, Member, PageShare, PageShares, PendingInvite, Role, SharedPage, TeamMember, Workspace } from '../../shared/types.ts';

export const workspaceRoutes = Router();
/** Routes that work without a token (the invite landing page). */
export const publicWorkspaceRoutes = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const userName = (id: string) => (db.prepare('SELECT name FROM users WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? 'Someone';
const workspaceName = (id: string) => (db.prepare('SELECT name FROM workspaces WHERE id = ?').get(id) as { name: string }).name;

workspaceRoutes.get(
  '/workspaces',
  h(
    (req) =>
      db
        .prepare(
          `SELECT w.id, w.name, m.role, w.created_at AS createdAt FROM workspaces w
           JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at`,
        )
        .all(req.user.id) as Workspace[],
  ),
);

workspaceRoutes.post(
  '/workspaces',
  h((req) => {
    const id = db.transaction(() => createWorkspace(req.user.id, str(req.body.name, 'Name', 100), false))();
    return { id };
  }),
);

workspaceRoutes.patch(
  '/workspaces/:id',
  h((req) => {
    const wsId = param(req, 'id');
    requireRole(wsId, req.user.id, 'admin');
    db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(str(req.body.name, 'Name', 100), wsId);
    publish({ type: 'workspaces' }, { userIds: memberIds(wsId) });
    return { ok: true };
  }),
);

workspaceRoutes.delete(
  '/workspaces/:id',
  h((req) => {
    const wsId = param(req, 'id');
    requireRole(wsId, req.user.id, 'owner');
    const members = memberIds(wsId);
    const templateFiles = templateFilePaths((db.prepare('SELECT id FROM templates WHERE workspace_id = ?').all(wsId) as { id: string }[]).map((t) => t.id));
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(wsId);
    removeFiles(templateFiles); // template attachment copies don't outlive their workspace
    accessChanged();
    publish({ type: 'workspaces' }, { userIds: members });
    return { ok: true };
  }),
);

workspaceRoutes.get(
  '/workspaces/:id/members',
  h((req) => {
    const wsId = param(req, 'id');
    const role = requireRole(wsId, req.user.id, 'viewer');
    const members = db
      .prepare(
        `SELECT u.id, u.email, u.name, u.color, m.role FROM workspace_members m JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = ? ORDER BY u.name COLLATE NOCASE`,
      )
      .all(wsId) as Member[];
    const invites =
      role === 'owner' || role === 'admin'
        ? (db
            .prepare(
              `SELECT email, role, invited_by AS invitedBy, created_at AS createdAt, expires_at AS expiresAt
               FROM workspace_invites WHERE workspace_id = ? ORDER BY created_at`,
            )
            .all(wsId) as PendingInvite[])
        : [];
    return { members, invites };
  }),
);

// Invite by email. An existing user is added straight away (and told by email);
// anyone else gets an invite link by email. Returns the link so an admin can
// copy it when SMTP isn't configured.
workspaceRoutes.post(
  '/workspaces/:id/members',
  h(async (req) => {
    const wsId = param(req, 'id');
    const myRole = requireRole(wsId, req.user.id, 'admin');
    const email = str(req.body.email, 'Email', 200).toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address');
    const role: Role = ROLES.includes(req.body.role) ? req.body.role : 'member';
    if (role === 'owner' && myRole !== 'owner') throw new HttpError(403, 'Only owners can add owners');
    const base = publicUrl(req.get('origin'));
    const mail = { to: email, workspaceName: workspaceName(wsId), inviterName: userName(req.user.id), role };
    // An account that hasn't confirmed its email can't be added directly (its owner may not own the address):
    // it gets a pending invite, which is applied when the email is confirmed.
    const user = db.prepare('SELECT id FROM users WHERE email = ? AND email_verified_at IS NOT NULL').get(email) as { id: string } | undefined;
    if (user) {
      if (roleIn(wsId, user.id)) throw new HttpError(409, 'That person is already a member');
      db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(wsId, user.id, role, now());
      db.prepare('DELETE FROM workspace_invites WHERE workspace_id = ? AND email = ?').run(wsId, email);
      publish({ type: 'workspaces' }, { userIds: [user.id] });
      publish({ type: 'members', workspaceId: wsId });
      const r = await sendAddedEmail({ ...mail, link: `${base}/w/${wsId}` });
      return { status: 'added', emailed: r.sent };
    }
    const token = upsertInvite(wsId, email, role, req.user.id);
    publish({ type: 'members', workspaceId: wsId });
    const inviteUrl = `${base}/invite/${token}`;
    const r = await sendInviteEmail({ ...mail, link: inviteUrl });
    return { status: 'invited', emailed: r.sent, inviteUrl };
  }),
);

// Re-send a pending invite with a fresh link (the old link stops working).
workspaceRoutes.post(
  '/workspaces/:id/invites/:email/resend',
  h(async (req) => {
    const wsId = param(req, 'id');
    requireRole(wsId, req.user.id, 'admin');
    const email = param(req, 'email').toLowerCase();
    const inv = db.prepare('SELECT role FROM workspace_invites WHERE workspace_id = ? AND email = ?').get(wsId, email) as
      | { role: Role }
      | undefined;
    if (!inv) throw new HttpError(404, 'Invite not found');
    const token = upsertInvite(wsId, email, inv.role, req.user.id);
    publish({ type: 'members', workspaceId: wsId });
    const inviteUrl = `${publicUrl(req.get('origin'))}/invite/${token}`;
    const r = await sendInviteEmail({ to: email, link: inviteUrl, workspaceName: workspaceName(wsId), inviterName: userName(req.user.id), role: inv.role });
    return { status: 'invited', emailed: r.sent, inviteUrl };
  }),
);

// What an invite link is for (shown on the landing page before signing in).
publicWorkspaceRoutes.get(
  '/invites/:token',
  h((req) => {
    const token = param(req, 'token');
    const inv = findInvite(token);
    if (inv) {
      const { expiresAt: _e, ...info } = inv;
      return info;
    }
    const pinv = findPageInvite(token);
    if (!pinv) throw new HttpError(404, 'This invite link is no longer valid');
    return {
      workspaceId: pinv.workspaceId,
      workspaceName: pinv.workspaceName,
      invitedByName: pinv.invitedByName,
      email: pinv.email,
      role: 'viewer',
      expired: pinv.expired,
      page: { id: pinv.pageId, title: pinv.pageTitle, canEdit: pinv.canEdit },
    } satisfies InviteInfo;
  }),
);

// Accept an invite link as the signed-in user. The link alone isn't enough:
// the account's email must be the one that was invited.
workspaceRoutes.post(
  '/invites/:token/accept',
  h((req) => {
    const token = param(req, 'token');
    const inv = findInvite(token);
    if (!inv) return acceptPageInvite(req.user.id, req.user.email, token);
    if (inv.expired) throw new HttpError(410, 'This invite has expired. Ask for a new one.');
    if (req.user.email.toLowerCase() !== inv.email.toLowerCase())
      throw new HttpError(403, `This invite was sent to ${inv.email}. Sign in with that email address to accept it.`);
    db.transaction(() => {
      if (!roleIn(inv.workspaceId, req.user.id))
        db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(
          inv.workspaceId,
          req.user.id,
          inv.role,
          now(),
        );
      db.prepare('DELETE FROM workspace_invites WHERE workspace_id = ? AND email = ?').run(inv.workspaceId, inv.email);
    })();
    publish({ type: 'workspaces' }, { userIds: [req.user.id] });
    publish({ type: 'members', workspaceId: inv.workspaceId });
    return { workspaceId: inv.workspaceId };
  }),
);

function ownerCount(wsId: string) {
  return (db.prepare("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND role = 'owner'").get(wsId) as { n: number }).n;
}

workspaceRoutes.patch(
  '/workspaces/:id/members/:userId',
  h((req) => {
    const wsId = param(req, 'id');
    const target = param(req, 'userId');
    const myRole = requireRole(wsId, req.user.id, 'admin');
    const role = req.body.role as Role;
    if (!ROLES.includes(role)) throw new HttpError(400, 'Invalid role');
    const current = roleIn(wsId, target);
    if (!current) throw new HttpError(404, 'Member not found');
    if ((role === 'owner' || current === 'owner') && myRole !== 'owner') throw new HttpError(403, 'Only owners can change owners');
    if (current === 'owner' && role !== 'owner' && ownerCount(wsId) === 1) throw new HttpError(400, 'A workspace needs at least one owner');
    db.prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?').run(role, wsId, target);
    accessChanged(); // e.g. demoted to viewer: open editors go read-only
    publish({ type: 'members', workspaceId: wsId });
    publish({ type: 'workspaces' }, { userIds: [target] });
    return { ok: true };
  }),
);

workspaceRoutes.delete(
  '/workspaces/:id/members/:userId',
  h((req) => {
    const wsId = param(req, 'id');
    const target = param(req, 'userId');
    const self = target === req.user.id;
    const myRole = requireRole(wsId, req.user.id, self ? 'viewer' : 'admin');
    const current = roleIn(wsId, target);
    if (!current) throw new HttpError(404, 'Member not found');
    if (current === 'owner' && !self && myRole !== 'owner') throw new HttpError(403, 'Only owners can remove owners');
    if (current === 'owner' && ownerCount(wsId) === 1) throw new HttpError(400, 'A workspace needs at least one owner');
    db.transaction(() => {
      db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(wsId, target);
      db.prepare("UPDATE tasks SET assignee_id = NULL WHERE workspace_id = ? AND assignee_id = ? AND status = 'open'").run(wsId, target);
      db.prepare('DELETE FROM notebook_shares WHERE user_id = ? AND notebook_id IN (SELECT id FROM notebooks WHERE workspace_id = ?)').run(target, wsId);
      db.prepare(
        `DELETE FROM page_shares WHERE user_id = ? AND page_id IN
           (SELECT p.id FROM pages p JOIN sections s ON s.id = p.section_id JOIN notebooks n ON n.id = s.notebook_id WHERE n.workspace_id = ?)`,
      ).run(target, wsId);
    })();
    publish({ type: 'shared-pages' }, { userIds: [target] });
    accessChanged(); // drop them from pages they have open
    publish({ type: 'members', workspaceId: wsId });
    publish({ type: 'workspaces' }, { userIds: [target] });
    return { ok: true };
  }),
);

workspaceRoutes.delete(
  '/workspaces/:id/invites/:email',
  h((req) => {
    const wsId = param(req, 'id');
    requireRole(wsId, req.user.id, 'admin');
    db.prepare('DELETE FROM workspace_invites WHERE workspace_id = ? AND email = ?').run(wsId, param(req, 'email').toLowerCase());
    publish({ type: 'members', workspaceId: wsId });
    return { ok: true };
  }),
);

// ───────────── Sharing a private notebook with specific people ─────────────

function notebookShares(notebookId: string): string[] {
  return (db.prepare('SELECT user_id FROM notebook_shares WHERE notebook_id = ? ORDER BY created_at').all(notebookId) as { user_id: string }[]).map(
    (r) => r.user_id,
  );
}

workspaceRoutes.get(
  '/notebooks/:id/shares',
  h((req) => {
    const id = param(req, 'id');
    mustAccess(notebookAccess(id, req.user.id));
    const nb = db.prepare('SELECT visibility, created_by AS createdBy FROM notebooks WHERE id = ?').get(id) as {
      visibility: string;
      createdBy: string;
    };
    return { ...nb, userIds: notebookShares(id) };
  }),
);

// Replace the list of people a private notebook is shared with. Creator only.
workspaceRoutes.put(
  '/notebooks/:id/shares',
  h((req) => {
    const id = param(req, 'id');
    const a = mustAccess(notebookAccess(id, req.user.id));
    if (!a.isNotebookOwner) throw new HttpError(403, 'Only the notebook’s creator can change who it’s shared with');
    const raw: unknown = req.body.userIds;
    if (!Array.isArray(raw) || raw.some((u) => typeof u !== 'string') || raw.length > 500) throw new HttpError(400, 'userIds must be a list of user ids');
    const wanted = new Set((raw as string[]).filter((u) => u !== req.user.id));
    for (const u of wanted) if (!roleIn(a.workspaceId, u)) throw new HttpError(400, 'You can only share with members of this workspace');
    const before = new Set(notebookShares(id));
    const removed = [...before].filter((u) => !wanted.has(u));
    const added = [...wanted].filter((u) => !before.has(u));
    db.transaction(() => {
      for (const u of removed) db.prepare('DELETE FROM notebook_shares WHERE notebook_id = ? AND user_id = ?').run(id, u);
      for (const u of added)
        db.prepare('INSERT INTO notebook_shares (notebook_id, user_id, created_by, created_at) VALUES (?, ?, ?, ?)').run(id, u, req.user.id, now());
    })();
    if (removed.length || added.length) {
      if (removed.length) accessChanged(); // unshared people are disconnected from its pages
      publish({ type: 'tree', workspaceId: a.workspaceId });
      refreshTasksForNotebook(id);
    }
    return { userIds: notebookShares(id) };
  }),
);

// ───────────── Sharing a single page (#98, migration 013) ─────────────
// A page share reaches one page only (see pageAccess in server/access.ts).
// Who may share: anyone who can manage the page (edit access to its notebook);
// in a private notebook, only the notebook's creator — the same rule as
// sharing the notebook itself. Someone outside the workspace gets view-only
// access to that page, and nothing else in the workspace.

const MAX_PAGE_SHARES = 200;

/** The page's access for a would-be sharer, or a 403/404. */
function mustShare(pageId: string, userId: string) {
  const a = mustManage(pageAccess(pageId, userId));
  const nb = db.prepare('SELECT visibility FROM notebooks WHERE id = ?').get(a.notebookId) as { visibility: string };
  if (nb.visibility === 'private' && !a.isNotebookOwner) throw new HttpError(403, 'Only the notebook’s creator can share pages from a private notebook');
  return a;
}

function pageShares(pageId: string, workspaceId: string): PageShares {
  const shares = (
    db
      .prepare(
        `SELECT u.id AS userId, u.name, u.email, u.color, ps.can_edit AS canEdit,
           EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = ? AND m.user_id = u.id) AS member
         FROM page_shares ps JOIN users u ON u.id = ps.user_id WHERE ps.page_id = ? ORDER BY ps.created_at, u.name`,
      )
      .all(workspaceId, pageId) as (Omit<PageShare, 'canEdit' | 'member'> & { canEdit: number; member: number })[]
  ).map((r) => ({ ...r, canEdit: !!r.canEdit, member: !!r.member }));
  const invites = (
    db
      .prepare('SELECT email, can_edit AS canEdit, expires_at AS expiresAt, created_at AS createdAt FROM page_invites WHERE page_id = ? ORDER BY created_at')
      .all(pageId) as { email: string; canEdit: number; expiresAt: string | null; createdAt: string }[]
  ).map((r) => ({ ...r, canEdit: !!r.canEdit }));
  return { shares, invites };
}

const pageTitle = (id: string) => (db.prepare('SELECT title FROM pages WHERE id = ?').get(id) as { title: string }).title || 'Untitled';

/** Link to a shared page in emails: the app opens it from "Shared with me". */
const pageLink = (base: string, pageId: string) => `${base}/shared/${pageId}`;

function sharesChanged(pageId: string, userIds: string[], revoked: boolean) {
  if (revoked) accessChanged(); // revoked or downgraded: open editors close (4403) or go read-only
  publish({ type: 'shared-pages' }, { userIds });
  refreshPageTasks(pageId); // its tasks appear for (or vanish from) the people affected
}

function refreshPageTasks(pageId: string) {
  const rows = db.prepare('SELECT * FROM tasks WHERE page_id = ?').all(pageId) as Parameters<typeof rowToTask>[0][];
  for (const r of rows) publish({ type: 'task', task: rowToTask(r) });
}

workspaceRoutes.get(
  '/pages/:id/shares',
  h((req) => {
    const id = param(req, 'id');
    const a = mustShare(id, req.user.id);
    return pageShares(id, a.workspaceId);
  }),
);

// Share with one person: { userId } (a workspace member) or { email } (anyone), and { canEdit }.
// An existing, verified account gets the share straight away (and an email); anyone else gets an
// invite link by email, applied when they sign up and confirm that address or open the link.
workspaceRoutes.post(
  '/pages/:id/shares',
  h(async (req) => {
    const id = param(req, 'id');
    const a = mustShare(id, req.user.id);
    const b = req.body ?? {};
    const canEdit = b.canEdit === true;
    let target: { id: string; email: string } | undefined;
    let email: string | null = null;
    if (typeof b.userId === 'string') {
      target = db.prepare('SELECT id, email FROM users WHERE id = ? AND email_verified_at IS NOT NULL').get(b.userId) as typeof target;
      if (!target || !roleIn(a.workspaceId, target.id)) throw new HttpError(400, 'Pick a member of this workspace, or share by email');
    } else {
      email = str(b.email, 'Email', 200).toLowerCase();
      if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address');
      target = db.prepare('SELECT id, email FROM users WHERE email = ? AND email_verified_at IS NOT NULL').get(email) as typeof target;
    }
    if (target?.id === req.user.id) throw new HttpError(400, 'You already have access to this page');
    const count = (db.prepare('SELECT (SELECT COUNT(*) FROM page_shares WHERE page_id = ?) + (SELECT COUNT(*) FROM page_invites WHERE page_id = ?) AS n').get(id, id) as { n: number }).n;
    if (count >= MAX_PAGE_SHARES) throw new HttpError(400, `A page can be shared with at most ${MAX_PAGE_SHARES} people`);
    const base = publicUrl(req.get('origin'));
    const mail = { pageTitle: pageTitle(id), inviterName: userName(req.user.id), canEdit };
    if (target) {
      const member = !!roleIn(a.workspaceId, target.id);
      const before = db.prepare('SELECT can_edit FROM page_shares WHERE page_id = ? AND user_id = ?').get(id, target.id) as { can_edit: number } | undefined;
      grantPageShare(id, target.id, canEdit, req.user.id);
      if (email) db.prepare('DELETE FROM page_invites WHERE page_id = ? AND email = ?').run(id, email);
      sharesChanged(id, [target.id], !!before?.can_edit && !canEdit);
      const r = before ? { sent: false } : await sendPageSharedEmail({ ...mail, canEdit: canEdit && member, to: target.email, link: pageLink(base, id), invite: false });
      return { status: 'shared', emailed: r.sent, ...pageShares(id, a.workspaceId) };
    }
    const token = upsertPageInvite(id, email!, canEdit, req.user.id);
    const inviteUrl = `${base}/invite/${token}`;
    const r = await sendPageSharedEmail({ ...mail, canEdit: false, to: email!, link: inviteUrl, invite: true });
    return { status: 'invited', emailed: r.sent, inviteUrl, ...pageShares(id, a.workspaceId) };
  }),
);

// Change what a share grants: { canEdit }.
workspaceRoutes.patch(
  '/pages/:id/shares/:userId',
  h((req) => {
    const id = param(req, 'id');
    const target = param(req, 'userId');
    const a = mustShare(id, req.user.id);
    const r = db.prepare('UPDATE page_shares SET can_edit = ? WHERE page_id = ? AND user_id = ?').run(req.body?.canEdit === true ? 1 : 0, id, target);
    if (!r.changes) throw new HttpError(404, 'Share not found');
    sharesChanged(id, [target], req.body?.canEdit !== true);
    return pageShares(id, a.workspaceId);
  }),
);

// Stop sharing with someone. Their open editor on the page is closed (4403). Anyone holding a
// share may also remove their own (“Remove from Shared with me”).
workspaceRoutes.delete(
  '/pages/:id/shares/:userId',
  h((req) => {
    const id = param(req, 'id');
    const target = param(req, 'userId');
    const a = target === req.user.id ? mustAccess(pageAccess(id, req.user.id)) : mustShare(id, req.user.id);
    const r = db.prepare('DELETE FROM page_shares WHERE page_id = ? AND user_id = ?').run(id, target);
    if (!r.changes) throw new HttpError(404, 'Share not found');
    sharesChanged(id, [target], true);
    return pageShares(id, a.workspaceId);
  }),
);

workspaceRoutes.delete(
  '/pages/:id/invites/:email',
  h((req) => {
    const id = param(req, 'id');
    const a = mustShare(id, req.user.id);
    db.prepare('DELETE FROM page_invites WHERE page_id = ? AND email = ?').run(id, param(req, 'email').toLowerCase());
    return pageShares(id, a.workspaceId);
  }),
);

// Pages shared with me, newest first, across workspaces (the sidebar's "Shared with me").
workspaceRoutes.get(
  '/shared-pages',
  h((req) => {
    const rows = db
      .prepare(
        `SELECT p.id, p.title, p.icon, n.workspace_id AS workspaceId, w.name AS workspaceName, ps.can_edit AS canEdit,
           EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = n.workspace_id AND m.user_id = ps.user_id) AS member,
           u.name AS sharedByName, ps.created_at AS sharedAt
         FROM page_shares ps JOIN pages p ON p.id = ps.page_id JOIN sections s ON s.id = p.section_id
         JOIN notebooks n ON n.id = s.notebook_id JOIN workspaces w ON w.id = n.workspace_id
         LEFT JOIN users u ON u.id = ps.created_by
         WHERE ps.user_id = ? ORDER BY ps.created_at DESC`,
      )
      .all(req.user.id) as (Omit<SharedPage, 'canEdit' | 'member'> & { canEdit: number; member: number })[];
    // canEdit is what the user can actually do: outside the workspace, view only.
    return rows.map((r) => ({ ...r, member: !!r.member, canEdit: !!r.member && !!r.canEdit })) satisfies SharedPage[];
  }),
);

// The tasks that live on a page, as the caller may see them (TASK_VISIBLE): what the page's task
// references render from. Workspace members already have these from GET /workspaces/:id/tasks; this is
// for someone holding a page share from outside the workspace.
workspaceRoutes.get(
  '/pages/:id/tasks',
  h((req) => {
    const id = param(req, 'id');
    mustAccess(pageAccess(id, req.user.id));
    const rows = db
      .prepare(`SELECT * FROM tasks t WHERE t.page_id = @id AND t.occurrence_of IS NULL AND ${TASK_VISIBLE} ORDER BY t.created_at LIMIT 1000`)
      .all({ id, userId: req.user.id }) as Parameters<typeof rowToTask>[0][];
    return rows.map(rowToTask);
  }),
);

/** POST /invites/:token/accept for a page invite: the account's email must be the invited one. */
function acceptPageInvite(userId: string, email: string, token: string) {
  const inv = findPageInvite(token);
  if (!inv) throw new HttpError(404, 'This invite link is no longer valid');
  if (inv.expired) throw new HttpError(410, 'This invite has expired. Ask for a new one.');
  if (email.toLowerCase() !== inv.email.toLowerCase())
    throw new HttpError(403, `This invite was sent to ${inv.email}. Sign in with that email address to accept it.`);
  db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM page_shares WHERE page_id = ? AND user_id = ?').get(inv.pageId, userId))
      grantPageShare(inv.pageId, userId, inv.canEdit, null);
    db.prepare('DELETE FROM page_invites WHERE page_id = ? AND email = ?').run(inv.pageId, inv.email);
  })();
  publish({ type: 'shared-pages' }, { userIds: [userId] });
  refreshPageTasks(inv.pageId);
  return { workspaceId: inv.workspaceId, pageId: inv.pageId };
}

// ───────────── Team view ─────────────
// Members plus their open task load, for the Tasks dashboard's Team view.
// Counts only tasks the caller can see (private notebooks stay private).
// `?today=YYYY-MM-DD` is the caller's local date (defaults to the server's UTC date).
workspaceRoutes.get(
  '/workspaces/:id/team',
  h((req) => {
    const wsId = param(req, 'id');
    requireRole(wsId, req.user.id, 'viewer');
    const q = String(req.query.today ?? '');
    const today = /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : new Date().toISOString().slice(0, 10);
    return db
      .prepare(
        `SELECT u.id, u.email, u.name, u.color, m.role,
           COUNT(t.id) AS openTasks,
           COALESCE(SUM(t.due_date < @today), 0) AS overdueTasks,
           COALESCE(SUM(t.due_date = @today), 0) AS dueTodayTasks
         FROM workspace_members m JOIN users u ON u.id = m.user_id
         LEFT JOIN tasks t ON t.workspace_id = m.workspace_id AND t.assignee_id = m.user_id AND t.status = 'open'
           AND ${TASK_VISIBLE}
         WHERE m.workspace_id = @wsId
         GROUP BY u.id ORDER BY u.name COLLATE NOCASE`,
      )
      .all({ wsId, today, userId: req.user.id }) as TeamMember[];
  }),
);
