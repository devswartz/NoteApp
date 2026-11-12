// Page metadata (content is edited over the collab WebSocket). Owner: Editor & Notes.
import { Router } from 'express';
import { db, newId, now } from '../db.ts';
import { accessChanged, atLeast, canSharePage, mustAccess, mustManage, pageAccess, sectionAccess } from '../access.ts';
import { sectionDefaultTemplate, templateOfferedIn, visibleTemplate, type TemplateRow } from '../templates.ts';
import { publish } from '../events.ts';
import { editPageDoc, flushAll, newBoxId, pageDocState } from '../collab.ts';
import { convertPageDoc } from '../../shared/pageDoc.ts';
import { rowToTask } from '../tasks.ts';
import { copyPage, detachPagesTasks, nextPos, positionAt } from '../tree.ts';
import type { Access } from '../access.ts';
import { HttpError, h, param } from '../http.ts';
import { backlinks } from '../links.ts';
import { dropForeignSharesOnPage } from '../workspaces.ts';
import { getVersion, listVersions, snapshot, startVersionSweep } from '../versions.ts';

export const pageRoutes = Router();

function pendingTemplateFor(v: unknown, sectionId: string, workspaceId: string, userId: string, member: boolean): TemplateRow | null {
  if (!member || typeof v !== 'string' || !v) return null;
  if (v === 'default') return sectionDefaultTemplate(sectionId, workspaceId);
  const t = visibleTemplate(v, userId);
  if (!t || t.workspace_id !== workspaceId || !templateOfferedIn(t.id, sectionId)) throw new HttpError(400, 'That template isn’t offered in this section');
  return t;
}
startVersionSweep();

