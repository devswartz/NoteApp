// Workspace tree: notebooks and sections (pages are in pages.ts). Owner: Editor & Notes.
import { Router } from 'express';
import { db, newId, now, pickColor } from '../db.ts';
import { NOTEBOOK_VISIBLE, accessChanged, mustAccess, notebookAccess, requireRole, sectionAccess } from '../access.ts';
import { publish } from '../events.ts';
import { dropForeignPageShares } from '../workspaces.ts';
import { trashNotebook, trashSection } from '../trash.ts';
import {
  checkSectionParent,
  copyPage,
  nextPos,
  nextSectionPos,
  positionAt,
  refreshTasksForNotebook,
  sectionPositionAt,
  sectionSubtree,
  validColor,
} from '../tree.ts';
import { HttpError, h, param, str } from '../http.ts';
import type { Notebook, PageMeta, Section } from '../../shared/types.ts';

export const treeRoutes = Router();

treeRoutes.get(
  '/workspaces/:id/tree',
  h((req) => {
    const workspaceId = param(req, 'id');
    requireRole(workspaceId, req.user.id, 'viewer');
    const p = { workspaceId, userId: req.user.id };
    const notebooks = db
      .prepare(
        `SELECT n.id, n.workspace_id AS workspaceId, n.name, n.color, n.visibility, n.created_by AS createdBy, n.position
         FROM notebooks n WHERE n.workspace_id = @workspaceId AND ${NOTEBOOK_VISIBLE} ORDER BY n.position`,
      )
      .all(p) as Notebook[];
    const sections = db
      .prepare(
        `SELECT s.id, s.notebook_id AS notebookId, s.parent_id AS parentId, s.name, s.color, s.position,
           s.default_template_id AS defaultTemplateId, s.no_default_template AS noDefaultTemplate FROM sections s
         JOIN notebooks n ON n.id = s.notebook_id WHERE n.workspace_id = @workspaceId AND s.deleted_at IS NULL AND ${NOTEBOOK_VISIBLE} ORDER BY s.position`,
      )
      .all(p)
      .map((s) => ({ ...(s as Section), noDefaultTemplate: !!(s as { noDefaultTemplate: unknown }).noDefaultTemplate }));
    const pages = db
      .prepare(
        `SELECT pg.id, pg.section_id AS sectionId, pg.title, pg.icon, pg.kind, pg.position, pg.updated_at AS updatedAt,
           pg.updated_by AS updatedBy
         FROM pages pg JOIN sections s ON s.id = pg.section_id JOIN notebooks n ON n.id = s.notebook_id
         WHERE n.workspace_id = @workspaceId AND pg.deleted_at IS NULL AND s.deleted_at IS NULL AND ${NOTEBOOK_VISIBLE} ORDER BY pg.position`,
      )
      .all(p) as PageMeta[];
    return { notebooks, sections, pages };
  }),
);

