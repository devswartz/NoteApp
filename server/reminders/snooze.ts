// Snooze from a push notification. The service worker has no access token,
// so each reminder push carries a random action token (stored hashed, valid
// 7 days, scoped to one user and task). POST /api/reminders/snooze with it
// sets (or moves) one snooze reminder per user and task.
import crypto from 'node:crypto';
import { db, now } from '../db.ts';
import { HttpError, TASK_VISIBLE } from '../access.ts';
import { addDays, todayIn, zonedTimeToUtc } from '../../shared/recurrence.ts';
import { getSettings } from './settings.ts';
import { syncReminders } from './store.ts';

export const SNOOZE_OPTIONS = ['10m', '1h', 'tomorrow'] as const;
export type SnoozeOption = (typeof SNOOZE_OPTIONS)[number];
const TOKEN_TTL_MS = 7 * 864e5;

const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

export function createSnoozeToken(userId: string, taskId: string, nowMs = Date.now()): string {
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare(
    `INSERT INTO action_tokens (token_hash, purpose, user_id, task_id, expires_at, created_at) VALUES (?, 'snooze', ?, ?, ?, ?)`,
  ).run(hash(token), userId, taskId, new Date(nowMs + TOKEN_TTL_MS).toISOString(), new Date(nowMs).toISOString());
  return token;
}

export const snoozeReminderId = (userId: string, taskId: string) => `snooze-${userId}-${taskId}`;

/** When a snooze option fires: +10 min, +1 h, or tomorrow at the default reminder time. */
export function snoozeUntil(option: SnoozeOption, userId: string, nowMs = Date.now()): Date {
  if (option === '10m') return new Date(nowMs + 10 * 60_000);
  if (option === '1h') return new Date(nowMs + 3600_000);
  const s = getSettings(userId);
  return zonedTimeToUtc(addDays(todayIn(s.timeZone, nowMs), 1), s.defaultReminderTime, s.timeZone);
}

export function snooze(token: unknown, option: unknown, nowMs = Date.now()): { taskId: string; until: string } {
  if (typeof token !== 'string' || token.length > 100) throw new HttpError(400, 'Invalid token');
  if (!SNOOZE_OPTIONS.includes(option as SnoozeOption)) throw new HttpError(400, 'Invalid snooze option');
  const row = db
    .prepare(`SELECT user_id, task_id, expires_at FROM action_tokens WHERE token_hash = ? AND purpose = 'snooze'`)
    .get(hash(token)) as { user_id: string; task_id: string; expires_at: string } | undefined;
  if (!row || Date.parse(row.expires_at) < nowMs) throw new HttpError(404, 'This notification has expired');
  if (!db.prepare(`SELECT 1 FROM tasks t WHERE t.id = @taskId AND t.status = 'open' AND ${TASK_VISIBLE}`).get({ taskId: row.task_id, userId: row.user_id }))
    throw new HttpError(404, 'Task not found');
  const until = snoozeUntil(option as SnoozeOption, row.user_id, nowMs).toISOString();
  const id = snoozeReminderId(row.user_id, row.task_id);
  db.prepare(
    `INSERT INTO task_reminders (id, task_id, user_id, kind, at, synced_at, created_at) VALUES (@id, @taskId, @userId, 'at', @until, '', @ts)
     ON CONFLICT (id) DO UPDATE SET at = @until, last_fired_at = NULL, next_fire_at = NULL, synced_at = ''`,
  ).run({ id, taskId: row.task_id, userId: row.user_id, until, ts: now() });
  syncReminders();
  return { taskId: row.task_id, until };
}

export function pruneActionTokens(nowMs = Date.now()) {
  db.prepare('DELETE FROM action_tokens WHERE expires_at < ?').run(new Date(nowMs).toISOString());
}
