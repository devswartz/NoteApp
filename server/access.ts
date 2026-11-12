// Access-control helpers. All authorisation decisions go through here.
import { db } from './db.ts';
import type { Role } from '../shared/types.ts';

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

// ── Access changes ──
// Call accessChanged() after anything that can take access away: role or
// membership changes, a workspace or notebook deleted, a notebook made
// private, a page moved. Live connections (collab sockets) subscribe and
// re-check themselves, so this is the one place routes need to call.
const accessListeners = new Set<() => void>();
export function onAccessChange(fn: () => void): () => void {
  accessListeners.add(fn);
  return () => accessListeners.delete(fn);
}
export function accessChanged() {
  for (const fn of accessListeners) fn();
}

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
export const NOTEBOOK_VISIBLE_ANY = `(n.visibility = 'shared' OR n.created_by = @userId
  OR EXISTS (SELECT 1 FROM notebook_shares nsh WHERE nsh.notebook_id = n.id AND nsh.user_id = @userId))`;
/** The same, for notebooks that are not in Trash (everything outside the Trash view itself). */
export const NOTEBOOK_VISIBLE = `(n.deleted_at IS NULL AND ${NOTEBOOK_VISIBLE_ANY})`;

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

function notebookCtx(notebookId: string, withTrashed = false): NotebookCtx | null {
  return (
    (db
      .prepare(
        `SELECT workspace_id AS workspaceId, id AS notebookId, visibility, created_by AS createdBy FROM notebooks WHERE id = ?${withTrashed ? '' : ' AND deleted_at IS NULL'}`,
      )
      .get(notebookId) as NotebookCtx) ?? null
  );
}

export interface Access {
  workspaceId: string;
  notebookId: string;
  /** Workspace role; 'viewer' for someone outside the workspace who has a page share (whatever its canEdit). */
  role: Role;
  /** May change the page's content (or, for notebook/section access, add and change its pages). */
  canEdit: boolean;
  isNotebookOwner: boolean;
  /** Is a workspace member. False only for page-share-only access from outside the workspace. */
  member: boolean;
  /**
   * Access to the whole notebook with edit rights: may move, copy, delete and share the page.
   * False when the page is reachable only through a page share (page_shares, migration 013),
   * which never reveals or changes anything outside the page itself.
   */
  canManage: boolean;
  /** Access comes only from a page share, not from the page's notebook. */
  viaPageShare: boolean;
  /** The page is in Trash: readable by the people who could restore it, and nothing else (no editing, moving or sharing). */
  trashed?: boolean;
}

function accessFor(ctx: NotebookCtx | null, userId: string): Access | null {
  if (!ctx) return null;
  const role = roleIn(ctx.workspaceId, userId);
  if (!role) return null;
  if (ctx.visibility === 'private' && ctx.createdBy !== userId && !isSharedWith(ctx.notebookId, userId)) return null;
  const canEdit = atLeast(role, 'member');
  return {
    workspaceId: ctx.workspaceId,
    notebookId: ctx.notebookId,
    role,
    canEdit,
    isNotebookOwner: ctx.createdBy === userId,
    member: true,
    canManage: canEdit,
    viaPageShare: false,
  };
}

/** Access to a notebook that is not in Trash (a trashed notebook is gone as far as everything else is concerned). */
export function notebookAccess(notebookId: string, userId: string) {
  return accessFor(notebookCtx(notebookId), userId);
}

/** Access to a notebook whether or not it is in Trash: what the Trash view itself uses. */
export function notebookAccessAny(notebookId: string, userId: string) {
  return accessFor(notebookCtx(notebookId, true), userId);
}

export function sectionAccess(sectionId: string, userId: string) {
  const row = db.prepare('SELECT notebook_id FROM sections WHERE id = ? AND deleted_at IS NULL').get(sectionId) as
    | { notebook_id: string }
    | undefined;
  return row ? notebookAccess(row.notebook_id, userId) : null;
}

/** The page share `userId` holds on `pageId`, if any. */
export function pageShare(pageId: string, userId: string): { canEdit: boolean } | null {
  const r = db.prepare('SELECT can_edit FROM page_shares WHERE page_id = ? AND user_id = ?').get(pageId, userId) as { can_edit: number } | undefined;
  return r ? { canEdit: !!r.can_edit } : null;
}

/**
 * Access to one page: through its notebook (notebookAccess), or through a page share
 * (page_shares). A page share reaches that page only — never its notebook, siblings or
 * sub-pages. Effective rights: for a workspace member, the lesser of the share and the
 * workspace role (an edit share lets a member or above edit; a viewer stays view-only). For
 * someone outside the workspace, the share itself: an edit share lets them edit that page's
 * content (text, title, icon, comments, uploads into it) and the tasks that live on it
 * (create, tick, edit, delete, assign to people with access to the page; see server/tasks.ts).
 * Workspace-level things stay member-only whatever the share says: tasks elsewhere, moving
 * tasks on or off a page (canMoveTask and the collab task guard), templates, the tree, search
 * and the member list. A share never adds to notebook-level access. Every route and socket
 * that serves page content goes through here.
 */
