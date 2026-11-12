// "Export my data" (GET /api/me/export): one person's own data as a zip, for any signed-in user.
//
//   README.txt                      what is in the archive
//   profile.json                    account, workspace memberships, pages shared with them
//   notification-settings.json      delivery settings, quiet hours, registered devices (no tokens)
//   tasks.json                      tasks they created or are assigned, that they can still see
//   comments.json                   comments they wrote, on pages they can still open
//   pages/<Workspace>/<Notebook>/<Section>/<Title>.md
//                                   every page they can open, as Markdown
//   pages/Shared with me/<Title>.md pages they reach only through a page share (no notebook or
//                                   workspace names: a share never reveals anything around the page)
//   files/<id><ext>                 files they uploaded that they can still see
//
// Scope is exactly what the person can see in the app today: the same access rules as everywhere
// else (PAGE_VISIBLE, TASK_VISIBLE, pageAccess, canReadFile). Other people's private notebooks,
// other workspaces and anyone else's settings never appear. Unlike the workspace export
// (server/export.ts, owners and admins), this is not a restorable backup.
import fs from 'node:fs';
import path from 'node:path';
import { db, now } from './db.ts';
import { PAGE_VISIBLE, TASK_VISIBLE, pageAccess } from './access.ts';
import { FILES_DIR, PUBLIC_URL, VERSION } from './config.ts';
import { pageMarkdown, safeName } from './export.ts';
import { canReadFile } from './routes/files.ts';
import { writeZip, type ZipEntry } from './zip.ts';
import { APP_NAME } from '../shared/config.ts';
import { sectionAncestry } from '../shared/sections.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

/** Uploaded files beyond this total are listed in the archive but not copied into it (the zip is built in memory). */
export const MAX_EXPORT_FILE_BYTES = 250 * 1024 * 1024;

const json = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2));

