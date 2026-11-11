// Workspace export/import. Owner: Foundation.
//
// Export (owners/admins): a zip with
//   workspace.json  everything needed to restore (format below), incl. each
//                   page's Yjs state (base64), so nothing is lost
//   pages/<Notebook>/<Section>/<Title>.md   readable Markdown copies
//   files/<id><ext> uploaded attachments and images
// Only what the exporter can see is included (other people's private
// notebooks and their tasks are left out).
//
// Import: creates a NEW workspace owned by the importer from such a zip, with
// fresh ids everywhere (task, page and file references inside pages are
// rewritten too). The archive is untrusted: see importWorkspace.
// Assignees and authors map to the importer when the email matches; other
// people are dropped, since they may not exist on this server.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import { db, newId, now } from './db.ts';
import { NOTEBOOK_VISIBLE, TASK_VISIBLE, HttpError } from './access.ts';
import { extractPage, newBoxId } from './collab.ts';
import { convertPageDoc, pageFragments } from '../shared/pageDoc.ts';
import { FILES_DIR, VERSION } from './config.ts';
import { toMarkdown } from './markdown.ts';
import { SAFE_TYPES } from './routes/files.ts';
import { readZip, writeZip, type ZipEntry } from './zip.ts';
import { sanitizeYDoc } from './sanitizeDoc.ts';
import {
  MAX_SUBTASKS_PER_TASK,
  MAX_TEMPLATE_CONTENT_BYTES,
  MAX_TEMPLATE_NAME,
  MAX_TEMPLATE_TASKS,
  MAX_TEMPLATES_PER_WORKSPACE,
  type TplTask,
} from './templates.ts';
import { APP_NAME } from '../shared/config.ts';
import { MAX_SECTION_DEPTH, sectionAncestry } from '../shared/sections.ts';
import { recurrenceError } from '../shared/recurrence.ts';
import { sanitizeContent } from '../shared/urls.ts';
import type { Priority } from '../shared/types.ts';

export const EXPORT_FORMAT = 'noteapp-workspace';
export const EXPORT_VERSION = 1;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

const safeName = (s: string) => (s || 'Untitled').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').trim().slice(0, 80) || 'Untitled';

