-- Reminders, push subscriptions and notification settings (owner: Recurrence & Reminders).

-- One row per user; missing row = defaults.
CREATE TABLE notification_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  time_zone TEXT NOT NULL DEFAULT 'UTC',
  email_enabled INTEGER NOT NULL DEFAULT 1,
  default_reminder_time TEXT NOT NULL DEFAULT '09:00',
  digest_enabled INTEGER NOT NULL DEFAULT 0,
  digest_time TEXT NOT NULL DEFAULT '08:00',
  updated_at TEXT NOT NULL
);

-- Reminders per task and recipient. kind:
--   'at'     fixed instant in `at`
--   'before' `minutes` before the task is due
--   'legacy' mirrors tasks.reminder_at (one row per task, id = task id)
-- next_fire_at is recomputed by the scheduler whenever the task changes
-- (tasks.updated_at > synced_at), so it survives restarts.
CREATE TABLE task_reminders (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('at','before','legacy')),
  at TEXT,
  minutes INTEGER,
  next_fire_at TEXT,
  last_fired_at TEXT,
  synced_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX task_reminders_next ON task_reminders(next_fire_at) WHERE next_fire_at IS NOT NULL;
CREATE INDEX task_reminders_task ON task_reminders(task_id);

-- Web push subscriptions, one per browser/device.
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_success_at TEXT
);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);

-- Delivery log: makes sends idempotent. key identifies one firing
-- ("reminder:<id>:<fireAt>", "digest:<userId>:<date>"); a (key, channel, target)
-- that already exists is never sent again, even after a crash or restart.
CREATE TABLE notification_log (
  key TEXT NOT NULL,
  channel TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sent','failed','skipped')),
  error TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (key, channel, target)
);

-- Single-purpose tokens carried by notifications, e.g. "snooze" from a push
-- notification (the service worker has no access token). Only a hash is stored.
CREATE TABLE action_tokens (
  token_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX action_tokens_expiry ON action_tokens(expires_at);

-- Quiet hours per user and workspace: reminders for that workspace's tasks
-- that come due inside the window are held until it ends (HH:mm, local time;
-- start > end wraps past midnight).
CREATE TABLE quiet_hours (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);

-- Private iCalendar feed per user (/api/calendar/<token>.ics). Only a hash of the token is stored.
CREATE TABLE calendar_feeds (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- Native push tokens (Phase 3 mobile app): APNs device tokens (ios) and FCM registration tokens (android).
CREATE TABLE device_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('ios','android')),
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_success_at TEXT
);
CREATE INDEX device_tokens_user ON device_tokens(user_id, platform);
