// Tags, teams and saved task views (migration 014, track 1 of docs/PLAN_FEEDBACK_1.md). Owner: Tasks.
//   Tags: every member sees them; anyone who can edit creates one; owners/admins rename, recolour and delete.
//   Teams: every member sees them; owners/admins manage teams, subteams (one level) and members.
//   Task views: personal by default (only the owner sees them); owners/admins can share one with everyone.
import { Router } from 'express';
import { db, newId, now } from '../db.ts';
import { atLeast, requireRole, roleIn } from '../access.ts';
import { publish } from '../events.ts';
import { getTask } from '../tasks.ts';
import { HttpError, h, param, str } from '../http.ts';
import type { Tag, TaskView, Team } from '../../shared/types.ts';

export const teamRoutes = Router();

const HEX = /^#[0-9a-fA-F]{6}$/;
/** Tag and team colours picked when none is given. */
export const LABEL_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6', '#64748b'];
const color = (v: unknown, fallback: string) => {
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || !HEX.test(v)) throw new HttpError(400, 'Invalid colour');
  return v.toLowerCase();
};
const nextColor = (table: 'tags' | 'teams', wsId: string) => {
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(wsId) as { n: number };
  return LABEL_COLORS[n % LABEL_COLORS.length];
};
const MAX_TAGS = 500;
const MAX_TEAMS = 200;
const MAX_VIEWS = 200;

/** Re-publish tasks whose tags or team just changed underneath them (delete, merge), with a fresh updated_at. */
function republishTasks(ids: string[]) {
  if (!ids.length) return;
  const ts = now();
  const bump = db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?');
  for (const id of ids) bump.run(ts, id);
  for (const id of ids) {
    const t = getTask(id);
    if (t) publish({ type: 'task', task: t });
  }
}

// ───────────── Tags ─────────────

interface TagRow {
  id: string;
  workspace_id: string;
  name: string;
  color: string;
  created_by: string;
  created_at: string;
}
const toTag = (r: TagRow): Tag => ({ id: r.id, workspaceId: r.workspace_id, name: r.name, color: r.color, createdBy: r.created_by, createdAt: r.created_at });
const tagName = (v: unknown) => {
  const name = str(v, 'Name', 40).replace(/^#+/, '').trim();
  if (!name) throw new HttpError(400, 'Name is required');
  return name;
};

export function listTags(wsId: string): Tag[] {
  return (db.prepare('SELECT * FROM tags WHERE workspace_id = ? ORDER BY name COLLATE NOCASE').all(wsId) as TagRow[]).map(toTag);
}

function tagOr404(id: string, userId: string, min: 'viewer' | 'admin') {
  const r = db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as TagRow | undefined;
  if (!r || !roleIn(r.workspace_id, userId)) throw new HttpError(404, 'Tag not found');
  requireRole(r.workspace_id, userId, min);
  return r;
}

teamRoutes.get('/workspaces/:id/tags', h((req) => (requireRole(param(req, 'id'), req.user.id, 'viewer'), listTags(param(req, 'id')))));

// Creating an existing name (any case) returns that tag, so two people adding "#waiting" at once get one tag.
teamRoutes.post(
  '/workspaces/:id/tags',
  h((req) => {
    const wsId = param(req, 'id');
    requireRole(wsId, req.user.id, 'member');
    const name = tagName(req.body?.name);
    const existing = db.prepare('SELECT * FROM tags WHERE workspace_id = ? AND name = ?').get(wsId, name) as TagRow | undefined;
    if (existing) return toTag(existing);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM tags WHERE workspace_id = ?').get(wsId) as { n: number };
    if (n >= MAX_TAGS) throw new HttpError(400, `A workspace can have up to ${MAX_TAGS} tags`);
    const id = newId();
    db.prepare('INSERT INTO tags (id, workspace_id, name, color, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id, wsId, name, color(req.body?.color, nextColor('tags', wsId)), req.user.id, now(),
    );
    publish({ type: 'tags', workspaceId: wsId });
    return toTag(db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as TagRow);
  }),
);

teamRoutes.patch(
  '/tags/:id',
  h((req) => {
    const r = tagOr404(param(req, 'id'), req.user.id, 'admin');
    const name = req.body?.name !== undefined ? tagName(req.body.name) : r.name;
    const c = color(req.body?.color, r.color);
    const clash = db.prepare('SELECT 1 FROM tags WHERE workspace_id = ? AND name = ? AND id <> ?').get(r.workspace_id, name, r.id);
    if (clash) throw new HttpError(409, 'A tag with that name already exists');
    db.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ?').run(name, c, r.id);
    publish({ type: 'tags', workspaceId: r.workspace_id });
    return toTag(db.prepare('SELECT * FROM tags WHERE id = ?').get(r.id) as TagRow);
  }),
);

teamRoutes.delete(
  '/tags/:id',
  h((req) => {
    const r = tagOr404(param(req, 'id'), req.user.id, 'admin');
    const tasks = (db.prepare('SELECT task_id FROM task_tags WHERE tag_id = ?').all(r.id) as { task_id: string }[]).map((x) => x.task_id);
    db.prepare('DELETE FROM tags WHERE id = ?').run(r.id); // task_tags cascade
    publish({ type: 'tags', workspaceId: r.workspace_id });
    republishTasks(tasks);
    return { ok: true };
  }),
);

// ───────────── Teams ─────────────

interface TeamRow {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  name: string;
  color: string;
  position: number;
}

export function listTeams(wsId: string): Team[] {
  const rows = db.prepare('SELECT * FROM teams WHERE workspace_id = ? ORDER BY position, created_at').all(wsId) as TeamRow[];
  const members = db
    .prepare('SELECT tm.team_id, tm.user_id FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE t.workspace_id = ?')
    .all(wsId) as { team_id: string; user_id: string }[];
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    parentId: r.parent_id,
    name: r.name,
    color: r.color,
    position: r.position,
    memberIds: members.filter((m) => m.team_id === r.id).map((m) => m.user_id),
  }));
}

