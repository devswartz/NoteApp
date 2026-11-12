// Trash: deleting a page, section or notebook moves it here for 60 days (see migration 019-trash.sql for how it is
// stored). Everything that reads the tree, search, tasks or exports filters trashed rows out through the shared
// predicates in access.ts (NOTEBOOK_VISIBLE, PAGE_VISIBLE, TASK_VISIBLE) or an explicit "deleted_at IS NULL"; this
// module is where rows enter and leave Trash, and where the Trash view's list and its permissions live.
import { HttpError, accessChanged, atLeast, notebookAccessAny, roleIn } from './access.ts';
import { db, now } from './db.ts';
import { publish } from './events.ts';
import { closeRoom } from './collab.ts';
import { detachPagesTasks, sectionSubtree } from './tree.ts';
import { rowToTask } from './tasks.ts';
import type { TrashItem, TrashKind } from '../shared/types.ts';

/** How long trashed items are kept before the daily job removes them for good. */
export const TRASH_DAYS = 60;
const DAY_MS = 86_400_000;

type TaskRow = Parameters<typeof rowToTask>[0];
export type { TrashKind };
const TABLE = { page: 'pages', section: 'sections', notebook: 'notebooks' } as const;

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** Hide the tasks on these pages: they keep their page and come back with it. Returns how many (and whose) were hidden. */
function hideTasks(pageIds: string[], trashId: string): { id: string; workspaceId: string; assigneeId: string | null }[] {
  if (!pageIds.length) return [];
  const rows = db
    .prepare(`SELECT id, workspace_id AS workspaceId, assignee_id AS assigneeId FROM tasks WHERE page_id IN (${placeholders(pageIds.length)}) AND trash_id IS NULL`)
    .all(...pageIds) as { id: string; workspaceId: string; assigneeId: string | null }[];
  db.prepare(`UPDATE tasks SET trash_id = ? WHERE page_id IN (${placeholders(pageIds.length)}) AND trash_id IS NULL`).run(trashId, ...pageIds);
  return rows;
}

/** What a trash action did, for the toast: how many tasks went out of sight with it. */
export interface Trashed {
  trashId: string;
  tasksHidden: number;
}

/** Flag these live sections and their live pages (and the pages' tasks) as one batch. */
function trashSections(sectionIds: string[], trashId: string, userId: string, at: string) {
  let pageIds: string[] = [];
  if (sectionIds.length) {
    pageIds = (
      db.prepare(`SELECT id FROM pages WHERE section_id IN (${placeholders(sectionIds.length)}) AND deleted_at IS NULL`).all(...sectionIds) as { id: string }[]
    ).map((r) => r.id);
    db.prepare(`UPDATE sections SET deleted_at = ?, deleted_by = ?, trash_id = ? WHERE id IN (${placeholders(sectionIds.length)})`).run(at, userId, trashId, ...sectionIds);
    db.prepare(`UPDATE pages SET deleted_at = ?, deleted_by = ?, trash_id = ? WHERE section_id IN (${placeholders(sectionIds.length)}) AND deleted_at IS NULL`).run(at, userId, trashId, ...sectionIds);
  }
  return pageIds;
}

function afterTrash(workspaceId: string, pageIds: string[], hidden: { id: string; workspaceId: string }[]) {
  for (const id of pageIds) {
    db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(id); // out of search while in Trash (restored on restore)
    closeRoom(id); // anyone editing it is let go; they can still open it read-only
  }
  for (const t of hidden) publish({ type: 'task-deleted', id: t.id, workspaceId: t.workspaceId });
  accessChanged();
  publish({ type: 'tree', workspaceId });
}

/** Move a page to Trash. */
export function trashPage(pageId: string, workspaceId: string, userId: string, at = now()): Trashed {
  let hidden: ReturnType<typeof hideTasks> = [];
  db.transaction(() => {
    db.prepare('UPDATE pages SET deleted_at = ?, deleted_by = ?, trash_id = ? WHERE id = ? AND deleted_at IS NULL').run(at, userId, pageId, pageId);
    hidden = hideTasks([pageId], pageId);
  })();
  afterTrash(workspaceId, [pageId], hidden);
  return { trashId: pageId, tasksHidden: hidden.length };
}

