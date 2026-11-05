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
  if (p.assigneeId && !roleIn(workspaceId, p.assigneeId)) throw new HttpError(400, 'Assignee is not a workspace member');
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
  if (input.pageId) {
    const a = pageAccess(input.pageId, userId);
    if (!a || a.workspaceId !== workspaceId || !a.canEdit) throw new HttpError(400, 'Invalid page');
  }
  const id = input.id ?? newId();
  const ts = now();
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, description, priority, due_date, due_time, recurrence, reminder_at,
       assignee_id, created_by, page_id, created_at, updated_at)
     VALUES (@id, @workspaceId, @title, @description, @priority, @dueDate, @dueTime, @recurrence, @reminderAt,
       @assigneeId, @userId, @pageId, @ts, @ts)`,
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
    pageId: input.pageId ?? null,
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
};

export function updateTask(userId: string, id: string, patch: TaskPatch): Task {
  const task = getTask(id);
  if (!task || !db.prepare(`SELECT 1 FROM tasks t WHERE t.id = @id AND ${TASK_VISIBLE}`).get({ id, userId }))
    throw new HttpError(404, 'Task not found');
  requireRole(task.workspaceId, userId, 'member');
  validate(patch, task.workspaceId);
  if (patch.pageId) {
    const a = pageAccess(patch.pageId, userId);
    if (!a || a.workspaceId !== task.workspaceId || !a.canEdit) throw new HttpError(400, 'Invalid page');
  }

  const ts = now();
  const sets: string[] = [];
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

  db.transaction(() => {
    // Recurring: the next due date in the completing user's time zone, or null
    // when the series has ended (until / count) and the task completes for good.
    const dueDate = completing && recurrence ? nextDueDate(recurrence, patch.dueDate ?? task.dueDate, id, userId) : null;
    if (completing && recurrence && dueDate) {
      // Record a completed occurrence for history, then roll the original
      // forward to its next due date and keep it open (docs/REMINDERS.md).
      const occId = newId();
      db.prepare(
        `INSERT INTO tasks (id, workspace_id, title, description, status, priority, due_date, due_time, assignee_id,
           created_by, page_id, occurrence_of, completed_at, completed_by, created_at, updated_at)
         SELECT @occId, workspace_id, title, description, 'done', priority, due_date, due_time, assignee_id,
           created_by, NULL, id, @ts, @userId, @ts, @ts FROM tasks WHERE id = @id`,
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
  return updated;
}

export function deleteTask(userId: string, id: string) {
  const task = getTask(id);
  if (!task || !db.prepare(`SELECT 1 FROM tasks t WHERE t.id = @id AND ${TASK_VISIBLE}`).get({ id, userId }))
    throw new HttpError(404, 'Task not found');
  requireRole(task.workspaceId, userId, 'member');
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  publish({ type: 'task-deleted', id, workspaceId: task.workspaceId });
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
      .prepare(`SELECT id FROM tasks WHERE page_id = ? AND occurrence_of IS NULL`)
      .all(pageId) as { id: string }[];
    for (const { id } of current) {
      if (!taskIds.has(id)) {
        db.prepare('UPDATE tasks SET page_id = NULL, updated_at = ? WHERE id = ?').run(now(), id);
        changed.push(id);
      }
    }
    for (const id of taskIds) {
      const r = db.prepare('UPDATE tasks SET page_id = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND (page_id IS NOT ? OR page_id IS NULL)')
        .run(pageId, now(), id, workspaceId, pageId);
      if (r.changes) changed.push(id);
    }
  })();
  for (const id of changed) {
    const t = getTask(id);
    if (t) publish({ type: 'task', task: t });
  }
}