export function exportWorkspace(workspaceId: string, userId: string): { zip: Buffer; filename: string } {
  const p = { workspaceId, userId };
  const ws = db.prepare('SELECT id, name, created_at FROM workspaces WHERE id = ?').get(workspaceId) as Row;
  const members = db
    .prepare('SELECT u.id, u.email, u.name, m.role FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?')
    .all(workspaceId) as Row[];
  const notebooks = db
    .prepare(`SELECT n.id, n.name, n.color, n.visibility, n.created_by, n.position FROM notebooks n WHERE n.workspace_id = @workspaceId AND ${NOTEBOOK_VISIBLE} ORDER BY n.position`)
    .all(p) as Row[];
  const nbIds = new Set(notebooks.map((n) => n.id));
  const sections = (db.prepare('SELECT id, notebook_id, parent_id, name, color, position FROM sections ORDER BY position').all() as Row[]).filter((s) =>
    nbIds.has(s.notebook_id),
  );
  const secIds = new Set(sections.map((s) => s.id));
  const pages = (
    db.prepare('SELECT id, section_id, title, icon, kind, position, ydoc, created_by, created_at, updated_at FROM pages ORDER BY position').all() as Row[]
  ).filter((pg) => secIds.has(pg.section_id));
  const tasks = db.prepare(`SELECT t.* FROM tasks t WHERE t.workspace_id = @workspaceId AND ${TASK_VISIBLE}`).all(p) as Row[];
  // Tags, teams and the exporter's own and shared saved views (migration 014).
  const tags = db.prepare('SELECT id, name, color FROM tags WHERE workspace_id = ? ORDER BY name').all(workspaceId) as Row[];
  const exportedTasks = new Set(tasks.map((t) => t.id));
  const taskTags = (db.prepare('SELECT tt.task_id, tt.tag_id FROM task_tags tt JOIN tags g ON g.id = tt.tag_id WHERE g.workspace_id = ?').all(workspaceId) as Row[]).filter(
    (x) => exportedTasks.has(x.task_id),
  );
  const teams = (db.prepare('SELECT id, parent_id, name, color, position FROM teams WHERE workspace_id = ? ORDER BY position').all(workspaceId) as Row[]).map((t) => ({
    ...t,
    member_ids: (db.prepare('SELECT user_id FROM team_members WHERE team_id = ?').all(t.id) as Row[]).map((x) => x.user_id),
  }));
  const taskViews = (
    db.prepare('SELECT id, owner_id, shared, name, query, position FROM task_views WHERE workspace_id = ? AND (owner_id = ? OR shared = 1) ORDER BY position').all(workspaceId, userId) as Row[]
  ).map((v) => ({ ...v, query: JSON.parse(v.query) }));
  const pageIds = new Set(pages.map((pg) => pg.id));
  // Templates: the workspace-wide ones and the exporter's own private ones (same rule as GET /workspaces/:id/templates).
  const templates = db
    .prepare(`SELECT * FROM templates WHERE workspace_id = ? AND (visibility = 'workspace' OR created_by = ?) ORDER BY created_at, id`)
    .all(workspaceId, userId) as Row[];
  const tplIds = new Set(templates.map((t) => t.id));
  // Where each template is offered (only rows for exported templates and sections).
  const templateSections = (
    db.prepare('SELECT ts.* FROM template_sections ts JOIN templates t ON t.id = ts.template_id WHERE t.workspace_id = ?').all(workspaceId) as Row[]
  ).filter((r) => tplIds.has(r.template_id) && secIds.has(r.section_id));
  // A file goes with its page or its template, so nothing in a private notebook or another
  // person's private template is exported.
  const files = (db.prepare('SELECT * FROM files WHERE workspace_id = ?').all(workspaceId) as Row[]).filter((f) =>
    f.template_id ? tplIds.has(f.template_id) : !f.page_id || pageIds.has(f.page_id),
  );

  const entries: ZipEntry[] = [];
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const used = new Set<string>();
  const sectionLinks = sections.map((s) => ({ id: s.id as string, parentId: s.parent_id as string | null, name: s.name as string }));
  for (const pg of pages) {
    const sec = sections.find((s) => s.id === pg.section_id)!;
    const nb = notebooks.find((n) => n.id === sec.notebook_id)!;
    // Subsections are nested folders: pages/<Notebook>/<Section>/<Subsection>/<Title>.md
    const dir = sectionAncestry(sectionLinks, sec.id)
      .map((s) => safeName(s.name))
      .join('/');
    const doc = new Y.Doc();
    if (pg.ydoc) Y.applyUpdate(doc, new Uint8Array(pg.ydoc));
    const md = toMarkdown(pg.title, pageFragments(doc), (id) => {
      const t = taskById.get(id);
      return t && { title: t.title, done: t.status === 'done', due: t.due_date };
    });
    let file = `pages/${safeName(nb.name)}/${dir}/${safeName(pg.title)}`;
    for (let i = 2; used.has(file); i++) file = `pages/${safeName(nb.name)}/${dir}/${safeName(pg.title)} (${i})`;
    used.add(file);
    entries.push({ name: `${file}.md`, data: Buffer.from(md) });
  }
  const fileEntries = files.flatMap((f) => {
    const disk = path.join(FILES_DIR, `${f.id}${f.ext}`);
    return fs.existsSync(disk) ? [{ name: `files/${f.id}${f.ext}`, data: fs.readFileSync(disk) }] : [];
  });

  const manifest = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    app: APP_NAME,
    appVersion: VERSION,
    exportedAt: now(),
    workspace: { id: ws.id, name: ws.name, createdAt: ws.created_at },
    members: members.map((m) => ({ id: m.id, email: m.email, name: m.name, role: m.role })),
    notebooks,
    sections,
    pages: pages.map(({ ydoc, ...pg }) => ({ ...pg, ydoc: ydoc ? Buffer.from(ydoc).toString('base64') : null })),
    tasks,
    tags,
    taskTags,
    teams,
    taskViews,
    files,
    templates: templates.map(({ content, tasks: snaps, ...t }) => ({ ...t, content: JSON.parse(content), tasks: JSON.parse(snaps) })),
    templateSections,
  };
  entries.unshift({ name: 'workspace.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) });
  entries.push(...fileEntries);
  const stamp = new Date().toISOString().slice(0, 10);
  return { zip: writeZip(entries), filename: `${safeName(ws.name)} ${stamp}.zip` };
}

/** Largest total unpacked size of an import (the body itself is capped at 100 MB by the route). */
export const MAX_UNPACKED_BYTES = 300 * 1024 * 1024;
const PRIORITIES = [1, 2, 3, 4];
const MAX_TEXT = 50_000;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
/** A stored file reference in a document: our upload/file paths. */
const FILE_URL = /^\/(uploads|files)\/([0-9a-f]{32})(\.[a-z0-9]{1,10})?$/;

const list = (v: unknown, what: string): Row[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => !x || typeof x !== 'object')) throw new HttpError(400, `workspace.json: ${what} must be a list`);
  return v as Row[];
};
const text = (v: unknown, max: number, fallback = '') => (typeof v === 'string' ? v.slice(0, max) : fallback);
const color = (v: unknown) => (typeof v === 'string' && HEX_COLOR.test(v) ? v.toLowerCase() : '#6366f1');
const icon = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 16) : null);
const isoOr = (v: unknown, fallback: string) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : fallback);
const dateOrNull = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const timeOrNull = (v: unknown) => (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : null);

