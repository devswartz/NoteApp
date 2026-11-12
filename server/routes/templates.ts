// User page templates (workspace-scoped). Owner: Editor & Notes.
//
//   GET    /workspaces/:id/templates       → TemplateMeta[]   (the ones this user may see; no content)
//   POST   /pages/:id/templates            { name, icon?, content, kind?, sections? } → TemplateMeta   "Save page as template"
//     kind 'canvas': content is a doc of canvasBox nodes (attrs x, y, w, z; content = the box's blocks)
//   PATCH  /templates/:id                  { name?, icon?, sections? }   rename / change where it's offered
//     sections: [{ sectionId, includeSubsections? (default true) }]; empty = offered everywhere
//   DELETE /templates/:id                                     (also removes the template's attachment copies)
//   POST   /templates/:id/use              { pageId } → TemplateUse   creates NEW tasks + file copies for that page
//   PUT    /sections/:id/default-template  { templateId | 'none' | null }   the section's default template
//   POST   /pages/:id/pending-template     { discard? } → PendingTemplateUse | null   fill a new page once
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
import { atLeast, mustAccess, pageAccess, requireRole, roleIn, sectionAccess } from '../access.ts';
import { publish } from '../events.ts';
import { HttpError, h, param, str } from '../http.ts';
import {
  MAX_TEMPLATE_NAME,
  createTemplate,
  defaultableTemplate,
  removeFiles,
  setTemplateScope,
  templateFilePaths,
  templateScope,
  useTemplate,
  visibleTemplate,
  type TemplateRow,
} from '../templates.ts';
import { fileVisible } from './files.ts';
import type { PendingTemplateUse, TemplateMeta } from '../../shared/types.ts';

export const templateRoutes = Router();

function meta(r: TemplateRow, userId: string): TemplateMeta {
  const scope = templateScope(r.id, userId);
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
    kind: r.kind === 'canvas' ? 'canvas' : 'document',
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    taskCount,
    fileCount,
    canManage: canManage(r, userId),
    scoped: scope.scoped,
    sections: scope.visible,
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
    // Templates belong to the workspace: page-share-only access (#98) can't add to its list.
    if (!a.member || a.viaPageShare) throw new HttpError(403, 'Only people with access to its notebook can save this page as a template');
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
      kind: body.kind === 'canvas' ? 'canvas' : 'document',
      canSeeFile: (f) => fileVisible(f, req.user.id),
    });
    if (body.sections !== undefined) {
      try {
        setTemplateScope({ id: made.id, workspace_id: a.workspaceId }, req.user.id, body.sections);
      } catch (e) {
        removeFiles(templateFilePaths([made.id]));
        db.prepare('DELETE FROM templates WHERE id = ?').run(made.id);
        throw e;
      }
    }
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
    if (b.sections !== undefined) setTemplateScope(r, req.user.id, b.sections);
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

/**
 * PUT /sections/:id/default-template { templateId: string | 'none' | null } → { ok }
 * The template new pages in this section start from. null = inherit the parent section's
 * default; 'none' = no default here, even if a parent has one. Editors of the notebook only
 * (not viewers, not page-share grantees). The template must be shared with the workspace and
 * offered in the section.
 */
templateRoutes.put(
  '/sections/:id/default-template',
  h((req) => {
    const sectionId = param(req, 'id');
    const a = mustAccess(sectionAccess(sectionId, req.user.id), true);
    if (!a.member || !atLeast(a.role, 'member')) throw new HttpError(403, 'Only editors can choose a section’s default template');
    const v = req.body?.templateId;
    if (v === null || v === undefined || v === 'none') {
      db.prepare('UPDATE sections SET default_template_id = NULL, no_default_template = ? WHERE id = ?').run(v === 'none' ? 1 : 0, sectionId);
    } else {
      const id = str(v, 'templateId', 100);
      if (!defaultableTemplate(id, sectionId, a.workspaceId))
        throw new HttpError(400, 'That template can’t be this section’s default: it must be shared with the workspace and offered in this section');
      db.prepare('UPDATE sections SET default_template_id = ?, no_default_template = 0 WHERE id = ?').run(id, sectionId);
    }
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { ok: true };
  }),
);

/**
 * POST /pages/:id/pending-template { discard? } → PendingTemplateUse | null
 * A page made with New page in a section with a default template (or with "New page from
 * template") carries pages.pending_template_id. Its creator's client claims it here once the page
 * is open: the claim clears it atomically, so it is applied once even with several clients open,
 * and creates the template's tasks and attachment copies for the page. null when there is
 * nothing to claim (already claimed, or the template was deleted). `discard` just clears it.
 */
templateRoutes.post(
  '/pages/:id/pending-template',
  h((req) => {
    const pageId = param(req, 'id');
    const a = mustAccess(pageAccess(pageId, req.user.id), true);
    if (!a.member || a.viaPageShare) throw new HttpError(403, 'Only people with access to its notebook can do that');
    // One transaction: the claim (compare-and-clear) and the tasks/files it creates stand or fall together.
    return db.transaction((): PendingTemplateUse | null => {
      const row = db.prepare('SELECT pending_template_id AS t, created_by AS by FROM pages WHERE id = ?').get(pageId) as { t: string | null; by: string };
      if (!row.t) return null;
      if (row.by !== req.user.id) throw new HttpError(403, 'Only the page’s creator fills it from its template');
      const claimed = db.prepare('UPDATE pages SET pending_template_id = NULL WHERE id = ? AND pending_template_id = ?').run(pageId, row.t);
      if (claimed.changes !== 1 || req.body?.discard === true) return null;
      const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(row.t) as TemplateRow | undefined;
      if (!t || t.workspace_id !== a.workspaceId || (t.visibility === 'private' && t.created_by !== req.user.id)) return null;
      requireRole(t.workspace_id, req.user.id, 'member');
      const out = useTemplate(t, pageId, req.user.id);
      return { templateId: t.id, name: t.name, title: t.name, icon: t.icon, kind: t.kind === 'canvas' ? 'canvas' : 'document', content: out.content, taskIds: out.taskIds };
    })();
  }),
);

templateRoutes.post(
  '/templates/:id/use',
  h((req) => {
    const t = visibleTemplate(param(req, 'id'), req.user.id);
    if (!t) throw new HttpError(404, 'Not found');
    const pageId = str(req.body?.pageId, 'pageId', 100);
    // Into a page you can edit, as a member of the template's workspace (#98 review).
    const a = mustAccess(pageAccess(pageId, req.user.id), true);
    if (a.workspaceId !== t.workspace_id) throw new HttpError(400, 'That template belongs to a different workspace');
    requireRole(t.workspace_id, req.user.id, 'member');
    const out = useTemplate(t, pageId, req.user.id);
    return { title: t.name, icon: t.icon, kind: t.kind === 'canvas' ? 'canvas' : 'document', content: out.content, taskIds: out.taskIds };
  }),
);
