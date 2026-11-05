// Quiet hours per user and workspace. A reminder for a task in that
// workspace that comes due inside the window is held until the window ends
// (it is not dropped). Times are HH:mm in the user's time zone; start > end
// wraps past midnight (22:00–07:00). The daily digest ignores quiet hours
// (its time is chosen explicitly).
import { db, now } from '../db.ts';
import { HttpError, requireRole } from '../access.ts';
import { addDays, isHHmm, timeIn, todayIn, zonedTimeToUtc } from '../../shared/recurrence.ts';
import type { QuietHours } from '../../shared/types.ts';

/** If nowMs is inside the window, the instant it ends; otherwise null. Pure. */
export function quietUntil(nowMs: number, tz: string, start: string, end: string): number | null {
  if (start === end) return null;
  const t = timeIn(tz, nowMs);
  const today = todayIn(tz, nowMs);
  if (start < end) return t >= start && t < end ? zonedTimeToUtc(today, end, tz).getTime() : null;
  if (t >= start) return zonedTimeToUtc(addDays(today, 1), end, tz).getTime();
  if (t < end) return zonedTimeToUtc(today, end, tz).getTime();
  return null;
}

export function listQuietHours(userId: string): QuietHours[] {
  return (
    db.prepare('SELECT workspace_id, start_time, end_time FROM quiet_hours WHERE user_id = ?').all(userId) as {
      workspace_id: string;
      start_time: string;
      end_time: string;
    }[]
  ).map((r) => ({ workspaceId: r.workspace_id, start: r.start_time, end: r.end_time }));
}

export function getQuietHours(userId: string, workspaceId: string): { start: string; end: string } | null {
  const r = db.prepare('SELECT start_time, end_time FROM quiet_hours WHERE user_id = ? AND workspace_id = ?').get(userId, workspaceId) as
    | { start_time: string; end_time: string }
    | undefined;
  return r ? { start: r.start_time, end: r.end_time } : null;
}

export function setQuietHours(userId: string, workspaceId: string, start: unknown, end: unknown): QuietHours {
  requireRole(workspaceId, userId, 'viewer');
  if (!isHHmm(start) || !isHHmm(end)) throw new HttpError(400, 'start and end must be HH:mm');
  db.prepare(
    `INSERT INTO quiet_hours (user_id, workspace_id, start_time, end_time, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, workspace_id) DO UPDATE SET start_time = excluded.start_time, end_time = excluded.end_time, updated_at = excluded.updated_at`,
  ).run(userId, workspaceId, start, end, now());
  return { workspaceId, start, end };
}

export function clearQuietHours(userId: string, workspaceId: string) {
  requireRole(workspaceId, userId, 'viewer');
  db.prepare('DELETE FROM quiet_hours WHERE user_id = ? AND workspace_id = ?').run(userId, workspaceId);
}
