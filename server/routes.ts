import express, { type NextFunction, type Request, type Response, Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, newId, now, pickColor } from './db.ts';
import { requireAuth, signToken } from './auth.ts';
import {
  HttpError,
  NOTEBOOK_VISIBLE,
  TASK_VISIBLE,
  mustAccess,
  notebookAccess,
  pageAccess,
  requireRole,
  roleIn,
  sectionAccess,
} from './access.ts';
import { addClient, publish } from './events.ts';
import { createTask, deleteTask, listCompleted, listTasks, rowToTask, updateTask } from './tasks.ts';
import { closeRoom } from './collab.ts';
import { seedWorkspace } from './seed.ts';
import type { Member, Notebook, PageMeta, Role, Section, Task, Workspace } from '../shared/types.ts';

export const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR ?? 'data/uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const api = Router();
const json = express.json({ limit: '1mb' });
api.use((req, res, next) => (req.path === '/uploads' ? next() : json(req, res, next)));

// Wrap handlers so thrown HttpErrors become JSON responses.
type Handler = (req: Request, res: Response) => unknown;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) {
    next(e);
  }
};

const str = (v: unknown, field: string, max = 500): string => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${field} is required`);
  if (v.length > max) throw new HttpError(400, `${field} is too long`);
  return v.trim();
};
const ROLES: Role[] = ['owner', 'admin', 'member', 'viewer'];

// ───────────────────────── Auth ─────────────────────────

function createWorkspace(userId: string, name: string, personal: boolean): string {
  const id = newId();
  const ts = now();
  db.prepare('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').run(id, name, userId, ts);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").run(
    id,
    userId,
    ts,
  );
  seedWorkspace(id, userId, personal);
  return id;
}

api.post(
  '/auth/register',
  h((req) => {
    const email = str(req.body.email, 'Email', 200).toLowerCase();
    const name = str(req.body.name, 'Name', 100);
    const password = req.body.password;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address');
    if (typeof password !== 'string' || password.length < 8)
      throw new HttpError(400, 'Password must be at least 8 characters');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email))
      throw new HttpError(409, 'An account with that email already exists');
    const id = newId();
    const ts = now();
    db.transaction(() => {
      db.prepare('INSERT INTO users (id, email, name, password_hash, color, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        id,
        email,
        name,
        bcrypt.hashSync(password, 10),
        pickColor(),
        ts,
      );
      // Accept any pending invitations for this email.
      const invites = db.prepare('SELECT workspace_id, role FROM workspace_invites WHERE email = ?').all(email) as {
        workspace_id: string;
        role: Role;
      }[];
      for (const inv of invites) {
        db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(
          inv.workspace_id,
          id,
          inv.role,
          ts,
        );
        publish({ type: 'members', workspaceId: inv.workspace_id });
      }
      db.prepare('DELETE FROM workspace_invites WHERE email = ?').run(email);
      createWorkspace(id, `${name.split(' ')[0]}'s Space`, true);
    })();
    return { token: signToken(id), user: { id, email, name, color: getUserColor(id) } };
  }),
);

function getUserColor(id: string) {
  return (db.prepare('SELECT color FROM users WHERE id = ?').get(id) as { color: string }).color;
}

api.post(
  '/auth/login',
  h((req) => {
    const email = String(req.body.email ?? '').trim();
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as
      | { id: string; email: string; name: string; color: string; password_hash: string }
      | undefined;
    if (!row || !bcrypt.compareSync(String(req.body.password ?? ''), row.password_hash))
      throw new HttpError(401, 'Incorrect email or password');
    return { token: signToken(row.id), user: { id: row.id, email: row.email, name: row.name, color: row.color } };
  }),
);

api.use(requireAuth);

api.get('/me', h((req) => req.user));
api.patch(
  '/me',
  h((req) => {
    if (req.body.name !== undefined) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(str(req.body.name, 'Name', 100), req.user.id);
    if (req.body.color !== undefined && /^#[0-9a-f]{6}$/i.test(req.body.color))
      db.prepare('UPDATE users SET color = ? WHERE id = ?').run(req.body.color, req.user.id);
    const wss = db.prepare('SELECT workspace_id FROM workspace_members WHERE user_id = ?').all(req.user.id) as { workspace_id: string }[];
    for (const w of wss) publish({ type: 'members', workspaceId: w.workspace_id });
    return db.prepare('SELECT id, email, name, color FROM users WHERE id = ?').get(req.user.id);
  }),
);

// Server-sent events stream (EventSource can't set headers, so the token comes via query).
api.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  addClient(req.user.id, res);
});

