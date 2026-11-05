// Workspaces, members and invites. Owner: Collaboration & Access.
import { Router } from 'express';
import { db, now } from '../db.ts';
import { accessChanged, mustAccess, notebookAccess, requireRole, roleIn } from '../access.ts';
import { refreshTasksForNotebook } from '../tree.ts';
import { publish } from '../events.ts';
import {
  createWorkspace,
  findInvite,
  memberIds,
  publicUrl,
  sendAddedEmail,
  sendInviteEmail,
  upsertInvite,
} from '../workspaces.ts';
import { HttpError, ROLES, h, param, str } from '../http.ts';
import type { Member, PendingInvite, Role, Workspace } from '../../shared/types.ts';

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
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(wsId);
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
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string } | undefined;
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
    const inv = findInvite(param(req, 'token'));
    if (!inv) throw new HttpError(404, 'This invite link is no longer valid');
    const { expiresAt: _e, ...info } = inv;
    return info;
  }),
);

// Accept an invite link as the signed-in user. The link alone isn't enough:
// the account's email must be the one that was invited.
workspaceRoutes.post(
  '/invites/:token/accept',
  h((req) => {
    const inv = findInvite(param(req, 'token'));
    if (!inv) throw new HttpError(404, 'This invite link is no longer valid');
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
    })();
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
