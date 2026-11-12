// User page templates: snapshotting a page, and turning a snapshot back into a page's content.
//
// A template's `content` is TipTap/ProseMirror JSON (what editor.getJSON() returns). It is
// self-contained:
//   - every taskRef node holds a template-local key ("tpl-task-0"), never a real task id; the
//     matching snapshot (title, description, priority, subtasks) is in `tasks`;
//   - every attachment URL ("/uploads/<id><ext>" in image, fileAttachment and link nodes)
//     points at a file row owned by the template (files.template_id), copied at save time.
// Using a template (`useTemplate`) creates NEW tasks and NEW file copies for the target page
// and returns the content rewritten to point at them. The client then inserts that content
// through the editor, exactly like a built-in template; nothing here writes page state.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FILES_DIR } from './config.ts';
import { db, newId, now } from './db.ts';
import { HttpError, roleIn, sectionAccess, taskVisible } from './access.ts';
import { createTask } from './tasks.ts';
import type { Priority, Section } from '../shared/types.ts';
import { effectiveDefaultTemplate, templateOffer } from '../shared/sections.ts';

// ── Limits ──
export const MAX_TEMPLATES_PER_WORKSPACE = 100;
/** Serialized size of a snapshot (the JSON body limit is 512 KB, so this leaves room for the other fields). */
export const MAX_TEMPLATE_CONTENT_BYTES = 300_000;
export const MAX_TEMPLATE_NAME = 100;
export const MAX_TEMPLATE_TASKS = 100; // top-level tasks
export const MAX_TEMPLATE_TASKS_TOTAL = 200; // including subtasks
export const MAX_SUBTASKS_PER_TASK = 25;
export const MAX_TEMPLATE_FILES = 20;
export const MAX_TEMPLATE_FILE_BYTES = 50 * 1024 * 1024; // total across a template's attachments
const MAX_DEPTH = 40;

export interface TplTask {
  key: string;
  title: string;
  description: string;
  priority: Priority;
  subtasks: { title: string; description: string; priority: Priority }[];
}

interface J {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: J[];
  marks?: J[];
  text?: string;
  [k: string]: unknown;
}

export const UPLOAD_URL = /^\/uploads\/([0-9a-f]{32})(\.[a-z0-9]{1,10})?$/;

interface Ctx {
  /** New URL for an upload reference, or null if it can't be kept (the node/mark is dropped). */
  file: (url: string) => string | null;
  /** New value for taskRef.taskId, or null to drop the node. */
  task: (id: unknown) => string | null;
  resetChecks: boolean;
}

/** Rewrites a JSON doc by `ctx`. Returns null if the node itself must be dropped. */
function walk(node: J, ctx: Ctx, depth: number): J | null {
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw new HttpError(400, 'Invalid content');
  if (depth > MAX_DEPTH) throw new HttpError(400, 'Content is nested too deeply');
  const out: J = { ...node };
  if (node.attrs && typeof node.attrs === 'object') {
    const attrs: Record<string, unknown> = { ...node.attrs };
    if (node.type === 'taskRef') {
      const key = ctx.task(attrs.taskId);
      if (key === null) return null;
      attrs.taskId = key;
    } else if (node.type === 'taskItem' && ctx.resetChecks) {
      attrs.checked = false;
    }
    for (const [k, v] of Object.entries(attrs)) {
      if (typeof v === 'string' && UPLOAD_URL.test(v)) {
        const n = ctx.file(v);
        if (n === null) return null;
        attrs[k] = n;
      }
    }
    out.attrs = attrs;
  }
  if (Array.isArray(node.marks)) {
    out.marks = node.marks.flatMap((m) => {
      if (!m || typeof m !== 'object') return [];
      const a = m.attrs && typeof m.attrs === 'object' ? { ...m.attrs } : undefined;
      if (a) {
        for (const [k, v] of Object.entries(a)) {
          if (typeof v === 'string' && UPLOAD_URL.test(v)) {
            const n = ctx.file(v);
            if (n === null) return []; // e.g. a link to a file we can't copy: keep the text, lose the link
            a[k] = n;
          }
        }
      }
      return [{ ...m, ...(a ? { attrs: a } : {}) }];
    });
  }
  if (Array.isArray(node.content)) {
    out.content = node.content.map((c) => walk(c, ctx, depth + 1)).filter((c): c is J => c !== null);
  }
  return out;
}