// ───────────────────────── Workspaces & members ─────────────────────────

api.get(
  '/workspaces',
  h(
    (req) =>
      db
        .prepare(
          `SELECT w.id, w.name, m.role, w.created_at AS createdAt FROM workspaces w
           JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at`,
        )
        .all(req.user.id) as Workspace[],
  ),
);

api.post(
  '/workspaces',
  h((req) => {
    const id = db.transaction(() => createWorkspace(req.user.id, str(req.body.name, 'Name', 100), false))();
    return { id };
  }),
);

api.patch(
  '/workspaces/:id',
  h((req) => {
    requireRole(req.params.id as string, req.user.id, 'admin');
    db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(str(req.body.name, 'Name', 100), req.params.id);
    for (const m of memberIds(req.params.id as string)) publish({ type: 'workspaces' }, { userIds: [m] });
    return { ok: true };
  }),
);

api.delete(
  '/workspaces/:id',
  h((req) => {
    requireRole(req.params.id as string, req.user.id, 'owner');
    const members = memberIds(req.params.id as string);
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(req.params.id);
    publish({ type: 'workspaces' }, { userIds: members });
    return { ok: true };
  }),
);

function memberIds(workspaceId: string) {
  return (db.prepare('SELECT user_id FROM workspace_members WHERE workspace_id = ?').all(workspaceId) as { user_id: string }[]).map(
    (r) => r.user_id,
  );
}

api.get(
  '/workspaces/:id/members',
  h((req) => {
    const role = requireRole(req.params.id as string, req.user.id, 'viewer');
    const members = db
      .prepare(
        `SELECT u.id, u.email, u.name, u.color, m.role FROM workspace_members m JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = ? ORDER BY u.name COLLATE NOCASE`,
      )
      .all(req.params.id) as Member[];
    const invites =
      role === 'owner' || role === 'admin'
        ? db.prepare('SELECT email, role FROM workspace_invites WHERE workspace_id = ? ORDER BY created_at').all(req.params.id)
        : [];
    return { members, invites };
  }),
);

api.post(
  '/workspaces/:id/members',
  h((req) => {
    const wsId = req.params.id as string;
    const myRole = requireRole(wsId, req.user.id, 'admin');
    const email = str(req.body.email, 'Email', 200).toLowerCase();
    const role: Role = ROLES.includes(req.body.role) ? req.body.role : 'member';
    if (role === 'owner' && myRole !== 'owner') throw new HttpError(403, 'Only owners can add owners');
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string } | undefined;
    if (user) {
      if (roleIn(wsId, user.id)) throw new HttpError(409, 'That person is already a member');
      db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(wsId, user.id, role, now());
      publish({ type: 'workspaces' }, { userIds: [user.id] });
      publish({ type: 'members', workspaceId: wsId });
      return { status: 'added' };
    }
    db.prepare(
      `INSERT INTO workspace_invites (workspace_id, email, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, email) DO UPDATE SET role = excluded.role`,
    ).run(wsId, email, role, req.user.id, now());
    publish({ type: 'members', workspaceId: wsId });
    return { status: 'invited' };
  }),
);

function ownerCount(wsId: string) {
  return (db.prepare("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND role = 'owner'").get(wsId) as { n: number }).n;
}

api.patch(
  '/workspaces/:id/members/:userId',
  h((req) => {
    const wsId = req.params.id as string;
    const target = req.params.userId as string;
    const myRole = requireRole(wsId, req.user.id, 'admin');
    const role = req.body.role as Role;
    if (!ROLES.includes(role)) throw new HttpError(400, 'Invalid role');
    const current = roleIn(wsId, target);
    if (!current) throw new HttpError(404, 'Member not found');
    if ((role === 'owner' || current === 'owner') && myRole !== 'owner') throw new HttpError(403, 'Only owners can change owners');
    if (current === 'owner' && role !== 'owner' && ownerCount(wsId) === 1) throw new HttpError(400, 'A workspace needs at least one owner');
    db.prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?').run(role, wsId, target);
    publish({ type: 'members', workspaceId: wsId });
    publish({ type: 'workspaces' }, { userIds: [target] });
    return { ok: true };
  }),
);

