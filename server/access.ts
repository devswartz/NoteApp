// Access-control helpers. All authorisation decisions go through here.
import { db } from './db.ts';
import type { Role } from '../shared/types.ts';

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function roleIn(workspaceId: string, userId: string): Role | null {
  const row = db
    .prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(workspaceId, userId) as { role: Role } | undefined;
  return row?.role ?? null;
}

export function atLeast(role: Role | null, min: Role): boolean {
  return role !== null && RANK[role] >= RANK[min];
}

/** Throws unless the user has at least `min` role in the workspace. Returns the role. */
export function requireRole(workspaceId: string, userId: string, min: Role): Role {
  const role = roleIn(workspaceId, userId);
  if (!role) throw new HttpError(404, 'Workspace not found');
  if (!atLeast(role, min)) throw new HttpError(403, 'You do not have permission to do that');
  return role;
}

/**
 * SQL predicate: notebook `n` is visible to user `@userId` (workspace membership is checked separately).
 * Shared notebooks are visible to all members; private ones only to their creator and the
 * people it was shared with (notebook_shares).
 */
export const NOTEBOOK_VISIBLE = `(n.visibility = 'shared' OR n.created_by = @userId
  OR EXISTS (SELECT 1 FROM notebook_shares nsh WHERE nsh.notebook_id = n.id AND nsh.user_id = @userId))`;

/** True if `userId` was given access to private notebook `notebookId`. */
export function isSharedWith(notebookId: string, userId: string): boolean {
  return !!db.prepare('SELECT 1 FROM notebook_shares WHERE notebook_id = ? AND user_id = ?').get(notebookId, userId);
}

interface NotebookCtx {
  workspaceId: string;
  notebookId: string;
  visibility: string;
  createdBy: string;
}

function notebookCtx(notebookId: string): NotebookCtx | null {
  return (
    (db
      .prepare(
        'SELECT workspace_id AS workspaceId, id AS notebookId, visibility, created_by AS createdBy FROM notebooks WHERE id = ?',
      )
      .get(notebookId) as NotebookCtx) ?? null
  );
}

export interface Access {
  workspaceId: string;
  notebookId: string;
  role: Role;
  canEdit: boolean;
  isNotebookOwner: boolean;
}

function accessFor(ctx: NotebookCtx | null, userId: string): Access | null {
  if (!ctx) return null;
  const role = roleIn(ctx.workspaceId, userId);
  if (!role) return null;
  if (ctx.visibility === 'private' && ctx.createdBy !== userId && !isSharedWith(ctx.notebookId, userId)) return null;
  return {
    workspaceId: ctx.workspaceId,
    notebookId: ctx.notebookId,
    role,
    canEdit: atLeast(role, 'member'),
    isNotebookOwner: ctx.createdBy === userId,
  };
}

export function notebookAccess(notebookId: string, userId: string) {
  return accessFor(notebookCtx(notebookId), userId);
}

export function sectionAccess(sectionId: string, userId: string) {
  const row = db.prepare('SELECT notebook_id FROM sections WHERE id = ?').get(sectionId) as
    | { notebook_id: string }
    | undefined;
  return row ? notebookAccess(row.notebook_id, userId) : null;
}

export function pageAccess(pageId: string, userId: string) {
  const row = db
    .prepare('SELECT s.notebook_id FROM pages p JOIN sections s ON s.id = p.section_id WHERE p.id = ?')
    .get(pageId) as { notebook_id: string } | undefined;
  return row ? notebookAccess(row.notebook_id, userId) : null;
}

export function mustAccess<T extends Access | null>(a: T, edit = false): NonNullable<T> {
  if (!a) throw new HttpError(404, 'Not found');
  if (edit && !a.canEdit) throw new HttpError(403, 'You have view-only access');
  return a as NonNullable<T>;
}

/**
 * SQL predicate for tasks visible to @userId, given alias `t`.
 * A task is visible to workspace members unless it lives in someone else's
 * private notebook — but the assignee and creator can always see it.
 */
export const TASK_VISIBLE = `
  EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = t.workspace_id AND wm.user_id = @userId)
  AND (
    t.page_id IS NULL
    OR t.assignee_id = @userId
    OR t.created_by = @userId
    OR EXISTS (
      SELECT 1 FROM pages p JOIN sections s ON s.id = p.section_id JOIN notebooks n ON n.id = s.notebook_id
      WHERE p.id = t.page_id AND ${NOTEBOOK_VISIBLE}
    )
  )`;

export function taskVisible(taskId: string, userId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM tasks t WHERE t.id = @taskId AND ${TASK_VISIBLE}`).get({ taskId, userId });
}