export function pageAccess(pageId: string, userId: string): Access | null {
  const row = db
    .prepare('SELECT s.notebook_id, n.workspace_id, p.deleted_at FROM pages p JOIN sections s ON s.id = p.section_id JOIN notebooks n ON n.id = s.notebook_id WHERE p.id = ?')
    .get(pageId) as { notebook_id: string; workspace_id: string; deleted_at: string | null } | undefined;
  if (!row) return null;
  if (row.deleted_at) {
    // In Trash: only the people who could restore it (members who can see its notebook) may look, and only look.
    const a = notebookAccessAny(row.notebook_id, userId);
    return a && a.canEdit ? { ...a, canEdit: false, canManage: false, trashed: true } : null;
  }
  const nb = notebookAccess(row.notebook_id, userId);
  const share = pageShare(pageId, userId);
  if (nb) return nb;
  if (!share) return null;
  const role = roleIn(row.workspace_id, userId);
  return {
    workspaceId: row.workspace_id,
    notebookId: row.notebook_id,
    role: role ?? 'viewer',
    // Members: min(share, role). Outside the workspace: the share (#98 follow-up).
    canEdit: share.canEdit && (role === null || atLeast(role, 'member')),
    isNotebookOwner: false,
    member: !!role,
    canManage: false,
    viaPageShare: true,
  };
}

/** Someone who can open a page (GET /pages/:id/people): the assignee picker for its tasks. */
export interface PagePerson {
  id: string;
  name: string;
  color: string;
  /** A workspace member (else they have the page through a page share only). */
  member: boolean;
  /** May edit the page (and so its tasks). */
  canEdit: boolean;
}

/**
 * Everyone who can open `pageId`: workspace members who can see its notebook, and the people it
 * is shared with (page_shares). This is all a page share holder learns about who is in the
 * workspace (#98 follow-up), so it carries names and colours only, no emails or roles.
 */
export function pagePeople(pageId: string): PagePerson[] {
  const row = db
    .prepare('SELECT n.workspace_id AS ws FROM pages p JOIN sections s ON s.id = p.section_id JOIN notebooks n ON n.id = s.notebook_id WHERE p.id = ?')
    .get(pageId) as { ws: string } | undefined;
  if (!row) return [];
  const candidates = db
    .prepare(
      `SELECT u.id, u.name, u.color FROM users u WHERE u.id IN (
         SELECT user_id FROM workspace_members WHERE workspace_id = ? UNION SELECT user_id FROM page_shares WHERE page_id = ?)
       ORDER BY u.name`,
    )
    .all(row.ws, pageId) as { id: string; name: string; color: string }[];
  const out: PagePerson[] = [];
  for (const c of candidates) {
    const a = pageAccess(pageId, c.id);
    if (a) out.push({ ...c, member: a.member, canEdit: a.canEdit });
  }
  return out;
}

/** Throws unless the caller may move, copy, delete or share the page (notebook-level edit access). */
export function mustManage(a: Access | null): Access {
  const ok = mustAccess(a);
  if (!ok.canManage) throw new HttpError(403, 'Only people with edit access to its notebook can do that');
  return ok;
}

/**
 * May share the page with others: notebook-level edit access, and for a page in a private
 * notebook only that notebook's creator (the rule for sharing the notebook itself).
 */
export function canSharePage(a: Access): boolean {
  if (!a.canManage) return false;
  const nb = db.prepare('SELECT visibility FROM notebooks WHERE id = ?').get(a.notebookId) as { visibility: string } | undefined;
  return nb?.visibility !== 'private' || a.isNotebookOwner;
}

/** SQL predicate: @userId holds a page share on the page whose id is `pageIdExpr`. */
export const pageSharedSql = (pageIdExpr: string) =>
  `EXISTS (SELECT 1 FROM page_shares psh WHERE psh.page_id = ${pageIdExpr} AND psh.user_id = @userId)`;

/**
 * SQL predicate: page `pg` (in notebook `n`) is visible to @userId — through its notebook
 * (workspace membership included) or through a page share.
 */
export const PAGE_VISIBLE = `(pg.deleted_at IS NULL AND ((${NOTEBOOK_VISIBLE}
    AND EXISTS (SELECT 1 FROM workspace_members pvm WHERE pvm.workspace_id = n.workspace_id AND pvm.user_id = @userId))
  OR ${pageSharedSql('pg.id')}))`;

export function mustAccess<T extends Access | null>(a: T, edit = false): NonNullable<T> {
  if (!a) throw new HttpError(404, 'Not found');
  if (edit && !a.canEdit) throw new HttpError(403, 'You have view-only access');
  return a as NonNullable<T>;
}

/**
 * SQL predicate for tasks visible to @userId, given alias `t`.
 * A task is visible to workspace members unless it lives in someone else's
 * private notebook, or left one (private_owner_only, migration 010) — but the
 * assignee and creator can always see it. Someone with a page share (migration
 * 013) also sees the tasks that live on that page, member or not, except
 * private_owner_only ones.
 */
export const TASK_VISIBLE = `(
  (EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = t.workspace_id AND wm.user_id = @userId)
  AND (
    (t.page_id IS NULL AND t.private_owner_only = 0)
    OR t.assignee_id = @userId
    OR t.created_by = @userId
    OR EXISTS (
      SELECT 1 FROM pages p JOIN sections s ON s.id = p.section_id JOIN notebooks n ON n.id = s.notebook_id
      WHERE p.id = t.page_id AND ${NOTEBOOK_VISIBLE_ANY}
    )
  ))
  OR (t.page_id IS NOT NULL AND t.private_owner_only = 0 AND ${pageSharedSql('t.page_id')}
      AND EXISTS (SELECT 1 FROM pages tp WHERE tp.id = t.page_id AND tp.deleted_at IS NULL))
)`;

export function taskVisible(taskId: string, userId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM tasks t WHERE t.id = @taskId AND ${TASK_VISIBLE}`).get({ taskId, userId });
}
