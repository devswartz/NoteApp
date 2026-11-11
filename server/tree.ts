// Tree helpers (notebooks / sections / pages) used by more than one route module.
import * as Y from 'yjs';
import { HttpError } from './access.ts';
import { db, newId, now } from './db.ts';
import { publish } from './events.ts';
import { keepPrivateWhenDetaching, rowToTask } from './tasks.ts';
import { closeRoom, flushAll } from './collab.ts';
import { MAX_SECTION_DEPTH } from '../shared/sections.ts';
import { pageFragments } from '../shared/pageDoc.ts';

type TaskRow = Parameters<typeof rowToTask>[0];

/** Next position at the end of a sibling list. */
export const nextPos = (table: 'notebooks' | 'sections' | 'pages', col: string, id: string) =>
  ((db.prepare(`SELECT MAX(position) AS m FROM ${table} WHERE ${col} = ?`).get(id) as { m: number | null }).m ?? 0) + 1;

/** Re-broadcast tasks whose visibility may have changed. */
export function refreshTasksForNotebook(notebookId: string) {
  const rows = db
    .prepare('SELECT t.* FROM tasks t JOIN pages p ON p.id = t.page_id JOIN sections s ON s.id = p.section_id WHERE s.notebook_id = ?')
    .all(notebookId) as TaskRow[];
  for (const r of rows) publish({ type: 'task', task: rowToTask(r) });
}

/**
 * Deleting notes never deletes their tasks: they become standalone tasks. Their files become
 * private to the uploader. `del` runs the actual DELETE.
 */
export function detachPagesTasks(pageIds: string[], del: () => void) {
  const affected: string[] = [];
  db.transaction(() => {
    for (const id of pageIds) {
      affected.push(...(db.prepare('SELECT id FROM tasks WHERE page_id = ?').all(id) as { id: string }[]).map((r) => r.id));
      db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(id);
      keepPrivateWhenDetaching('page_id = ?', id); // tasks from a private notebook stay private
      // Files attached to a deleted page must not become visible to the whole workspace
      // (pages.id → files.page_id is ON DELETE SET NULL). Without a workspace, a file's
      // metadata is visible only to its uploader (GET /files/:id). The bytes stay at their
      // capability URL, so copies of the page that embed them keep working.
      db.prepare('UPDATE files SET workspace_id = NULL WHERE page_id = ?').run(id);
    }
    del();
  })();
  for (const id of pageIds) closeRoom(id);
  for (const id of affected) {
    const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    if (r) publish({ type: 'task', task: rowToTask(r) });
  }
}

type Table = 'notebooks' | 'sections' | 'pages';

/**
 * Position that puts an item at `index` among its siblings (0 = first), ignoring
 * the item itself. Positions are REAL, so inserting between two items averages them.
 */
export function positionAt(table: Table, col: string, parentId: string, index: number, selfId?: string): number {
  const sibs = (db.prepare(`SELECT id, position FROM ${table} WHERE ${col} = ? ORDER BY position`).all(parentId) as {
    id: string;
    position: number;
  }[]).filter((s) => s.id !== selfId);
  if (!sibs.length) return 1;
  if (!Number.isFinite(index) || index >= sibs.length) return sibs[sibs.length - 1].position + 1;
  if (index <= 0) return sibs[0].position - 1;
  return (sibs[index - 1].position + sibs[index].position) / 2;
}

/** Collect the taskRef ids in a page's Yjs document (in document order). */
export function taskRefsInDoc(doc: Y.Doc): Y.XmlElement[] {
  const out: Y.XmlElement[] = [];
  const walk = (node: Y.XmlFragment | Y.XmlElement) => {
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlElement) {
        if (child.nodeName === 'taskRef') out.push(child);
        walk(child);
      }
    }
  };
  for (const frag of pageFragments(doc)) walk(frag);
  return out;
}

/**
 * Duplicate a page into `sectionId`. The copy gets its own copies of the tasks it
 * embeds (new ids, rewritten in the document): two pages must never claim one task.
 * Returns the new page id and the ids of the new tasks.
 */
export function copyPage(pageId: string, sectionId: string, userId: string, opts: { title?: string; position?: number } = {}) {
  flushAll(); // save edits still pending in open collab rooms, so the copy is current
  const src = db.prepare('SELECT * FROM pages WHERE id = ?').get(pageId) as
    | { title: string; icon: string | null; kind: string; ydoc: Buffer | null; text: string }
    | undefined;
  if (!src) throw new Error('page not found');
  const doc = new Y.Doc();
  if (src.ydoc) Y.applyUpdate(doc, new Uint8Array(src.ydoc));

  const id = newId();
  const ts = now();
  const newTasks: string[] = [];
  db.transaction(() => {
    const position = opts.position ?? nextPos('pages', 'section_id', sectionId);
    const title = opts.title ?? src.title;
    db.prepare(
      `INSERT INTO pages (id, section_id, title, icon, kind, text, position, created_by, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, sectionId, title, src.icon, src.kind, src.text, position, userId, ts, ts, userId);
    for (const el of taskRefsInDoc(doc)) {
      const oldId = el.getAttribute('taskId');
      // Only tasks this page owns are cloned. A reference to any other task (another page's,
      // another workspace's, or a deleted one) is dropped from the copy rather than cloned or
      // left in place, where the copy's next save would claim that task.
      const row =
        typeof oldId === 'string'
          ? (db.prepare('SELECT * FROM tasks WHERE id = ? AND page_id = ? AND occurrence_of IS NULL').get(oldId, pageId) as Record<string, unknown> | undefined)
          : undefined;
      if (!row) {
        const parent = el.parent as Y.XmlElement | Y.XmlFragment | null;
        if (parent) {
          const idx = parent.toArray().indexOf(el);
          if (idx >= 0) parent.delete(idx, 1);
        }
        continue;
      }
      const copy: Record<string, unknown> = { ...row, id: newId(), page_id: id, occurrence_of: null, created_by: userId, created_at: ts, updated_at: ts };
      const cols = Object.keys(copy);
      db.prepare(`INSERT INTO tasks (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(copy);
      el.setAttribute('taskId', copy.id as string);
      newTasks.push(copy.id as string);
    }
    db.prepare('UPDATE pages SET ydoc = ? WHERE id = ?').run(Buffer.from(Y.encodeStateAsUpdate(doc)), id);
    db.prepare('INSERT INTO pages_fts (page_id, title, text) VALUES (?, ?, ?)').run(id, title, src.text);
  })();
  doc.destroy();
  for (const tid of newTasks) {
    const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(tid) as TaskRow;
    publish({ type: 'task', task: rowToTask(r) });
  }
  return { id, taskIds: newTasks };
}

/**
 * Notebook/section colours are rendered into styles, so only "#rrggbb" is accepted.
 * A missing value takes `fallback()` (a random palette colour on create; updates pass one that throws).
 */
export function validColor(v: unknown, fallback: () => string): string {
  if (v === undefined || v === null || v === '') return fallback();
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v.trim())) throw new HttpError(400, 'Colour must look like #4f46e5');
  return v.trim().toLowerCase();
}

