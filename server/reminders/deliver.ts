// Idempotent delivery: each (notice key, channel, target) is claimed in
// notification_log before sending. A claim that already exists — sent, failed
// or interrupted by a crash — is never sent again, so restarts, catch-up and
// overlapping ticks can't produce duplicates (at-most-once per target).
import { db, now } from '../db.ts';
import { TargetGoneError, type DeliveryChannel, type Notice } from './channels.ts';

export interface DeliveryReport {
  sent: number;
  failed: number;
  skipped: number;
}

const claim = db.prepare(
  `INSERT INTO notification_log (key, channel, target, status, created_at) VALUES (?, ?, ?, 'pending', ?)
   ON CONFLICT DO NOTHING`,
);
const settle = db.prepare('UPDATE notification_log SET status = ?, error = ? WHERE key = ? AND channel = ? AND target = ?');

export async function deliver(notice: Notice, channels: DeliveryChannel[], nowIso = now()): Promise<DeliveryReport> {
  const report: DeliveryReport = { sent: 0, failed: 0, skipped: 0 };
  const jobs: Promise<void>[] = [];
  for (const ch of channels) {
    if (notice.channels && !notice.channels.includes(ch.name)) continue;
    if (!ch.available()) {
      report.skipped++;
      continue;
    }
    for (const target of ch.targets(notice.userId)) {
      if (!claim.run(notice.key, ch.name, target, nowIso).changes) {
        report.skipped++; // already delivered (or attempted)
        continue;
      }
      jobs.push(
        ch.send(target, notice).then(
          () => {
            settle.run('sent', null, notice.key, ch.name, target);
            report.sent++;
          },
          (e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            settle.run('failed', msg.slice(0, 500), notice.key, ch.name, target);
            report.failed++;
            if (e instanceof TargetGoneError) ch.forget?.(target);
            else console.warn(`Reminder delivery via ${ch.name} failed: ${msg}`);
          },
        ),
      );
    }
  }
  await Promise.all(jobs);
  return report;
}

/** Old log rows only matter for de-duplication within the catch-up window. */
export function pruneNotificationLog(olderThanMs = 30 * 864e5, nowMs = Date.now()) {
  db.prepare('DELETE FROM notification_log WHERE created_at < ?').run(new Date(nowMs - olderThanMs).toISOString());
}
