// Comments side panel for a page, plus <CommentHighlights/>, which styles the
// anchors of open threads. Owner: Collaboration & Access.
//
//   <CommentsPanel pageId={pageId} canComment={canEdit} />
//   <CommentHighlights />   // anywhere on the page view
import { useEffect, useMemo, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { Check, MessageSquare, MoreHorizontal, RotateCcw, Trash2 } from 'lucide-react';
import { useStore } from '../store.ts';
import { Avatar } from '../components/ui.tsx';
import {
  cancelComment,
  deleteComment,
  deleteThread,
  editComment,
  focusThread,
  loadComments,
  replyTo,
  setResolved,
  submitComment,
  useComments,
} from './collabComments.ts';
import type { CommentThread } from '../../shared/types.ts';
import './collab.css';

const ago = (iso: string) => formatDistanceToNow(new Date(iso), { addSuffix: true });

/** Styles open threads' anchors (and the active one more strongly); resolved ones look like plain text. */
export function CommentHighlights() {
  const threads = useComments((s) => s.threads);
  const pending = useComments((s) => s.pending);
  const activeId = useComments((s) => s.activeId);
  const css = useMemo(() => {
    const sel = (id: string) => `.ProseMirror [data-thread-id="${id.replace(/[^\w-]/g, '')}"]`;
    const open = threads.filter((t) => !t.resolvedAt).map((t) => t.id);
    if (pending) open.push(pending.threadId);
    const rules = open.length ? `${open.map(sel).join(',')}{background:var(--comment-bg,rgba(250,204,21,.28));border-bottom:2px solid var(--comment-line,rgba(234,179,8,.8));cursor:pointer}` : '';
    const active = activeId ? `${sel(activeId)}{background:var(--comment-bg-active,rgba(250,204,21,.55))}` : '';
    return rules + active;
  }, [threads, pending, activeId]);
  return css ? <style>{css}</style> : null;
}

export function CommentsPanel({ pageId, canComment }: { pageId: string; canComment: boolean }) {
  const { threads, loaded, pending, activeId, showResolved } = useComments();
  useEffect(() => {
    void loadComments(pageId);
  }, [pageId]);
  const open = threads.filter((t) => !t.resolvedAt);
  const resolved = threads.filter((t) => t.resolvedAt);

  return (
    <div className="comments-panel">
      {pending && <Composer quote={pending.quote} />}
      {loaded && !threads.length && !pending && (
        <p className="muted small comments-empty">
          <MessageSquare size={14} /> No comments yet.{canComment ? ' Select text and choose Comment to start a thread.' : ''}
        </p>
      )}
      {open.map((t) => (
        <ThreadCard key={t.id} t={t} active={t.id === activeId} canComment={canComment} />
      ))}
      {resolved.length > 0 && (
        <button className="btn-ghost btn-sm" onClick={() => useComments.setState({ showResolved: !showResolved })}>
          {showResolved ? 'Hide' : 'Show'} {resolved.length} resolved
        </button>
      )}
      {showResolved && resolved.map((t) => <ThreadCard key={t.id} t={t} active={t.id === activeId} canComment={canComment} />)}
    </div>
  );
}

function Composer({ quote }: { quote: string }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    await submitComment(body);
    setBusy(false);
  };
  return (
    <div className="comment-thread is-active">
      <blockquote className="comment-quote">{quote}</blockquote>
      <textarea
        className="input comment-input"
        autoFocus
        placeholder="Add a comment…"
        aria-label="New comment"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
          if (e.key === 'Escape') cancelComment();
        }}
      />
      <div className="row gap-8 comment-actions">
        <button className="btn btn-secondary btn-sm" onClick={cancelComment}>
          Cancel
        </button>
        <button className="btn btn-primary btn-sm" disabled={busy || !body.trim()} onClick={() => void submit()}>
          Comment
        </button>
      </div>
    </div>
  );
}