function teamOr404(id: string, userId: string) {
  const r = db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as TeamRow | undefined;
  if (!r || !roleIn(r.workspace_id, userId)) throw new HttpError(404, 'Team not found');
  requireRole(r.workspace_id, userId, 'admin');
  return r;
}

/** A valid parent for a subteam: a top-level team in the same workspace (subteams are one level deep). */
function checkParent(wsId: string, parentId: unknown, selfId?: string): string | null {
  if (parentId === null || parentId === undefined) return null;
  if (typeof parentId !== 'string') throw new HttpError(400, 'Invalid parent team');
  const p = db.prepare('SELECT * FROM teams WHERE id = ? AND workspace_id = ?').get(parentId, wsId) as TeamRow | undefined;
  if (!p) throw new HttpError(400, 'Invalid parent team');
  if (p.parent_id) throw new HttpError(400, 'Subteams can’t have subteams');
  if (selfId && (p.id === selfId || db.prepare('SELECT 1 FROM teams WHERE parent_id = ?').get(selfId)))
    throw new HttpError(400, 'A team with subteams can’t become a subteam');
  return p.id;
}

const teamsChanged = (wsId: string) => publish({ type: 'teams', workspaceId: wsId });

teamRoutes.get('/workspaces/:id/teams', h((req) => (requireRole(param(req, 'id'), req.user.id, 'viewer'), listTeams(param(req, 'id')))));

teamRoutes.post(
  '/workspaces/:id/teams',
  h((req) => {
    const wsId = param(req, 'id');
    requireRole(wsId, req.user.id, 'admin');
    const name = str(req.body?.name, 'Name', 60);
    const parentId = checkParent(wsId, req.body?.parentId);
    const { n, maxPos } = db.prepare('SELECT COUNT(*) AS n, MAX(position) AS maxPos FROM teams WHERE workspace_id = ?').get(wsId) as {
      n: number;
      maxPos: number | null;
    };
    if (n >= MAX_TEAMS) throw new HttpError(400, `A workspace can have up to ${MAX_TEAMS} teams`);
    const id = newId();
    db.prepare('INSERT INTO teams (id, workspace_id, parent_id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, wsId, parentId, name, color(req.body?.color, nextColor('teams', wsId)), (maxPos ?? 0) + 1, now(),
    );
    if (Array.isArray(req.body?.memberIds)) setMembers(id, wsId, req.body.memberIds);
    teamsChanged(wsId);
    return listTeams(wsId).find((t) => t.id === id);
  }),
);

