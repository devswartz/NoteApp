// Task persistence and business rules (completion, recurrence, linking to notes).
import { db, newId, now } from './db.ts';
import { HttpError, TASK_VISIBLE, atLeast, pageAccess, pageShare, roleIn } from './access.ts';
import { publish } from './events.ts';
import { recurrenceError } from '../shared/recurrence.ts';
import { nextDueDate } from './reminders/recurring.ts';
import type { Priority, Recurrence, Task, TaskPatch } from '../shared/types.ts';

interface TaskRow {
  id: string;
  workspace_id: string;
  title: string;
  description: string;
  status: 'open' | 'done';
  priority: number;
  due_date: string | null;
  due_time: string | null;
  recurrence: string | null;
  reminder_at: string | null;
  assignee_id: string | null;
  created_by: string;
  page_id: string | null;
  parent_id: string | null;
  team_id?: string | null;
  assigned_by?: string | null;
  completed_at: string | null;
  completed_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Tag ids of one task (task_tags, migration 014). */
export function taskTagIds(taskId: string): string[] {
  return (db.prepare('SELECT tag_id FROM task_tags WHERE task_id = ?').all(taskId) as { tag_id: string }[]).map((x) => x.tag_id);
}

export function rowToTask(r: TaskRow, tagIds?: string[]): Task {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    title: r.title,
    description: r.description,
    status: r.status,
    priority: r.priority as Priority,
    dueDate: r.due_date,
    dueTime: r.due_time,
    recurrence: r.recurrence ? (JSON.parse(r.recurrence) as Recurrence) : null,
    reminderAt: r.reminder_at,
    assigneeId: r.assignee_id,
    createdBy: r.created_by,
    pageId: r.page_id,
    parentId: r.parent_id ?? null,
    teamId: r.team_id ?? null,
    tagIds: tagIds ?? taskTagIds(r.id),
    assignedBy: r.assigned_by ?? null,
    completedAt: r.completed_at,
    completedBy: r.completed_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getTask(id: string): Task | null {
  const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  return r ? rowToTask(r) : null;
}

export function listTasks(workspaceId: string, userId: string): Task[] {
  // Completed tasks are capped to keep payloads reasonable; the Completed view
  // pages further back via /tasks/completed.
  const rows = db
    .prepare(
      `SELECT * FROM tasks t WHERE t.workspace_id = @workspaceId AND ${TASK_VISIBLE}
       AND (t.status = 'open' OR t.completed_at > @since)
       ORDER BY t.created_at`,
    )
    .all({ workspaceId, userId, since: new Date(Date.now() - 30 * 864e5).toISOString() }) as TaskRow[];
  const tags = workspaceTaskTags(workspaceId);
  return rows.map((r) => rowToTask(r, tags.get(r.id) ?? []));
}

/** task id → tag ids for every tagged task in a workspace (one query for list endpoints). */
function workspaceTaskTags(workspaceId: string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  const rows = db
    .prepare('SELECT tt.task_id, tt.tag_id FROM task_tags tt JOIN tags g ON g.id = tt.tag_id WHERE g.workspace_id = ?')
    .all(workspaceId) as { task_id: string; tag_id: string }[];
  for (const r of rows) m.set(r.task_id, [...(m.get(r.task_id) ?? []), r.tag_id]);
  return m;
}

export function listCompleted(workspaceId: string, userId: string, before: string | null, limit = 100): Task[] {
  const rows = db
    .prepare(
      `SELECT * FROM tasks t WHERE t.workspace_id = @workspaceId AND t.status = 'done' AND ${TASK_VISIBLE}
       AND (@before IS NULL OR t.completed_at < @before)
       ORDER BY t.completed_at DESC LIMIT @limit`,
    )
    .all({ workspaceId, userId, before, limit }) as TaskRow[];
  return rows.map((r) => rowToTask(r));
}

function validate(p: TaskPatch, workspaceId: string) {
  if (p.title !== undefined && (typeof p.title !== 'string' || p.title.length > 1000)) throw new HttpError(400, 'Invalid title');
  if (p.description !== undefined && (typeof p.description !== 'string' || p.description.length > 50_000))
    throw new HttpError(400, 'Invalid description');
  if (p.reminderAt && (typeof p.reminderAt !== 'string' || Number.isNaN(Date.parse(p.reminderAt))))
    throw new HttpError(400, 'Invalid reminder');
  if (p.assigneeId !== undefined && p.assigneeId !== null && typeof p.assigneeId !== 'string') throw new HttpError(400, 'Invalid assignee');
  if (p.pageId !== undefined && p.pageId !== null && typeof p.pageId !== 'string') throw new HttpError(400, 'Invalid page');
  if (p.priority !== undefined && ![1, 2, 3, 4].includes(p.priority)) throw new HttpError(400, 'Invalid priority');
  if (p.status !== undefined && !['open', 'done'].includes(p.status)) throw new HttpError(400, 'Invalid status');
  if (p.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(p.dueDate)) throw new HttpError(400, 'Invalid due date');
  if (p.dueTime && !/^\d{2}:\d{2}$/.test(p.dueTime)) throw new HttpError(400, 'Invalid due time');
  if (p.recurrence) {
    const err = recurrenceError(p.recurrence);
    if (err) throw new HttpError(400, err);
  }
  if (p.parentId !== undefined && p.parentId !== null && typeof p.parentId !== 'string') throw new HttpError(400, 'Invalid parent');
  if (p.teamId !== undefined && p.teamId !== null) {
    if (typeof p.teamId !== 'string' || !db.prepare('SELECT 1 FROM teams WHERE id = ? AND workspace_id = ?').get(p.teamId, workspaceId))
      throw new HttpError(400, 'Invalid team');
  }
  if (p.tagIds !== undefined && (!Array.isArray(p.tagIds) || p.tagIds.length > 50 || p.tagIds.some((x) => typeof x !== 'string')))
    throw new HttpError(400, 'Invalid tags');
}

/**
 * Who a task may be assigned to (#98 follow-up). Workspace members, as always, when a member
 * assigns it; on a page shared one by one, also the people that page is shared with. Someone
 * outside the workspace (assigning a task on a page shared with them) may pick anyone who can
 * open that page, and nobody else: the page's people are all they know of the workspace.
 */
function checkAssignee(assigneeId: string | null | undefined, workspaceId: string, pageId: string | null, actorIsMember: boolean) {
  if (!assigneeId) return;
  const ok = actorIsMember
    ? !!roleIn(workspaceId, assigneeId) || (!!pageId && !!pageShare(pageId, assigneeId))
    : !!pageId && !!pageAccess(pageId, assigneeId);
  if (!ok) throw new HttpError(400, pageId ? 'Assignee can’t open this page' : 'Assignee is not a workspace member');
}

/**
 * Tasks assigned to someone who can no longer see them: outside the workspace, and without a
 * share on the task's page (a share removed, the task moved off the page). They're unassigned
 * so they don't linger as "assigned to" someone who can't open them. `where` scopes the
 * update (e.g. 'page_id = ?'). Publishes the changed tasks; returns their ids.
 */
export function unassignOutsiders(where: string, ...args: unknown[]): string[] {
  const ids = (
    db
      .prepare(
        `SELECT t.id FROM tasks t WHERE (${where}) AND t.assignee_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = t.workspace_id AND m.user_id = t.assignee_id)
           AND NOT (t.page_id IS NOT NULL AND EXISTS (SELECT 1 FROM page_shares ps WHERE ps.page_id = t.page_id AND ps.user_id = t.assignee_id))`,
      )
      .all(...args) as { id: string }[]
  ).map((r) => r.id);
  if (!ids.length) return ids;
  const ts = now();
  const upd = db.prepare('UPDATE tasks SET assignee_id = NULL, assigned_by = NULL, updated_at = ? WHERE id = ?');
  for (const id of ids) upd.run(ts, id);
  for (const id of ids) publish({ type: 'task', task: getTask(id)! });
  return ids;
}

/** Throws unless `userId` may add tasks in the workspace: a member (not a viewer), or (onto a page they can edit) someone outside it. */
function mustCreate(workspaceId: string, userId: string, input: TaskPatch): boolean {
  const role = roleIn(workspaceId, userId);
  if (role === 'viewer') throw new HttpError(403, 'You do not have permission to do that');
  if (role) return true;
  // Outside the workspace (#98 follow-up): only on a page shared with them to edit (checked by the caller), never standalone.
  if (!input.pageId && !input.parentId) throw new HttpError(404, 'Workspace not found');
  if (input.teamId || input.tagIds?.length) throw new HttpError(400, 'Teams and tags are for workspace members');
  return false;
}

/**
 * Replace a task's tags. Ids that aren't tags of this workspace are ignored (a tag may have been
 * deleted while an offline edit was queued).
 */
function setTaskTags(taskId: string, workspaceId: string, tagIds: string[]) {
  db.prepare('DELETE FROM task_tags WHERE task_id = ?').run(taskId);
  const add = db.prepare(
    'INSERT OR IGNORE INTO task_tags (task_id, tag_id) SELECT ?, id FROM tags WHERE id = ? AND workspace_id = ?',
  );
  for (const id of new Set(tagIds)) add.run(taskId, id, workspaceId);
}

const IN_PRIVATE_NOTEBOOK = `SELECT p.id FROM pages p JOIN sections s ON s.id = p.section_id
  JOIN notebooks n ON n.id = s.notebook_id WHERE n.visibility = 'private'`;

/**
 * Before tasks lose their page: those leaving a page in a private notebook stay
 * private (creator and assignee only, see TASK_VISIBLE) instead of becoming
 * workspace-visible standalone tasks. Covers subtasks and completion history,
 * which share the page. `where` selects the tasks, e.g. 'page_id = ?'.
 */
export function keepPrivateWhenDetaching(where: string, ...args: unknown[]) {
  db.prepare(`UPDATE tasks SET private_owner_only = 1 WHERE (${where}) AND page_id IN (${IN_PRIVATE_NOTEBOOK})`).run(...args);
}

function privateOwnerOnly(id: string): number {
  return (db.prepare('SELECT private_owner_only AS v FROM tasks WHERE id = ?').get(id) as { v: number } | undefined)?.v ?? 0;
}

/** A valid parent for a subtask: same workspace, visible, and itself top-level (one level only). */
function resolveParent(userId: string, workspaceId: string, parentId: string, selfId?: string): Task {
  const parent = getTask(parentId);
  if (!parent || parent.workspaceId !== workspaceId || !taskVisibleTo(parentId, userId)) throw new HttpError(400, 'Invalid parent task');
  if (parent.id === selfId) throw new HttpError(400, 'A task cannot be its own subtask');
  if (parent.parentId) throw new HttpError(400, 'Subtasks cannot have subtasks');
  // A subtask goes into the parent's note, so the same rule as creating a task
  // there applies: seeing the parent (e.g. as its assignee) isn't enough.
  if (parent.pageId) {
    const a = pageAccess(parent.pageId, userId);
    if (!a || !a.canEdit) throw new HttpError(400, 'You can’t add tasks to that note');
  }
  return parent;
}

function taskVisibleTo(id: string, userId: string) {
  return !!db.prepare(`SELECT 1 FROM tasks t WHERE t.id = @id AND ${TASK_VISIBLE}`).get({ id, userId });
}

function childIds(parentId: string): string[] {
  return (db.prepare('SELECT id FROM tasks WHERE parent_id = ?').all(parentId) as { id: string }[]).map((r) => r.id);
}

/** Subtasks live in their parent's note (and so share its visibility). Returns the children that moved. */
function cascadePage(parentId: string, pageId: string | null): string[] {
  const ids = (
    db.prepare('SELECT id FROM tasks WHERE parent_id = ? AND page_id IS NOT ?').all(parentId, pageId) as { id: string }[]
  ).map((r) => r.id);
  if (!ids.length) return ids;
  if (pageId === null) keepPrivateWhenDetaching('parent_id = ?', parentId);
  db.prepare(
    `UPDATE tasks SET page_id = @pageId, updated_at = @ts,
       private_owner_only = CASE WHEN @pageId IS NULL THEN private_owner_only ELSE 0 END WHERE parent_id = @parentId`,
  ).run({ pageId, ts: now(), parentId });
  return ids;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createTask(userId: string, workspaceId: string, input: TaskPatch & { title: string; id?: string }): Task {
  const member = mustCreate(workspaceId, userId, input);
  validate(input, workspaceId);
  // Clients may supply the id so a task can be embedded in a note instantly
  // (before the request round-trips). Retrying with the same id is idempotent.
  if (input.id !== undefined) {
    if (typeof input.id !== 'string' || !UUID_RE.test(input.id)) throw new HttpError(400, 'Invalid id');
    const existing = getTask(input.id);
    if (existing) {
      if (existing.workspaceId !== workspaceId || existing.createdBy !== userId) throw new HttpError(409, 'Task id already used');
      return existing;
    }
  }
  let pageId = input.pageId ?? null;
  const parentId = input.parentId ?? null;
  if (parentId) {
    pageId = resolveParent(userId, workspaceId, parentId).pageId;
  } else if (pageId) {
    const a = pageAccess(pageId, userId);
    if (!a || a.workspaceId !== workspaceId || !a.canEdit) throw new HttpError(400, 'Invalid page');
  }
  checkAssignee(input.assigneeId, workspaceId, pageId, member);
  const id = input.id ?? newId();
  const ts = now();
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, description, priority, due_date, due_time, recurrence, reminder_at,
       assignee_id, assigned_by, team_id, created_by, page_id, parent_id, private_owner_only, created_at, updated_at)
     VALUES (@id, @workspaceId, @title, @description, @priority, @dueDate, @dueTime, @recurrence, @reminderAt,
       @assigneeId, @assignedBy, @teamId, @userId, @pageId, @parentId, @privateOnly, @ts, @ts)`,
  ).run({
    id,
    workspaceId,
    userId,
    ts,
    title: input.title.trim(),
    description: input.description ?? '',
    priority: input.priority ?? 4,
    dueDate: input.dueDate ?? null,
    dueTime: input.dueTime ?? null,
    recurrence: input.recurrence ? JSON.stringify(input.recurrence) : null,
    reminderAt: input.reminderAt ?? null,
    assigneeId: input.assigneeId === undefined ? null : input.assigneeId,
    assignedBy: input.assigneeId ? userId : null,
    teamId: input.teamId ?? null,
    pageId,
    parentId,
    // A subtask of a private standalone task is just as private.
    privateOnly: parentId && !pageId ? privateOwnerOnly(parentId) : 0,
  });
  if (input.tagIds?.length) setTaskTags(id, workspaceId, input.tagIds);
  const task = getTask(id)!;
  publish({ type: 'task', task });
  return task;
}

const COLUMNS: Record<keyof TaskPatch, string> = {
  title: 'title',
  description: 'description',
  status: 'status',
  priority: 'priority',
  dueDate: 'due_date',
  dueTime: 'due_time',
  recurrence: 'recurrence',
  reminderAt: 'reminder_at',
  assigneeId: 'assignee_id',
  pageId: 'page_id',
  parentId: 'parent_id',
  teamId: 'team_id',
  tagIds: '', // task_tags, not a column
};

/**
 * Changing a task that lives on a note needs edit access to that note (#98 review): seeing it
 * (e.g. through a view-only page share) is not enough. The one exception: the person it's assigned
 * to may tick it off or reopen it, and nothing else, without edit access to its note.
 */
/** May `userId` move this task off its current note? Needs edit access to that note (or it has none). No assignee exception. */
export function canMoveTask(taskId: string, userId: string): boolean {
  const task = getTask(taskId);
  if (!task || !atLeast(roleIn(task.workspaceId, userId), 'member')) return false;
  return !task.pageId || !!pageAccess(task.pageId, userId)?.canEdit;
}

/**
 * Throws unless `userId` may change (or delete) the task. Returns whether they're a workspace member.
 * Tasks on a page: whoever may edit that page, members or not (#98 follow-up: an edit page share
 * covers the tasks living on that page). Standalone tasks: workspace members. Viewers never.
 */
function mustEditTask(task: Task, userId: string, patch?: TaskPatch): boolean {
  const role = roleIn(task.workspaceId, userId);
  if (role === 'viewer') throw new HttpError(403, 'You do not have permission to do that');
  if (!task.pageId) {
    if (!role) throw new HttpError(404, 'Workspace not found');
    return true;
  }
  const a = pageAccess(task.pageId, userId);
  if (a?.canEdit) return !!role;
  const statusOnly = !!patch && Object.keys(patch).every((k) => k === 'status');
  if (statusOnly && task.assigneeId === userId && (role || a)) return !!role;
  if (!role && !a) throw new HttpError(404, 'Task not found');
  throw new HttpError(403, 'You have view-only access to the note this task is in');
}

export function updateTask(userId: string, id: string, input: TaskPatch): Task {
  const patch: TaskPatch = { ...input };
  const task = getTask(id);
  if (!task || !db.prepare(`SELECT 1 FROM tasks t WHERE t.id = @id AND ${TASK_VISIBLE}`).get({ id, userId }))
    throw new HttpError(404, 'Task not found');
  const member = mustEditTask(task, userId, patch);
  validate(patch, task.workspaceId);
  if (!member && (patch.teamId !== undefined || patch.tagIds !== undefined)) throw new HttpError(400, 'Teams and tags are for workspace members');
  if (patch.pageId) {
    const a = pageAccess(patch.pageId, userId);
    if (!a || a.workspaceId !== task.workspaceId || !a.canEdit) throw new HttpError(400, 'Invalid page');
  }
  if (patch.parentId) {
    const parent = resolveParent(userId, task.workspaceId, patch.parentId, id);
    if (childIds(id).length) throw new HttpError(400, 'A task with subtasks cannot become a subtask');
    patch.pageId = parent.pageId;
  } else if (patch.parentId === null && task.parentId) {
    patch.pageId ??= null; // leaving the parent's note too: it becomes a standalone task
  } else if (task.parentId && patch.pageId !== undefined && patch.pageId !== task.pageId) {
    throw new HttpError(400, 'A subtask stays in its parent’s note');
  }
  const pageAfter = patch.pageId !== undefined ? patch.pageId : task.pageId;
  // Taking a task off its page makes it a workspace task: for members only.
  if (!member && !pageAfter) throw new HttpError(403, 'Only workspace members can take a task off its page');
  if (patch.assigneeId !== undefined) checkAssignee(patch.assigneeId, task.workspaceId, pageAfter ?? null, member);

  const ts = now();
  const sets: string[] = [];
  if (patch.pageId) sets.push('private_owner_only = 0');
  else if (patch.parentId && privateOwnerOnly(patch.parentId)) sets.push('private_owner_only = 1');
  const params: Record<string, unknown> = { id, ts };
  for (const [key, col] of Object.entries(COLUMNS) as [keyof TaskPatch, string][]) {
    if (patch[key] === undefined || key === 'tagIds') continue;
    let v: unknown = patch[key];
    if (key === 'recurrence') v = v ? JSON.stringify(v) : null;
    if (key === 'title') v = String(v).trim();
    sets.push(`${col} = @${key}`);
    params[key] = v;
  }

  // "Assigned by" is whoever changed the assignee, and clears when the task is unassigned.
  if (patch.assigneeId !== undefined && (patch.assigneeId ?? null) !== task.assigneeId) {
    sets.push('assigned_by = @assignedBy');
    params.assignedBy = patch.assigneeId ? userId : null;
  }
  const tagsChanged = patch.tagIds !== undefined;

  const completing = patch.status === 'done' && task.status === 'open';
  const reopening = patch.status === 'open' && task.status === 'done';
  const recurrence = patch.recurrence !== undefined ? patch.recurrence : task.recurrence;

  let reopenedChildren: string[] = [];
  db.transaction(() => {
    // Leaving a private note keeps the task private (entering a note clears it, above).
    if (patch.pageId === null && task.pageId) keepPrivateWhenDetaching('id = ?', id);
    if (tagsChanged) setTaskTags(id, task.workspaceId, patch.tagIds!);
    // Recurring: the next due date in the completing user's time zone, or null
    // when the series has ended (until / count) and the task completes for good.
    const dueDate = completing && recurrence ? nextDueDate(recurrence, patch.dueDate ?? task.dueDate, id, userId) : null;
    if (completing && recurrence && dueDate) {
      // Record a completed occurrence for history, then roll the original
      // forward to its next due date and keep it open (docs/REMINDERS.md).
      // The history row keeps page_id and private_owner_only: visibility follows
      // them, so history is exactly as private as the task (reconcile skips occurrences).
      const occId = newId();
      db.prepare(
        `INSERT INTO tasks (id, workspace_id, title, description, status, priority, due_date, due_time, assignee_id, assigned_by, team_id,
           created_by, page_id, private_owner_only, occurrence_of, completed_at, completed_by, created_at, updated_at)
         SELECT @occId, workspace_id, title, description, 'done', priority, due_date, due_time, assignee_id, assigned_by, team_id,
           created_by, page_id, private_owner_only, id, @ts, @userId, @ts, @ts FROM tasks WHERE id = @id`,
      ).run({ occId, id, ts, userId });
      db.prepare('INSERT INTO task_tags (task_id, tag_id) SELECT ?, tag_id FROM task_tags WHERE task_id = ?').run(occId, id);
      // Shift the reminder by the same offset relative to the due date.
      let reminderAt = task.reminderAt;
      if (reminderAt && task.dueDate) {
        const delta = Date.parse(dueDate) - Date.parse(task.dueDate);
        reminderAt = new Date(Date.parse(reminderAt) + delta).toISOString();
      }
      const filtered = sets.filter((s) => !s.startsWith('status') && !s.startsWith('due_date') && !s.startsWith('reminder_at'));
      filtered.push('due_date = @nextDue', 'reminder_at = @nextReminder');
      db.prepare(`UPDATE tasks SET ${filtered.join(', ')}, updated_at = @ts WHERE id = @id`).run({
        ...params,
        nextDue: dueDate,
        nextReminder: reminderAt,
      });
      // The next occurrence starts with its subtasks open again.
      reopenedChildren = (
        db.prepare(`SELECT id FROM tasks WHERE parent_id = ? AND status = 'done'`).all(id) as { id: string }[]
      ).map((r) => r.id);
      if (reopenedChildren.length)
        db.prepare(`UPDATE tasks SET status = 'open', completed_at = NULL, completed_by = NULL, updated_at = ? WHERE parent_id = ? AND status = 'done'`).run(ts, id);
      publish({ type: 'task', task: getTask(occId)! });
      return;
    }
    if (completing) sets.push('completed_at = @ts', 'completed_by = @userId');
    if (reopening) sets.push('completed_at = NULL', 'completed_by = NULL');
    params.userId = userId;
    if (sets.length || tagsChanged) db.prepare(`UPDATE tasks SET ${[...sets, 'updated_at = @ts'].join(', ')} WHERE id = @id`).run(params);
  })();

  let updated = getTask(id)!;
  publish({ type: 'task', task: updated });
  if (updated.pageId !== task.pageId) {
    for (const c of cascadePage(id, updated.pageId)) publish({ type: 'task', task: getTask(c)! });
    // Off a shared page: someone who had it only through that page can't be its assignee any more.
    if (unassignOutsiders('t.id = ? OR t.parent_id = ?', id, id).includes(id)) updated = getTask(id)!;
  }
  for (const c of reopenedChildren) publish({ type: 'task', task: getTask(c)! });
  return updated;
}

export function deleteTask(userId: string, id: string) {
  const task = getTask(id);
  if (!task || !db.prepare(`SELECT 1 FROM tasks t WHERE t.id = @id AND ${TASK_VISIBLE}`).get({ id, userId }))
    throw new HttpError(404, 'Task not found');
  mustEditTask(task, userId);
  const children = childIds(id);
  // Share holders outside the workspace saw it on its page: tell them directly (broadcasts skip them).
  const outsiders = task.pageId
    ? (
        db
          .prepare(
            `SELECT ps.user_id FROM page_shares ps WHERE ps.page_id = ?
               AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = ? AND m.user_id = ps.user_id)`,
          )
          .all(task.pageId, task.workspaceId) as { user_id: string }[]
      ).map((r) => r.user_id)
    : [];
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id); // subtasks go with it (ON DELETE CASCADE)
  for (const c of [id, ...children]) {
    publish({ type: 'task-deleted', id: c, workspaceId: task.workspaceId });
    if (outsiders.length) publish({ type: 'task-deleted', id: c, workspaceId: task.workspaceId }, { userIds: outsiders });
  }
}

/**
 * Called whenever a note is saved. Reconciles which tasks the note embeds:
 * - tasks referenced in the doc are linked to the page (e.g. after being moved
 *   or pasted from another note),
 * - tasks that claim the page but are no longer in it become standalone tasks
 *   (they are never deleted silently).
 */
export function syncPageTasks(
  pageId: string,
  workspaceId: string,
  taskIds: Set<string>,
  mayAttach: (taskId: string) => boolean = () => true,
  mayDetach: (taskId: string) => boolean = () => true,
) {
  const changed: string[] = [];
  db.transaction(() => {
    const current = db
      .prepare(`SELECT id FROM tasks WHERE page_id = ? AND occurrence_of IS NULL AND parent_id IS NULL`)
      .all(pageId) as { id: string }[];
    for (const { id } of current) {
      if (!taskIds.has(id) && mayDetach(id)) {
        keepPrivateWhenDetaching('id = ?', id);
        db.prepare('UPDATE tasks SET page_id = NULL, updated_at = ? WHERE id = ?').run(now(), id);
        changed.push(id);
      }
    }
    for (const id of taskIds) {
      // A reference to a task on another page (or standalone) moves it here only if whoever put the
      // reference in may see that task (#98 review): otherwise pasting an id would pull in, and
      // un-privatise, a task the editor can't see. Tasks already on this page are untouched.
      if (!mayAttach(id)) continue;
      const r = db.prepare('UPDATE tasks SET page_id = ?, private_owner_only = 0, updated_at = ? WHERE id = ? AND workspace_id = ? AND parent_id IS NULL AND (page_id IS NOT ? OR page_id IS NULL)')
        .run(pageId, now(), id, workspaceId, pageId);
      if (r.changes) changed.push(id);
    }
    // Subtasks follow their parent between notes.
    for (const id of [...changed]) changed.push(...cascadePage(id, (getTask(id)?.pageId ?? null)));
  })();
  // Tasks that left the page lose an assignee who had them only through its page share.
  if (changed.length) unassignOutsiders(`t.id IN (${changed.map(() => '?').join(', ')})`, ...changed);
  for (const id of changed) {
    const t = getTask(id);
    if (t) publish({ type: 'task', task: t });
  }
}
