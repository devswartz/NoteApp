// In-app notifications (the bell inbox). Owner: Collaboration & Access.
import { Router } from 'express';
import { db, now } from '../db.ts';
import { rowToNotification } from '../notifications.ts';
import { h, param } from '../http.ts';
import { lockOpen, pageLockedBy } from '../access.ts';
import type { AppNotification } from '../../shared/types.ts';

export const notificationRoutes = Router();

/**
 * A notification about a locked page (server/locks.ts), as `userId` may see it: gone if someone else locked the
 * page; for its owner, without the comment text until this sign-in unlocks.
 */
function lockedView(n: AppNotification, userId: string): AppNotification | null {
  const pageId = typeof n.data?.pageId === 'string' ? n.data.pageId : null;
  const by = pageLockedBy(pageId);
  if (!by) return n;
  if (by !== userId) return null;
  return lockOpen(by, userId) ? n : { ...n, body: '' };
}

// Newest first. ?before=<createdAt> pages back; ?limit= (default 30, max 100).
notificationRoutes.get(
  '/notifications',
  h((req) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const before = typeof req.query.before === 'string' ? req.query.before : '9999';
    const rows = db
      .prepare('SELECT * FROM notifications WHERE user_id = ? AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(req.user.id, before, limit) as Parameters<typeof rowToNotification>[0][];
    const unreadRows = db.prepare('SELECT * FROM notifications WHERE user_id = ? AND read_at IS NULL').all(req.user.id) as Parameters<typeof rowToNotification>[0][];
    const unread = unreadRows.map(rowToNotification).filter((n) => lockedView(n, req.user.id)).length;
    return { items: rows.map(rowToNotification).map((n) => lockedView(n, req.user.id)).filter((n): n is AppNotification => !!n), unread };
  }),
);

notificationRoutes.post(
  '/notifications/:id/read',
  h((req) => {
    db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?').run(now(), param(req, 'id'), req.user.id);
    return { ok: true };
  }),
);

notificationRoutes.post(
  '/notifications/read-all',
  h((req) => {
    db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), req.user.id);
    return { ok: true };
  }),
);