teamRoutes.patch(
  '/teams/:id',
  h((req) => {
    const r = teamOr404(param(req, 'id'), req.user.id);
    const b = req.body ?? {};
    const name = b.name !== undefined ? str(b.name, 'Name', 60) : r.name;
    const parentId = b.parentId !== undefined ? checkParent(r.workspace_id, b.parentId, r.id) : r.parent_id;
    const position = b.position !== undefined ? Number(b.position) : r.position;
    if (!Number.isFinite(position)) throw new HttpError(400, 'Invalid position');
    db.prepare('UPDATE teams SET name = ?, color = ?, parent_id = ?, position = ? WHERE id = ?').run(name, color(b.color, r.color), parentId, position, r.id);
    teamsChanged(r.workspace_id);
    return listTeams(r.workspace_id).find((t) => t.id === r.id);
  }),
);

teamRoutes.delete(
  '/teams/:id',
  h((req) => {
    const r = teamOr404(param(req, 'id'), req.user.id);
    // Its subteams go with it; their tasks keep everything else and lose the team.
    const tasks = (
      db.prepare('SELECT id FROM tasks WHERE team_id IN (SELECT id FROM teams WHERE id = ? OR parent_id = ?)').all(r.id, r.id) as { id: string }[]
    ).map((x) => x.id);
    db.prepare('DELETE FROM teams WHERE id = ?').run(r.id);
    teamsChanged(r.workspace_id);
    republishTasks(tasks);
    return { ok: true };
  }),
);

function setMembers(teamId: string, wsId: string, userIds: unknown) {
  if (!Array.isArray(userIds) || userIds.length > 1000 || userIds.some((u) => typeof u !== 'string')) throw new HttpError(400, 'Invalid members');
  for (const u of userIds as string[]) if (!roleIn(wsId, u)) throw new HttpError(400, 'Only workspace members can join a team');
  db.transaction(() => {
    db.prepare('DELETE FROM team_members WHERE team_id = ?').run(teamId);
    const add = db.prepare('INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?, ?)');
    for (const u of userIds as string[]) add.run(teamId, u);
  })();
}

teamRoutes.put(
  '/teams/:id/members',
  h((req) => {
    const r = teamOr404(param(req, 'id'), req.user.id);
    setMembers(r.id, r.workspace_id, req.body?.userIds);
    teamsChanged(r.workspace_id);
    return listTeams(r.workspace_id).find((t) => t.id === r.id);
  }),
);

// ───────────── Saved task views ─────────────

interface ViewRow {
  id: string;
  workspace_id: string;
  owner_id: string;
  shared: number;
  name: string;
  query: string;
  position: number;
  created_at: string;
}
const toView = (r: ViewRow): TaskView => ({
  id: r.id,
  workspaceId: r.workspace_id,
  ownerId: r.owner_id,
  shared: !!r.shared,
  name: r.name,
  query: JSON.parse(r.query),
  position: r.position,
  createdAt: r.created_at,
});

export function listViews(wsId: string, userId: string): TaskView[] {
  return (
    db.prepare('SELECT * FROM task_views WHERE workspace_id = ? AND (owner_id = ? OR shared = 1) ORDER BY position, created_at').all(wsId, userId) as ViewRow[]
  ).map(toView);
}

/** The view's query: { filters: object, sort: string, group: string }, at most 8 KB. The client validates field values. */
function viewQuery(v: unknown): string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'Invalid view');
  const q = v as Record<string, unknown>;
  if (!q.filters || typeof q.filters !== 'object' || Array.isArray(q.filters) || typeof q.sort !== 'string' || typeof q.group !== 'string')
    throw new HttpError(400, 'Invalid view');
  const json = JSON.stringify({ filters: q.filters, sort: q.sort.slice(0, 20), group: q.group.slice(0, 20) });
  if (json.length > 8192) throw new HttpError(400, 'That view is too large');
  return json;
}

/** Notify whoever can see the view: everyone for a shared one, else only its owner. */
function viewsChanged(wsId: string, ownerId: string, shared: boolean) {
  publish({ type: 'task-views', workspaceId: wsId }, shared ? {} : { userIds: [ownerId] });
}