api.delete(
  '/workspaces/:id/members/:userId',
  h((req) => {
    const wsId = req.params.id as string;
    const target = req.params.userId as string;
    const self = target === req.user.id;
    const myRole = requireRole(wsId, req.user.id, self ? 'viewer' : 'admin');
    const current = roleIn(wsId, target);
    if (!current) throw new HttpError(404, 'Member not found');
    if (current === 'owner' && !self && myRole !== 'owner') throw new HttpError(403, 'Only owners can remove owners');
    if (current === 'owner' && ownerCount(wsId) === 1) throw new HttpError(400, 'A workspace needs at least one owner');
    db.transaction(() => {
      db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(wsId, target);
      db.prepare("UPDATE tasks SET assignee_id = NULL WHERE workspace_id = ? AND assignee_id = ? AND status = 'open'").run(wsId, target);
    })();
    publish({ type: 'members', workspaceId: wsId });
    publish({ type: 'workspaces' }, { userIds: [target] });
    return { ok: true };
  }),
);

api.delete(
  '/workspaces/:id/invites/:email',
  h((req) => {
    requireRole(req.params.id as string, req.user.id, 'admin');
    db.prepare('DELETE FROM workspace_invites WHERE workspace_id = ? AND email = ?').run(req.params.id, req.params.email);
    publish({ type: 'members', workspaceId: req.params.id as string });
    return { ok: true };
  }),
);

// ───────────────────────── Notebooks / sections / pages ─────────────────────────

api.get(
  '/workspaces/:id/tree',
  h((req) => {
    const workspaceId = req.params.id as string;
    requireRole(workspaceId, req.user.id, 'viewer');
    const p = { workspaceId, userId: req.user.id };
    const notebooks = db
      .prepare(
        `SELECT n.id, n.workspace_id AS workspaceId, n.name, n.color, n.visibility, n.created_by AS createdBy, n.position
         FROM notebooks n WHERE n.workspace_id = @workspaceId AND ${NOTEBOOK_VISIBLE} ORDER BY n.position`,
      )
      .all(p) as Notebook[];
    const sections = db
      .prepare(
        `SELECT s.id, s.notebook_id AS notebookId, s.name, s.color, s.position FROM sections s
         JOIN notebooks n ON n.id = s.notebook_id WHERE n.workspace_id = @workspaceId AND ${NOTEBOOK_VISIBLE} ORDER BY s.position`,
      )
      .all(p) as Section[];
    const pages = db
      .prepare(
        `SELECT pg.id, pg.section_id AS sectionId, pg.title, pg.icon, pg.kind, pg.position, pg.updated_at AS updatedAt,
           pg.updated_by AS updatedBy
         FROM pages pg JOIN sections s ON s.id = pg.section_id JOIN notebooks n ON n.id = s.notebook_id
         WHERE n.workspace_id = @workspaceId AND ${NOTEBOOK_VISIBLE} ORDER BY pg.position`,
      )
      .all(p) as PageMeta[];
    return { notebooks, sections, pages };
  }),
);

const nextPos = (table: string, col: string, id: string) =>
  ((db.prepare(`SELECT MAX(position) AS m FROM ${table} WHERE ${col} = ?`).get(id) as { m: number | null }).m ?? 0) + 1;

