// Task persistence and business rules (completion, recurrence, linking to notes).
import { db, newId, now } from './db.ts';
import { HttpError, TASK_VISIBLE, pageAccess, requireRole, roleIn } from './access.ts';
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
  completed_at: string | null;
  completed_by: string | null;
  created_at: string;
  updated_at: string;
}

export function rowToTask(r: TaskRow): Task {
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
  return rows.map(rowToTask);
}

export function listCompleted(workspaceId: string, userId: string, before: string | null, limit = 100): Task[] {
  const rows = db
    .prepare(
      `SELECT * FROM tasks t WHERE t.workspace_id = @workspaceId AND t.status = 'done' AND ${TASK_VISIBLE}
       AND (@before IS NULL OR t.completed_at < @before)
       ORDER BY t.completed_at DESC LIMIT @limit`,
    )
    .all({ workspaceId, userId, before, limit }) as TaskRow[];
  return rows.map(rowToTask);
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
  if (p.assigneeId && !roleIn(workspaceId, p.assigneeId)) throw new HttpError(400, 'Assignee is not a workspace member');
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
  requireRole(workspaceId, userId, 'member');
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
  const id = input.id ?? newId();
  const ts = now();
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, description, priority, due_date, due_time, recurrence, reminder_at,
       assignee_id, created_by, page_id, parent_id, private_owner_only, created_at, updated_at)
     VALUES (@id, @workspaceId, @title, @description, @priority, @dueDate, @dueTime, @recurrence, @reminderAt,
       @assigneeId, @userId, @pageId, @parentId, @privateOnly, @ts, @ts)`,
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
    pageId,
    parentId,
    // A subtask of a private standalone task is just as private.
    privateOnly: parentId && !pageId ? privateOwnerOnly(parentId) : 0,
  });
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
};

export function updateTask(userId: string, id: string, input: TaskPatch): Task {
  const patch: TaskPatch = { ...input };
  const task = getTask(id);
  if (!task || !db.prepare(`SELECT 1 FROM tasks t WHERE t.id = @id AND ${TASK_VISIBLE}`).get({ id, userId }))
    throw new HttpError(404, 'Task not found');
  requireRole(task.workspaceId, userId, 'member');
  validate(patch, task.workspaceId);
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

  const ts = now();
  const sets: string[] = [];
  if (patch.pageId) sets.push('private_owner_only = 0');
  else if (patch.parentId && privateOwnerOnly(patch.parentId)) sets.push('private_owner_only = 1');
  const params: Record<string, unknown> = { id, ts };
  for (const [key, col] of Object.entries(COLUMNS) as [keyof TaskPatch, string][]) {
    if (patch[key] === undefined) continue;
    let v: unknown = patch[key];
    if (key === 'recurrence') v = v ? JSON.stringify(v) : null;
    if (key === 'title') v = String(v).trim();
    sets.push(`${col} = @${key}`);
    params[key] = v;
  }

  const completing = patch.status === 'done' && task.status === 'open';
  const reopening = patch.status === 'open' && task.status === 'done';
  const recurrence = patch.recurrence !== undefined ? patch.recurrence : task.recurrence;

  let reopenedChildren: string[] = [];
  db.transaction(() => {
    // Leaving a private note keeps the task private (entering a note clears it, above).
    if (patch.pageId === null && task.pageId) keepPrivateWhenDetaching('id = ?', id);
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
        `INSERT INTO tasks (id, workspace_id, title, description, status, priority, due_date, due_time, assignee_id,
           created_by, page_id, private_owner_only, occurrence_of, completed_at, completed_by, created_at, updated_at)
         SELECT @occId, workspace_id, title, description, 'done', priority, due_date, due_time, assignee_id,
           created_by, page_id, private_owner_only, id, @ts, @userId, @ts, @ts FROM tasks WHERE id = @id`,
      ).run({ occId, id, ts, userId });
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
    if (sets.length) db.prepare(`UPDATE tasks SET ${sets.join(', ')}, updated_at = @ts WHERE id = @id`).run(params);
  })();

  const updated = getTask(id)!;
  publish({ type: 'task', task: updated });
  if (updated.pageId !== task.pageId) for (const c of cascadePage(id, updated.pageId)) publish({ type: 'task', task: getTask(c)! });
  for (const c of reopenedChildren) publish({ type: 'task', task: getTask(c)! });
  return updated;
}

export function deleteTask(userId: string, id: string) {
  const task = getTask(id);
  if (!task || !db.prepare(`SELECT 1 FROM tasks t WHERE t.id = @id AND ${TASK_VISIBLE}`).get({ id, userId }))
    throw new HttpError(404, 'Task not found');
  requireRole(task.workspaceId, userId, 'member');
  const children = childIds(id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id); // subtasks go with it (ON DELETE CASCADE)
  for (const c of [id, ...children]) publish({ type: 'task-deleted', id: c, workspaceId: task.workspaceId });
}

/**
 * Called whenever a note is saved. Reconciles which tasks the note embeds:
 * - tasks referenced in the doc are linked to the page (e.g. after being moved
 *   or pasted from another note),
 * - tasks that claim the page but are no longer in it become standalone tasks
 *   (they are never deleted silently).
 */
export function syncPageTasks(pageId: string, workspaceId: string, taskIds: Set<string>) {
  const changed: string[] = [];
  db.transaction(() => {
    const current = db
      .prepare(`SELECT id FROM tasks WHERE page_id = ? AND occurrence_of IS NULL AND parent_id IS NULL`)
      .all(pageId) as { id: string }[];
    for (const { id } of current) {
      if (!taskIds.has(id)) {
        keepPrivateWhenDetaching('id = ?', id);
        db.prepare('UPDATE tasks SET page_id = NULL, updated_at = ? WHERE id = ?').run(now(), id);
        changed.push(id);
      }
    }
    for (const id of taskIds) {
      const r = db.prepare('UPDATE tasks SET page_id = ?, private_owner_only = 0, updated_at = ? WHERE id = ? AND workspace_id = ? AND parent_id IS NULL AND (page_id IS NOT ? OR page_id IS NULL)')
        .run(pageId, now(), id, workspaceId, pageId);
      if (r.changes) changed.push(id);
    }
    // Subtasks follow their parent between notes.
    for (const id of [...changed]) changed.push(...cascadePage(id, (getTask(id)?.pageId ?? null)));
  })();
  for (const id of changed) {
    const t = getTask(id);
    if (t) publish({ type: 'task', task: t });
  }
}