/** Every upload URL mentioned in the doc. */
function uploadUrls(node: J, found: Set<string>, depth = 0) {
  if (!node || typeof node !== 'object' || depth > MAX_DEPTH + 1) return;
  for (const src of [node.attrs, ...(node.marks ?? []).map((m) => m?.attrs)]) {
    if (src && typeof src === 'object') for (const v of Object.values(src)) if (typeof v === 'string' && UPLOAD_URL.test(v)) found.add(v);
  }
  for (const c of node.content ?? []) uploadUrls(c, found, depth + 1);
}

export type TemplateKind = 'document' | 'canvas';
/** A canvas template's doc holds only these, one per text box, with the box's geometry in attrs. */
export const CANVAS_BOX_NODE = 'canvasBox';
const MAX_CANVAS_BOXES = 200;

function validDoc(content: unknown, kind: TemplateKind = 'document'): J {
  if (!content || typeof content !== 'object' || Array.isArray(content) || (content as J).type !== 'doc' || !Array.isArray((content as J).content))
    throw new HttpError(400, 'content must be a document');
  if (kind === 'canvas') {
    const boxes = (content as J).content!;
    if (boxes.length > MAX_CANVAS_BOXES) throw new HttpError(413, `A template can have up to ${MAX_CANVAS_BOXES} text boxes`);
    for (const b of boxes) {
      const a = b?.attrs;
      const ok =
        b?.type === CANVAS_BOX_NODE &&
        Array.isArray(b.content) &&
        !!a &&
        ['x', 'y', 'w', 'z'].every((k) => typeof a[k] === 'number' && Number.isFinite(a[k] as number));
      if (!ok) throw new HttpError(400, 'A canvas template is a list of text boxes with x, y, w and z');
    }
  }
  if (Buffer.byteLength(JSON.stringify(content)) > MAX_TEMPLATE_CONTENT_BYTES)
    throw new HttpError(413, `That page is too large for a template (limit ${MAX_TEMPLATE_CONTENT_BYTES / 1000} KB of content)`);
  return content as J;
}

interface FileRow {
  id: string;
  workspace_id: string | null;
  page_id: string | null;
  template_id: string | null;
  name: string;
  ext: string;
  mime: string;
  size: number;
  created_by: string;
}

/** Copy a stored file's bytes and metadata. Returns the new row id and the path written (for cleanup). */
function copyFile(src: FileRow, dest: { workspaceId: string; pageId: string | null; templateId: string | null; userId: string }) {
  const id = crypto.randomBytes(16).toString('hex');
  const from = path.join(FILES_DIR, src.id + src.ext);
  const to = path.join(FILES_DIR, id + src.ext);
  fs.copyFileSync(from, to);
  db.prepare(
    'INSERT INTO files (id, workspace_id, page_id, template_id, name, ext, mime, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, dest.workspaceId, dest.pageId, dest.templateId, src.name, src.ext, src.mime, src.size, dest.userId, now());
  return { id, url: `/uploads/${id}${src.ext}`, path: to };
}

function unlinkQuiet(paths: string[]) {
  for (const p of paths) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* already gone */
    }
  }
}

/** Delete a template's attachment bytes from disk (rows go with the template via ON DELETE CASCADE). Call before deleting the row. */
export function templateFilePaths(templateIds: string[]): string[] {
  const out: string[] = [];
  for (const t of templateIds) {
    for (const r of db.prepare('SELECT id, ext FROM files WHERE template_id = ?').all(t) as { id: string; ext: string }[])
      out.push(path.join(FILES_DIR, r.id + r.ext));
  }
  return out;
}
export { unlinkQuiet as removeFiles };

export interface TemplateRow {
  id: string;
  workspace_id: string;
  name: string;
  icon: string | null;
  visibility: 'workspace' | 'private';
  content: string;
  tasks: string;
  kind: TemplateKind;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** A template the user may see: a workspace member, and (for private templates) its creator. */
export function visibleTemplate(id: string, userId: string): TemplateRow | null {
  const r = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow | undefined;
  if (!r || !roleIn(r.workspace_id, userId)) return null;
  if (r.visibility === 'private' && r.created_by !== userId) return null;
  return r;
}

/** True if every member of the workspace can see the task: not owner-only, and not on a page in a private notebook. */
function pageInSharedNotebook(pageId: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM pages p JOIN sections s ON s.id = p.section_id JOIN notebooks n ON n.id = s.notebook_id WHERE p.id = ? AND n.visibility = 'shared'`)
    .get(pageId);
}

function visibleToWorkspace(taskId: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM tasks t WHERE t.id = ? AND t.private_owner_only = 0 AND (t.page_id IS NULL OR EXISTS (
         SELECT 1 FROM pages p JOIN sections s ON s.id = p.section_id JOIN notebooks n ON n.id = s.notebook_id
         WHERE p.id = t.page_id AND n.visibility = 'shared'))`,
    )
    .get(taskId);
}