api.post(
  '/workspaces/:id/notebooks',
  h((req) => {
    const wsId = req.params.id as string;
    requireRole(wsId, req.user.id, 'member');
    const id = newId();
    const visibility = req.body.visibility === 'private' ? 'private' : 'shared';
    db.prepare(
      `INSERT INTO notebooks (id, workspace_id, name, color, visibility, created_by, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, wsId, str(req.body.name, 'Name', 100), req.body.color ?? pickColor(), visibility, req.user.id, nextPos('notebooks', 'workspace_id', wsId), now());
    // Every notebook starts with one section so there is somewhere to write.
    const sectionId = newId();
    db.prepare('INSERT INTO sections (id, notebook_id, name, color, position, created_at) VALUES (?, ?, ?, ?, 1, ?)').run(
      sectionId, id, 'General', pickColor(), now(),
    );
    publish({ type: 'tree', workspaceId: wsId });
    return { id, sectionId };
  }),
);

api.patch(
  '/notebooks/:id',
  h((req) => {
    const a = mustAccess(notebookAccess(req.params.id as string, req.user.id), true);
    const b = req.body;
    if (b.name !== undefined) db.prepare('UPDATE notebooks SET name = ? WHERE id = ?').run(str(b.name, 'Name', 100), req.params.id);
    if (b.color !== undefined) db.prepare('UPDATE notebooks SET color = ? WHERE id = ?').run(String(b.color), req.params.id);
    if (typeof b.position === 'number') db.prepare('UPDATE notebooks SET position = ? WHERE id = ?').run(b.position, req.params.id);
    if (b.visibility !== undefined) {
      if (!a.isNotebookOwner) throw new HttpError(403, 'Only the notebook creator can change its visibility');
      if (!['shared', 'private'].includes(b.visibility)) throw new HttpError(400, 'Invalid visibility');
      db.prepare('UPDATE notebooks SET visibility = ? WHERE id = ?').run(b.visibility, req.params.id);
      if (b.visibility === 'private') {
        const pages = db.prepare('SELECT p.id FROM pages p JOIN sections s ON s.id = p.section_id WHERE s.notebook_id = ?').all(req.params.id) as { id: string }[];
        for (const p of pages) closeRoom(p.id);
      }
      refreshTasksForNotebook(req.params.id as string);
    }
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { ok: true };
  }),
);

/** Re-broadcast tasks whose visibility may have changed. */
function refreshTasksForNotebook(notebookId: string) {
  const rows = db
    .prepare('SELECT t.* FROM tasks t JOIN pages p ON p.id = t.page_id JOIN sections s ON s.id = p.section_id WHERE s.notebook_id = ?')
    .all(notebookId);
  for (const r of rows) publish({ type: 'task', task: rowToTask(r as Parameters<typeof rowToTask>[0]) });
}

api.delete(
  '/notebooks/:id',
  h((req) => {
    const a = mustAccess(notebookAccess(req.params.id as string, req.user.id), true);
    if (!a.isNotebookOwner && !['owner', 'admin'].includes(a.role))
      throw new HttpError(403, 'Only the creator or a workspace admin can delete a notebook');
    const pages = db.prepare('SELECT p.id FROM pages p JOIN sections s ON s.id = p.section_id WHERE s.notebook_id = ?').all(req.params.id) as { id: string }[];
    detachPagesTasks(pages.map((p) => p.id), () => db.prepare('DELETE FROM notebooks WHERE id = ?').run(req.params.id));
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { ok: true };
  }),
);

/** Deleting notes never deletes their tasks: they become standalone tasks. */
function detachPagesTasks(pageIds: string[], del: () => void) {
  const affected: string[] = [];
  db.transaction(() => {
    for (const id of pageIds) {
      affected.push(...(db.prepare('SELECT id FROM tasks WHERE page_id = ?').all(id) as { id: string }[]).map((r) => r.id));
      db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(id);
    }
    del();
  })();
  for (const id of pageIds) closeRoom(id);
  for (const id of affected) {
    const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (r) publish({ type: 'task', task: rowToTask(r as Parameters<typeof rowToTask>[0]) });
  }
}

api.post(
  '/notebooks/:id/sections',
  h((req) => {
    const a = mustAccess(notebookAccess(req.params.id as string, req.user.id), true);
    const id = newId();
    db.prepare('INSERT INTO sections (id, notebook_id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id, req.params.id, str(req.body.name, 'Name', 100), req.body.color ?? pickColor(), nextPos('sections', 'notebook_id', req.params.id as string), now(),
    );
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { id };
  }),
);

api.patch(
  '/sections/:id',
  h((req) => {
    const a = mustAccess(sectionAccess(req.params.id as string, req.user.id), true);
    const b = req.body;
    if (b.name !== undefined) db.prepare('UPDATE sections SET name = ? WHERE id = ?').run(str(b.name, 'Name', 100), req.params.id);
    if (b.color !== undefined) db.prepare('UPDATE sections SET color = ? WHERE id = ?').run(String(b.color), req.params.id);
    if (b.notebookId !== undefined) {
      const t = mustAccess(notebookAccess(b.notebookId, req.user.id), true);
      if (t.workspaceId !== a.workspaceId) throw new HttpError(400, 'Cannot move between workspaces');
      db.prepare('UPDATE sections SET notebook_id = ? WHERE id = ?').run(b.notebookId, req.params.id);
    }
    if (typeof b.position === 'number') db.prepare('UPDATE sections SET position = ? WHERE id = ?').run(b.position, req.params.id);
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { ok: true };
  }),
);

api.delete(
  '/sections/:id',
  h((req) => {
    const a = mustAccess(sectionAccess(req.params.id as string, req.user.id), true);
    const pages = db.prepare('SELECT id FROM pages WHERE section_id = ?').all(req.params.id) as { id: string }[];
    detachPagesTasks(pages.map((p) => p.id), () => db.prepare('DELETE FROM sections WHERE id = ?').run(req.params.id));
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { ok: true };
  }),
);

api.post(
  '/sections/:id/pages',
  h((req) => {
    const a = mustAccess(sectionAccess(req.params.id as string, req.user.id), true);
    const id = newId();
    const ts = now();
    const title = typeof req.body.title === 'string' ? req.body.title.slice(0, 300) : '';
    db.prepare(
      `INSERT INTO pages (id, section_id, title, position, created_by, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, req.params.id, title, nextPos('pages', 'section_id', req.params.id as string), req.user.id, ts, ts, req.user.id);
    db.prepare('INSERT INTO pages_fts (page_id, title, text) VALUES (?, ?, ?)').run(id, title, '');
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { id };
  }),
);

api.get(
  '/pages/:id',
  h((req) => {
    const a = mustAccess(pageAccess(req.params.id as string, req.user.id));
    const page = db
      .prepare(
        `SELECT p.id, p.section_id AS sectionId, p.title, p.icon, p.kind, p.position, p.updated_at AS updatedAt,
           p.updated_by AS updatedBy, p.created_by AS createdBy, p.created_at AS createdAt
         FROM pages p WHERE p.id = ?`,
      )
      .get(req.params.id);
    return { page, workspaceId: a.workspaceId, canEdit: a.canEdit };
  }),
);

api.patch(
  '/pages/:id',
  h((req) => {
    const id = req.params.id as string;
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
        closeRoom(id); // collaborators may have lost access
        const tasks = db.prepare('SELECT * FROM tasks WHERE page_id = ?').all(id);
        for (const r of tasks) publish({ type: 'task', task: rowToTask(r as Parameters<typeof rowToTask>[0]) });
      }
    }
    if (typeof b.position === 'number') db.prepare('UPDATE pages SET position = ? WHERE id = ?').run(b.position, id);
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { ok: true };
  }),
);