function ThreadCard({ t, active, canComment }: { t: CommentThread; active: boolean; canComment: boolean }) {
  const me = useStore((s) => s.user!);
  const members = useStore((s) => s.members);
  const role = useStore((s) => s.workspaces.find((w) => w.id === s.wsId)?.role);
  const [reply, setReply] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState<string | null>(null);
  const isAdmin = role === 'owner' || role === 'admin';
  const who = (id: string | null) => members.find((m) => m.id === id);
  const resolver = who(t.resolvedBy);

  return (
    <div className={`comment-thread ${active ? 'is-active' : ''} ${t.resolvedAt ? 'is-resolved' : ''}`} onClick={() => !active && focusThread(t.id)}>
      <div className="row gap-8 comment-thread-head">
        <blockquote className="comment-quote grow" title={t.quote}>
          {t.quote || '(text removed)'}
        </blockquote>
        {canComment && (
          <button
            className="btn-ghost icon-btn"
            title={t.resolvedAt ? 'Reopen' : 'Resolve'}
            aria-label={t.resolvedAt ? 'Reopen thread' : 'Resolve thread'}
            onClick={(e) => {
              e.stopPropagation();
              void setResolved(t.id, !t.resolvedAt);
            }}
          >
            {t.resolvedAt ? <RotateCcw size={15} /> : <Check size={15} />}
          </button>
        )}
        {canComment && (t.createdBy === me.id || isAdmin) && (
          <button
            className="btn-ghost icon-btn"
            title="Delete thread"
            aria-label="Delete thread"
            onClick={(e) => {
              e.stopPropagation();
              if (confirm('Delete this whole thread?')) void deleteThread(t.id);
            }}
          >
            <Trash2 size={15} />
          </button>
        )}
      </div>
      {t.resolvedAt && <div className="muted small">Resolved {resolver ? `by ${resolver.name} ` : ''}{ago(t.resolvedAt)}</div>}
      {t.comments.map((c) => {
        const author = who(c.authorId);
        const mine = c.authorId === me.id;
        return (
          <div key={c.id} className="comment">
            <div className="row gap-8">
              <Avatar user={author ?? { name: 'Former member', color: '#999999' }} size={20} />
              <strong className="small">{author?.name ?? 'Former member'}</strong>
              <span className="muted small grow" title={new Date(c.createdAt).toLocaleString()}>
                {ago(c.createdAt)}
                {c.editedAt ? ' · edited' : ''}
              </span>
              {canComment && (mine || isAdmin) && (
                <button
                  className="btn-ghost icon-btn"
                  aria-label="Comment actions"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenu(menu === c.id ? null : c.id);
                  }}
                >
                  <MoreHorizontal size={14} />
                </button>
              )}
            </div>
            {menu === c.id && (
              <div className="row gap-8 comment-menu">
                {mine && (
                  <button
                    className="btn-ghost btn-sm"
                    onClick={() => {
                      setEditing(c.id);
                      setDraft(c.body);
                      setMenu(null);
                    }}
                  >
                    Edit
                  </button>
                )}
                <button className="btn-ghost btn-sm" onClick={() => void deleteComment(t.id, c.id).then(() => setMenu(null))}>
                  Delete
                </button>
              </div>
            )}
            {editing === c.id ? (
              <div onClick={(e) => e.stopPropagation()}>
                <textarea className="input comment-input" aria-label="Edit comment" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
                <div className="row gap-8 comment-actions">
                  <button className="btn btn-secondary btn-sm" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={!draft.trim()}
                    onClick={() => void editComment(c.id, draft).then(() => setEditing(null))}
                  >
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <p className="comment-body">{c.body}</p>
            )}
          </div>
        );
      })}
      {canComment && active && (
        <div onClick={(e) => e.stopPropagation()}>
          <textarea
            className="input comment-input"
            placeholder={t.resolvedAt ? 'Reply to reopen…' : 'Reply…'}
            aria-label="Reply"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && reply.trim()) void replyTo(t.id, reply).then(() => setReply(''));
            }}
          />
          {reply.trim() && (
            <div className="row gap-8 comment-actions">
              <button className="btn btn-primary btn-sm" onClick={() => void replyTo(t.id, reply).then(() => setReply(''))}>
                Reply
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