/**
 * Build and store a template from a page's editor JSON.
 * Tasks: each taskRef the user can see becomes a snapshot (title, description, priority and subtasks),
 * everything else about the task (done state, due date, recurrence, reminder, assignee, page) is not kept.
 * Refs to tasks that are missing, in another workspace or not visible to the user are dropped.
 * A template that keeps a task or file not everyone in the workspace can see is saved private to its creator.
 * Files: each referenced upload the user can see in this workspace is copied; others drop their node.
 */
export function createTemplate(opts: {
  workspaceId: string;
  userId: string;
  name: string;
  icon: string | null;
  visibility: 'workspace' | 'private';
  content: unknown;
  /** The kind of page it was saved from; using it makes a page of that kind. */
  kind?: TemplateKind;
  canSeeFile: (f: FileRow) => boolean;
}) {
  const kind: TemplateKind = opts.kind === 'canvas' ? 'canvas' : 'document';
  const doc = validDoc(opts.content, kind);
  const count = (db.prepare('SELECT COUNT(*) AS n FROM templates WHERE workspace_id = ?').get(opts.workspaceId) as { n: number }).n;
  if (count >= MAX_TEMPLATES_PER_WORKSPACE) throw new HttpError(409, `A workspace can have up to ${MAX_TEMPLATES_PER_WORKSPACE} templates`);

  // A workspace template is readable by every member, so it must not carry a task or file they couldn't see
  // (owner-only tasks, or anything on a page in a private notebook the saver merely has access to).
  let visibility = opts.visibility;

  // Files: resolve and copy.
  const urls = new Set<string>();
  uploadUrls(doc, urls);
  const resolved = new Map<string, FileRow>();
  let bytes = 0;
  for (const url of urls) {
    const m = UPLOAD_URL.exec(url)!;
    const row = db.prepare('SELECT * FROM files WHERE id = ?').get(m[1]) as FileRow | undefined;
    if (!row || row.ext !== (m[2] ?? '') || row.workspace_id !== opts.workspaceId || !opts.canSeeFile(row)) continue;
    if (!fs.existsSync(path.join(FILES_DIR, row.id + row.ext))) continue;
    resolved.set(url, row);
    if (row.page_id && !pageInSharedNotebook(row.page_id)) visibility = 'private';
    bytes += row.size;
  }
  if (resolved.size > MAX_TEMPLATE_FILES) throw new HttpError(413, `A template can include up to ${MAX_TEMPLATE_FILES} attachments`);
  if (bytes > MAX_TEMPLATE_FILE_BYTES)
    throw new HttpError(413, `A template's attachments can total up to ${MAX_TEMPLATE_FILE_BYTES / 1024 / 1024} MB`);

  // Tasks: snapshot.
  const tasks: TplTask[] = [];
  let subtotal = 0;
  const taskKey = (id: unknown): string | null => {
    if (typeof id !== 'string') return null;
    const t = db.prepare('SELECT * FROM tasks WHERE id = ? AND workspace_id = ? AND parent_id IS NULL').get(id, opts.workspaceId) as
      | { title: string; description: string; priority: number }
      | undefined;
    if (!t || !taskVisible(id, opts.userId)) return null;
    if (!visibleToWorkspace(id)) visibility = 'private';
    if (tasks.length >= MAX_TEMPLATE_TASKS || tasks.length + subtotal >= MAX_TEMPLATE_TASKS_TOTAL)
      throw new HttpError(413, `A template can include up to ${MAX_TEMPLATE_TASKS} tasks (${MAX_TEMPLATE_TASKS_TOTAL} with subtasks)`);
    const subs = db
      .prepare('SELECT title, description, priority FROM tasks WHERE parent_id = ? ORDER BY created_at LIMIT ?')
      .all(id, MAX_SUBTASKS_PER_TASK) as { title: string; description: string; priority: number }[];
    subtotal += subs.length;
    const key = `tpl-task-${tasks.length}`;
    tasks.push({
      key,
      title: t.title,
      description: t.description,
      priority: t.priority as Priority,
      subtasks: subs.map((s) => ({ title: s.title, description: s.description, priority: s.priority as Priority })),
    });
    return key;
  };

  const templateId = newId();
  const written: string[] = [];
  const newUrl = new Map<string, string>();
  try {
    db.transaction(() => {
      const ts = now();
      // The template row first: files.template_id references it.
      db.prepare(
        `INSERT INTO templates (id, workspace_id, name, icon, visibility, content, tasks, kind, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '{}', '[]', ?, ?, ?, ?)`,
      ).run(templateId, opts.workspaceId, opts.name, opts.icon, visibility, kind, opts.userId, ts, ts);
      for (const [url, row] of resolved) {
        const c = copyFile(row, { workspaceId: opts.workspaceId, pageId: null, templateId, userId: opts.userId });
        written.push(c.path);
        newUrl.set(url, c.url);
      }
      const out = walk(doc, { file: (u) => newUrl.get(u) ?? null, task: taskKey, resetChecks: true }, 0);
      db.prepare('UPDATE templates SET visibility = ? WHERE id = ?').run(visibility, templateId);
      const content = JSON.stringify(out);
      if (Buffer.byteLength(content) > MAX_TEMPLATE_CONTENT_BYTES) throw new HttpError(413, 'That page is too large for a template');
      db.prepare('UPDATE templates SET content = ?, tasks = ? WHERE id = ?').run(content, JSON.stringify(tasks), templateId);
    })();
  } catch (e) {
    unlinkQuiet(written);
    throw e;
  }
  return { id: templateId, taskCount: tasks.length, fileCount: newUrl.size };
}

