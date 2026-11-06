// Full-text search over pages (title + text) and tasks (title + description). Owner: Editor & Notes.
//
//   GET /api/workspaces/:id/search?q=<text>&limit=<1..50, default 20>
//   → SearchResult (shared/types.ts): { pages: [...], tasks: [...] }, best match first.
//
// Each term is prefix-matched ("plan" finds "planning"), stemmed (porter), and all
// terms must match. Snippets wrap matched terms in « and ». Only notebooks/tasks
// the caller can see are searched.
import { Router } from 'express';
import { db } from '../db.ts';
import { PAGE_VISIBLE, TASK_VISIBLE, requireRole } from '../access.ts';
import { rowToTask } from '../tasks.ts';
import { h, param } from '../http.ts';
import type { SearchResult } from '../../shared/types.ts';

export const searchRoutes = Router();

/** Turn user input into a safe FTS5 query: every term quoted and prefix-matched, ANDed together. */
export function ftsQuery(q: string): string {
  return q
    .split(/\s+/)
    .map((t) => t.replace(/["«»]/g, '').trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((t) => `"${t}"*`)
    .join(' ');
}

export function search(workspaceId: string, userId: string, q: string, limit = 20): SearchResult {
  const fts = ftsQuery(q);
  if (!fts) return { pages: [], tasks: [] };
  const p = { fts, workspaceId, userId, limit };
  // Title matches weigh 10× text matches; recently edited pages win ties.
  const pages = db
    .prepare(
      `SELECT pg.id, pg.title, pg.icon,
         CASE WHEN length(f.text) > 0 THEN snippet(pages_fts, 2, '«', '»', '…', 14) ELSE '' END AS snippet,
         n.name AS notebookName, s.name AS sectionName
       FROM pages_fts f JOIN pages pg ON pg.id = f.page_id JOIN sections s ON s.id = pg.section_id JOIN notebooks n ON n.id = s.notebook_id
       WHERE pages_fts MATCH @fts AND n.workspace_id = @workspaceId AND ${PAGE_VISIBLE}
       ORDER BY bm25(pages_fts, 0, 10, 1), pg.updated_at DESC LIMIT @limit`,
    )
    .all(p) as SearchResult['pages'];
  const rows = db
    .prepare(
      `SELECT t.*, snippet(tasks_fts, 2, '«', '»', '…', 10) AS fts_snippet
       FROM tasks_fts f JOIN tasks t ON t.id = f.task_id
       WHERE tasks_fts MATCH @fts AND t.workspace_id = @workspaceId AND t.occurrence_of IS NULL AND ${TASK_VISIBLE}
       ORDER BY t.status = 'done', bm25(tasks_fts, 0, 10, 1), t.updated_at DESC LIMIT @limit`,
    )
    .all(p) as (Parameters<typeof rowToTask>[0] & { fts_snippet: string })[];
  const tasks = rows.map((r) => {
    const t = rowToTask(r);
    // Only a description match is worth a snippet; the title is shown anyway.
    return r.fts_snippet.includes('«') ? { ...t, snippet: r.fts_snippet } : t;
  });
  return { pages, tasks };
}

searchRoutes.get(
  '/workspaces/:id/search',
  h((req) => {
    const workspaceId = param(req, 'id');
    requireRole(workspaceId, req.user.id, 'viewer');
    const q = String(req.query.q ?? '').trim().slice(0, 200);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    return search(workspaceId, req.user.id, q, limit);
  }),
);
