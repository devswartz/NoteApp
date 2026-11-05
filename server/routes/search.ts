// Full-text search over pages and tasks. Owner: Editor & Notes.
import { Router } from 'express';
import { db } from '../db.ts';
import { NOTEBOOK_VISIBLE, TASK_VISIBLE, requireRole } from '../access.ts';
import { rowToTask } from '../tasks.ts';
import { h, param } from '../http.ts';
import type { Task } from '../../shared/types.ts';

export const searchRoutes = Router();

searchRoutes.get(
  '/workspaces/:id/search',
  h((req) => {
    const workspaceId = param(req, 'id');
    requireRole(workspaceId, req.user.id, 'viewer');
    const q = String(req.query.q ?? '').trim();
    if (!q) return { pages: [], tasks: [] };
    // Prefix match on each term, quoted to neutralise FTS syntax characters.
    const fts = q
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, '""')}"*`)
      .join(' ');
    const userId = req.user.id;
    const pages = db
      .prepare(
        `SELECT pg.id, pg.title, snippet(pages_fts, 2, '«', '»', '…', 12) AS snippet, n.name AS notebookName, s.name AS sectionName
         FROM pages_fts f JOIN pages pg ON pg.id = f.page_id JOIN sections s ON s.id = pg.section_id JOIN notebooks n ON n.id = s.notebook_id
         WHERE pages_fts MATCH @fts AND n.workspace_id = @workspaceId AND ${NOTEBOOK_VISIBLE}
         ORDER BY bm25(pages_fts, 0, 5, 1) LIMIT 20`,
      )
      .all({ fts, workspaceId, userId });
    const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const tasks = (
      db
        .prepare(
          `SELECT * FROM tasks t WHERE t.workspace_id = @workspaceId AND (t.title LIKE @like ESCAPE '\\' OR t.description LIKE @like ESCAPE '\\')
           AND ${TASK_VISIBLE} ORDER BY t.status = 'done', t.updated_at DESC LIMIT 20`,
        )
        .all({ workspaceId, userId, like }) as Parameters<typeof rowToTask>[0][]
    ).map(rowToTask) as Task[];
    return { pages, tasks };
  }),
);