/**
 * Import is fed a file from anywhere, so everything in it is treated as untrusted:
 *   - page documents go through the editor's URL rules (sanitizeYDoc), template content through sanitizeContent
 *   - every value written to the database is type-checked, clamped or replaced by a default
 *   - nothing is written to disk under a name from the archive: attachments get fresh ids (and the
 *     documents that mention them are rewritten), so an import can never touch an existing file
 *   - size: the route caps the body (100 MB) and admits one import at a time, rate limited per user and
 *     server-wide (server/ratelimit.ts); readZip caps the unpacked total (300 MB) and each entry
 */
export async function importWorkspace(zip: Buffer, userId: string): Promise<{ workspaceId: string; name: string }> {
  let entries: ZipEntry[];
  try {
    entries = await readZip(zip, { maxTotal: MAX_UNPACKED_BYTES });
  } catch (e) {
    throw new HttpError(400, `That file isn't a valid export: ${(e as Error).message}`);
  }
  const manifestEntry = entries.find((e) => e.name === 'workspace.json');
  if (!manifestEntry) throw new HttpError(400, 'workspace.json is missing from the archive');
  let m: Row;
  try {
    m = JSON.parse(manifestEntry.data.toString('utf8'));
  } catch {
    throw new HttpError(400, 'workspace.json is not valid JSON');
  }
  if (!m || typeof m !== 'object' || m.format !== EXPORT_FORMAT) throw new HttpError(400, 'Not a workspace export');
  if (typeof m.version !== 'number' || m.version > EXPORT_VERSION) throw new HttpError(400, 'This export comes from a newer version of the app');
  const members = list(m.members, 'members');
  const notebooks = list(m.notebooks, 'notebooks');
  const sections = list(m.sections, 'sections');
  const pages = list(m.pages, 'pages');
  const tasks = list(m.tasks, 'tasks');
  const files = list(m.files, 'files');
  const templates = list(m.templates, 'templates');
  const tags = list(m.tags, 'tags');
  const taskTags = list(m.taskTags, 'taskTags');
  const teams = list(m.teams, 'teams');
  const taskViews = list(m.taskViews, 'taskViews');

  const me = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId) as { id: string; email: string };
  const exportedIdsForMe = new Set(members.filter((x) => typeof x.email === 'string' && x.email.toLowerCase() === me.email.toLowerCase()).map((x) => x.id));
  const person = (id: unknown) => (typeof id === 'string' && exportedIdsForMe.has(id) ? userId : null);
  const map = new Map<string, string>();
  const fresh = (old: unknown) => {
    const k = String(old);
    if (!map.has(k)) map.set(k, newId());
    return map.get(k)!;
  };
  const mapped = (old: unknown) => (typeof old === 'string' ? (map.get(old) ?? null) : null);
  const ts = now();
  const workspaceId = newId();
  const name = `${text(m.workspace?.name, 90, 'Workspace') || 'Workspace'} (imported)`;

  // Attachments: only those listed in the manifest with their bytes present, each under a fresh id.
  const fileUrl = new Map<string, string>(); // old id → new "/uploads/<id><ext>"
  const fileRows: { row: Row; data: Buffer; id: string; ext: string }[] = [];
  for (const f of files) {
    const ext = typeof f.ext === 'string' ? f.ext : '';
    if (!/^[0-9a-f]{32}$/.test(String(f.id)) || !/^(\.[a-z0-9]{1,10})?$/.test(ext)) continue;
    const entry = entries.find((e) => e.name === `files/${f.id}${ext}`);
    if (!entry) continue;
    const id = crypto.randomBytes(16).toString('hex');
    // Same rule as uploads: only allow-listed extensions are kept, and the type comes from the extension.
    fileRows.push({ row: f, data: entry.data, id, ext: Object.hasOwn(SAFE_TYPES, ext) ? ext : '' });
    fileUrl.set(f.id, `/uploads/${id}${fileRows.at(-1)!.ext}`);
  }
  /** A document's file URL → the imported copy's URL ("" if the file wasn't imported). Other URLs are kept. */
  const rewriteUrl = (u: string) => {
    const hit = FILE_URL.exec(u);
    return hit ? (fileUrl.get(hit[2]) ?? '') : u;
  };

  // Tasks first get their new ids so page documents can be rewritten.
  for (const t of tasks) fresh(t.id);
  for (const p of pages) fresh(p.id);
  const teamIds = new Set(teams.map((t) => String(t.id)));
  for (const t of teams) fresh(t.id);

  const written: string[] = [];
  try {
    db.transaction(() => {
      db.prepare('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').run(workspaceId, name, userId, ts);
      db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").run(workspaceId, userId, ts);
      for (const n of notebooks)
        db.prepare('INSERT INTO notebooks (id, workspace_id, name, color, visibility, created_by, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
          fresh(n.id), workspaceId, text(n.name, 100) || 'Notebook', color(n.color), n.visibility === 'private' ? 'private' : 'shared', userId, Number(n.position) || 0, ts,
        );
      for (const s of sections) {
        const nb = mapped(s.notebook_id);
        if (!nb || !notebooks.some((n) => n.id === s.notebook_id)) continue;
        db.prepare('INSERT INTO sections (id, notebook_id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
          fresh(s.id), nb, text(s.name, 100) || 'Section', color(s.color), Number(s.position) || 0, ts,
        );
      }
      const importedSections = new Set(sections.filter((s) => notebooks.some((n) => n.id === s.notebook_id)).map((s) => s.id));
      // Nesting: kept when the whole chain of parents is imported, in the same notebook, without a
      // cycle and within MAX_SECTION_DEPTH levels; otherwise the section lands at the top level.
      const byId = new Map(sections.filter((s) => importedSections.has(s.id)).map((s) => [String(s.id), s]));
      const setParent = db.prepare('UPDATE sections SET parent_id = ? WHERE id = ?');
      for (const s of byId.values()) {
        if (typeof s.parent_id !== 'string') continue;
        let ok = true;
        const seen = new Set<string>([String(s.id)]);
        for (let cur = s; typeof cur.parent_id === 'string'; ) {
          const parent = byId.get(cur.parent_id);
          if (!parent || parent.notebook_id !== s.notebook_id || seen.has(cur.parent_id) || seen.size >= MAX_SECTION_DEPTH) {
            ok = false;
            break;
          }
          seen.add(cur.parent_id);
          cur = parent;
        }
        if (ok) setParent.run(map.get(s.parent_id), map.get(String(s.id)));
      }
      const importedPages = new Set<string>();
      for (const pg of pages) {
        if (!importedSections.has(pg.section_id)) continue;
        let ydoc: Buffer | null = null;
        let body = '';
        if (pg.ydoc) {
          const doc = new Y.Doc();
          try {
            Y.applyUpdate(doc, new Uint8Array(Buffer.from(String(pg.ydoc), 'base64')));
          } catch {
            throw new HttpError(400, `The page "${text(pg.title, 80)}" in this export is damaged`);
          }
          sanitizeYDoc(doc, {
            url: rewriteUrl,
            element: (el) => {
              const ref = el.nodeName === 'taskRef' ? 'taskId' : el.nodeName === 'pageLink' ? 'pageId' : null;
              const old = ref && el.getAttribute(ref);
              if (ref && typeof old === 'string' && map.has(old)) el.setAttribute(ref, map.get(old)!);
            },
          });
          // Every page is a canvas: a document page in an older export becomes one wide box.
          convertPageDoc(doc, 'canvas', newBoxId);
          ydoc = Buffer.from(Y.encodeStateAsUpdate(doc));
          body = extractPage(doc).text;
        }
        const id = fresh(pg.id);
        importedPages.add(pg.id);
        const title = text(pg.title, 300);
        db.prepare(
          `INSERT INTO pages (id, section_id, title, icon, kind, ydoc, text, position, created_by, created_at, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, map.get(pg.section_id), title, icon(pg.icon), 'canvas', ydoc, body, Number(pg.position) || 0, userId, isoOr(pg.created_at, ts), ts, userId);
        db.prepare('INSERT INTO pages_fts (page_id, title, text) VALUES (?, ?, ?)').run(id, title, body);
      }
      const pageOf = (old: unknown) => (typeof old === 'string' && importedPages.has(old) ? map.get(old)! : null);

      // Teams (subteams one level deep) and tags, before the tasks that point at them.
      const teamOf = (old: unknown) => (typeof old === 'string' && teamIds.has(old) ? map.get(old)! : null);
      const topLevel = new Set(teams.filter((t) => !teamIds.has(String(t.parent_id))).map((t) => String(t.id)));
      for (const t of [...teams].sort((a, b) => Number(topLevel.has(String(b.id))) - Number(topLevel.has(String(a.id))))) {
        const parent = topLevel.has(String(t.id)) ? null : topLevel.has(String(t.parent_id)) ? teamOf(t.parent_id) : null;
        db.prepare('INSERT INTO teams (id, workspace_id, parent_id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          map.get(String(t.id)), workspaceId, parent, text(t.name, 60) || 'Team', color(t.color), Number(t.position) || 0, ts,
        );
        if (Array.isArray(t.member_ids) && t.member_ids.some((u: unknown) => person(u)))
          db.prepare('INSERT INTO team_members (team_id, user_id) VALUES (?, ?)').run(map.get(String(t.id)), userId);
      }
      const tagIds = new Map<string, string>();
      const addTag = db.prepare('INSERT OR IGNORE INTO tags (id, workspace_id, name, color, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const g of tags.slice(0, 500)) {
        const name = text(g.name, 40).trim();
        if (!name || typeof g.id !== 'string') continue;
        const id = newId();
        if (addTag.run(id, workspaceId, name, color(g.color), userId, ts).changes) tagIds.set(g.id, id);
        else tagIds.set(g.id, (db.prepare('SELECT id FROM tags WHERE workspace_id = ? AND name = ?').get(workspaceId, name) as Row).id);
      }

      // Tasks: rows first, then the links between them (subtasks, recurring history), so the order in the file doesn't matter.
      const taskIds = new Set(tasks.map((t) => String(t.id)));
      for (const t of tasks) {
        const done = t.status === 'done';
        db.prepare(
          `INSERT INTO tasks (id, workspace_id, title, description, status, priority, due_date, due_time, recurrence, reminder_at,
             assignee_id, created_by, page_id, completed_at, completed_by, created_at, updated_at, private_owner_only, team_id, assigned_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          map.get(String(t.id)), workspaceId, text(t.title, 500), text(t.description, MAX_TEXT), done ? 'done' : 'open',
          PRIORITIES.includes(t.priority) ? t.priority : 4, dateOrNull(t.due_date), timeOrNull(t.due_time),
          recurrence(t.recurrence), t.reminder_at ? isoOr(t.reminder_at, ts) : null,
          person(t.assignee_id), userId, pageOf(t.page_id), done ? isoOr(t.completed_at, ts) : null, done ? userId : null, isoOr(t.created_at, ts), ts,
          t.private_owner_only ? 1 : 0, teamOf(t.team_id), person(t.assignee_id) ? person(t.assigned_by) : null,
        );
      }
      const tagTask = db.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)');
      for (const x of taskTags) {
        const task = taskIds.has(String(x.task_id)) ? map.get(String(x.task_id)) : undefined;
        const tag = typeof x.tag_id === 'string' ? tagIds.get(x.tag_id) : undefined;
        if (task && tag) tagTask.run(task, tag);
      }
      // Saved views: the importer's own and shared ones, all owned by the importer now; ids inside the filters are rewritten.
      const remap = (v: unknown): unknown =>
        typeof v === 'string' ? (map.get(v) ?? tagIds.get(v) ?? v) : Array.isArray(v) ? v.map(remap) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remap(x)])) : v;
      for (const [i, v] of taskViews.slice(0, 200).entries()) {
        const q = v.query;
        if (!q || typeof q !== 'object' || !q.filters || typeof q.filters !== 'object' || typeof q.sort !== 'string' || typeof q.group !== 'string') continue;
        const query = JSON.stringify({ filters: remap(q.filters), sort: q.sort.slice(0, 20), group: q.group.slice(0, 20) });
        if (query.length > 8192) continue;
        db.prepare('INSERT INTO task_views (id, workspace_id, owner_id, shared, name, query, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
          newId(), workspaceId, userId, v.shared ? 1 : 0, text(v.name, 60) || 'View', query, Number(v.position) || i, ts,
        );
      }
      const link = db.prepare('UPDATE tasks SET parent_id = ?, occurrence_of = ? WHERE id = ?');
      for (const t of tasks) {
        const parent = taskIds.has(String(t.parent_id)) && t.parent_id !== t.id ? map.get(String(t.parent_id))! : null;
        const occ = taskIds.has(String(t.occurrence_of)) && t.occurrence_of !== t.id ? map.get(String(t.occurrence_of))! : null;
        if (parent || occ) link.run(parent, occ, map.get(String(t.id)));
      }

      // Templates (content is editor JSON: sanitised like an imported Markdown file).
      for (const t of templates.slice(0, MAX_TEMPLATES_PER_WORKSPACE)) {
        const doc = t.content;
        if (!doc || typeof doc !== 'object' || doc.type !== 'doc' || !Array.isArray(doc.content)) continue;
        const content = JSON.stringify(rewriteJsonUrls(sanitizeContent(doc), rewriteUrl));
        if (Buffer.byteLength(content) > MAX_TEMPLATE_CONTENT_BYTES) continue;
        const snaps = Array.isArray(t.tasks) ? (t.tasks as Row[]).slice(0, MAX_TEMPLATE_TASKS).filter((x) => x && typeof x.key === 'string').map(snapshot) : [];
        db.prepare(
          `INSERT INTO templates (id, workspace_id, name, icon, visibility, content, tasks, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(fresh(t.id), workspaceId, text(t.name, MAX_TEMPLATE_NAME) || 'Template', icon(t.icon), t.visibility === 'private' ? 'private' : 'workspace', content, JSON.stringify(snaps), userId, isoOr(t.created_at, ts), ts);
      }
      const importedTemplates = new Set(templates.filter((t) => map.has(String(t.id))).map((t) => String(t.id)));
      const scope = db.prepare('INSERT OR IGNORE INTO template_sections (template_id, section_id, include_subsections) VALUES (?, ?, ?)');
      for (const r of list(m.templateSections, 'templateSections')) {
        if (importedTemplates.has(String(r.template_id)) && importedSections.has(r.section_id))
          scope.run(map.get(String(r.template_id)), map.get(r.section_id), r.include_subsections ? 1 : 0);
      }

      fs.mkdirSync(FILES_DIR, { recursive: true });
      for (const { row: f, data, id, ext } of fileRows) {
        const templateId = typeof f.template_id === 'string' && importedTemplates.has(f.template_id) ? map.get(f.template_id)! : null;
        if (f.template_id && !templateId) continue; // its template wasn't imported
        const disk = path.join(FILES_DIR, `${id}${ext}`);
        fs.writeFileSync(disk, data, { flag: 'wx' }); // fresh id: never overwrites
        written.push(disk);
        db.prepare(
          `INSERT INTO files (id, workspace_id, page_id, template_id, name, ext, mime, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, workspaceId, pageOf(f.page_id), templateId, fileName(f.name, ext), ext, (SAFE_TYPES[ext] ?? 'application/octet-stream').split(';')[0], data.length, userId, ts);
      }
    })();
  } catch (e) {
    for (const p of written) fs.rmSync(p, { force: true });
    throw e;
  }
  return { workspaceId, name };
}