/**
 * Instantiate a template into `pageId`: creates the template's tasks as brand-new open tasks in
 * the page (assigned to `userId`, like tasks created in the editor), copies its attachments for
 * the page, and returns the content rewritten to reference them.
 */
export function useTemplate(t: TemplateRow, pageId: string, userId: string) {
  const doc = JSON.parse(t.content) as J;
  const snaps = JSON.parse(t.tasks) as TplTask[];
  const byKey = new Map(snaps.map((s) => [s.key, s]));
  const files = db.prepare('SELECT * FROM files WHERE template_id = ?').all(t.id) as FileRow[];

  const written: string[] = [];
  const created: string[] = [];
  const urlMap = new Map<string, string>();
  let content: unknown = null;
  try {
    db.transaction(() => {
      for (const f of files) {
        const c = copyFile(f, { workspaceId: t.workspace_id, pageId, templateId: null, userId });
        written.push(c.path);
        urlMap.set(`/uploads/${f.id}${f.ext}`, c.url);
      }
      const make = (key: string) => {
        const s = byKey.get(key);
        if (!s) return null;
        const task = createTask(userId, t.workspace_id, { title: s.title.trim() || 'Untitled task', description: s.description, priority: s.priority, pageId, assigneeId: userId });
        created.push(task.id);
        for (const sub of s.subtasks) {
          const st = createTask(userId, t.workspace_id, { title: sub.title.trim() || 'Untitled task', description: sub.description, priority: sub.priority, parentId: task.id, assigneeId: userId });
          created.push(st.id);
        }
        return task.id;
      };
      const out = walk(doc, { file: (u) => urlMap.get(u) ?? null, task: (k) => (typeof k === 'string' ? make(k) : null), resetChecks: false }, 0);
      content = out;
    })();
  } catch (e) {
    unlinkQuiet(written);
    throw e;
  }
  return { content, taskIds: created };
}

// ── Where a template is offered (template_sections, migration 016) ──
// No rows: everywhere (the default). Rows: in those sections, and in their subsections when
// include_subsections is set. People only see (and can only add) sections they have access to;
// rows for sections someone can't see are kept untouched when they edit the list.

export const MAX_TEMPLATE_SECTIONS = 50;
export interface TemplateScope {
  sectionId: string;
  includeSubsections: boolean;
}

/** The template's scope rows: `visible` are those `userId` can see; `scoped` is true if there are any rows at all. */
export function templateScope(templateId: string, userId: string): { scoped: boolean; visible: TemplateScope[] } {
  const rows = db.prepare('SELECT section_id, include_subsections FROM template_sections WHERE template_id = ? ORDER BY section_id').all(templateId) as {
    section_id: string;
    include_subsections: number;
  }[];
  return {
    scoped: rows.length > 0,
    visible: rows.filter((r) => sectionAccess(r.section_id, userId)).map((r) => ({ sectionId: r.section_id, includeSubsections: !!r.include_subsections })),
  };
}

/**
 * Replace the sections `userId` can see in a template's scope with `input` (a list of
 * { sectionId, includeSubsections? }); rows for sections they can't see stay as they are.
 * Each section must be in the template's workspace and visible to the user.
 */