/** A view the caller may change: their own, or a shared one if they're an owner/admin. Others' personal views are 404. */
function viewForChange(id: string, userId: string): ViewRow {
  const r = db.prepare('SELECT * FROM task_views WHERE id = ?').get(id) as ViewRow | undefined;
  const role = r ? roleIn(r.workspace_id, userId) : null;
  if (!r || !role || (r.owner_id !== userId && !r.shared)) throw new HttpError(404, 'View not found');
  if (r.owner_id !== userId && !atLeast(role, 'admin')) throw new HttpError(403, 'Only owners and admins can change shared views');
  return r;
}

teamRoutes.get('/workspaces/:id/task-views', h((req) => (requireRole(param(req, 'id'), req.user.id, 'viewer'), listViews(param(req, 'id'), req.user.id))));

// Anyone who can read the workspace can save personal views; sharing one needs owner/admin.
// A client-chosen id makes the upload of device-only views idempotent.
teamRoutes.post(
  '/workspaces/:id/task-views',
  h((req) => {
    const wsId = param(req, 'id');
    const role = requireRole(wsId, req.user.id, 'viewer');
    const b = req.body ?? {};
    const shared = b.shared === true;
    if (shared && !atLeast(role, 'admin')) throw new HttpError(403, 'Only owners and admins can share views');
    const name = str(b.name, 'Name', 60);
    const query = viewQuery(b.query);
    let id = newId();
    if (b.id !== undefined) {
      if (typeof b.id !== 'string' || !/^[\w-]{8,64}$/.test(b.id)) throw new HttpError(400, 'Invalid id');
      const existing = db.prepare('SELECT * FROM task_views WHERE id = ?').get(b.id) as ViewRow | undefined;
      if (existing) {
        if (existing.owner_id !== req.user.id || existing.workspace_id !== wsId) throw new HttpError(409, 'View id already used');
        return toView(existing);
      }
      id = b.id;
    }
    const { n, maxPos } = db.prepare('SELECT COUNT(*) AS n, MAX(position) AS maxPos FROM task_views WHERE workspace_id = ? AND owner_id = ?').get(wsId, req.user.id) as {
      n: number;
      maxPos: number | null;
    };
    if (n >= MAX_VIEWS) throw new HttpError(400, `You can save up to ${MAX_VIEWS} views`);
    db.prepare('INSERT INTO task_views (id, workspace_id, owner_id, shared, name, query, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, wsId, req.user.id, shared ? 1 : 0, name, query, (maxPos ?? 0) + 1, now(),
    );
    viewsChanged(wsId, req.user.id, shared);
    return toView(db.prepare('SELECT * FROM task_views WHERE id = ?').get(id) as ViewRow);
  }),
);

teamRoutes.patch(
  '/task-views/:id',
  h((req) => {
    const r = viewForChange(param(req, 'id'), req.user.id);
    const b = req.body ?? {};
    const name = b.name !== undefined ? str(b.name, 'Name', 60) : r.name;
    const query = b.query !== undefined ? viewQuery(b.query) : r.query;
    const position = b.position !== undefined ? Number(b.position) : r.position;
    if (!Number.isFinite(position)) throw new HttpError(400, 'Invalid position');
    let shared = !!r.shared;
    if (b.shared !== undefined) {
      if (typeof b.shared !== 'boolean') throw new HttpError(400, 'Invalid shared');
      if (b.shared !== shared && !atLeast(roleIn(r.workspace_id, req.user.id), 'admin')) throw new HttpError(403, 'Only owners and admins can share views');
      shared = b.shared;
    }
    db.prepare('UPDATE task_views SET name = ?, query = ?, position = ?, shared = ? WHERE id = ?').run(name, query, position, shared ? 1 : 0, r.id);
    viewsChanged(r.workspace_id, r.owner_id, shared || !!r.shared);
    return toView(db.prepare('SELECT * FROM task_views WHERE id = ?').get(r.id) as ViewRow);
  }),
);

teamRoutes.delete(
  '/task-views/:id',
  h((req) => {
    const r = viewForChange(param(req, 'id'), req.user.id);
    db.prepare('DELETE FROM task_views WHERE id = ?').run(r.id);
    viewsChanged(r.workspace_id, r.owner_id, !!r.shared);
    return { ok: true };
  }),
);
