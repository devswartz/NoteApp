// Workspace activity feed ("who changed what"). Owner: Collaboration & Access.
//
// Recording is passive: `activityRecorder` (registered right after
// requireAuth) watches mutating requests. For each one that matches a rule
// below it snapshots what's needed before the handler runs (e.g. the name of
// something about to be deleted), captures the JSON response, and on success
// writes one `activity` row. Other areas don't call anything; a failure here
// is logged and never affects the request. Page content edits come from the
// collab server (onPageSaved), coalesced per person and page.
//
// Reading (`GET /workspaces/:id/activity`) hides entries about notebooks and
// tasks the reader can't see.
import { Router, type Request, type RequestHandler } from 'express';
import { db, now } from '../db.ts';
import { NOTEBOOK_VISIBLE, TASK_VISIBLE, pageSharedSql, requireRole } from '../access.ts';
import { publish } from '../events.ts';
import { onPageSaved } from '../collab.ts';
import { h, param } from '../http.ts';
import type { ActivityItem } from '../../shared/types.ts';

export const activityRoutes = Router();

type Target = ActivityItem['targetType'];
export interface ActivityEntry {
  workspaceId: string;
  actorId: string | null;
  verb: string;
  targetType: Target;
  targetId: string;
  summary: string;
  notebookId?: string | null;
  taskId?: string | null;
  private?: boolean;
}

// ───────────── Lookups ─────────────

interface NotebookInfo {
  id: string;
  name: string;
  workspaceId: string;
  visibility: string;
}
interface SectionInfo {
  id: string;
  name: string;
  notebookId: string;
}
interface PageInfo {
  id: string;
  title: string;
  sectionId: string;
  notebookId: string;
}
interface TaskInfo {
  id: string;
  title: string;
  workspaceId: string;
  status: string;
  assigneeId: string | null;
  pageId: string | null;
}

const nbInfo = (id: unknown) =>
  typeof id === 'string'
    ? ((db.prepare('SELECT id, name, workspace_id AS workspaceId, visibility FROM notebooks WHERE id = ?').get(id) as NotebookInfo) ?? null)
    : null;
const secInfo = (id: unknown) =>
  typeof id === 'string' ? ((db.prepare('SELECT id, name, notebook_id AS notebookId FROM sections WHERE id = ?').get(id) as SectionInfo) ?? null) : null;
const pageInfo = (id: unknown) =>
  typeof id === 'string'
    ? ((db
        .prepare('SELECT p.id, p.title, p.section_id AS sectionId, s.notebook_id AS notebookId FROM pages p JOIN sections s ON s.id = p.section_id WHERE p.id = ?')
        .get(id) as PageInfo) ?? null)
    : null;
const taskInfo = (id: unknown) =>
  typeof id === 'string'
    ? ((db
        .prepare('SELECT id, title, workspace_id AS workspaceId, status, assignee_id AS assigneeId, page_id AS pageId FROM tasks WHERE id = ?')
        .get(id) as TaskInfo) ?? null)
    : null;
const userName = (id: unknown) =>
  (typeof id === 'string' && (db.prepare('SELECT name FROM users WHERE id = ?').get(id) as { name: string } | undefined)?.name) || 'someone';
