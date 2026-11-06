// User page templates (workspace-scoped). Owner: Editor & Notes.
//
//   GET    /workspaces/:id/templates       → TemplateMeta[]   (the ones this user may see; no content)
//   POST   /pages/:id/templates            { name, icon?, content } → TemplateMeta   "Save page as template"
//   PATCH  /templates/:id                  { name?, icon? }   rename
//   DELETE /templates/:id                                     (also removes the template's attachment copies)
//   POST   /templates/:id/use              { pageId } → TemplateUse   creates NEW tasks + file copies for that page
//
// Who may do what:
//   - See / use: every member of the workspace (viewers can list; using needs edit rights on the target page).
//     Exception: a template saved from a page in a PRIVATE notebook is visible to its creator only,
//     so private content never reaches people who couldn't read the page.
//   - Save: anyone who can edit the page (workspace member or above, with access to its notebook).
//   - Rename / delete: the creator, or a workspace owner/admin (for workspace-visible templates).
// Content is the editor's JSON (sent by the client from the live editor), see server/templates.ts.
import { Router } from 'express';
import { db } from '../db.ts';
import { atLeast, mustAccess, pageAccess, requireRole, roleIn } from '../access.ts';
import { publish } from '../events.ts';
import { HttpError, h, param, str } from '../http.ts';
import {
  MAX_TEMPLATE_NAME,
  createTemplate,
  removeFiles,
  templateFilePaths,
  useTemplate,
  visibleTemplate,
  type TemplateRow,
} from '../templates.ts';
import { fileVisible } from './files.ts';
import type { TemplateMeta } from '../../shared/types.ts';

export const templateRoutes = Router();

function meta(r: TemplateRow, userId: string): TemplateMeta {
  const fileCount = (db.prepare('SELECT COUNT(*) AS n FROM files WHERE template_id = ?').get(r.id) as { n: number }).n;
  let taskCount = 0;
  try {
    taskCount = (JSON.parse(r.tasks) as unknown[]).length;
  } catch {
    /* corrupt snapshot: list it anyway */
  }
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    icon: r.icon,
    visibility: r.visibility,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    taskCount,
    fileCount,
    canManage: canManage(r, userId),
  };
}

function canManage(r: TemplateRow, userId: string): boolean {
  const role = roleIn(r.workspace_id, userId);
  if (!atLeast(role, 'member')) return false;
  return r.created_by === userId || (r.visibility === 'workspace' && atLeast(role, 'admin'));
}

/** Tell other clients to refetch the list; a private template only concerns its creator's own sessions. */
function changed(r: Pick<TemplateRow, 'workspace_id' | 'visibility' | 'created_by'>) {
  publish({ type: 'templates', workspaceId: r.workspace_id }, r.visibility === 'private' ? { userIds: [r.created_by] } : {});
}

function icon(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > 16) throw new HttpError(400, 'icon is invalid');
  return v;
}

function managed(req: Parameters<typeof param>[0]): TemplateRow {
  const r = visibleTemplate(param(req, 'id'), req.user.id);
  if (!r) throw new HttpError(404, 'Not found');
  if (!canManage(r, req.user.id)) throw new HttpError(403, 'Only its creator or a workspace admin can change this template');
  return r;
}

templateRoutes.get(
  '/workspaces/:id/templates',
  h((req) => {
    const wsId = param(req, 'id');
    requireRole(wsId, req.user.id, 'viewer');
    const rows = db
      .prepare(`SELECT * FROM templates WHERE workspace_id = ? AND (visibility = 'workspace' OR created_by = ?) ORDER BY created_at, id`)
      .all(wsId, req.user.id) as TemplateRow[];
    return rows.map((r) => meta(r, req.user.id));
  }),
);

templateRoutes.post(
  '/pages/:id/templates',
  h((req) => {
    const pageId = param(req, 'id');
    const a = mustAccess(pageAccess(pageId, req.user.id), true);
    const body = req.body ?? {};
    const name = str(body.name, 'name', MAX_TEMPLATE_NAME);
    const nb = db.prepare('SELECT visibility FROM notebooks WHERE id = ?').get(a.notebookId) as { visibility: string };
    const visibility = nb.visibility === 'private' ? 'private' : 'workspace';
    const made = createTemplate({
      workspaceId: a.workspaceId,
      userId: req.user.id,
      name,
      icon: icon(body.icon),
      visibility,
      content: body.content,
      canSeeFile: (f) => fileVisible(f, req.user.id),
    });
    const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(made.id) as TemplateRow;
    changed(row);
    return meta(row, req.user.id);
  }),
);

templateRoutes.patch(
  '/templates/:id',
  h((req) => {
    const r = managed(req);
    const b = req.body ?? {};
    const name = b.name === undefined ? r.name : str(b.name, 'name', MAX_TEMPLATE_NAME);
    const ic = b.icon === undefined ? r.icon : icon(b.icon);
    db.prepare('UPDATE templates SET name = ?, icon = ?, updated_at = ? WHERE id = ?').run(name, ic, new Date().toISOString(), r.id);
    changed(r);
    return meta(db.prepare('SELECT * FROM templates WHERE id = ?').get(r.id) as TemplateRow, req.user.id);
  }),
);

templateRoutes.delete(
  '/templates/:id',
  h((req) => {
    const r = managed(req);
    const paths = templateFilePaths([r.id]);
    db.prepare('DELETE FROM templates WHERE id = ?').run(r.id); // its file rows cascade
    removeFiles(paths);
    changed(r);
    return { ok: true };
  }),
);

templateRoutes.post(
  '/templates/:id/use',
  h((req) => {
    const t = visibleTemplate(param(req, 'id'), req.user.id);
    if (!t) throw new HttpError(404, 'Not found');
    const pageId = str(req.body?.pageId, 'pageId', 100);
    const a = mustAccess(pageAccess(pageId, req.user.id), true);
    if (a.workspaceId !== t.workspace_id) throw new HttpError(400, 'That template belongs to a different workspace');
    const out = useTemplate(t, pageId, req.user.id);
    return { title: t.name, icon: t.icon, content: out.content, taskIds: out.taskIds };
  }),
);