treeRoutes.post(
  '/workspaces/:id/notebooks',
  h((req) => {
    const wsId = param(req, 'id');
    requireRole(wsId, req.user.id, 'member');
    const id = newId();
    const visibility = req.body.visibility === 'private' ? 'private' : 'shared';
    db.prepare(
      `INSERT INTO notebooks (id, workspace_id, name, color, visibility, created_by, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, wsId, str(req.body.name, 'Name', 100), validColor(req.body.color, pickColor), visibility, req.user.id, nextPos('notebooks', 'workspace_id', wsId), now());
    // Every notebook starts with one section so there is somewhere to write.
    const sectionId = newId();
    db.prepare('INSERT INTO sections (id, notebook_id, name, color, position, created_at) VALUES (?, ?, ?, ?, 1, ?)').run(
      sectionId, id, 'General', pickColor(), now(),
    );
    publish({ type: 'tree', workspaceId: wsId });
    return { id, sectionId };
  }),
);

treeRoutes.patch(
  '/notebooks/:id',
  h((req) => {
    const id = param(req, 'id');
    const a = mustAccess(notebookAccess(id, req.user.id), true);
    const b = req.body;
    if (b.name !== undefined) db.prepare('UPDATE notebooks SET name = ? WHERE id = ?').run(str(b.name, 'Name', 100), id);
    if (b.color !== undefined) db.prepare('UPDATE notebooks SET color = ? WHERE id = ?').run(validColor(b.color, () => { throw new HttpError(400, 'Colour must look like #4f46e5'); }), id);
    if (typeof b.position === 'number') db.prepare('UPDATE notebooks SET position = ? WHERE id = ?').run(b.position, id);
    let removedPageShares = 0;
    if (b.visibility !== undefined) {
      if (!a.isNotebookOwner) throw new HttpError(403, 'Only the notebook creator can change its visibility');
      if (!['shared', 'private'].includes(b.visibility)) throw new HttpError(400, 'Invalid visibility');
      const was = (db.prepare('SELECT visibility FROM notebooks WHERE id = ?').get(id) as { visibility: string }).visibility;
      db.prepare('UPDATE notebooks SET visibility = ? WHERE id = ?').run(b.visibility, id);
      // Made private: single-page shares someone else granted on its pages end (#98).
      if (was !== 'private' && b.visibility === 'private') removedPageShares = dropForeignPageShares(id);
      accessChanged(); // collaborators may have lost access
      refreshTasksForNotebook(id);
    }
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { ok: true, removedPageShares };
  }),
);

treeRoutes.delete(
  '/notebooks/:id',
  h((req) => {
    const id = param(req, 'id');
    const a = mustAccess(notebookAccess(id, req.user.id), true);
    if (!a.isNotebookOwner && !['owner', 'admin'].includes(a.role))
      throw new HttpError(403, 'Only the creator or a workspace admin can delete a notebook');
    // To the Trash, not gone: it can be restored for 60 days (server/trash.ts).
    const t = trashNotebook(id, a.workspaceId, req.user.id);
    return { ok: true, ...t };
  }),
);

treeRoutes.post(
  '/notebooks/:id/sections',
  h((req) => {
    const notebookId = param(req, 'id');
    const a = mustAccess(notebookAccess(notebookId, req.user.id), true);
    // { parentId } makes it a subsection of that section (same notebook, at most MAX_SECTION_DEPTH levels).
    const parentId = typeof req.body.parentId === 'string' && req.body.parentId ? req.body.parentId : null;
    checkSectionParent(null, notebookId, parentId);
    const id = newId();
    db.prepare('INSERT INTO sections (id, notebook_id, parent_id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, notebookId, parentId, str(req.body.name, 'Name', 100), validColor(req.body.color, pickColor), nextSectionPos(notebookId, parentId), now(),
    );
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { id };
  }),
);

treeRoutes.patch(
  '/sections/:id',
  h((req) => {
    const id = param(req, 'id');
    const a = mustAccess(sectionAccess(id, req.user.id), true);
    const b = req.body;
    if (b.name !== undefined) db.prepare('UPDATE sections SET name = ? WHERE id = ?').run(str(b.name, 'Name', 100), id);
    if (b.color !== undefined) db.prepare('UPDATE sections SET color = ? WHERE id = ?').run(validColor(b.color, () => { throw new HttpError(400, 'Colour must look like #4f46e5'); }), id);
    if ((b.notebookId !== undefined && b.notebookId !== a.notebookId) || b.parentId !== undefined) {
      const notebookId = b.notebookId !== undefined ? String(b.notebookId) : a.notebookId;
      const parentId = b.parentId === undefined ? (notebookId === a.notebookId ? currentParent(id) : null) : b.parentId ? String(b.parentId) : null;
      moveSectionTo(id, a, notebookId, parentId, req.user.id);
      if (typeof b.position !== 'number') db.prepare('UPDATE sections SET position = ? WHERE id = ?').run(sectionPositionAt(notebookId, parentId, Infinity, id), id);
    }
    if (typeof b.position === 'number') db.prepare('UPDATE sections SET position = ? WHERE id = ?').run(b.position, id);
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { ok: true };
  }),
);

treeRoutes.delete(
  '/sections/:id',
  h((req) => {
    const id = param(req, 'id');
    const a = mustAccess(sectionAccess(id, req.user.id), true);
    // Its subsections and pages go with it, to the Trash (server/trash.ts).
    const t = trashSection(id, a.workspaceId, req.user.id);
    return { ok: true, ...t };
  }),
);

const currentParent = (id: string) => (db.prepare('SELECT parent_id FROM sections WHERE id = ?').get(id) as { parent_id: string | null }).parent_id;

/**
 * Move a section (with its subsections and pages) under `parentId`, or to the top level of
 * `notebookId` when it's null; the notebook may be another one in the same workspace.
 * Checks access to the target, cycles and the depth limit. Position is set by the caller.
 */
function moveSectionTo(id: string, a: { workspaceId: string; notebookId: string }, notebookId: string, parentId: string | null, userId: string) {
  const t = notebookId === a.notebookId ? a : mustAccess(notebookAccess(notebookId, userId), true);
  if (t.workspaceId !== a.workspaceId) throw new HttpError(400, 'Cannot move between workspaces');
  checkSectionParent(id, notebookId, parentId);
  const subtree = sectionSubtree(id);
  db.transaction(() => {
    db.prepare('UPDATE sections SET parent_id = ? WHERE id = ?').run(parentId, id);
    if (notebookId !== a.notebookId) {
      const upd = db.prepare('UPDATE sections SET notebook_id = ? WHERE id = ?');
      for (const s of subtree) upd.run(notebookId, s);
    }
  })();
  if (notebookId !== a.notebookId) {
    // Visibility may differ between the two notebooks.
    accessChanged(); // collaborators may have lost access to its pages
    refreshTasksForNotebook(notebookId);
  }
}

/** POST /notebooks/:id/move { index } — reorder notebooks in the sidebar. */
treeRoutes.post(
  '/notebooks/:id/move',
  h((req) => {
    const id = param(req, 'id');
    const a = mustAccess(notebookAccess(id, req.user.id), true);
    const index = typeof req.body.index === 'number' ? req.body.index : Infinity;
    const position = positionAt('notebooks', 'workspace_id', a.workspaceId, index, id);
    db.prepare('UPDATE notebooks SET position = ? WHERE id = ?').run(position, id);
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { ok: true, position };
  }),
);

/**
 * POST /sections/:id/move { notebookId?, parentId?, index? } — reorder, nest, un-nest, or move into
 * another notebook. parentId: a section id (nest under it; its notebook wins), null (top level), or
 * omitted (keep the parent when staying in the same notebook, else top level).
 */
treeRoutes.post(
  '/sections/:id/move',
  h((req) => {
    const id = param(req, 'id');
    const a = mustAccess(sectionAccess(id, req.user.id), true);
    const b = req.body ?? {};
    let parentId: string | null;
    let notebookId = typeof b.notebookId === 'string' ? b.notebookId : a.notebookId;
    if (typeof b.parentId === 'string' && b.parentId) {
      parentId = b.parentId;
      const p = db.prepare('SELECT notebook_id FROM sections WHERE id = ? AND deleted_at IS NULL').get(parentId) as { notebook_id: string } | undefined;
      if (!p) throw new HttpError(404, 'That section no longer exists');
      notebookId = p.notebook_id;
    } else if (b.parentId === null) parentId = null;
    else parentId = notebookId === a.notebookId ? currentParent(id) : null;
    if (notebookId !== a.notebookId || parentId !== currentParent(id)) moveSectionTo(id, a, notebookId, parentId, req.user.id);
    const index = typeof b.index === 'number' ? b.index : Infinity;
    const position = sectionPositionAt(notebookId, parentId, index, id);
    db.prepare('UPDATE sections SET position = ? WHERE id = ?').run(position, id);
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { ok: true, notebookId, parentId, position };
  }),
);

/** POST /sections/:id/copy { notebookId?, name? } → { id } — duplicate a section and all its pages (and their tasks). */
treeRoutes.post(
  '/sections/:id/copy',
  h((req) => {
    const id = param(req, 'id');
    const a = mustAccess(sectionAccess(id, req.user.id));
    const notebookId = typeof req.body.notebookId === 'string' ? req.body.notebookId : a.notebookId;
    const t = mustAccess(notebookAccess(notebookId, req.user.id), true);
    if (t.workspaceId !== a.workspaceId) throw new HttpError(400, 'Cannot copy between workspaces');
    const src = db.prepare('SELECT name, color, parent_id FROM sections WHERE id = ?').get(id) as { name: string; color: string; parent_id: string | null };
    const name = typeof req.body.name === 'string' && req.body.name.trim() ? str(req.body.name, 'Name', 100) : notebookId === a.notebookId ? `${src.name} (copy)` : src.name;
    // A copy in the same notebook sits next to the original; in another notebook, at its top level.
    const parentId = notebookId === a.notebookId ? src.parent_id : null;
    // Subsections are copied too, keeping their nesting.
    const copySection = (from: string, parent: string | null, sectionName: string, color: string, position: number): string => {
      const newSection = newId();
      db.prepare('INSERT INTO sections (id, notebook_id, parent_id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        newSection, notebookId, parent, sectionName, color, position, now(),
      );
      const pages = db.prepare('SELECT id, position FROM pages WHERE section_id = ? AND deleted_at IS NULL ORDER BY position').all(from) as { id: string; position: number }[];
      for (const p of pages) copyPage(p.id, newSection, req.user.id, { position: p.position });
      const subs = db.prepare('SELECT id, name, color, position FROM sections WHERE parent_id = ? AND deleted_at IS NULL ORDER BY position').all(from) as {
        id: string;
        name: string;
        color: string;
        position: number;
      }[];
      for (const s of subs) copySection(s.id, newSection, s.name, s.color, s.position);
      return newSection;
    };
    const newSection = copySection(id, parentId, name, src.color, nextSectionPos(notebookId, parentId));
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { id: newSection };
  }),
);
