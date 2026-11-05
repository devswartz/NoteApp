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
// fresh ids everywhere (task references inside pages are rewritten too).
// Assignees and authors map to the importer when the email matches; other
// people are dropped, since they may not exist on this server.
import fs from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import { db, newId, now } from './db.ts';
import { NOTEBOOK_VISIBLE, TASK_VISIBLE, HttpError } from './access.ts';
import { extractDoc } from './collab.ts';
import { FILES_DIR, VERSION } from './config.ts';
import { toMarkdown } from './markdown.ts';
import { readZip, writeZip, type ZipEntry } from './zip.ts';
import { APP_NAME } from '../shared/config.ts';

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
  const sections = (db.prepare('SELECT id, notebook_id, name, color, position FROM sections ORDER BY position').all() as Row[]).filter((s) =>
    nbIds.has(s.notebook_id),
  );
  const secIds = new Set(sections.map((s) => s.id));
  const pages = (
    db.prepare('SELECT id, section_id, title, icon, kind, position, ydoc, created_by, created_at, updated_at FROM pages ORDER BY position').all() as Row[]
  ).filter((pg) => secIds.has(pg.section_id));
  const tasks = db.prepare(`SELECT t.* FROM tasks t WHERE t.workspace_id = @workspaceId AND ${TASK_VISIBLE}`).all(p) as Row[];
  const pageIds = new Set(pages.map((pg) => pg.id));
  const files = (db.prepare('SELECT * FROM files WHERE workspace_id = ?').all(workspaceId) as Row[]).filter(
    (f) => !f.page_id || pageIds.has(f.page_id),
  );

  const entries: ZipEntry[] = [];
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const used = new Set<string>();
  for (const pg of pages) {
    const sec = sections.find((s) => s.id === pg.section_id)!;
    const nb = notebooks.find((n) => n.id === sec.notebook_id)!;
    const doc = new Y.Doc();
    if (pg.ydoc) Y.applyUpdate(doc, new Uint8Array(pg.ydoc));
    const md = toMarkdown(pg.title, doc.getXmlFragment('default'), (id) => {
      const t = taskById.get(id);
      return t && { title: t.title, done: t.status === 'done', due: t.due_date };
    });
    let file = `pages/${safeName(nb.name)}/${safeName(sec.name)}/${safeName(pg.title)}`;
    for (let i = 2; used.has(file); i++) file = `pages/${safeName(nb.name)}/${safeName(sec.name)}/${safeName(pg.title)} (${i})`;
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
    files,
  };
  entries.unshift({ name: 'workspace.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) });
  entries.push(...fileEntries);
  const stamp = new Date().toISOString().slice(0, 10);
  return { zip: writeZip(entries), filename: `${safeName(ws.name)} ${stamp}.zip` };
}

export function importWorkspace(zip: Buffer, userId: string): { workspaceId: string; name: string } {
  let entries: ZipEntry[];
  try {
    entries = readZip(zip);
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
  if (m.format !== EXPORT_FORMAT) throw new HttpError(400, 'Not a workspace export');
  if (m.version > EXPORT_VERSION) throw new HttpError(400, 'This export comes from a newer version of the app');

  const me = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId) as { id: string; email: string };
  const exportedIdsForMe = new Set((m.members as Row[]).filter((x) => x.email?.toLowerCase() === me.email.toLowerCase()).map((x) => x.id));
  const person = (id: string | null) => (id && exportedIdsForMe.has(id) ? userId : null);
  const map = new Map<string, string>();
  const fresh = (old: string) => {
    if (!map.has(old)) map.set(old, newId());
    return map.get(old)!;
  };
  const ts = now();
  const workspaceId = newId();
  const name = `${String(m.workspace?.name ?? 'Workspace').slice(0, 90)} (imported)`;

  db.transaction(() => {
    db.prepare('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').run(workspaceId, name, userId, ts);
    db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").run(workspaceId, userId, ts);
    for (const n of m.notebooks as Row[])
      db.prepare('INSERT INTO notebooks (id, workspace_id, name, color, visibility, created_by, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        fresh(n.id), workspaceId, String(n.name), String(n.color ?? '#6366f1'), n.visibility === 'private' ? 'private' : 'shared', userId, Number(n.position) || 0, ts,
      );
    for (const s of m.sections as Row[]) {
      if (!map.has(s.notebook_id)) continue;
      db.prepare('INSERT INTO sections (id, notebook_id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        fresh(s.id), map.get(s.notebook_id), String(s.name), String(s.color ?? '#6366f1'), Number(s.position) || 0, ts,
      );
    }
    // Tasks first get their new ids so page documents can be rewritten.
    for (const t of m.tasks as Row[]) fresh(t.id);
    for (const pg of m.pages as Row[]) {
      if (!map.has(pg.section_id)) continue;
      let ydoc: Buffer | null = null;
      let text = '';
      if (pg.ydoc) {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, new Uint8Array(Buffer.from(pg.ydoc, 'base64')));
        const rewrite = (n: Y.XmlElement | Y.XmlFragment) => {
          for (const c of n.toArray()) {
            if (!(c instanceof Y.XmlElement)) continue;
            if (c.nodeName === 'taskRef') {
              const old = c.getAttribute('taskId') as string | undefined;
              if (old && map.has(old)) c.setAttribute('taskId', map.get(old)!);
            }
            rewrite(c);
          }
        };
        rewrite(doc.getXmlFragment('default'));
        ydoc = Buffer.from(Y.encodeStateAsUpdate(doc));
        text = extractDoc(doc.getXmlFragment('default')).text;
      }
      const id = fresh(pg.id);
      const title = String(pg.title ?? '').slice(0, 300);
      db.prepare(
        `INSERT INTO pages (id, section_id, title, icon, kind, ydoc, text, position, created_by, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, map.get(pg.section_id), title, pg.icon ?? null, pg.kind === 'canvas' ? 'canvas' : 'document', ydoc, text, Number(pg.position) || 0, userId, pg.created_at ?? ts, ts, userId);
      db.prepare('INSERT INTO pages_fts (page_id, title, text) VALUES (?, ?, ?)').run(id, title, text);
    }
    const tasks = m.tasks as Row[];
    // Recurring-task history points at its parent: insert parents first.
    tasks.sort((a, b) => (a.occurrence_of ? 1 : 0) - (b.occurrence_of ? 1 : 0));
    for (const t of tasks) {
      db.prepare(
        `INSERT INTO tasks (id, workspace_id, title, description, status, priority, due_date, due_time, recurrence, reminder_at,
           assignee_id, created_by, page_id, occurrence_of, completed_at, completed_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        map.get(t.id), workspaceId, String(t.title ?? ''), String(t.description ?? ''), t.status === 'done' ? 'done' : 'open',
        [1, 2, 3, 4].includes(t.priority) ? t.priority : 4, t.due_date ?? null, t.due_time ?? null, t.recurrence ?? null, t.reminder_at ?? null,
        person(t.assignee_id), userId, t.page_id ? (map.get(t.page_id) ?? null) : null, t.occurrence_of ? (map.get(t.occurrence_of) ?? null) : null,
        t.completed_at ?? null, t.completed_at ? userId : null, t.created_at ?? ts, ts,
      );
    }
    // Attachments keep their ids (URLs in pages stay valid); bytes are copied if missing.
    fs.mkdirSync(FILES_DIR, { recursive: true });
    for (const f of m.files as Row[]) {
      if (!/^[0-9a-f]{32}$/.test(String(f.id)) || !/^(\.[a-z0-9]{1,10})?$/.test(String(f.ext ?? ''))) continue;
      const entry = entries.find((e) => e.name === `files/${f.id}${f.ext}`);
      if (!entry) continue;
      const disk = path.join(FILES_DIR, `${f.id}${f.ext}`);
      if (!fs.existsSync(disk)) fs.writeFileSync(disk, entry.data);
      db.prepare(
        `INSERT OR IGNORE INTO files (id, workspace_id, page_id, name, ext, mime, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(f.id, workspaceId, f.page_id ? (map.get(f.page_id) ?? null) : null, String(f.name), f.ext ?? '', String(f.mime ?? 'application/octet-stream'), entry.data.length, userId, ts);
    }
  })();
  return { workspaceId, name };
}