/** Move a section, its subsections and their pages to Trash. */
export function trashSection(sectionId: string, workspaceId: string, userId: string, at = now()): Trashed {
  let pageIds: string[] = [];
  let hidden: ReturnType<typeof hideTasks> = [];
  db.transaction(() => {
    // Subsections already in Trash on their own keep their own entry (and their own 60 days).
    const live = sectionSubtree(sectionId).filter((id) => !db.prepare('SELECT deleted_at FROM sections WHERE id = ?').pluck().get(id));
    pageIds = trashSections(live, sectionId, userId, at);
    hidden = hideTasks(pageIds, sectionId);
  })();
  afterTrash(workspaceId, pageIds, hidden);
  return { trashId: sectionId, tasksHidden: hidden.length };
}

/** Move a notebook, with its sections and pages, to Trash. */
export function trashNotebook(notebookId: string, workspaceId: string, userId: string, at = now()): Trashed {
  let pageIds: string[] = [];
  let hidden: ReturnType<typeof hideTasks> = [];
  db.transaction(() => {
    const sections = (db.prepare('SELECT id FROM sections WHERE notebook_id = ? AND deleted_at IS NULL').all(notebookId) as { id: string }[]).map((r) => r.id);
    pageIds = trashSections(sections, notebookId, userId, at);
    db.prepare('UPDATE notebooks SET deleted_at = ?, deleted_by = ?, trash_id = ? WHERE id = ?').run(at, userId, notebookId, notebookId);
    hidden = hideTasks(pageIds, notebookId);
  })();
  afterTrash(workspaceId, pageIds, hidden);
  return { trashId: notebookId, tasksHidden: hidden.length };
}

// ───────── Who may see and act on what is in Trash ─────────

interface Root {
  kind: TrashKind;
  id: string;
  workspaceId: string;
  notebookId: string;
  deletedAt: string;
  deletedBy: string | null;
  name: string;
}

/** The item at the top of a trash batch (the one the Trash lists), or null if there is no such entry. */
function rootOf(kind: TrashKind, id: string): Root | null {
  const common = `deleted_at AS deletedAt, deleted_by AS deletedBy`;
  const row =
    kind === 'notebook'
      ? db.prepare(`SELECT 'notebook' AS kind, id, workspace_id AS workspaceId, id AS notebookId, ${common}, name FROM notebooks WHERE id = ? AND trash_id = id AND deleted_at IS NOT NULL`).get(id)
      : kind === 'section'
        ? db
            .prepare(
              `SELECT 'section' AS kind, s.id, n.workspace_id AS workspaceId, s.notebook_id AS notebookId, s.deleted_at AS deletedAt, s.deleted_by AS deletedBy, s.name
               FROM sections s JOIN notebooks n ON n.id = s.notebook_id WHERE s.id = ? AND s.trash_id = s.id AND s.deleted_at IS NOT NULL`,
            )
            .get(id)
        : db
            .prepare(
              `SELECT 'page' AS kind, p.id, n.workspace_id AS workspaceId, s.notebook_id AS notebookId, p.deleted_at AS deletedAt, p.deleted_by AS deletedBy, p.title AS name
               FROM pages p JOIN sections s ON s.id = p.section_id JOIN notebooks n ON n.id = s.notebook_id WHERE p.id = ? AND p.trash_id = p.id AND p.deleted_at IS NOT NULL`,
            )
            .get(id);
  return (row as Root | undefined) ?? null;
}

/**
 * May `userId` see this trash entry and restore or delete it? The same people who could delete it: members who can see
 * its notebook (a private notebook's trash is visible only to people who could see the notebook), and for a notebook
 * its creator or a workspace admin. Viewers and page-share holders see nothing.
 */
function canActOn(root: Root, userId: string): boolean {
  const a = notebookAccessAny(root.notebookId, userId);
  if (!a || !a.canEdit) return false;
  if (root.kind === 'notebook') return a.isNotebookOwner || atLeast(a.role, 'admin');
  return true;
}

