// Comment threads on text selections: the `comment` mark, a small store for
// the open page's threads, and the actions the editor UI calls.
// Owner: Collaboration & Access.
//
// Flow: beginComment(editor, pageId) marks the selection with a fresh thread
// id (so the anchor follows concurrent edits) and opens the composer; on
// submit the thread is created on the server; on cancel the mark is removed.
// Mark styling comes from <CommentHighlights/> (collabCommentsPanel.tsx), so
// resolved/deleted threads stop being highlighted without touching the doc.
import { Mark, mergeAttributes, type Editor } from '@tiptap/core';
import { create } from 'zustand';
import { del, get, patch, post } from '../api.ts';
import { errorToast } from '../store.ts';
import type { CommentThread } from '../../shared/types.ts';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    comment: {
      /** Mark the current selection as anchored to `threadId`. */
      setComment: (threadId: string) => ReturnType;
      /** Remove every anchor of `threadId` from the document. */
      unsetComment: (threadId: string) => ReturnType;
    };
  }
}

export const CommentMark = Mark.create({
  name: 'comment',
  inclusive: false,
  excludes: '', // overlapping threads are allowed
  addAttributes() {
    return {
      threadId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-thread-id'),
        renderHTML: (attrs) => (attrs.threadId ? { 'data-thread-id': attrs.threadId } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-thread-id]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'comment-anchor' }), 0];
  },
  addCommands() {
    return {
      setComment:
        (threadId) =>
        ({ commands }) =>
          commands.setMark(this.name, { threadId }),
      unsetComment:
        (threadId) =>
        ({ tr, state, dispatch }) => {
          const type = state.schema.marks[this.name];
          state.doc.descendants((node, pos) => {
            for (const m of node.marks)
              if (m.type === type && m.attrs.threadId === threadId) tr.removeMark(pos, pos + node.nodeSize, m);
          });
          if (dispatch) dispatch(tr);
          return true;
        },
    };
  },
});

// ───────────── Store ─────────────

export interface PendingComment {
  threadId: string;
  quote: string;
}

interface CommentsState {
  pageId: string | null;
  threads: CommentThread[];
  loaded: boolean;
  /** The thread being composed (marked in the doc but not yet saved). */
  pending: PendingComment | null;
  /** Thread highlighted in the doc and the panel. */
  activeId: string | null;
  showResolved: boolean;
}

export const useComments = create<CommentsState>(() => ({
  pageId: null,
  threads: [],
  loaded: false,
  pending: null,
  activeId: null,
  showResolved: false,
}));
const set = useComments.setState;
const st = useComments.getState;

let editorRef: Editor | null = null;
/** The page editor registers itself so thread actions can update anchors. */
export function bindCommentEditor(editor: Editor | null) {
  editorRef = editor;
}

export async function loadComments(pageId: string) {
  if (st().pageId !== pageId) set({ pageId, threads: [], loaded: false, pending: null, activeId: null });
  try {
    const threads = await get<CommentThread[]>(`/pages/${pageId}/comments`);
    if (st().pageId === pageId) set({ threads, loaded: true });
  } catch (e) {
    errorToast(e);
  }
}

/** Live event: comments on `pageId` changed somewhere. */
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
export function commentsChanged(pageId: string) {
  if (st().pageId !== pageId) return;
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => void loadComments(pageId), 150);
}

export function closeComments() {
  set({ pageId: null, threads: [], loaded: false, pending: null, activeId: null });
}

/** Start a comment on the editor's current selection. Returns false if nothing is selected. */
export function beginComment(editor: Editor): boolean {
  const { from, to, empty } = editor.state.selection;
  if (empty) return false;
  cancelComment();
  const threadId = crypto.randomUUID();
  const quote = editor.state.doc.textBetween(from, to, ' ').slice(0, 500);
  editor.chain().focus().setComment(threadId).run();
  set({ pending: { threadId, quote }, activeId: threadId });
  return true;
}

export function cancelComment() {
  const p = st().pending;
  if (!p) return;
  editorRef?.commands.unsetComment(p.threadId);
  set({ pending: null, activeId: st().activeId === p.threadId ? null : st().activeId });
}

export async function submitComment(body: string) {
  const { pending, pageId } = st();
  if (!pending || !pageId || !body.trim()) return;
  try {
    const t = await post<CommentThread>(`/pages/${pageId}/comments`, { threadId: pending.threadId, quote: pending.quote, body });
    set({ pending: null, threads: [...st().threads.filter((x) => x.id !== t.id), t], activeId: t.id });
  } catch (e) {
    errorToast(e);
  }
}

const upsert = (t: CommentThread) => set({ threads: st().threads.map((x) => (x.id === t.id ? t : x)) });

export async function replyTo(threadId: string, body: string) {
  if (!body.trim()) return;
  try {
    upsert(await post<CommentThread>(`/comment-threads/${threadId}/replies`, { body }));
  } catch (e) {
    errorToast(e);
  }
}

export async function setResolved(threadId: string, resolved: boolean) {
  try {
    upsert(await patch<CommentThread>(`/comment-threads/${threadId}`, { resolved }));
    if (resolved && st().activeId === threadId) set({ activeId: null });
  } catch (e) {
    errorToast(e);
  }
}

export async function deleteThread(threadId: string) {
  try {
    await del(`/comment-threads/${threadId}`);
    editorRef?.commands.unsetComment(threadId);
    set({ threads: st().threads.filter((t) => t.id !== threadId) });
  } catch (e) {
    errorToast(e);
  }
}

export async function editComment(commentId: string, body: string) {
  try {
    upsert(await patch<CommentThread>(`/comments/${commentId}`, { body }));
  } catch (e) {
    errorToast(e);
  }
}

export async function deleteComment(threadId: string, commentId: string) {
  try {
    const r = await del<{ threadDeleted: boolean }>(`/comments/${commentId}`);
    if (r.threadDeleted) {
      editorRef?.commands.unsetComment(threadId);
      set({ threads: st().threads.filter((t) => t.id !== threadId) });
    } else await loadComments(st().pageId!);
  } catch (e) {
    errorToast(e);
  }
}

/** Select a thread: highlight it and scroll its anchor into view. */
export function focusThread(threadId: string | null) {
  set({ activeId: threadId });
  if (!threadId || typeof document === 'undefined') return;
  const el = document.querySelector(`.ProseMirror [data-thread-id="${CSS.escape(threadId)}"]`);
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/** The thread whose anchor contains the editor's cursor, if any (to open it on click). */
export function threadAtSelection(editor: Editor): string | null {
  const type = editor.state.schema.marks.comment;
  if (!type) return null;
  const marks = editor.state.selection.$from.marks();
  const m = marks.find((x) => x.type === type);
  return (m?.attrs.threadId as string) ?? null;
}
