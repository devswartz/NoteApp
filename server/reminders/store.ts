// Reminders per task: persistence and next_fire_at computation.
//
// next_fire_at is a cache of "when does this reminder fire next". It is
// recomputed by syncReminders() for any reminder whose task changed since it
// was last computed (tasks.updated_at > synced_at), or whose settings changed
// (synced_at reset to ''). So moving a due date, rolling a recurring task
// forward or completing it all update reminders without hooks in server/tasks.ts.
//
// tasks.reminder_at (the original single reminder field) is mirrored as a
// 'legacy' reminder (id = task id) for the assignee, or the creator.
import { db, newId, now } from '../db.ts';
import { HttpError, TASK_VISIBLE } from '../access.ts';
import { isISODate, zonedTimeToUtc } from '../../shared/recurrence.ts';
import { getSettings } from './settings.ts';
import type { NotificationSettings, Reminder, ReminderSpec } from '../../shared/types.ts';

export interface ReminderRow {
  id: string;
  task_id: string;
  user_id: string;
  kind: 'at' | 'before' | 'legacy';
  at: string | null;
  minutes: number | null;
  next_fire_at: string | null;
  last_fired_at: string | null;
  synced_at: string;
  created_at: string;
}

interface TaskBits {
  status: 'open' | 'done';
  due_date: string | null;
  due_time: string | null;
  reminder_at: string | null;
}

export const MAX_BEFORE_MINUTES = 60 * 24 * 60; // 60 days
export const MAX_REMINDERS_PER_TASK = 10;

export function rowToReminder(r: ReminderRow): Reminder {
  const base = { id: r.id, taskId: r.task_id, userId: r.user_id, nextFireAt: r.next_fire_at, lastFiredAt: r.last_fired_at, createdAt: r.created_at };
  return r.kind === 'before' ? { kind: 'before', minutes: r.minutes ?? 0, ...base } : { kind: 'at', at: r.at ?? '', ...base };
}

/** The instant the reminder should fire next, or null. Pure; exported for tests. */
export function computeFireAt(r: Pick<ReminderRow, 'kind' | 'at' | 'minutes' | 'last_fired_at'>, t: TaskBits, s: NotificationSettings): string | null {
  if (t.status !== 'open') return null;
  let at: string | null = null;
  if (r.kind === 'at') at = r.at;
  else if (r.kind === 'legacy') at = t.reminder_at;
  else if (r.kind === 'before' && t.due_date && isISODate(t.due_date)) {
    const time = t.due_time && /^\d{2}:\d{2}$/.test(t.due_time) ? t.due_time : s.defaultReminderTime;
    at = new Date(zonedTimeToUtc(t.due_date, time, s.timeZone).getTime() - (r.minutes ?? 0) * 60_000).toISOString();
  }
  if (!at || Number.isNaN(Date.parse(at))) return null;
  at = new Date(at).toISOString();
  // Fired already for this instant (e.g. the due date hasn't moved since).
  if (r.last_fired_at && Date.parse(at) <= Date.parse(r.last_fired_at)) return null;
  return at;
}

function validateSpec(spec: ReminderSpec): ReminderSpec {
  if (spec?.kind === 'at') {
    if (typeof spec.at !== 'string' || Number.isNaN(Date.parse(spec.at))) throw new HttpError(400, 'Invalid reminder time');
    return { kind: 'at', at: new Date(spec.at).toISOString() };
  }
  if (spec?.kind === 'before') {
    if (!Number.isInteger(spec.minutes) || spec.minutes < 0 || spec.minutes > MAX_BEFORE_MINUTES) throw new HttpError(400, 'Invalid reminder offset');
    return { kind: 'before', minutes: spec.minutes };
  }
  throw new HttpError(400, 'Invalid reminder');
}

/** Throws 404 unless the user can see the task. */
export function requireVisibleTask(taskId: string, userId: string) {
  const ok = db.prepare(`SELECT 1 FROM tasks t WHERE t.id = @taskId AND ${TASK_VISIBLE}`).get({ taskId, userId });
  if (!ok) throw new HttpError(404, 'Task not found');
}

export function listReminders(taskId: string, userId: string): Reminder[] {
  requireVisibleTask(taskId, userId);
  syncReminders();
  const rows = db
    .prepare("SELECT * FROM task_reminders WHERE task_id = ? AND user_id = ? AND kind != 'legacy' ORDER BY created_at")
    .all(taskId, userId) as ReminderRow[];
  return rows.map(rowToReminder);
}

