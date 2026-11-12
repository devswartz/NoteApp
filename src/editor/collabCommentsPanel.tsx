// Comments side panel for a page, plus <CommentHighlights/>, which styles the
// anchors of open threads. Owner: Collaboration & Access.
//
//   <CommentsPanel pageId={pageId} canComment={canEdit} />
//   <CommentHighlights />   // anywhere on the page view
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { Check, MessageSquare, MoreHorizontal, RotateCcw, Trash2 } from 'lucide-react';
import { useStore } from '../store.ts';
import { Avatar } from '../components/ui.tsx';
import { confirmDialog } from '../components/shell/dialogs.tsx';
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
import { matchMembers } from './collabMentions.ts';
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
      <MentionTextarea
        autoFocus
        placeholder="Add a comment… (@ to mention)"
        aria-label="New comment"
        value={body}
        onChange={setBody}
        onSubmit={() => void submit()}
        onCancel={cancelComment}
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
            onClick={async (e) => {
              e.stopPropagation();
              if (await confirmDialog({ title: 'Delete this whole thread?', message: 'The comment and all its replies are removed.', confirmLabel: 'Delete thread', danger: true })) void deleteThread(t.id);
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
                <MentionTextarea aria-label="Edit comment" value={draft} onChange={setDraft} autoFocus onCancel={() => setEditing(null)} />
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
              <CommentBody body={c.body} />
            )}
          </div>
        );
      })}
      {canComment && active && (
        <div onClick={(e) => e.stopPropagation()}>
          <MentionTextarea
            placeholder={t.resolvedAt ? 'Reply to reopen…' : 'Reply… (@ to mention)'}
            aria-label="Reply"
            value={reply}
            onChange={setReply}
            onSubmit={() => reply.trim() && void replyTo(t.id, reply).then(() => setReply(''))}
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

// ───────────── Mentions in comments ─────────────
// Stored as `@[Name](userId)`; the server notifies mentioned people.

const MENTION_RE = /@\[([^\]\n]{1,100})\]\(([0-9a-f-]{36})\)/gi;

/** Comment text with mentions rendered as chips. */
export function CommentBody({ body }: { body: string }) {
  const me = useStore((s) => s.user?.id);
  const parts: (string | { name: string; id: string })[] = [];
  let last = 0;
  for (const m of body.matchAll(MENTION_RE)) {
    parts.push(body.slice(last, m.index));
    parts.push({ name: m[1], id: m[2] });
    last = m.index! + m[0].length;
  }
  parts.push(body.slice(last));
  return (
    <p className="comment-body">
      {parts.map((p, i) =>
        typeof p === 'string' ? (
          p
        ) : (
          <span key={i} className={`mention ${p.id === me ? 'is-me' : ''}`}>
            @{p.name}
          </span>
        ),
      )}
    </p>
  );
}

/** A textarea with "@" autocomplete over workspace members. */
export function MentionTextarea({
  value,
  onChange,
  onSubmit,
  onCancel,
  ...rest
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  onCancel?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  'aria-label': string;
}) {
  const members = useStore((s) => s.members);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<{ q: string; start: number } | null>(null);
  const [index, setIndex] = useState(0);
  const options = query ? matchMembers(members, query.q, 6) : [];

  const detect = (text: string, caret: number) => {
    const m = /(^|\s)@([\w.-]{0,30})$/.exec(text.slice(0, caret));
    setQuery(m ? { q: m[2], start: caret - m[2].length - 1 } : null);
    setIndex(0);
  };
  const insert = (name: string, id: string) => {
    if (!query || !ref.current) return;
    const caret = ref.current.selectionStart;
    const token = `@[${name}](${id}) `;
    const next = value.slice(0, query.start) + token + value.slice(caret);
    onChange(next);
    setQuery(null);
    const pos = query.start + token.length;
    requestAnimationFrame(() => ref.current?.setSelectionRange(pos, pos));
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (query && options.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insert(options[index].name, options[index].id);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setQuery(null);
        return;
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSubmit?.();
    if (e.key === 'Escape') onCancel?.();
  };
  return (
    <div className="mention-textarea">
      <textarea
        ref={ref}
        className="input comment-input"
        {...rest}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          detect(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
      />
      {query && options.length > 0 && (
        <div className="mention-pop mention-pop-inline" role="listbox">
          {options.map((m, i) => (
            <button
              key={m.id}
              type="button"
              className={`mention-item ${i === index ? 'is-active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                insert(m.name, m.id);
              }}
            >
              <span className="mention-dot" style={{ background: m.color }} />
              <span>{m.name}</span>
              <span className="muted small">{m.email}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
