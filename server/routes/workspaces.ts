// Workspaces, members and invites. Owner: Collaboration & Access.
import { Router } from 'express';
import { db, now } from '../db.ts';
import { requireRole, roleIn } from '../access.ts';
import { publish } from '../events.ts';
import { createWorkspace, memberIds } from '../workspaces.ts';
import { HttpError, ROLES, h, param, str } from '../http.ts';
import type { Member, Role, Workspace } from '../../shared/types.ts';

export const workspaceRoutes = Router();

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
        ? db.prepare('SELECT email, role FROM workspace_invites WHERE workspace_id = ? ORDER BY created_at').all(wsId)
        : [];
    return { members, invites };
  }),
);

workspaceRoutes.post(
  '/workspaces/:id/members',
  h((req) => {
    const wsId = param(req, 'id');
    const myRole = requireRole(wsId, req.user.id, 'admin');
    const email = str(req.body.email, 'Email', 200).toLowerCase();
    const role: Role = ROLES.includes(req.body.role) ? req.body.role : 'member';
    if (role === 'owner' && myRole !== 'owner') throw new HttpError(403, 'Only owners can add owners');
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string } | undefined;
    if (user) {
      if (roleIn(wsId, user.id)) throw new HttpError(409, 'That person is already a member');
      db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(wsId, user.id, role, now());
      publish({ type: 'workspaces' }, { userIds: [user.id] });
      publish({ type: 'members', workspaceId: wsId });
      return { status: 'added' };
    }
    db.prepare(
      `INSERT INTO workspace_invites (workspace_id, email, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, email) DO UPDATE SET role = excluded.role`,
    ).run(wsId, email, role, req.user.id, now());
    publish({ type: 'members', workspaceId: wsId });
    return { status: 'invited' };
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
    })();
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
    db.prepare('DELETE FROM workspace_invites WHERE workspace_id = ? AND email = ?').run(wsId, param(req, 'email'));
    publish({ type: 'members', workspaceId: wsId });
    return { ok: true };
  }),
);
