// In-app notifications (the bell inbox). Owner: Collaboration & Access.
//
//   import { notify } from './notifications.ts';
//   notify(userId, { kind: 'assigned', workspaceId, actorId, title: 'Sam assigned you “Pay rent”', link: `/w/${ws}/tasks/my` });
//
// Stores one row per recipient and pushes a live `notification` event to them.
// Never notifies people about their own actions. Other areas (Tasks,
// Reminders) can call notify() directly.
import { db, newId, now } from './db.ts';
import { publish } from './events.ts';
import { pageAccess } from './access.ts';
import { onComment } from './routes/comments.ts';
import { onPageMentions } from './collab.ts';
import type { AppNotification, NotificationKind } from '../shared/types.ts';

export interface NotifyInput {
  kind: NotificationKind;
  workspaceId?: string | null;
  actorId?: string | null;
  title: string;
  body?: string;
  link?: string | null;
  data?: Record<string, unknown> | null;
}

interface Row {
  id: string;
  kind: NotificationKind;
  workspace_id: string | null;
  actor_id: string | null;
  title: string;
  body: string;
  link: string | null;
  data: string | null;
  created_at: string;
  read_at: string | null;
}

export const rowToNotification = (r: Row): AppNotification => ({
  id: r.id,
  kind: r.kind,
  workspaceId: r.workspace_id,
  actorId: r.actor_id,
  title: r.title,
  body: r.body,
  link: r.link,
  data: r.data ? (JSON.parse(r.data) as Record<string, unknown>) : null,
  createdAt: r.created_at,
  readAt: r.read_at,
});

/** The same (recipient, kind, actor, page/link) within this window is delivered once. */
export const DEDUP_WINDOW_MS = 10 * 60_000;
/** At most this many notifications per recipient per minute; the rest are dropped. */
export const MAX_PER_MINUTE = 20;

/**
 * Notify one user. Returns the notification, or null if skipped: your own action,
 * a duplicate (same kind, actor and page/link within DEDUP_WINDOW_MS, e.g. deleting
 * and re-adding an @mention), or over MAX_PER_MINUTE for this recipient.
 */
export function notify(userId: string, n: NotifyInput): AppNotification | null {
  if (n.actorId && n.actorId === userId) return null;
  const since = (ms: number) => new Date(Date.now() - ms).toISOString();
  const dup = db
    .prepare(
      `SELECT 1 FROM notifications WHERE user_id = ? AND kind = ? AND actor_id IS ? AND COALESCE(link, title) = ? AND created_at > ? LIMIT 1`,
    )
    .get(userId, n.kind, n.actorId ?? null, n.link ?? n.title.slice(0, 300), since(DEDUP_WINDOW_MS));
  if (dup) return null;
  const recent = (db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND created_at > ?').get(userId, since(60_000)) as { c: number }).c;
  if (recent >= MAX_PER_MINUTE) return null;
  const row: Row = {
    id: newId(),
    kind: n.kind,
    workspace_id: n.workspaceId ?? null,
    actor_id: n.actorId ?? null,
    title: n.title.slice(0, 300),
    body: (n.body ?? '').slice(0, 1000),
    link: n.link ?? null,
    data: n.data ? JSON.stringify(n.data) : null,
    created_at: now(),
    read_at: null,
  };
  db.prepare(
    `INSERT INTO notifications (id, user_id, workspace_id, kind, actor_id, title, body, link, data, created_at)
     VALUES (@id, @userId, @workspace_id, @kind, @actor_id, @title, @body, @link, @data, @created_at)`,
  ).run({ ...row, userId });
  const notification = rowToNotification(row);
  publish({ type: 'notification', notification }, { userIds: [userId] });
  return notification;
}

export const userName = (id: string | null | undefined) =>
  (id && (db.prepare('SELECT name FROM users WHERE id = ?').get(id) as { name: string } | undefined)?.name) || 'Someone';

// ───────────── Mentions ─────────────
// Comment bodies store mentions as `@[Display Name](userId)`; page documents
// use `mention` nodes with an `id` attribute (src/editor/collabMentions.ts).

const MENTION_RE = /@\[([^\]\n]{1,100})\]\(([0-9a-f-]{36})\)/gi;

/** User ids mentioned in a comment body. */
export function mentionsIn(text: string): Set<string> {
  const ids = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) ids.add(m[2].toLowerCase());
  return ids;
}

/** Comment body as plain text (mentions become "@Name"), for notification previews. */
export const plainMentions = (text: string) => text.replace(MENTION_RE, '@$1');

const pageTitle = (pageId: string) =>
  (db.prepare('SELECT title FROM pages WHERE id = ?').get(pageId) as { title: string } | undefined)?.title || 'Untitled';

/** Notify people newly @mentioned on a page (called when a page is saved). Skips people who can't see the page. */
export function notifyPageMentions(pageId: string, workspaceId: string, userIds: Iterable<string>, actorId: string | null) {
  const title = pageTitle(pageId);
  for (const uid of userIds) {
    if (!pageAccess(pageId, uid)) continue;
    notify(uid, {
      kind: 'mention',
      workspaceId,
      actorId,
      title: `${userName(actorId)} mentioned you in “${title}”`,
      link: `/w/${workspaceId}/p/${pageId}`,
      data: { pageId },
    });
  }
}

// New comments: notify people mentioned, and others in the thread (participants).
onComment(({ thread, comment, actorId }) => {
  const title = pageTitle(thread.pageId);
  const link = `/w/${thread.workspaceId}/p/${thread.pageId}`;
  const data = { pageId: thread.pageId, threadId: thread.id, commentId: comment.id };
  const preview = plainMentions(comment.body);
  const mentioned = mentionsIn(comment.body);
  const done = new Set<string>([actorId]);
  for (const uid of mentioned) {
    if (done.has(uid) || !pageAccess(thread.pageId, uid)) continue;
    done.add(uid);
    notify(uid, { kind: 'mention', workspaceId: thread.workspaceId, actorId, title: `${userName(actorId)} mentioned you in a comment on “${title}”`, body: preview, link, data });
  }
  const participants = new Set([thread.createdBy, ...thread.comments.map((c) => c.authorId)]);
  for (const uid of participants) {
    if (done.has(uid) || !pageAccess(thread.pageId, uid)) continue;
    done.add(uid);
    notify(uid, { kind: 'comment', workspaceId: thread.workspaceId, actorId, title: `${userName(actorId)} replied on “${title}”`, body: preview, link, data });
  }
});

onPageMentions((pageId, workspaceId, userIds, actorId) => notifyPageMentions(pageId, workspaceId, userIds, actorId));
