// Workspace tree: notebooks and sections (pages are in pages.ts). Owner: Editor & Notes.
import { Router } from 'express';
import { db, newId, now, pickColor } from '../db.ts';
import { NOTEBOOK_VISIBLE, accessChanged, mustAccess, notebookAccess, requireRole, sectionAccess } from '../access.ts';
import { publish } from '../events.ts';
import { copyPage, detachPagesTasks, nextPos, positionAt, refreshTasksForNotebook } from '../tree.ts';
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
        `SELECT s.id, s.notebook_id AS notebookId, s.name, s.color, s.position FROM sections s
         JOIN notebooks n ON n.id = s.notebook_id WHERE n.workspace_id = @workspaceId AND ${NOTEBOOK_VISIBLE} ORDER BY s.position`,
      )
      .all(p) as Section[];
    const pages = db
      .prepare(
        `SELECT pg.id, pg.section_id AS sectionId, pg.title, pg.icon, pg.kind, pg.position, pg.updated_at AS updatedAt,
           pg.updated_by AS updatedBy
         FROM pages pg JOIN sections s ON s.id = pg.section_id JOIN notebooks n ON n.id = s.notebook_id
         WHERE n.workspace_id = @workspaceId AND ${NOTEBOOK_VISIBLE} ORDER BY pg.position`,
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
    ).run(id, wsId, str(req.body.name, 'Name', 100), req.body.color ?? pickColor(), visibility, req.user.id, nextPos('notebooks', 'workspace_id', wsId), now());
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
    if (b.color !== undefined) db.prepare('UPDATE notebooks SET color = ? WHERE id = ?').run(String(b.color), id);
    if (typeof b.position === 'number') db.prepare('UPDATE notebooks SET position = ? WHERE id = ?').run(b.position, id);
    if (b.visibility !== undefined) {
      if (!a.isNotebookOwner) throw new HttpError(403, 'Only the notebook creator can change its visibility');
      if (!['shared', 'private'].includes(b.visibility)) throw new HttpError(400, 'Invalid visibility');
      db.prepare('UPDATE notebooks SET visibility = ? WHERE id = ?').run(b.visibility, id);
      accessChanged(); // collaborators may have lost access
      refreshTasksForNotebook(id);
    }
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { ok: true };
  }),
);

treeRoutes.delete(
  '/notebooks/:id',
  h((req) => {
    const id = param(req, 'id');
    const a = mustAccess(notebookAccess(id, req.user.id), true);
    if (!a.isNotebookOwner && !['owner', 'admin'].includes(a.role))
      throw new HttpError(403, 'Only the creator or a workspace admin can delete a notebook');
    const pages = db.prepare('SELECT p.id FROM pages p JOIN sections s ON s.id = p.section_id WHERE s.notebook_id = ?').all(id) as { id: string }[];
    detachPagesTasks(pages.map((p) => p.id), () => db.prepare('DELETE FROM notebooks WHERE id = ?').run(id));
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { ok: true };
  }),
);

treeRoutes.post(
  '/notebooks/:id/sections',
  h((req) => {
    const notebookId = param(req, 'id');
    const a = mustAccess(notebookAccess(notebookId, req.user.id), true);
    const id = newId();
    db.prepare('INSERT INTO sections (id, notebook_id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id, notebookId, str(req.body.name, 'Name', 100), req.body.color ?? pickColor(), nextPos('sections', 'notebook_id', notebookId), now(),
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
    if (b.color !== undefined) db.prepare('UPDATE sections SET color = ? WHERE id = ?').run(String(b.color), id);
    if (b.notebookId !== undefined && b.notebookId !== a.notebookId) moveSectionTo(id, a, String(b.notebookId), req.user.id);
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
    const pages = db.prepare('SELECT id FROM pages WHERE section_id = ?').all(id) as { id: string }[];
    detachPagesTasks(pages.map((p) => p.id), () => db.prepare('DELETE FROM sections WHERE id = ?').run(id));
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { ok: true };
  }),
);

/** Move a section (with its pages) into another notebook of the same workspace. */
function moveSectionTo(id: string, a: { workspaceId: string; notebookId: string }, notebookId: string, userId: string) {
  const t = mustAccess(notebookAccess(notebookId, userId), true);
  if (t.workspaceId !== a.workspaceId) throw new HttpError(400, 'Cannot move between workspaces');
  db.prepare('UPDATE sections SET notebook_id = ? WHERE id = ?').run(notebookId, id);
  // Visibility may differ between the two notebooks.
  accessChanged(); // collaborators may have lost access to its pages
  refreshTasksForNotebook(notebookId);
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

/** POST /sections/:id/move { notebookId?, index? } — reorder, or move into another notebook. */
treeRoutes.post(
  '/sections/:id/move',
  h((req) => {
    const id = param(req, 'id');
    const a = mustAccess(sectionAccess(id, req.user.id), true);
    const notebookId = typeof req.body.notebookId === 'string' ? req.body.notebookId : a.notebookId;
    if (notebookId !== a.notebookId) moveSectionTo(id, a, notebookId, req.user.id);
    const index = typeof req.body.index === 'number' ? req.body.index : Infinity;
    const position = positionAt('sections', 'notebook_id', notebookId, index, id);
    db.prepare('UPDATE sections SET position = ? WHERE id = ?').run(position, id);
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { ok: true, notebookId, position };
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
    const src = db.prepare('SELECT name, color FROM sections WHERE id = ?').get(id) as { name: string; color: string };
    const name = typeof req.body.name === 'string' && req.body.name.trim() ? str(req.body.name, 'Name', 100) : notebookId === a.notebookId ? `${src.name} (copy)` : src.name;
    const newSection = newId();
    db.prepare('INSERT INTO sections (id, notebook_id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      newSection, notebookId, name, src.color, nextPos('sections', 'notebook_id', notebookId), now(),
    );
    const pages = db.prepare('SELECT id, position FROM pages WHERE section_id = ? ORDER BY position').all(id) as { id: string; position: number }[];
    for (const p of pages) copyPage(p.id, newSection, req.user.id, { position: p.position });
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { id: newSection };
  }),
);
