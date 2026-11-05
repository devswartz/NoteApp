// Per-user notification settings (notification_settings; a missing row = defaults).
import { db, now } from '../db.ts';
import { HttpError } from '../access.ts';
import { isHHmm, isValidTimeZone } from '../../shared/recurrence.ts';
import type { NotificationSettings } from '../../shared/types.ts';

export const DEFAULT_SETTINGS: NotificationSettings = {
  timeZone: 'UTC',
  emailEnabled: true,
  defaultReminderTime: '09:00',
  digestEnabled: false,
  digestTime: '08:00',
};

interface Row {
  time_zone: string;
  email_enabled: number;
  default_reminder_time: string;
  digest_enabled: number;
  digest_time: string;
}

export function getSettings(userId: string): NotificationSettings {
  const r = db.prepare('SELECT * FROM notification_settings WHERE user_id = ?').get(userId) as Row | undefined;
  if (!r) return { ...DEFAULT_SETTINGS };
  return {
    timeZone: isValidTimeZone(r.time_zone) ? r.time_zone : 'UTC',
    emailEnabled: !!r.email_enabled,
    defaultReminderTime: r.default_reminder_time,
    digestEnabled: !!r.digest_enabled,
    digestTime: r.digest_time,
  };
}

export function updateSettings(userId: string, patch: Partial<NotificationSettings>): NotificationSettings {
  const s = { ...getSettings(userId) };
  if (patch.timeZone !== undefined) {
    if (!isValidTimeZone(patch.timeZone)) throw new HttpError(400, 'Invalid time zone');
    s.timeZone = patch.timeZone;
  }
  for (const k of ['emailEnabled', 'digestEnabled'] as const) {
    if (patch[k] === undefined) continue;
    if (typeof patch[k] !== 'boolean') throw new HttpError(400, `Invalid ${k}`);
    s[k] = patch[k];
  }
  for (const k of ['defaultReminderTime', 'digestTime'] as const) {
    if (patch[k] === undefined) continue;
    if (!isHHmm(patch[k])) throw new HttpError(400, `Invalid ${k}`);
    s[k] = patch[k];
  }
  db.prepare(
    `INSERT INTO notification_settings (user_id, time_zone, email_enabled, default_reminder_time, digest_enabled, digest_time, updated_at)
     VALUES (@userId, @timeZone, @emailEnabled, @defaultReminderTime, @digestEnabled, @digestTime, @ts)
     ON CONFLICT (user_id) DO UPDATE SET time_zone = @timeZone, email_enabled = @emailEnabled,
       default_reminder_time = @defaultReminderTime, digest_enabled = @digestEnabled, digest_time = @digestTime, updated_at = @ts`,
  ).run({ userId, ...s, emailEnabled: s.emailEnabled ? 1 : 0, digestEnabled: s.digestEnabled ? 1 : 0, ts: now() });
  // Reminder times depend on the time zone and default time: recompute this user's.
  db.prepare("UPDATE task_reminders SET synced_at = '' WHERE user_id = ?").run(userId);
  return s;
}
