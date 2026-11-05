// Comment threads on text selections in pages. Owner: Collaboration & Access.
//
// A thread is anchored in the page's Yjs document by a `comment` mark whose
// `threadId` attribute is the thread id (src/editor/collabComments.ts). The
// client picks the id, creates the thread here, then adds the mark, so the
// mark never points at a missing thread; retrying the create is idempotent.
// Viewers can read comments; members and up can comment and resolve.
import { Router } from 'express';
import { db, newId, now } from '../db.ts';
import { mustAccess, pageAccess, roleIn, atLeast } from '../access.ts';
import { publish } from '../events.ts';
import { HttpError, h, param, str } from '../http.ts';
import type { Comment, CommentThread } from '../../shared/types.ts';

export const commentRoutes = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BODY_MAX = 10_000;

interface ThreadRow {
  id: string;
  page_id: string;
  workspace_id: string;
  quote: string;
  created_by: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

const COMMENT_COLS = 'id, thread_id AS threadId, author_id AS authorId, body, created_at AS createdAt, edited_at AS editedAt';

function toThread(r: ThreadRow, comments: Comment[]): CommentThread {
  return {
    id: r.id,
    pageId: r.page_id,
    workspaceId: r.workspace_id,
    quote: r.quote,
    createdBy: r.created_by,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by,
    comments,
  };
}

export function getThread(id: string): CommentThread | null {
  const r = db.prepare('SELECT * FROM comment_threads WHERE id = ?').get(id) as ThreadRow | undefined;
  if (!r) return null;
  return toThread(r, db.prepare(`SELECT ${COMMENT_COLS} FROM comments WHERE thread_id = ? ORDER BY created_at, rowid`).all(id) as Comment[]);
}

/** The thread plus the caller's access to its page (404 if they can't see it). */
function threadFor(id: string, userId: string, edit: boolean) {
  const t = getThread(id);
  if (!t) throw new HttpError(404, 'Comment not found');
  const a = mustAccess(pageAccess(t.pageId, userId), false);
  if (edit && !a.canEdit) throw new HttpError(403, 'You have view-only access');
  return { t, a };
}

function changed(t: { workspaceId: string; pageId: string }) {
  publish({ type: 'comments', workspaceId: t.workspaceId, pageId: t.pageId });
}

commentRoutes.get(
  '/pages/:id/comments',
  h((req) => {
    const pageId = param(req, 'id');
    mustAccess(pageAccess(pageId, req.user.id));
    const threads = db.prepare('SELECT * FROM comment_threads WHERE page_id = ? ORDER BY created_at').all(pageId) as ThreadRow[];
    const comments = db
      .prepare(
        `SELECT ${COMMENT_COLS} FROM comments WHERE thread_id IN (SELECT id FROM comment_threads WHERE page_id = ?) ORDER BY created_at, rowid`,
      )
      .all(pageId) as Comment[];
    const by = new Map<string, Comment[]>();
    for (const c of comments) by.set(c.threadId, [...(by.get(c.threadId) ?? []), c]);
    return threads.map((t) => toThread(t, by.get(t.id) ?? []));
  }),
);

// Start a thread: { threadId (client-chosen UUID), quote, body }.
commentRoutes.post(
  '/pages/:id/comments',
  h((req) => {
    const pageId = param(req, 'id');
    const a = mustAccess(pageAccess(pageId, req.user.id), true);
    const threadId = req.body.threadId ?? newId();
    if (typeof threadId !== 'string' || !UUID_RE.test(threadId)) throw new HttpError(400, 'Invalid threadId');
    const body = str(req.body.body, 'Comment', BODY_MAX);
    const quote = typeof req.body.quote === 'string' ? req.body.quote.slice(0, 500) : '';
    const existing = getThread(threadId);
    if (existing) {
      if (existing.pageId !== pageId || existing.createdBy !== req.user.id) throw new HttpError(409, 'Thread id already used');
      return existing; // retried create
    }
    const ts = now();
    db.transaction(() => {
      db.prepare('INSERT INTO comment_threads (id, workspace_id, page_id, quote, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        threadId,
        a.workspaceId,
        pageId,
        quote,
        req.user.id,
        ts,
      );
      db.prepare('INSERT INTO comments (id, thread_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)').run(newId(), threadId, req.user.id, body, ts);
    })();
    const t = getThread(threadId)!;
    changed(t);
    onCommentHooks.forEach((fn) => fn({ thread: t, comment: t.comments[0], actorId: req.user.id }));
    return t;
  }),
);

// Reply: { body }. Replying to a resolved thread reopens it.
commentRoutes.post(
  '/comment-threads/:id/replies',
  h((req) => {
    const { t } = threadFor(param(req, 'id'), req.user.id, true);
    const body = str(req.body.body, 'Comment', BODY_MAX);
    const id = newId();
    db.transaction(() => {
      db.prepare('INSERT INTO comments (id, thread_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)').run(id, t.id, req.user.id, body, now());
      db.prepare('UPDATE comment_threads SET resolved_at = NULL, resolved_by = NULL WHERE id = ?').run(t.id);
    })();
    const out = getThread(t.id)!;
    changed(out);
    onCommentHooks.forEach((fn) => fn({ thread: out, comment: out.comments.find((c) => c.id === id)!, actorId: req.user.id }));
    return out;
  }),
);

// Resolve or reopen: { resolved: boolean }.
commentRoutes.patch(
  '/comment-threads/:id',
  h((req) => {
    const { t } = threadFor(param(req, 'id'), req.user.id, true);
    if (typeof req.body.resolved !== 'boolean') throw new HttpError(400, 'resolved must be true or false');
    if (req.body.resolved) db.prepare('UPDATE comment_threads SET resolved_at = ?, resolved_by = ? WHERE id = ?').run(now(), req.user.id, t.id);
    else db.prepare('UPDATE comment_threads SET resolved_at = NULL, resolved_by = NULL WHERE id = ?').run(t.id);
    const out = getThread(t.id)!;
    changed(out);
    return out;
  }),
);

// Delete a whole thread: its creator or a workspace admin.
commentRoutes.delete(
  '/comment-threads/:id',
  h((req) => {
    const { t, a } = threadFor(param(req, 'id'), req.user.id, true);
    if (t.createdBy !== req.user.id && !atLeast(a.role, 'admin')) throw new HttpError(403, 'Only its author or an admin can delete this thread');
    db.prepare('DELETE FROM comment_threads WHERE id = ?').run(t.id);
    changed(t);
    return { ok: true };
  }),
);

function commentCtx(id: string, userId: string) {
  const c = db.prepare(`SELECT ${COMMENT_COLS} FROM comments WHERE id = ?`).get(id) as Comment | undefined;
  if (!c) throw new HttpError(404, 'Comment not found');
  return { c, ...threadFor(c.threadId, userId, true) };
}

// Edit your own comment: { body }.
commentRoutes.patch(
  '/comments/:id',
  h((req) => {
    const { c, t } = commentCtx(param(req, 'id'), req.user.id);
    if (c.authorId !== req.user.id) throw new HttpError(403, 'You can only edit your own comments');
    db.prepare('UPDATE comments SET body = ?, edited_at = ? WHERE id = ?').run(str(req.body.body, 'Comment', BODY_MAX), now(), c.id);
    const out = getThread(t.id)!;
    changed(out);
    return out;
  }),
);

// Delete one comment (author or admin). Deleting the last one deletes the thread.
commentRoutes.delete(
  '/comments/:id',
  h((req) => {
    const { c, t } = commentCtx(param(req, 'id'), req.user.id);
    if (c.authorId !== req.user.id && !atLeast(roleIn(t.workspaceId, req.user.id), 'admin'))
      throw new HttpError(403, 'Only its author or an admin can delete this comment');
    db.transaction(() => {
      db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
      if (!db.prepare('SELECT 1 FROM comments WHERE thread_id = ?').get(t.id)) db.prepare('DELETE FROM comment_threads WHERE id = ?').run(t.id);
    })();
    changed(t);
    return { ok: true, threadDeleted: !getThread(t.id) };
  }),
);

// ───────────── Hooks ─────────────
// Notifications (mentions, replies) subscribe here rather than this module importing them.
export interface CommentEvent {
  thread: CommentThread;
  comment: Comment;
  actorId: string;
}
const onCommentHooks = new Set<(e: CommentEvent) => void>();
export function onComment(fn: (e: CommentEvent) => void) {
  onCommentHooks.add(fn);
  return () => onCommentHooks.delete(fn);
}