pageRoutes.post(
  '/sections/:id/pages',
  h((req) => {
    const sectionId = param(req, 'id');
    const a = mustAccess(sectionAccess(sectionId, req.user.id), true);
    const id = newId();
    const ts = now();
    const title = typeof req.body.title === 'string' ? req.body.title.slice(0, 300) : '';
    // Every page is a canvas of text boxes (docs/PLAN_CANVAS.md); a `kind` in the body is ignored.
    const kind = 'canvas';
    // template: 'default' (the app's New page) starts from the section's default template, a
    // template id ("New page from template") from that one. Anything else (imports, quick add,
    // the share extension, the API) makes a blank page. The page only remembers the template;
    // its creator's client fills it once (POST /pages/:id/pending-template).
    const pending = pendingTemplateFor(req.body?.template, sectionId, a.workspaceId, req.user.id, a.member && atLeast(a.role, 'member'));
    db.prepare(
      `INSERT INTO pages (id, section_id, title, kind, position, created_by, created_at, updated_at, updated_by, pending_template_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, sectionId, title, kind, nextPos('pages', 'section_id', sectionId), req.user.id, ts, ts, req.user.id, pending?.id ?? null);
    db.prepare('INSERT INTO pages_fts (page_id, title, text) VALUES (?, ?, ?)').run(id, title, '');
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { id, pendingTemplate: pending ? { id: pending.id, name: pending.name } : null };
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
    // viaPageShare: opened through a page share (#98), so the client shows it under "Shared with me";
    // canManage: may move, copy or delete it; canShare: may share it (#98).
    // pendingTemplate: this page was just made from a template that its creator's client still has to fill in.
    const pending = db.prepare('SELECT 1 FROM pages WHERE id = ? AND created_by = ? AND pending_template_id IS NOT NULL').get(id, req.user.id);
    return {
      page,
      workspaceId: a.workspaceId,
      canEdit: a.canEdit,
      canManage: a.canManage,
      canShare: canSharePage(a),
      viaPageShare: a.viaPageShare,
      member: a.member,
      pendingTemplate: !!pending && a.canEdit && a.member && !a.viaPageShare,
    };
  }),
);

/** GET /pages/:id/backlinks → Backlink[]: visible pages that link here with [[…]], most recently edited first. */
pageRoutes.get(
  '/pages/:id/backlinks',
  h((req) => {
    const id = param(req, 'id');
    const a = mustAccess(pageAccess(id, req.user.id));
    return backlinks(id, a.workspaceId, req.user.id);
  }),
);

/**
 * GET /pages/:id/doc → { ydoc: base64 Yjs state }: the page's current content, read-only.
 * Printing a section renders each page from this instead of opening a collab session.
 */
pageRoutes.get(
  '/pages/:id/doc',
  h((req) => {
    const id = param(req, 'id');
    mustAccess(pageAccess(id, req.user.id));
    const state = pageDocState(id);
    if (!state) throw new HttpError(404, 'Page not found');
    return { ydoc: Buffer.from(state).toString('base64') };
  }),
);

// ───────── Version history ─────────
// GET  /pages/:id/versions          → VersionMeta[] (newest first); takes an auto snapshot first if due
// GET  /pages/:id/versions/:vid     → VersionMeta & { ydoc: base64 Yjs state }
// POST /pages/:id/versions {reason?} → { id } snapshot now ('manual' | 'restore'; the client calls this before restoring)
pageRoutes.get(
  '/pages/:id/versions',
  h((req) => {
    const id = param(req, 'id');
    mustAccess(pageAccess(id, req.user.id));
    snapshot(id, 'auto');
    return listVersions(id);
  }),
);

pageRoutes.get(
  '/pages/:id/versions/:vid',
  h((req) => {
    const id = param(req, 'id');
    mustAccess(pageAccess(id, req.user.id));
    const v = getVersion(id, param(req, 'vid'));
    if (!v) throw new HttpError(404, 'Version not found');
    return { ...v, ydoc: v.ydoc.toString('base64') };
  }),
);

pageRoutes.post(
  '/pages/:id/versions',
  h((req) => {
    const id = param(req, 'id');
    mustAccess(pageAccess(id, req.user.id), true);
    flushAll(); // capture edits still pending in the open collab room
    const reason = req.body?.reason === 'restore' ? 'restore' : 'manual';
    return { id: snapshot(id, reason) ?? listVersions(id)[0]?.id ?? null };
  }),
);

/**
 * POST /pages/:id/convert { kind: 'canvas' } → { kind }
 * Turns a (legacy) document page into a canvas: the whole content becomes one wide box at the
 * top left. Pages are all canvases now (the startup data migration converts the rest), so
 * 'document' is refused. One Yjs transaction on the live room if the page is open, else on the
 * stored doc. The state before is kept as a version, so it can be undone from Version history.
 */
pageRoutes.post(
  '/pages/:id/convert',
  h((req) => {
    const id = param(req, 'id');
    const a = mustAccess(pageAccess(id, req.user.id), true);
    const kind = req.body?.kind;
    if (kind !== 'canvas') throw new HttpError(400, "Every page is a canvas: kind must be 'canvas'");
    const cur = (db.prepare('SELECT kind FROM pages WHERE id = ?').get(id) as { kind: string }).kind;
    if (cur === kind) return { kind };
    flushAll();
    snapshot(id, 'manual');
    db.prepare('UPDATE pages SET kind = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(kind, now(), req.user.id, id);
    editPageDoc(id, (doc) => convertPageDoc(doc, kind, newBoxId));
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { kind };
  }),
);

pageRoutes.patch(
  '/pages/:id',
  h((req) => {
    const id = param(req, 'id');
    const a = mustAccess(pageAccess(id, req.user.id), true);
    const b = req.body;
    // Moving and reordering change its notebook: not for page-share-only access (#98).
    if (b.sectionId !== undefined || b.position !== undefined) mustManage(a);
    if (b.title !== undefined) {
      const title = String(b.title).slice(0, 300);
      db.prepare('UPDATE pages SET title = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(title, now(), req.user.id, id);
      db.prepare('UPDATE pages_fts SET title = ? WHERE page_id = ?').run(title, id);
    }
    if (b.icon !== undefined) db.prepare('UPDATE pages SET icon = ? WHERE id = ?').run(b.icon ? String(b.icon).slice(0, 16) : null, id);
    if (b.sectionId !== undefined) movePageTo(id, a, String(b.sectionId), req.user.id);
    if (typeof b.position === 'number') db.prepare('UPDATE pages SET position = ? WHERE id = ?').run(b.position, id);
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { ok: true };
  }),
);

/** Move a page into a section (any notebook in the same workspace). Kicks collaborators if the notebook changed. */
function movePageTo(id: string, a: Access, sectionId: string, userId: string) {
  const t = mustAccess(sectionAccess(sectionId, userId), true);
  if (t.workspaceId !== a.workspaceId) throw new HttpError(400, 'Cannot move between workspaces');
  db.prepare('UPDATE pages SET section_id = ? WHERE id = ?').run(sectionId, id);
  if (t.notebookId !== a.notebookId) {
    // Into a private notebook: page shares its creator didn't grant end (#98).
    const vis = (db.prepare('SELECT visibility FROM notebooks WHERE id = ?').get(t.notebookId) as { visibility: string }).visibility;
    if (vis === 'private') dropForeignSharesOnPage(id, t.notebookId);
    accessChanged(); // collaborators may have lost access (e.g. moved into a private notebook)
    const tasks = db.prepare('SELECT * FROM tasks WHERE page_id = ?').all(id) as Parameters<typeof rowToTask>[0][];
    for (const r of tasks) publish({ type: 'task', task: rowToTask(r) });
  }
}

/**
 * POST /pages/:id/move { sectionId?, index? }
 * Move to another section (default: stay) at `index` among its pages (default: end).
 * Used by sidebar drag-and-drop and the page menu.
 */
pageRoutes.post(
  '/pages/:id/move',
  h((req) => {
    const id = param(req, 'id');
    const a = mustManage(pageAccess(id, req.user.id));
    const current = (db.prepare('SELECT section_id FROM pages WHERE id = ?').get(id) as { section_id: string }).section_id;
    const sectionId = typeof req.body.sectionId === 'string' ? req.body.sectionId : current;
    const index = typeof req.body.index === 'number' ? req.body.index : Infinity;
    if (sectionId !== current) movePageTo(id, a, sectionId, req.user.id);
    const position = positionAt('pages', 'section_id', sectionId, index, id);
    db.prepare('UPDATE pages SET position = ? WHERE id = ?').run(position, id);
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { ok: true, sectionId, position };
  }),
);

/**
 * POST /pages/:id/copy { sectionId?, title? } → { id }
 * Duplicate a page (default: right after the original, titled "<title> (copy)").
 * Embedded tasks are duplicated too, so the copy doesn't steal the original's tasks.
 */
pageRoutes.post(
  '/pages/:id/copy',
  h((req) => {
    const id = param(req, 'id');
    // A page share reaches this page only; copying it elsewhere in the workspace is for notebook-level access.
    const a = mustManage(pageAccess(id, req.user.id));
    const src = db.prepare('SELECT section_id, title, position FROM pages WHERE id = ?').get(id) as { section_id: string; title: string; position: number };
    const sectionId = typeof req.body.sectionId === 'string' ? req.body.sectionId : src.section_id;
    const t = mustAccess(sectionAccess(sectionId, req.user.id), true);
    if (t.workspaceId !== a.workspaceId) throw new HttpError(400, 'Cannot copy between workspaces');
    let position: number | undefined;
    if (sectionId === src.section_id) {
      const next = db.prepare('SELECT MIN(position) AS p FROM pages WHERE section_id = ? AND position > ?').get(sectionId, src.position) as { p: number | null };
      position = next.p === null ? src.position + 1 : (src.position + next.p) / 2;
    }
    const title = typeof req.body.title === 'string' ? req.body.title.slice(0, 300) : sectionId === src.section_id ? `${src.title || 'Untitled'} (copy)` : src.title;
    const r = copyPage(id, sectionId, req.user.id, { title, position });
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { id: r.id };
  }),
);

pageRoutes.delete(
  '/pages/:id',
  h((req) => {
    const id = param(req, 'id');
    const a = mustManage(pageAccess(id, req.user.id));
    detachPagesTasks([id], () => db.prepare('DELETE FROM pages WHERE id = ?').run(id));
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { ok: true };
  }),
);