// ── Subsections ──
// A section may sit inside another section of the same notebook (sections.parent_id), up to
// MAX_SECTION_DEPTH levels. Every section keeps its notebook_id, so access checks are unchanged.

type SectionLink = { id: string; name: string; notebook_id: string; parent_id: string | null };

/** Ids of `sectionId` and all sections nested under it (parents before children). */
export function sectionSubtree(sectionId: string): string[] {
  return (
    db
      .prepare(
        `WITH RECURSIVE sub(id, lvl) AS (SELECT ?, 0 UNION SELECT s.id, sub.lvl + 1 FROM sections s JOIN sub ON s.parent_id = sub.id WHERE sub.lvl < 20)
         SELECT id FROM sub ORDER BY lvl`,
      )
      .all(sectionId) as { id: string }[]
  ).map((r) => r.id);
}

/** Section rows from the top-level ancestor down to `sectionId` (inclusive). */
export function sectionChain(sectionId: string): SectionLink[] {
  const out: SectionLink[] = [];
  const get = db.prepare('SELECT id, name, notebook_id, parent_id FROM sections WHERE id = ?');
  for (let id: string | null = sectionId; id && out.length < 20; ) {
    const r = get.get(id) as SectionLink | undefined;
    if (!r || out.some((x) => x.id === r.id)) break;
    out.unshift(r);
    id = r.parent_id;
  }
  return out;
}

/** Levels in the subtree rooted at `sectionId` (1 when it has no subsections). */
export function sectionHeight(sectionId: string): number {
  return (
    db
      .prepare(
        `WITH RECURSIVE sub(id, lvl) AS (SELECT ?, 1 UNION SELECT s.id, sub.lvl + 1 FROM sections s JOIN sub ON s.parent_id = sub.id WHERE sub.lvl < 20)
         SELECT MAX(lvl) AS h FROM sub`,
      )
      .get(sectionId) as { h: number }
  ).h;
}

/** Section names from the top level down, e.g. ["Projects", "Alpha"]. */
export const sectionPathNames = (sectionId: string) => sectionChain(sectionId).map((s) => s.name);

type Sib = { id: string; position: number };
const sectionSiblings = (notebookId: string, parentId: string | null): Sib[] =>
  (parentId
    ? db.prepare('SELECT id, position FROM sections WHERE parent_id = ? ORDER BY position').all(parentId)
    : db.prepare('SELECT id, position FROM sections WHERE notebook_id = ? AND parent_id IS NULL ORDER BY position').all(notebookId)) as Sib[];

/** Position at the end of a section's siblings (the top level of a notebook, or inside a parent section). */
export const nextSectionPos = (notebookId: string, parentId: string | null) => (sectionSiblings(notebookId, parentId).at(-1)?.position ?? 0) + 1;

/** Like positionAt, among a section's siblings. */
export function sectionPositionAt(notebookId: string, parentId: string | null, index: number, selfId?: string): number {
  const sibs = sectionSiblings(notebookId, parentId).filter((s) => s.id !== selfId);
  if (!sibs.length) return 1;
  if (!Number.isFinite(index) || index >= sibs.length) return sibs[sibs.length - 1].position + 1;
  if (index <= 0) return sibs[0].position - 1;
  return (sibs[index - 1].position + sibs[index].position) / 2;
}

/**
 * Check that a section may live under `parentId` (null = the top level of `notebookId`): the parent
 * is in that notebook, isn't the section itself or one of its subsections, and the result stays
 * within MAX_SECTION_DEPTH levels. `sectionId` is null for a new section.
 */
export function checkSectionParent(sectionId: string | null, notebookId: string, parentId: string | null) {
  if (!parentId) return;
  const parent = db.prepare('SELECT notebook_id FROM sections WHERE id = ?').get(parentId) as { notebook_id: string } | undefined;
  if (!parent) throw new HttpError(404, 'That section no longer exists');
  if (parent.notebook_id !== notebookId) throw new HttpError(400, 'A subsection must be in the same notebook as its parent');
  if (sectionId && sectionSubtree(sectionId).includes(parentId))
    throw new HttpError(400, 'A section cannot be moved into itself or one of its subsections');
  if (sectionChain(parentId).length + (sectionId ? sectionHeight(sectionId) : 1) > MAX_SECTION_DEPTH)
    throw new HttpError(400, `Sections can be nested at most ${MAX_SECTION_DEPTH} levels deep`);
}