/** The stored JSON of a valid recurrence rule, or null. */
function recurrence(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2000) return null;
  try {
    const r = JSON.parse(v);
    return recurrenceError(r) ? null : JSON.stringify(r);
  } catch {
    return null;
  }
}

const fileName = (v: unknown, ext: string) => (typeof v === 'string' ? path.basename(v.replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200) : '') || `file${ext}`;

/** A template's task snapshot, with every field type-checked (see TplTask in templates.ts). */
function snapshot(x: Row): TplTask {
  const prio = (p: unknown) => (PRIORITIES.includes(p as number) ? (p as Priority) : 4);
  return {
    key: x.key.slice(0, 64),
    title: text(x.title, 500),
    description: text(x.description, MAX_TEXT),
    priority: prio(x.priority),
    subtasks: (Array.isArray(x.subtasks) ? (x.subtasks as Row[]) : [])
      .filter((s) => s && typeof s === 'object')
      .slice(0, MAX_SUBTASKS_PER_TASK)
      .map((s) => ({ title: text(s.title, 500), description: text(s.description, MAX_TEXT), priority: prio(s.priority) })),
  };
}

/** Apply `fn` to every string attribute that looks like one of our file URLs; drop nodes/marks whose file is gone. */
function rewriteJsonUrls(node: Row, fn: (u: string) => string): Row {
  const fix = (attrs: Row | undefined) => {
    if (!attrs || typeof attrs !== 'object') return { attrs, ok: true };
    const out: Row = { ...attrs };
    for (const [k, v] of Object.entries(attrs)) {
      if (typeof v === 'string' && FILE_URL.test(v)) {
        out[k] = fn(v);
        if (!out[k]) return { attrs: out, ok: false };
      }
    }
    return { attrs: out, ok: true };
  };
  const walk = (n: Row): Row | null => {
    const a = fix(n.attrs);
    if (!a.ok) return null;
    const out: Row = { ...n, ...(n.attrs ? { attrs: a.attrs } : {}) };
    if (Array.isArray(n.marks)) out.marks = (n.marks as Row[]).flatMap((mk) => { const f = fix(mk?.attrs); return f.ok ? [{ ...mk, ...(mk?.attrs ? { attrs: f.attrs } : {}) }] : []; });
    if (Array.isArray(n.content)) out.content = (n.content as Row[]).map(walk).filter((c): c is Row => c !== null);
    return out;
  };
  return walk(node) ?? { ...node, content: [] };
}