export function setTemplateScope(t: Pick<TemplateRow, 'id' | 'workspace_id'>, userId: string, input: unknown) {
  if (!Array.isArray(input)) throw new HttpError(400, 'sections must be a list');
  if (input.length > MAX_TEMPLATE_SECTIONS) throw new HttpError(400, `A template can be tied to up to ${MAX_TEMPLATE_SECTIONS} sections`);
  const wanted = new Map<string, boolean>();
  for (const x of input) {
    const sectionId = x && typeof x === 'object' ? (x as Record<string, unknown>).sectionId : undefined;
    if (typeof sectionId !== 'string') throw new HttpError(400, 'sections[].sectionId is required');
    const a = sectionAccess(sectionId, userId);
    if (!a || a.workspaceId !== t.workspace_id) throw new HttpError(400, 'One of those sections is not in this workspace');
    wanted.set(sectionId, (x as Record<string, unknown>).includeSubsections !== false);
  }
  db.transaction(() => {
    const existing = db.prepare('SELECT section_id FROM template_sections WHERE template_id = ?').all(t.id) as { section_id: string }[];
    const drop = db.prepare('DELETE FROM template_sections WHERE template_id = ? AND section_id = ?');
    for (const r of existing) if (sectionAccess(r.section_id, userId) && !wanted.has(r.section_id)) drop.run(t.id, r.section_id);
    const put = db.prepare(
      `INSERT INTO template_sections (template_id, section_id, include_subsections) VALUES (?, ?, ?)
       ON CONFLICT (template_id, section_id) DO UPDATE SET include_subsections = excluded.include_subsections`,
    );
    for (const [sectionId, inc] of wanted) put.run(t.id, sectionId, inc ? 1 : 0);
    const total = (db.prepare('SELECT COUNT(*) AS n FROM template_sections WHERE template_id = ?').get(t.id) as { n: number }).n;
    if (total > MAX_TEMPLATE_SECTIONS) throw new HttpError(400, `A template can be tied to up to ${MAX_TEMPLATE_SECTIONS} sections`);
  })();
}

// ── Section default templates (migration 018) ──
// A section may name a default template (sections.default_template_id); subsections inherit the
// nearest ancestor's unless they set their own or chose "None" (no_default_template). Only
// workspace-visible templates offered in the section can be a default, since the default applies
// to everyone who makes a page there.

type SectionRow = Pick<Section, 'id' | 'parentId' | 'defaultTemplateId' | 'noDefaultTemplate'>;

/** The sections of `sectionId`'s notebook, as the shared helpers want them. */
function notebookSections(sectionId: string): SectionRow[] {
  return (
    db
      .prepare(
        `SELECT s.id, s.parent_id AS parentId, s.default_template_id AS defaultTemplateId, s.no_default_template AS none
         FROM sections s WHERE s.deleted_at IS NULL AND s.notebook_id = (SELECT notebook_id FROM sections WHERE id = ?)`,
      )
      .all(sectionId) as { id: string; parentId: string | null; defaultTemplateId: string | null; none: number }[]
  ).map((r) => ({ id: r.id, parentId: r.parentId, defaultTemplateId: r.defaultTemplateId, noDefaultTemplate: !!r.none }));
}

/** Whether a template is offered in `sectionId` (tied to it or an ancestor, or offered everywhere). */
export function templateOfferedIn(templateId: string, sectionId: string): boolean {
  const rows = db.prepare('SELECT section_id, include_subsections FROM template_sections WHERE template_id = ?').all(templateId) as {
    section_id: string;
    include_subsections: number;
  }[];
  const scope = { scoped: rows.length > 0, sections: rows.map((r) => ({ sectionId: r.section_id, includeSubsections: !!r.include_subsections })) };
  return templateOffer(scope, sectionId, notebookSections(sectionId)) !== null;
}

/** A template that may be a section's default: in the workspace, shared with it, and offered in the section. */
export function defaultableTemplate(templateId: string, sectionId: string, workspaceId: string): TemplateRow | null {
  const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(templateId) as TemplateRow | undefined;
  if (!t || t.workspace_id !== workspaceId || t.visibility !== 'workspace') return null;
  return templateOfferedIn(t.id, sectionId) ? t : null;
}

/** The template new pages in `sectionId` start from (own or inherited), if it is still usable there. */
export function sectionDefaultTemplate(sectionId: string, workspaceId: string): TemplateRow | null {
  const d = effectiveDefaultTemplate(notebookSections(sectionId), sectionId);
  return d ? defaultableTemplate(d.templateId, sectionId, workspaceId) : null;
}