export function createReminder(taskId: string, userId: string, input: ReminderSpec & { id?: string }): Reminder {
  requireVisibleTask(taskId, userId);
  const spec = validateSpec(input);
  const n = (db.prepare("SELECT COUNT(*) AS n FROM task_reminders WHERE task_id = ? AND user_id = ? AND kind != 'legacy'").get(taskId, userId) as { n: number }).n;
  if (n >= MAX_REMINDERS_PER_TASK) throw new HttpError(400, 'Too many reminders on this task');
  const id = newId();
  db.prepare(
    `INSERT INTO task_reminders (id, task_id, user_id, kind, at, minutes, synced_at, created_at)
     VALUES (@id, @taskId, @userId, @kind, @at, @minutes, '', @ts)`,
  ).run({ id, taskId, userId, kind: spec.kind, at: spec.kind === 'at' ? spec.at : null, minutes: spec.kind === 'before' ? spec.minutes : null, ts: now() });
  syncReminders();
  return rowToReminder(db.prepare('SELECT * FROM task_reminders WHERE id = ?').get(id) as ReminderRow);
}

function ownReminder(id: string, userId: string): ReminderRow {
  const r = db.prepare("SELECT * FROM task_reminders WHERE id = ? AND user_id = ? AND kind != 'legacy'").get(id, userId) as ReminderRow | undefined;
  if (!r) throw new HttpError(404, 'Reminder not found');
  return r;
}

export function updateReminder(id: string, userId: string, input: ReminderSpec): Reminder {
  ownReminder(id, userId);
  const spec = validateSpec(input);
  db.prepare(
    `UPDATE task_reminders SET kind = @kind, at = @at, minutes = @minutes, last_fired_at = NULL, synced_at = '' WHERE id = @id`,
  ).run({ id, kind: spec.kind, at: spec.kind === 'at' ? spec.at : null, minutes: spec.kind === 'before' ? spec.minutes : null });
  syncReminders();
  return rowToReminder(db.prepare('SELECT * FROM task_reminders WHERE id = ?').get(id) as ReminderRow);
}

export function deleteReminder(id: string, userId: string) {
  ownReminder(id, userId);
  db.prepare('DELETE FROM task_reminders WHERE id = ?').run(id);
}

/**
 * Brings reminders up to date with their tasks: mirrors tasks.reminder_at into
 * 'legacy' rows and recomputes next_fire_at where the task or settings changed.
 * Cheap when nothing changed (indexed comparison), so it runs every tick.
 */
export function syncReminders(nowIso = now()) {
  // nowIso only stamps created_at of new legacy rows.
  db.transaction(() => {
    // Legacy mirror: add rows for tasks with reminder_at, drop rows whose task cleared it.
    db.prepare(
      `INSERT INTO task_reminders (id, task_id, user_id, kind, synced_at, created_at)
       SELECT t.id, t.id, COALESCE(t.assignee_id, t.created_by), 'legacy', '', @ts FROM tasks t
       WHERE t.reminder_at IS NOT NULL AND t.status = 'open'
         AND NOT EXISTS (SELECT 1 FROM task_reminders r WHERE r.id = t.id)`,
    ).run({ ts: nowIso });
    db.prepare(
      `DELETE FROM task_reminders WHERE kind = 'legacy'
       AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_reminders.task_id AND t.reminder_at IS NOT NULL)`,
    ).run();
    // Legacy recipient follows the assignee.
    db.prepare(
      `UPDATE task_reminders SET user_id = (SELECT COALESCE(t.assignee_id, t.created_by) FROM tasks t WHERE t.id = task_reminders.task_id)
       WHERE kind = 'legacy' AND synced_at < (SELECT t.updated_at FROM tasks t WHERE t.id = task_reminders.task_id)`,
    ).run();

    const stale = db
      .prepare(
        `SELECT r.*, t.status, t.due_date, t.due_time, t.reminder_at, t.updated_at AS task_updated_at
         FROM task_reminders r JOIN tasks t ON t.id = r.task_id
         WHERE r.synced_at = '' OR r.synced_at < t.updated_at`,
      )
      .all() as (ReminderRow & TaskBits & { task_updated_at: string })[];
    const update = db.prepare('UPDATE task_reminders SET next_fire_at = ?, synced_at = ? WHERE id = ?');
    const settings = new Map<string, NotificationSettings>();
    for (const r of stale) {
      let s = settings.get(r.user_id);
      if (!s) settings.set(r.user_id, (s = getSettings(r.user_id)));
      // synced_at = the task version it was computed from, so the check is exact
      // whatever the clock says.
      update.run(computeFireAt(r, r, s), r.task_updated_at, r.id);
    }
  })();
}