function mustActOn(kind: TrashKind, id: string, userId: string): Root {
  const root = rootOf(kind, id);
  if (!root || !canActOn(root, userId)) throw new HttpError(404, 'That is not in the Trash');
  return root;
}

/** The workspace's Trash as `userId` may see it, newest first. */
export function listTrash(workspaceId: string, userId: string, at = new Date()): TrashItem[] {
  const role = roleIn(workspaceId, userId);
  if (!role || !atLeast(role, 'member')) return [];
  const rows = [
    ...(db
      .prepare(`SELECT 'notebook' AS kind, n.id FROM notebooks n WHERE n.workspace_id = ? AND n.trash_id = n.id AND n.deleted_at IS NOT NULL`)
      .all(workspaceId) as { kind: TrashKind; id: string }[]),
    ...(db
      .prepare(
        `SELECT 'section' AS kind, s.id FROM sections s JOIN notebooks n ON n.id = s.notebook_id WHERE n.workspace_id = ? AND s.trash_id = s.id AND s.deleted_at IS NOT NULL`,
      )
      .all(workspaceId) as { kind: TrashKind; id: string }[]),
    ...(db
      .prepare(
        `SELECT 'page' AS kind, p.id FROM pages p JOIN sections s ON s.id = p.section_id JOIN notebooks n ON n.id = s.notebook_id WHERE n.workspace_id = ? AND p.trash_id = p.id AND p.deleted_at IS NOT NULL`,
      )
      .all(workspaceId) as { kind: TrashKind; id: string }[]),
  ];
  const out: TrashItem[] = [];
  for (const r of rows) {
    const root = rootOf(r.kind, r.id);
    if (!root || !canActOn(root, userId)) continue;
    const by = root.deletedBy ? (db.prepare('SELECT name FROM users WHERE id = ?').pluck().get(root.deletedBy) as string | undefined) : undefined;
    const pages = root.kind === 'page' ? 0 : (db.prepare('SELECT COUNT(*) FROM pages WHERE trash_id = ?').pluck().get(root.id) as number);
    const sections = root.kind === 'notebook' ? (db.prepare('SELECT COUNT(*) FROM sections WHERE trash_id = ?').pluck().get(root.id) as number) : root.kind === 'section' ? (db.prepare('SELECT COUNT(*) FROM sections WHERE trash_id = ?').pluck().get(root.id) as number) - 1 : 0;
    const where = trashPath(root);
    const expires = new Date(new Date(root.deletedAt).getTime() + TRASH_DAYS * DAY_MS);
    out.push({
      kind: root.kind,
      id: root.id,
      name: root.name,
      icon: root.kind === 'page' ? ((db.prepare('SELECT icon FROM pages WHERE id = ?').pluck().get(root.id) as string | null) ?? null) : null,
      deletedAt: root.deletedAt,
      deletedBy: root.deletedBy,
      deletedByName: by ?? null,
      expiresAt: expires.toISOString(),
      daysLeft: Math.max(0, Math.ceil((expires.getTime() - at.getTime()) / DAY_MS)),
      path: where,
      pages,
      sections: Math.max(0, sections),
    });
  }
  return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

/** Where a trashed item used to be: "Notebook › Section" (for a page or section). */
function trashPath(root: Root): string {
  const nb = db.prepare('SELECT name FROM notebooks WHERE id = ?').pluck().get(root.notebookId) as string | undefined;
  if (root.kind === 'notebook') return '';
  const parts: string[] = [];
  let sectionId = root.kind === 'page' ? (db.prepare('SELECT section_id FROM pages WHERE id = ?').pluck().get(root.id) as string) : (db.prepare('SELECT parent_id FROM sections WHERE id = ?').pluck().get(root.id) as string | null);
  for (let i = 0; sectionId && i < 20; i++) {
    const s = db.prepare('SELECT name, parent_id FROM sections WHERE id = ?').get(sectionId) as { name: string; parent_id: string | null } | undefined;
    if (!s) break;
    parts.unshift(s.name);
    sectionId = s.parent_id as string;
  }
  return [nb, ...parts].filter(Boolean).join(' › ');
}

// ───────── Restore ─────────

export interface Restored {
  /** It could not go back where it was (its section or parent is gone) and went here instead; "" when it went back as it was. */
  movedTo: string;
}

/**
 * Put a trashed item (with everything that was trashed with it) back. A page goes back to its section, a section to its
 * parent section, a notebook as it was. If the parent is gone, a page goes to the first section of its notebook and a
 * section to the top of its notebook, and the result says so. If the notebook is in Trash too, restore that first.
 */
export function restoreItem(kind: TrashKind, id: string, userId: string): Restored {
  const root = mustActOn(kind, id, userId);
  let movedTo = '';
  const restoredPages = (db.prepare('SELECT id FROM pages WHERE trash_id = ?').all(id) as { id: string }[]).map((r) => r.id);
  const restoredTasks = (db.prepare('SELECT id FROM tasks WHERE trash_id = ?').all(id) as { id: string }[]).map((r) => r.id);
  db.transaction(() => {
    if (kind !== 'notebook') {
      const nbLive = db.prepare('SELECT 1 FROM notebooks WHERE id = ? AND deleted_at IS NULL').get(root.notebookId);
      if (!nbLive) throw new HttpError(409, 'Its notebook is in the Trash too. Restore the notebook first.');
    }
    if (kind === 'page') {
      const sectionId = db.prepare('SELECT section_id FROM pages WHERE id = ?').pluck().get(id) as string;
      const ok = db.prepare('SELECT 1 FROM sections WHERE id = ? AND deleted_at IS NULL').get(sectionId);
      if (!ok) {
        const first = db
          .prepare('SELECT id, name FROM sections WHERE notebook_id = ? AND deleted_at IS NULL ORDER BY (parent_id IS NOT NULL), position LIMIT 1')
          .get(root.notebookId) as { id: string; name: string } | undefined;
        if (!first) throw new HttpError(409, 'Its notebook has no section to put it in. Add a section, or restore the one it was in.');
        db.prepare('UPDATE pages SET section_id = ? WHERE id = ?').run(first.id, id);
        movedTo = first.name;
      }
    } else if (kind === 'section') {
      const parentId = db.prepare('SELECT parent_id FROM sections WHERE id = ?').pluck().get(id) as string | null;
      if (parentId && !db.prepare('SELECT 1 FROM sections WHERE id = ? AND deleted_at IS NULL').get(parentId)) {
        db.prepare('UPDATE sections SET parent_id = NULL WHERE id = ?').run(id);
        movedTo = (db.prepare('SELECT name FROM notebooks WHERE id = ?').pluck().get(root.notebookId) as string) ?? '';
      }
    }
    db.prepare('UPDATE pages SET deleted_at = NULL, deleted_by = NULL, trash_id = NULL WHERE trash_id = ?').run(id);
    db.prepare('UPDATE sections SET deleted_at = NULL, deleted_by = NULL, trash_id = NULL WHERE trash_id = ?').run(id);
    db.prepare('UPDATE notebooks SET deleted_at = NULL, deleted_by = NULL, trash_id = NULL WHERE trash_id = ?').run(id);
    db.prepare('UPDATE tasks SET trash_id = NULL WHERE trash_id = ?').run(id);
    for (const pid of restoredPages) {
      const p = db.prepare('SELECT title, text FROM pages WHERE id = ?').get(pid) as { title: string; text: string };
      db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(pid);
      db.prepare('INSERT INTO pages_fts (page_id, title, text) VALUES (?, ?, ?)').run(pid, p.title, p.text);
    }
  })();
  for (const tid of restoredTasks) {
    const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(tid) as TaskRow | undefined;
    if (r) publish({ type: 'task', task: rowToTask(r) });
  }
  accessChanged();
  publish({ type: 'tree', workspaceId: root.workspaceId });
  return { movedTo };
}

// ───────── Delete forever ─────────

/**
 * Remove a trash entry for good: the item and everything in it, with its versions, comments, shares and Yjs docs (they
 * cascade). Its files become private to the uploader and its tasks standalone, as deleting always did: that is the
 * point where that happens now.
 */
export function purgeItem(kind: TrashKind, id: string, userId: string | null) {
  const root = userId ? mustActOn(kind, id, userId) : rootOf(kind, id);
  if (!root) return;
  purgeRoot(root);
}

function purgeRoot(root: Root) {
  const pageIds = (db.prepare('SELECT id FROM pages WHERE trash_id = ?').all(root.id) as { id: string }[]).map((r) => r.id);
  // A section or page trashed on its own earlier, inside a notebook trashed later, goes with the notebook (it cascades).
  const inside =
    root.kind === 'notebook'
      ? (db.prepare('SELECT p.id FROM pages p JOIN sections s ON s.id = p.section_id WHERE s.notebook_id = ?').all(root.id) as { id: string }[]).map((r) => r.id)
      : root.kind === 'section'
        ? (db.prepare(`SELECT id FROM pages WHERE section_id IN (${placeholders(sectionSubtreeAll(root.id).length)})`).all(...sectionSubtreeAll(root.id)) as { id: string }[]).map((r) => r.id)
        : pageIds;
  const all = [...new Set([...pageIds, ...inside])];
  const standalone = all.length ? (db.prepare(`SELECT id FROM tasks WHERE page_id IN (${placeholders(all.length)})`).all(...all) as { id: string }[]).map((r) => r.id) : [];
  detachPagesTasks(all, () => {
    db.prepare(`DELETE FROM ${TABLE[root.kind]} WHERE id = ?`).run(root.id);
    // Their page is gone, so they are standalone now, and no longer hidden.
    db.prepare('UPDATE tasks SET trash_id = NULL WHERE trash_id IS NOT NULL AND page_id IS NULL').run();
  });
  for (const tid of standalone) {
    const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(tid) as TaskRow | undefined;
    if (r) publish({ type: 'task', task: rowToTask(r) });
  }
  accessChanged();
  publish({ type: 'tree', workspaceId: root.workspaceId });
}

/** A section and everything nested under it, trashed or not. */
function sectionSubtreeAll(sectionId: string): string[] {
  return (
    db
      .prepare(
        `WITH RECURSIVE sub(id, lvl) AS (SELECT ?, 0 UNION SELECT s.id, sub.lvl + 1 FROM sections s JOIN sub ON s.parent_id = sub.id WHERE sub.lvl < 20) SELECT id FROM sub`,
      )
      .all(sectionId) as { id: string }[]
  ).map((r) => r.id);
}

/** Delete forever everything in a workspace's Trash that `userId` can see. Returns how many entries went. */
export function emptyTrash(workspaceId: string, userId: string): number {
  const role = roleIn(workspaceId, userId);
  if (!role || !atLeast(role, 'admin')) throw new HttpError(403, 'Only workspace owners and admins can empty the Trash');
  const items = listTrash(workspaceId, userId);
  for (const it of items) {
    const root = rootOf(it.kind, it.id);
    if (root) purgeRoot(root); // an earlier one may have taken it with it
  }
  return items.length;
}

/** The daily job: delete forever whatever has been in Trash longer than TRASH_DAYS. `at` is injectable for tests. */
export function purgeExpired(at = new Date()): number {
  const cutoff = new Date(at.getTime() - TRASH_DAYS * DAY_MS).toISOString();
  const expired: Root[] = [];
  for (const kind of ['notebook', 'section', 'page'] as const) {
    const t = TABLE[kind];
    const ids = db.prepare(`SELECT id FROM ${t} WHERE trash_id = id AND deleted_at IS NOT NULL AND deleted_at < ?`).all(cutoff) as { id: string }[];
    for (const r of ids) {
      const root = rootOf(kind, r.id);
      if (root) expired.push(root);
    }
  }
  // Notebooks first: they take their separately trashed sections and pages with them.
  const order = { notebook: 0, section: 1, page: 2 } as const;
  expired.sort((a, b) => order[a.kind] - order[b.kind]);
  let n = 0;
  for (const root of expired) {
    if (!rootOf(root.kind, root.id)) continue; // already taken by one above
    purgeRoot(root);
    n++;
  }
  return n;
}
