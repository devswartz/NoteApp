// Optional daily digest email: open tasks due today or overdue, sent at the
// user's chosen local time. Idempotent per user and local date.
import { db } from '../db.ts';
import { TASK_VISIBLE } from '../access.ts';
import { todayIn, zonedTimeToUtc } from '../../shared/recurrence.ts';
import { getSettings } from './settings.ts';
import { escapeHtml } from './email.ts';
import type { Notice } from './channels.ts';

interface DigestTask {
  id: string;
  title: string;
  due_date: string;
  due_time: string | null;
  workspace_id: string;
  workspace_name: string;
}

/** Digests that are due at `nowMs` (within the catch-up window) and not yet sent. */
export function dueDigests(nowMs: number, catchUpMs: number): Notice[] {
  const users = db
    .prepare(
      `SELECT s.user_id FROM notification_settings s WHERE s.digest_enabled = 1 AND s.email_enabled = 1`,
    )
    .all() as { user_id: string }[];
  const out: Notice[] = [];
  for (const { user_id: userId } of users) {
    const s = getSettings(userId);
    const today = todayIn(s.timeZone, nowMs);
    const at = zonedTimeToUtc(today, s.digestTime, s.timeZone).getTime();
    if (nowMs < at || nowMs - at > catchUpMs) continue;
    const key = `digest:${userId}:${today}`;
    if (db.prepare('SELECT 1 FROM notification_log WHERE key = ?').get(key)) continue;
    const tasks = db
      .prepare(
        `SELECT t.id, t.title, t.due_date, t.due_time, t.workspace_id, w.name AS workspace_name
         FROM tasks t JOIN workspaces w ON w.id = t.workspace_id
         WHERE t.status = 'open' AND t.due_date IS NOT NULL AND t.due_date <= @today
           AND (t.assignee_id = @userId OR (t.assignee_id IS NULL AND t.created_by = @userId))
           AND ${TASK_VISIBLE}
         ORDER BY t.due_date, COALESCE(t.due_time, '99:99'), t.priority`,
      )
      .all({ userId, today }) as DigestTask[];
    if (!tasks.length) continue;
    out.push(buildDigest(userId, today, tasks, key));
  }
  return out;
}

function buildDigest(userId: string, today: string, tasks: DigestTask[], key: string): Notice {
  const label = (t: DigestTask) =>
    `${t.title || 'Untitled task'}${t.due_date < today ? ` (overdue, ${t.due_date})` : t.due_time ? ` (${t.due_time})` : ''}`;
  const overdue = tasks.filter((t) => t.due_date < today).length;
  const title = `Today: ${tasks.length} task${tasks.length === 1 ? '' : 's'}${overdue ? ` (${overdue} overdue)` : ''}`;
  const body = tasks.map((t) => `• ${label(t)}`).join('\n');
  const html = `<p>Your tasks for ${today}:</p><ul>${tasks.map((t) => `<li>${escapeHtml(label(t))}</li>`).join('')}</ul>`;
  return { key, userId, title, body, html, path: `/w/${tasks[0].workspace_id}/tasks/today`, channels: ['email'] };
}