const wsName = (id: string) => (db.prepare('SELECT name FROM workspaces WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? '';

const q = (s: string | null | undefined) => `“${(s || 'Untitled').slice(0, 80)}”`;

/** Context for a page/section/notebook: workspace, notebook and whether it's private. */
function nbCtx(notebookId: string | null | undefined) {
  const nb = nbInfo(notebookId);
  return nb ? { workspaceId: nb.workspaceId, notebookId: nb.id, private: nb.visibility === 'private' } : null;
}
function taskCtx(t: TaskInfo) {
  const p = t.pageId ? pageInfo(t.pageId) : null;
  const nb = p ? nbInfo(p.notebookId) : null;
  return { workspaceId: t.workspaceId, taskId: t.id, private: nb?.visibility === 'private' };
}

/** Where an entry about a page or a task belongs, for callers outside the request recorder (the AI connector, server/mcp/). */
export function pageActivityCtx(pageId: string) {
  const p = pageInfo(pageId);
  return p ? nbCtx(p.notebookId) : null;
}
export function taskActivityCtx(taskId: string) {
  const t = taskInfo(taskId);
  return t ? taskCtx(t) : null;
}

// ───────────── Rules ─────────────

interface Ctx {
  userId: string;
  m: RegExpMatchArray;
  body: Record<string, unknown>;
  res: Record<string, unknown> | null;
  before: unknown;
}
interface Rule {
  method: string;
  re: RegExp;
  /** Snapshot taken before the handler runs. */
  before?: (m: RegExpMatchArray) => unknown;
  describe: (c: Ctx) => ActivityEntry | null;
}

const ID = '([0-9a-f-]{36})';
const R = (s: string) => new RegExp(`^${s.replace(/:id/g, ID)}/?$`, 'i');

const RULES: Rule[] = [
  {
    method: 'POST',
    re: R('/workspaces/:id/notebooks'),
    describe: ({ userId, res }) => {
      const nb = nbInfo(res?.id);
      const c = nb && nbCtx(nb.id);
      return c && { ...c, actorId: userId, verb: 'created', targetType: 'notebook', targetId: nb.id, summary: `created notebook ${q(nb.name)}` };
    },
  },
  {
    method: 'PATCH',
    re: R('/notebooks/:id'),
    before: (m) => nbInfo(m[1]),
    describe: ({ userId, m, before }) => {
      const b = before as NotebookInfo | null;
      const a = nbInfo(m[1]);
      if (!a || !b) return null;
      const c = nbCtx(a.id)!;
      if (a.name !== b.name) return { ...c, actorId: userId, verb: 'renamed', targetType: 'notebook', targetId: a.id, summary: `renamed notebook ${q(b.name)} to ${q(a.name)}` };
      if (a.visibility !== b.visibility)
        return {
          ...c,
          private: true, // the change itself only matters to people who could see it before or after
          actorId: userId,
          verb: a.visibility === 'private' ? 'made-private' : 'shared',
          targetType: 'notebook',
          targetId: a.id,
          summary: a.visibility === 'private' ? `made notebook ${q(a.name)} private` : `shared notebook ${q(a.name)} with the workspace`,
        };
      return null;
    },
  },
  {
    method: 'PUT',
    re: R('/notebooks/:id/shares'),
    describe: ({ userId, m, res }) => {
      const nb = nbInfo(m[1]);
      const n = Array.isArray(res?.userIds) ? res!.userIds.length : 0;
      return nb && { ...nbCtx(nb.id)!, actorId: userId, verb: 'shared', targetType: 'notebook', targetId: nb.id, summary: n ? `shared notebook ${q(nb.name)} with ${n} ${n === 1 ? 'person' : 'people'}` : `made notebook ${q(nb.name)} private to them` };
    },
  },
  {
    method: 'DELETE',
    re: R('/notebooks/:id'),
    before: (m) => nbInfo(m[1]),
    describe: ({ userId, before }) => {
      const b = before as NotebookInfo | null;
      return b && { workspaceId: b.workspaceId, notebookId: b.id, private: b.visibility === 'private', actorId: userId, verb: 'deleted', targetType: 'notebook', targetId: b.id, summary: `deleted notebook ${q(b.name)}` };
    },
  },
  {
    method: 'POST',
    re: R('/notebooks/:id/sections'),
    describe: ({ userId, m, res }) => {
      const s = secInfo(res?.id);
      const nb = nbInfo(m[1]);
      return s && nb && { ...nbCtx(nb.id)!, actorId: userId, verb: 'created', targetType: 'section', targetId: s.id, summary: `added section ${q(s.name)} to ${q(nb.name)}` };
    },
  },
  {
    method: 'PATCH',
    re: R('/sections/:id'),
    before: (m) => secInfo(m[1]),
    describe: ({ userId, m, before }) => {
      const b = before as SectionInfo | null;
      const a = secInfo(m[1]);
      if (!a || !b) return null;
      if (a.name !== b.name) return { ...nbCtx(a.notebookId)!, actorId: userId, verb: 'renamed', targetType: 'section', targetId: a.id, summary: `renamed section ${q(b.name)} to ${q(a.name)}` };
      if (a.notebookId !== b.notebookId)
        return { ...nbCtx(a.notebookId)!, actorId: userId, verb: 'moved', targetType: 'section', targetId: a.id, summary: `moved section ${q(a.name)} to ${q(nbInfo(a.notebookId)?.name)}` };
      return null;
    },
  },
  {
    method: 'POST',
    re: R('/sections/:id/move'),
    before: (m) => secInfo(m[1]),
    describe: ({ userId, m, before }) => {
      const b = before as SectionInfo | null;
      const a = secInfo(m[1]);
      if (!a || !b || a.notebookId === b.notebookId) return null; // reorder only
      return { ...nbCtx(a.notebookId)!, actorId: userId, verb: 'moved', targetType: 'section', targetId: a.id, summary: `moved section ${q(a.name)} to ${q(nbInfo(a.notebookId)?.name)}` };
    },
  },
  {
    method: 'POST',
    re: R('/sections/:id/copy'),
    describe: ({ userId, res }) => {
      const s = secInfo(res?.id);
      return s && { ...nbCtx(s.notebookId)!, actorId: userId, verb: 'copied', targetType: 'section', targetId: s.id, summary: `copied a section to ${q(s.name)}` };
    },
  },
  {
    method: 'DELETE',
    re: R('/sections/:id'),
    before: (m) => {
      const s = secInfo(m[1]);
      return s && { s, c: nbCtx(s.notebookId) };
    },
    describe: ({ userId, before }) => {
      const b = before as { s: SectionInfo; c: ReturnType<typeof nbCtx> } | null;
      return b?.c ? { ...b.c, actorId: userId, verb: 'deleted', targetType: 'section', targetId: b.s.id, summary: `deleted section ${q(b.s.name)}` } : null;
    },
  },
  {
    method: 'POST',
    re: R('/sections/:id/pages'),
    describe: ({ userId, res }) => {
      const p = pageInfo(res?.id);
      return p && { ...nbCtx(p.notebookId)!, actorId: userId, verb: 'created', targetType: 'page', targetId: p.id, summary: `created page ${q(p.title)}` };
    },
  },
  {
    method: 'PATCH',
    re: R('/pages/:id'),
    before: (m) => pageInfo(m[1]),
    describe: ({ userId, m, before }) => {
      const b = before as PageInfo | null;
      const a = pageInfo(m[1]);
      if (!a || !b) return null;
      if (a.title !== b.title && b.title) return { ...nbCtx(a.notebookId)!, actorId: userId, verb: 'renamed', targetType: 'page', targetId: a.id, summary: `renamed page ${q(b.title)} to ${q(a.title)}` };
      if (a.sectionId !== b.sectionId) return { ...nbCtx(a.notebookId)!, actorId: userId, verb: 'moved', targetType: 'page', targetId: a.id, summary: `moved page ${q(a.title)} to ${q(secInfo(a.sectionId)?.name)}` };
      return null;
    },
  },
  {
    method: 'POST',
    re: R('/pages/:id/move'),
    before: (m) => pageInfo(m[1]),
    describe: ({ userId, m, before }) => {
      const b = before as PageInfo | null;
      const a = pageInfo(m[1]);
      if (!a || !b || a.sectionId === b.sectionId) return null;
      return { ...nbCtx(a.notebookId)!, actorId: userId, verb: 'moved', targetType: 'page', targetId: a.id, summary: `moved page ${q(a.title)} to ${q(secInfo(a.sectionId)?.name)}` };
    },
  },
  {
    method: 'POST',
    re: R('/pages/:id/copy'),
    describe: ({ userId, res }) => {
      const p = pageInfo(res?.id);
      return p && { ...nbCtx(p.notebookId)!, actorId: userId, verb: 'copied', targetType: 'page', targetId: p.id, summary: `duplicated a page as ${q(p.title)}` };
    },
  },
  {
    method: 'DELETE',
    re: R('/pages/:id'),
    before: (m) => {
      const p = pageInfo(m[1]);
      return p && { p, c: nbCtx(p.notebookId) };
    },
    describe: ({ userId, before }) => {
      const b = before as { p: PageInfo; c: ReturnType<typeof nbCtx> } | null;
      return b?.c ? { ...b.c, actorId: userId, verb: 'deleted', targetType: 'page', targetId: b.p.id, summary: `deleted page ${q(b.p.title)}` } : null;
    },
  },
  {
    method: 'POST',
    re: R('/workspaces/:id/tasks'),
    describe: ({ userId, res }) => {
      const t = taskInfo(res?.id);
      if (!t || !t.title.trim()) return null; // inline "[] " tasks are titled a moment later (see PATCH)
      const who = t.assigneeId && t.assigneeId !== userId ? ` for ${userName(t.assigneeId)}` : '';
      return { ...taskCtx(t), actorId: userId, verb: 'created', targetType: 'task', targetId: t.id, summary: `added task ${q(t.title)}${who}` };
    },
  },
  {
    method: 'PATCH',
    re: R('/tasks/:id'),
    before: (m) => ({ t: taskInfo(m[1]), at: now() }),
    describe: ({ userId, m, before }) => {
      const { t: b, at } = before as { t: TaskInfo | null; at: string };
      const a = taskInfo(m[1]) ?? null;
      if (!a || !b) return null;
      const base = { ...taskCtx(a), actorId: userId, targetType: 'task' as const, targetId: a.id };
      // Completing a recurring task leaves it open (rolled forward) and inserts a done occurrence.
      const rolled = !!db.prepare("SELECT 1 FROM tasks WHERE occurrence_of = ? AND status = 'done' AND completed_at >= ?").get(a.id, at);
      if (b.status !== 'done' && (a.status === 'done' || rolled)) return { ...base, verb: 'completed', summary: `completed ${q(a.title)}` };
      if (b.status === 'done' && a.status === 'open') return { ...base, verb: 'reopened', summary: `reopened ${q(a.title)}` };
      if (a.assigneeId !== b.assigneeId)
        return a.assigneeId
          ? { ...base, verb: 'assigned', summary: `assigned ${q(a.title)} to ${a.assigneeId === userId ? 'themselves' : userName(a.assigneeId)}` }
          : { ...base, verb: 'unassigned', summary: `unassigned ${q(a.title)}` };
      if (!b.title.trim() && a.title.trim()) return { ...base, verb: 'created', summary: `added task ${q(a.title)}` };
      return null;
    },
  },
  {
    method: 'DELETE',
    re: R('/tasks/:id'),
    before: (m) => {
      const t = taskInfo(m[1]);
      return t && { t, c: taskCtx(t) };
    },
    describe: ({ userId, before }) => {
      const b = before as { t: TaskInfo; c: ReturnType<typeof taskCtx> } | null;
      return b && b.t.title.trim() ? { ...b.c, actorId: userId, verb: 'deleted', targetType: 'task', targetId: b.t.id, summary: `deleted task ${q(b.t.title)}` } : null;
    },
  },
  {
    method: 'PATCH',
    re: R('/workspaces/:id'),
    before: (m) => wsName(m[1]),
    describe: ({ userId, m, before }) => {
      const a = wsName(m[1]);
      return a !== before ? { workspaceId: m[1], actorId: userId, verb: 'renamed', targetType: 'workspace', targetId: m[1], summary: `renamed the workspace to ${q(a)}` } : null;
    },
  },
  {
    method: 'POST',
    re: R('/workspaces/:id/members'),
    describe: ({ userId, m, body, res }) => {
      const email = String(body.email ?? '').toLowerCase();
      const role = String(body.role ?? 'member');
      if (res?.status === 'added') {
        const u = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email) as { id: string; name: string } | undefined;
        return { workspaceId: m[1], actorId: userId, verb: 'added', targetType: 'member', targetId: u?.id ?? email, summary: `added ${u?.name ?? email} as ${role}` };
      }
      return { workspaceId: m[1], actorId: userId, verb: 'invited', targetType: 'member', targetId: email, summary: `invited ${email} as ${role}` };
    },
  },
  {
    method: 'PATCH',
    re: R('/workspaces/:id/members/:id'),
    describe: ({ userId, m, body }) => ({ workspaceId: m[1], actorId: userId, verb: 'role', targetType: 'member', targetId: m[2], summary: `made ${userName(m[2])} ${body.role === 'admin' || body.role === 'owner' ? 'an' : 'a'} ${String(body.role)}` }),
  },
  {
    method: 'DELETE',
    re: R('/workspaces/:id/members/:id'),
    before: (m) => userName(m[2]),
    describe: ({ userId, m, before }) =>
      m[2] === userId
        ? { workspaceId: m[1], actorId: userId, verb: 'left', targetType: 'member', targetId: m[2], summary: 'left the workspace' }
        : { workspaceId: m[1], actorId: userId, verb: 'removed', targetType: 'member', targetId: m[2], summary: `removed ${String(before)} from the workspace` },
  },
  {
    method: 'POST',
    re: R('/pages/:id/comments'),
    describe: ({ userId, m, res }) => {
      const p = pageInfo(m[1]);
      return p && res?.id ? { ...nbCtx(p.notebookId)!, actorId: userId, verb: 'commented', targetType: 'comment', targetId: String(res.id), summary: `commented on ${q(p.title)}` } : null;
    },
  },
];

// ───────────── Writing ─────────────

const pendingEvents = new Map<string, NodeJS.Timeout>();
function announce(workspaceId: string) {
  if (pendingEvents.has(workspaceId)) return;
  pendingEvents.set(
    workspaceId,
    setTimeout(() => {
      pendingEvents.delete(workspaceId);
      publish({ type: 'activity', workspaceId });
    }, 300),
  );
}

export function recordActivity(e: ActivityEntry) {
  db.prepare(
    `INSERT INTO activity (workspace_id, actor_id, verb, target_type, target_id, summary, notebook_id, task_id, private, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(e.workspaceId, e.actorId, e.verb, e.targetType, e.targetId, e.summary, e.notebookId ?? null, e.taskId ?? null, e.private ? 1 : 0, now());
  announce(e.workspaceId);
}

export const activityRecorder: RequestHandler = (req, res, next) => {
  if (req.method === 'GET' || !req.user) return next();
  let rule: Rule | undefined;
  let m: RegExpMatchArray | null = null;
  for (const r of RULES) {
    if (r.method !== req.method) continue;
    m = req.path.match(r.re);
    if (m) {
      rule = r;
      break;
    }
  }
  if (!rule || !m) return next();
  let before: unknown = null;
  try {
    before = rule.before?.(m) ?? null;
  } catch (e) {
    console.error('[activity] snapshot failed', e);
  }
  let captured: Record<string, unknown> | null = null;
  const json = res.json.bind(res);
  res.json = (b: unknown) => {
    captured = b && typeof b === 'object' ? (b as Record<string, unknown>) : null;
    return json(b);
  };
  const userId = req.user.id;
  const body = (req.body ?? {}) as Record<string, unknown>;
  res.on('finish', () => {
    if (res.statusCode >= 300) return;
    try {
      const e = rule.describe({ userId, m: m!, body, res: captured, before });
      if (e) recordActivity(e);
    } catch (err) {
      console.error('[activity] record failed', err);
    }
  });
  next();
};

// Page content edits (collab saves), coalesced: one "edited" entry per person and page per 15 minutes.
const EDIT_WINDOW_MS = 15 * 60_000;
onPageSaved((pageId, actorId) => {
  if (!actorId) return;
  const p = pageInfo(pageId);
  const c = p && nbCtx(p.notebookId);
  if (!p || !c) return;
  const last = db
    .prepare("SELECT id, created_at FROM activity WHERE target_type = 'page' AND target_id = ? AND actor_id = ? AND verb = 'edited' ORDER BY id DESC LIMIT 1")
    .get(pageId, actorId) as { id: number; created_at: string } | undefined;
  const newest = db.prepare('SELECT MAX(id) AS id FROM activity WHERE workspace_id = ?').get(c.workspaceId) as { id: number };
  if (last && last.id === newest.id && Date.now() - Date.parse(last.created_at) < EDIT_WINDOW_MS) {
    db.prepare('UPDATE activity SET created_at = ?, summary = ? WHERE id = ?').run(now(), `edited ${q(p.title)}`, last.id);
    announce(c.workspaceId);
    return;
  }
  recordActivity({ ...c, actorId, verb: 'edited', targetType: 'page', targetId: pageId, summary: `edited ${q(p.title)}` });
});

// ───────────── Reading ─────────────

activityRoutes.get(
  '/workspaces/:id/activity',
  h((req: Request) => {
    const workspaceId = param(req, 'id');
    requireRole(workspaceId, req.user.id, 'viewer');
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const before = Number(req.query.before) || null;
    return db
      .prepare(
        `SELECT a.id, a.workspace_id AS workspaceId, a.actor_id AS actorId, a.verb, a.target_type AS targetType, a.target_id AS targetId,
                a.summary, a.created_at AS createdAt
         FROM activity a
         WHERE a.workspace_id = @workspaceId AND (@before IS NULL OR a.id < @before)
           AND (a.actor_id = @userId OR (
             (a.notebook_id IS NULL
               OR EXISTS (SELECT 1 FROM notebooks n WHERE n.id = a.notebook_id AND ${NOTEBOOK_VISIBLE})
               -- a page shared with them (#98): its edits and renames, not moves (those name its sections)
               OR (a.target_type = 'page' AND a.verb IN ('edited', 'renamed') AND ${pageSharedSql('a.target_id')})
               OR (a.private = 0 AND NOT EXISTS (SELECT 1 FROM notebooks n2 WHERE n2.id = a.notebook_id)))
             AND (a.task_id IS NULL
               OR EXISTS (SELECT 1 FROM tasks t WHERE t.id = a.task_id AND ${TASK_VISIBLE})
               OR (a.private = 0 AND NOT EXISTS (SELECT 1 FROM tasks t2 WHERE t2.id = a.task_id)))
           ))
         ORDER BY a.id DESC LIMIT @limit`,
      )
      .all({ workspaceId, userId: req.user.id, before, limit }) as ActivityItem[];
  }),
);