api.delete(
  '/pages/:id',
  h((req) => {
    const id = req.params.id as string;
    const a = mustAccess(pageAccess(id, req.user.id), true);
    detachPagesTasks([id], () => db.prepare('DELETE FROM pages WHERE id = ?').run(id));
    publish({ type: 'tree', workspaceId: a.workspaceId });
    return { ok: true };
  }),
);

// ───────────────────────── Tasks ─────────────────────────

api.get('/workspaces/:id/tasks', h((req) => {
  requireRole(req.params.id as string, req.user.id, 'viewer');
  return listTasks(req.params.id as string, req.user.id);
}));

api.get('/workspaces/:id/tasks/completed', h((req) => {
  requireRole(req.params.id as string, req.user.id, 'viewer');
  return listCompleted(req.params.id as string, req.user.id, (req.query.before as string) || null);
}));

// Empty titles are allowed: typing "[] " in a note creates the task before its title is typed.
api.post('/workspaces/:id/tasks', h((req) => {
  const title = req.body.title ?? '';
  if (typeof title !== 'string' || title.length > 1000) throw new HttpError(400, 'Invalid title');
  return createTask(req.user.id, req.params.id as string, { ...req.body, title });
}));
api.patch('/tasks/:id', h((req) => updateTask(req.user.id, req.params.id as string, req.body)));
api.delete('/tasks/:id', h((req) => {
  deleteTask(req.user.id, req.params.id as string);
  return { ok: true };
}));

// ───────────────────────── Search ─────────────────────────

api.get(
  '/workspaces/:id/search',
  h((req) => {
    const workspaceId = req.params.id as string;
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

// ───────────────────────── Uploads ─────────────────────────

api.post(
  '/uploads',
  express.raw({ type: () => true, limit: '25mb' }),
  h((req) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Empty upload');
    const original = decodeURIComponent(String(req.headers['x-filename'] ?? 'file'));
    const ext = path.extname(original).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
    // Unguessable name; files are served without auth so links can be embedded in notes.
    const name = crypto.randomBytes(16).toString('hex') + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), req.body);
    return { url: `/uploads/${name}`, name: original, size: req.body.length };
  }),
);

// Error handler
api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});