export function exportUserData(userId: string): { zip: Buffer; filename: string } {
  const p = { userId };
  const user = db.prepare('SELECT id, email, name, color, created_at, email_verified_at FROM users WHERE id = ?').get(userId) as Row;
  const memberships = db
    .prepare('SELECT w.id, w.name, m.role, m.joined_at FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY w.name')
    .all(userId) as Row[];
  const wsName = new Map(memberships.map((w) => [w.id as string, w.name as string]));

  // ── Pages: every page they can open ──
  const pages = db
    .prepare(
      `SELECT pg.id, pg.title, pg.icon, pg.kind, pg.ydoc, pg.section_id, pg.created_at, pg.updated_at, s.notebook_id, n.name AS notebook, n.workspace_id
       FROM pages pg JOIN sections s ON s.id = pg.section_id JOIN notebooks n ON n.id = s.notebook_id
       WHERE ${PAGE_VISIBLE} ORDER BY n.workspace_id, n.position, s.position, pg.position`,
    )
    .all(p) as Row[];
  const sectionsByNotebook = new Map<string, { id: string; parentId: string | null; name: string }[]>();
  const sectionsOf = (notebookId: string) => {
    let list = sectionsByNotebook.get(notebookId);
    if (!list) {
      list = (db.prepare('SELECT id, parent_id, name FROM sections WHERE notebook_id = ? AND deleted_at IS NULL').all(notebookId) as Row[]).map((s) => ({
        id: s.id,
        parentId: s.parent_id,
        name: s.name,
      }));
      sectionsByNotebook.set(notebookId, list);
    }
    return list;
  };
  // Task titles for task references inside pages: only tasks they can see.
  const visibleTasks = new Map(
    (db.prepare(`SELECT t.id, t.title, t.status, t.due_date FROM tasks t WHERE ${TASK_VISIBLE}`).all(p) as Row[]).map((t) => [t.id as string, t]),
  );
  const taskLookup = (id: string) => {
    const t = visibleTasks.get(id);
    return t && { title: t.title as string, done: t.status === 'done', due: t.due_date as string | null };
  };

  // ── Files: the ones they uploaded and can still see ──
  const uploaded = db.prepare('SELECT id, name, ext, mime, size, workspace_id, page_id, created_at FROM files WHERE created_by = ? ORDER BY created_at').all(userId) as Row[];
  const files: Row[] = [];
  const skipped: Row[] = [];
  const fileEntries: ZipEntry[] = [];
  let bytes = 0;
  for (const f of uploaded) {
    if (!canReadFile(f.id, userId)) continue;
    const disk = path.join(FILES_DIR, `${f.id}${f.ext}`);
    if (!fs.existsSync(disk)) continue;
    const meta = { id: f.id, name: f.name, mime: f.mime, size: f.size, createdAt: f.created_at, path: `files/${f.id}${f.ext}` };
    if (bytes + f.size > MAX_EXPORT_FILE_BYTES) {
      skipped.push({ ...meta, path: undefined, reason: 'archive size limit' });
      continue;
    }
    bytes += f.size;
    files.push(meta);
    fileEntries.push({ name: meta.path, data: fs.readFileSync(disk) });
  }
  const inArchive = new Set(files.map((f) => f.path.slice('files/'.length)));

  const entries: ZipEntry[] = [];
  const used = new Set<string>();
  const pageList: Row[] = [];
  for (const pg of pages) {
    const a = pageAccess(pg.id, userId);
    if (!a) continue;
    const folders = a.viaPageShare
      ? ['Shared with me']
      : [wsName.get(pg.workspace_id) ?? 'Workspace', pg.notebook, ...sectionAncestry(sectionsOf(pg.notebook_id), pg.section_id).map((s) => s.name)];
    const dir = ['pages', ...folders.map(safeName)].join('/');
    let file = `${dir}/${safeName(pg.title)}`;
    for (let i = 2; used.has(file); i++) file = `${dir}/${safeName(pg.title)} (${i})`;
    used.add(file);
    const up = '../'.repeat(file.split('/').length - 1);
    // Upload links: to the copy in this archive when there is one, else to the file on the server (opening it asks to sign in).
    const md = pageMarkdown(pg.title, pg.ydoc, taskLookup).replace(/\/uploads\/([0-9a-f]{32}(?:\.[a-z0-9]{1,10})?)/g, (whole, name: string) =>
      inArchive.has(name) ? `${up}files/${name}` : `${PUBLIC_URL}${whole}`,
    );
    entries.push({ name: `${file}.md`, data: Buffer.from(md) });
    pageList.push({
      id: pg.id,
      title: pg.title,
      path: `${file}.md`,
      access: a.viaPageShare ? (a.canEdit ? 'page share (can edit)' : 'page share (view only)') : a.canEdit ? 'edit' : 'view',
      createdAt: pg.created_at,
      updatedAt: pg.updated_at,
    });
  }

  // ── Tasks they created or are assigned (and can still see) ──
  const tasks = (
    db
      .prepare(
        `SELECT t.id, t.workspace_id, t.title, t.description, t.status, t.priority, t.due_date, t.due_time, t.recurrence, t.parent_id, t.page_id,
                t.created_by = @userId AS created_by_me, t.assignee_id = @userId AS assigned_to_me, t.completed_at, t.created_at, t.updated_at
         FROM tasks t WHERE (t.created_by = @userId OR t.assignee_id = @userId) AND ${TASK_VISIBLE} ORDER BY t.created_at`,
      )
      .all(p) as Row[]
  ).map((t) => ({
    ...t,
    created_by_me: !!t.created_by_me,
    assigned_to_me: !!t.assigned_to_me,
    workspace: wsName.get(t.workspace_id) ?? null,
    // The page's title only when they can open the page.
    page: t.page_id && pageAccess(t.page_id, userId) ? (db.prepare('SELECT title FROM pages WHERE id = ?').get(t.page_id) as Row | undefined)?.title ?? null : null,
    page_id: t.page_id && pageAccess(t.page_id, userId) ? t.page_id : null,
    reminders: db.prepare('SELECT kind, at, minutes FROM task_reminders WHERE task_id = ? AND user_id = ? ORDER BY created_at').all(t.id, userId),
  }));

  // ── Comments they wrote, on pages they can still open ──
  const comments = (
    db
      .prepare(
        `SELECT c.id, c.body, c.created_at, c.edited_at, th.id AS thread_id, th.quote, th.page_id, th.resolved_at, pg.title AS page_title
         FROM comments c JOIN comment_threads th ON th.id = c.thread_id JOIN pages pg ON pg.id = th.page_id
         WHERE c.author_id = ? AND pg.deleted_at IS NULL ORDER BY c.created_at`,
      )
      .all(userId) as Row[]
  ).filter((c) => !!pageAccess(c.page_id, userId));

  // ── Notification settings (secrets such as push endpoints and device tokens are left out) ──
  const settings = db.prepare('SELECT time_zone, email_enabled, default_reminder_time, digest_enabled, digest_time, updated_at FROM notification_settings WHERE user_id = ?').get(userId) as
    | Row
    | undefined;
  const notificationSettings = {
    settings: settings
      ? { ...settings, email_enabled: !!settings.email_enabled, digest_enabled: !!settings.digest_enabled }
      : { note: 'Defaults: you have not changed your notification settings.' },
    quietHours: (db.prepare('SELECT workspace_id, start_time, end_time, updated_at FROM quiet_hours WHERE user_id = ?').all(userId) as Row[]).map((q) => ({
      ...q,
      workspace: wsName.get(q.workspace_id) ?? null,
    })),
    calendarFeed: !!db.prepare('SELECT 1 FROM calendar_feeds WHERE user_id = ?').get(userId),
    browserPush: db.prepare('SELECT user_agent, created_at, last_success_at FROM push_subscriptions WHERE user_id = ? ORDER BY created_at').all(userId),
    mobileDevices: db.prepare('SELECT platform, created_at, last_success_at FROM device_tokens WHERE user_id = ? ORDER BY created_at').all(userId),
  };

  const profile = {
    app: APP_NAME,
    appVersion: VERSION,
    exportedAt: now(),
    account: { id: user.id, email: user.email, name: user.name, color: user.color, createdAt: user.created_at, emailVerifiedAt: user.email_verified_at },
    workspaces: memberships.map((w) => ({ id: w.id, name: w.name, role: w.role, joinedAt: w.joined_at })),
    pages: pageList,
    files,
    filesNotIncluded: skipped,
  };

  const readme = `${APP_NAME} data export for ${user.email}, ${profile.exportedAt}

profile.json                 your account, workspaces, the pages listed below, and your files
notification-settings.json   how and when you are notified
tasks.json                   tasks you created or are assigned
comments.json                comments you wrote
pages/                       every page you can open, as Markdown
files/                       files you uploaded

Only what you can see in ${APP_NAME} today is included. A workspace owner or admin can export a
whole workspace, including a backup that can be imported again, from Settings.
`;
  entries.unshift(
    { name: 'README.txt', data: Buffer.from(readme) },
    { name: 'profile.json', data: json(profile) },
    { name: 'notification-settings.json', data: json(notificationSettings) },
    { name: 'tasks.json', data: json(tasks) },
    { name: 'comments.json', data: json(comments) },
  );
  entries.push(...fileEntries);
  const stamp = new Date().toISOString().slice(0, 10);
  return { zip: writeZip(entries), filename: `${APP_NAME} data ${stamp}.zip` };
}
