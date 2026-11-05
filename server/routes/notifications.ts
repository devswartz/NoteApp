// In-app notifications (the bell inbox). Owner: Collaboration & Access.
import { Router } from 'express';
import { db, now } from '../db.ts';
import { rowToNotification } from '../notifications.ts';
import { h, param } from '../http.ts';
import type { AppNotification } from '../../shared/types.ts';

export const notificationRoutes = Router();

// Newest first. ?before=<createdAt> pages back; ?limit= (default 30, max 100).
notificationRoutes.get(
  '/notifications',
  h((req) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const before = typeof req.query.before === 'string' ? req.query.before : '9999';
    const rows = db
      .prepare('SELECT * FROM notifications WHERE user_id = ? AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(req.user.id, before, limit) as Parameters<typeof rowToNotification>[0][];
    const unread = (db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id) as { n: number }).n;
    return { items: rows.map(rowToNotification) as AppNotification[], unread };
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
