// Page metadata (content is edited over the collab WebSocket). Owner: Editor & Notes.
import { Router } from 'express';
import { db, newId, now } from '../db.ts';
import { accessChanged, mustAccess, pageAccess, sectionAccess } from '../access.ts';
import { publish } from '../events.ts';
import { rowToTask } from '../tasks.ts';
import { detachPagesTasks, nextPos } from '../tree.ts';
import { HttpError, h, param } from '../http.ts';

export const pageRoutes = Router();

pageRoutes.post(
  '/sections/:id/pages',
  h((req) => {
    const sectionId = param(req, 'id');
    const a = mustAccess(sectionAccess(sectionId, req.user.id), true);
    const id = newId();
    const ts = now();
    const title = typeof req.body.title === 'string' ? req.body.title.slice(0, 300) : '';
    db.prepare(
      `INSERT INTO pages (id, section_id, title, position, created_by, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, sectionId, title, nextPos('pages', 'section_id', sectionId), req.user.id, ts, ts, req.user.id);
    db.prepare('INSERT INTO pages_fts (page_id, title, text) VALUES (?, ?, ?)').run(id, title, '');
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { id };
  }),
);

pageRoutes.get(
  '/pages/:id',
  h((req) => {
    const id = param(req, 'id');
    const a = mustAccess(pageAccess(id, req.user.id));
    const page = db
      .prepare(
        `SELECT p.id, p.section_id AS sectionId, p.title, p.icon, p.kind, p.position, p.updated_at AS updatedAt,
           p.updated_by AS updatedBy, p.created_by AS createdBy, p.created_at AS createdAt
         FROM pages p WHERE p.id = ?`,
      )
      .get(id);
    return { page, workspaceId: a.workspaceId, canEdit: a.canEdit };
  }),
);

pageRoutes.patch(
  '/pages/:id',
  h((req) => {
    const id = param(req, 'id');
    const a = mustAccess(pageAccess(id, req.user.id), true);
    const b = req.body;
    if (b.title !== undefined) {
      const title = String(b.title).slice(0, 300);
      db.prepare('UPDATE pages SET title = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(title, now(), req.user.id, id);
      db.prepare('UPDATE pages_fts SET title = ? WHERE page_id = ?').run(title, id);
    }
    if (b.icon !== undefined) db.prepare('UPDATE pages SET icon = ? WHERE id = ?').run(b.icon ? String(b.icon).slice(0, 16) : null, id);
    if (b.sectionId !== undefined) {
      const t = mustAccess(sectionAccess(b.sectionId, req.user.id), true);
      if (t.workspaceId !== a.workspaceId) throw new HttpError(400, 'Cannot move between workspaces');
      db.prepare('UPDATE pages SET section_id = ? WHERE id = ?').run(b.sectionId, id);
      if (t.notebookId !== a.notebookId) {
        accessChanged(); // collaborators may have lost access
        const tasks = db.prepare('SELECT * FROM tasks WHERE page_id = ?').all(id) as Parameters<typeof rowToTask>[0][];
        for (const r of tasks) publish({ type: 'task', task: rowToTask(r) });
      }
    }
    if (typeof b.position === 'number') db.prepare('UPDATE pages SET position = ? WHERE id = ?').run(b.position, id);
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { ok: true };
  }),
);

pageRoutes.delete(
  '/pages/:id',
  h((req) => {
    const id = param(req, 'id');
    const a = mustAccess(pageAccess(id, req.user.id), true);
    detachPagesTasks([id], () => db.prepare('DELETE FROM pages WHERE id = ?').run(id));
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { ok: true };
  }),
);
