// In-process reminder scheduler (no extra services).
//
// Every tick (default 20 s) it:
//   1. syncs reminders with their tasks (store.ts → next_fire_at),
//   2. claims reminders whose next_fire_at has passed, atomically, and delivers
//      them through every available channel (deliver.ts, idempotent),
//   3. sends daily digests that are due.
// State lives in SQLite, so after a restart the first tick catches up on
// anything that came due while the server was down, as long as it is within
// the catch-up window (12 h). Older ones are dropped rather than sent late.
import { db } from '../db.ts';
import { TASK_VISIBLE } from '../access.ts';
import { syncReminders } from './store.ts';
import { deliver, pruneNotificationLog } from './deliver.ts';
import { dueDigests } from './digest.ts';
import { emailChannel } from './email.ts';
import { mailEnabled } from '../mail.ts';
import { vapidPublicKey, webPushChannel } from './push.ts';
import type { DeliveryChannel, Notice } from './channels.ts';

export const CATCH_UP_MS = 12 * 3600_000;

export function defaultChannels(): DeliveryChannel[] {
  return [webPushChannel(), emailChannel()];
}

export interface SchedulerOptions {
  now?: () => number;
  channels?: DeliveryChannel[];
  intervalMs?: number;
  catchUpMs?: number;
}

export interface TickReport {
  fired: number;
  missed: number;
  digests: number;
  sent: number;
  failed: number;
}

interface DueRow {
  id: string;
  task_id: string;
  user_id: string;
  next_fire_at: string;
  title: string;
  workspace_id: string;
  page_id: string | null;
  due_date: string | null;
  due_time: string | null;
}

export class ReminderScheduler {
  private now: () => number;
  private channels: DeliveryChannel[];
  private intervalMs: number;
  private catchUpMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<TickReport> | null = null;
  private lastPrune = 0;

  constructor(opts: SchedulerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.channels = opts.channels ?? defaultChannels();
    this.intervalMs = opts.intervalMs ?? 20_000;
    this.catchUpMs = opts.catchUpMs ?? CATCH_UP_MS;
  }

  /** One pass. Concurrent calls share the pass in progress. */
  tick(): Promise<TickReport> {
    this.running ??= this.run().finally(() => (this.running = null));
    return this.running;
  }

  private async run(): Promise<TickReport> {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const report: TickReport = { fired: 0, missed: 0, digests: 0, sent: 0, failed: 0 };
    syncReminders(nowIso);

    const due = db
      .prepare(
        `SELECT r.id, r.task_id, r.user_id, r.next_fire_at, t.title, t.workspace_id, t.page_id, t.due_date, t.due_time
         FROM task_reminders r JOIN tasks t ON t.id = r.task_id
         WHERE r.next_fire_at IS NOT NULL AND r.next_fire_at <= ? ORDER BY r.next_fire_at LIMIT 500`,
      )
      .all(nowIso) as DueRow[];
    const claim = db.prepare('UPDATE task_reminders SET last_fired_at = next_fire_at, next_fire_at = NULL WHERE id = ? AND next_fire_at = ?');
    const visible = db.prepare(`SELECT 1 FROM tasks t WHERE t.id = @taskId AND ${TASK_VISIBLE}`);
    const notices: Notice[] = [];
    for (const r of due) {
      if (!claim.run(r.id, r.next_fire_at).changes) continue; // taken by another pass
      if (nowMs - Date.parse(r.next_fire_at) > this.catchUpMs) {
        report.missed++;
        continue;
      }
      if (!visible.get({ taskId: r.task_id, userId: r.user_id })) continue; // lost access
      report.fired++;
      notices.push(reminderNotice(r));
    }
    for (const n of dueDigests(nowMs, this.catchUpMs)) {
      report.digests++;
      notices.push(n);
    }
    for (const n of notices) {
      const d = await deliver(n, this.channels, nowIso);
      report.sent += d.sent;
      report.failed += d.failed;
    }
    if (nowMs - this.lastPrune > 6 * 3600_000) {
      this.lastPrune = nowMs;
      pruneNotificationLog(30 * 864e5, nowMs);
    }
    return report;
  }

  start() {
    const schedule = (ms: number) => {
      this.timer = setTimeout(loop, ms);
      this.timer.unref?.();
    };
    const loop = () => {
      this.tick()
        .catch((e) => console.error('Reminder scheduler tick failed', e))
        .finally(() => {
          if (this.timer) schedule(this.intervalMs); // null after stop()
        });
    };
    schedule(1000);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

function reminderNotice(r: DueRow): Notice {
  let body = 'Reminder';
  if (r.due_date) body = `Due ${r.due_date}${r.due_time ? ` at ${r.due_time}` : ''}`;
  const path = r.page_id ? `/w/${r.workspace_id}/p/${r.page_id}?task=${r.task_id}` : `/w/${r.workspace_id}/tasks/today?task=${r.task_id}`;
  return {
    key: `reminder:${r.id}:${r.next_fire_at}`,
    userId: r.user_id,
    title: r.title || 'Task reminder',
    body,
    path,
    taskId: r.task_id,
    tag: `task-${r.task_id}`,
  };
}

let instance: ReminderScheduler | null = null;

/** Called from server/index.ts. Returns a stop function. */
export function startReminderScheduler(opts?: SchedulerOptions): () => void {
  if (!vapidPublicKey()) console.warn('Web push is disabled (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set)');
  if (!mailEnabled()) console.warn('Reminder email is disabled (SMTP_HOST / MAIL_FROM not set)');
  instance = new ReminderScheduler(opts);
  instance.start();
  return () => instance?.stop();
}

/** Runs a pass now (e.g. after a reminder is created); no-op if the scheduler isn't running. */
export function pokeScheduler() {
  void instance?.tick().catch(() => {});
}
