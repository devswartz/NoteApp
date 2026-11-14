// "taskRef" — a block node that embeds a live task inside a note.
// The node stores only the task id; the task itself lives in the database and
// the app store, so it stays in sync with the Tasks dashboard everywhere.
import { Extension, Node, mergeAttributes, type Editor } from '@tiptap/core';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, GripVertical, ListChecks, Maximize2, FileX2, Flag } from 'lucide-react';
import { deletedHere, deletedTitles, UNDO_WINDOW_MS } from '../store/tasks.ts';
import { deleteTask, newTaskId, toggleTask, ui, updateTask, useStore, createTask } from '../store.ts';
import { useAnyTask } from '../components/sharing/sharedPages.ts';
import { AssigneeChip, DueChip, PRIORITY_COLORS, PriorityMenu, TaskCheckbox } from '../components/TaskControls.tsx';
import { Dropdown } from '../components/ui.tsx';
import { parseQuickAdd } from '../../shared/quickadd.ts';
import { resolveMember } from '../components/TaskRow.tsx';
import type { Priority, Task, TaskPatch } from '../../shared/types.ts';
import { markCreatedHere } from './undoTasks.ts';
import { canInsertTask, pageIdOf, tasksAllowedOn } from './taskGate.ts';
import { listItemAt } from './smartLists.ts';
import {
  addChecklistToTask,
  convertTransaction,
  exitEmptyLastChild,
  firstLineOfTask,
  indentIntoTask,
  liftOutOfTask,
  shiftTabBlock,
  tabBlock,
  unwrapTask,
} from './taskChildren.ts';

export interface TaskRefOptions {
  pageId: string;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    taskRef: {
      /** Insert a new task (optionally with a title) at the selection. */
      insertTask: (title?: string, patch?: TaskPatch) => ReturnType;
      /** Turn the current line into a task. */
      convertBlockToTask: () => ReturnType;
      /**
       * Turn the current line, or every line in the selection, into tasks.
       * Lines in bullet/numbered/check lists are flattened; checked items become done tasks;
       * images, tables, code and other non-text blocks in the selection are kept as they are.
       * Use `convertToTasks(editor)` to also get the new task ids.
       */
      convertToTask: () => ReturnType;
    };
  }
}

/** Task ids that should grab focus when their node view mounts. */
let pendingFocus: string | null = null;
/** Tasks created empty in this session: natural-language parsing applies to their first title. */
const freshTasks = new Set<string>();

function newTask(pageId: string, title = '', patch: TaskPatch = {}): string {
  const id = newTaskId();
  markCreatedHere(id);
  const me = useStore.getState().user?.id ?? null;
  if (!title) freshTasks.add(id);
  const { status, ...rest } = patch;
  const created = createTask({ id, title, pageId, assigneeId: me, ...rest });
  // Creation always starts open; a checked checklist item becomes a completed task.
  if (status === 'done') void created.then((t) => t && toggleTask(id));
  return id;
}

/**
 * A new task like `taskId` (same title, assignee, dates, priority, tags and status), for a box pasted
 * onto `pageId`. Null when the task isn't known here (the reference is kept as it was).
 */
export function cloneTask(pageId: string, taskId: string): string | null {
  const src = useStore.getState().tasks[taskId];
  if (!src) return null;
  const { title, description, status, priority, dueDate, dueTime, recurrence, assigneeId, teamId, tagIds } = src;
  return newTask(pageId, title, { description, status, priority, dueDate, dueTime, recurrence, assigneeId, teamId, tagIds });
}

export const TaskRef = Node.create<TaskRefOptions>({
  name: 'taskRef',
  group: 'block',
  // The task's notes: bullets, numbered lists, paragraphs and nested task blocks (its subtasks), indented under it
  // like the lines under a OneNote To Do tag (./taskChildren.ts). Optional, so a page saved before notes existed
  // loads as it was; an older app that doesn't know about them keeps them in the shared doc (it only hides them).
  content: 'block*',
  // Typing, Backspace and Delete never merge a line into or out of a task by accident: Tab / Shift+Tab move lines.
  isolating: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return { pageId: '' };
  },

  addAttributes() {
    return {
      taskId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-task-id'),
        renderHTML: (attrs) => ({ 'data-task-id': attrs.taskId }),
      },
    };
  },

  parseHTML() {
    // The notes are in their own element; anything else inside (a copied task's "[ ] title" line) is not content.
    return [
      {
        tag: 'div[data-type="task-ref"]',
        contentElement: (dom: HTMLElement) => dom.querySelector(':scope > [data-task-children]') ?? dom.ownerDocument.createElement('div'),
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'task-ref' }), ['div', { 'data-task-children': '' }, 0]];
  },

  // Markdown export: a checklist line with the live task's state, due date and priority; its notes indented under it.
  renderMarkdown(node, h) {
    const t = useStore.getState().tasks[node.attrs?.taskId as string];
    const kids = (node.content ?? []).map((c) => h.renderChildren([c])).join('\n').trim();
    if (!t) return kids; // never lose the notes, even when the task can't be shown
    const extras = [t.dueDate ? `📅 ${t.dueDate}${t.dueTime ? ` ${t.dueTime}` : ''}` : '', t.priority < 4 ? `p${t.priority}` : ''].filter(Boolean).join(' ');
    const line = `- [${t.status === 'done' ? 'x' : ' '}] ${t.title}${extras ? ` ${extras}` : ''}`;
    return kids ? `${line}\n${kids.replace(/^(?=.)/gm, '  ')}` : line;
  },

  // Plain-text clipboard / export: the task's line (when the range starts at or before it), then its notes in the range.
  renderText(props) {
    // Tiptap passes the range being serialised (getTextBetween), though its type doesn't say so.
    const { node, pos, range } = props as typeof props & { range?: { from: number; to: number } };
    return taskText(node, pos, range);
  },

  addNodeView() {
    return ReactNodeViewRenderer(TaskRefView, {
      // The task line's own inputs and buttons handle their events; the notes under it are ordinary editor content.
      stopEvent: ({ event }) => {
        const el = event.target as HTMLElement | null;
        if (!el || event.type === 'dragstart') return false;
        if (el.closest('.popover')) return true;
        return !!el.closest('.task-ref-inner') && !!el.closest('input, textarea, button, a');
      },
    });
  },

  addCommands() {
    return {
      insertTask:
        (title = '', patch = {}) =>
        ({ chain }) => {
          if (!tasksAllowedOn(this.options.pageId)) return false;
          const id = newTask(this.options.pageId, title, patch);
          pendingFocus = id;
          return chain().insertContent({ type: this.name, attrs: { taskId: id } }).run();
        },
      // Both run after the current transaction (they create tasks and may lift list items,
      // which takes several steps); see convertToTasks() for a synchronous version.
      convertToTask:
        () =>
        ({ editor, dispatch }) => {
          if (!canConvert(editor)) return false;
          if (dispatch) queueMicrotask(() => convertToTasks(editor));
          return true;
        },
      convertBlockToTask:
        () =>
        ({ editor, dispatch }) => {
          if (!canConvert(editor)) return false;
          if (dispatch) queueMicrotask(() => convertLine(editor));
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Enter': () => convertToTasks(this.editor).length > 0 || canConvert(this.editor),
    };
  },

  addExtensions() {
    return [TaskChildrenKeys];
  },
});

/** "[ ] title" / "[x] title" of a task id, from the live task. */
const taskLineText = (id: string) => {
  const t = useStore.getState().tasks[id];
  return `[${t?.status === 'done' ? 'x' : ' '}] ${t?.title ?? ''}`;
};

/** Plain text of a task block within `range` (document positions; the whole block without one): its line, then its notes. */
export function taskText(node: PMNode, pos: number, range?: { from: number; to: number }): string {
  const from = range ? range.from : pos;
  const to = range ? range.to : pos + node.nodeSize;
  const lines: string[] = [];
  const walk = (n: PMNode, at: number, depth: number) => {
    if (at + n.nodeSize <= from || at >= to) return;
    if (n.type.name === 'taskRef') {
      if (from <= at) lines.push('  '.repeat(depth) + taskLineText(n.attrs.taskId as string));
      n.forEach((c, offset) => walk(c, at + 1 + offset, depth + 1));
    } else if (n.isTextblock) {
      const start = Math.max(0, Math.max(from, at + 1) - (at + 1));
      const end = Math.max(start, Math.min(to, at + n.nodeSize - 1) - (at + 1));
      lines.push('  '.repeat(depth) + n.textBetween(start, end, '\n', (leaf) => (leaf.type.name === 'hardBreak' ? '\n' : '')));
    } else if (!n.isLeaf) n.forEach((c, offset) => walk(c, at + 1 + offset, depth));
  };
  walk(node, pos, 0);
  return lines.join('\n');
}

/** Focus a task's title (caret at the end), e.g. going up out of its first note line. */
export function focusTaskTitle(view: EditorView, taskPos: number): boolean {
  const dom = view.nodeDOM(taskPos) as HTMLElement | null;
  const input = dom?.querySelector<HTMLTextAreaElement>('textarea.task-ref-title');
  if (!input) return false;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  return true;
}

/**
 * Keys for the notes under tasks (./taskChildren.ts). Ahead of smartLists (priority 200), which keeps Tab and
 * Shift+Tab inside lists: Tab on the first line of a list right below a task moves the list in.
 */
const TaskChildrenKeys = Extension.create({
  name: 'taskChildrenKeys',
  priority: 300,
  addKeyboardShortcuts() {
    const run = (fn: (state: EditorState, dispatch: (tr: Transaction) => void) => boolean) => () =>
      this.editor.isEditable && fn(this.editor.state, this.editor.view.dispatch);
    return {
      Tab: run((state, dispatch) => indentIntoTask(state, tabBlock(state), dispatch)),
      'Shift-Tab': run((state, dispatch) => !listItemAt(this.editor) && liftOutOfTask(state, shiftTabBlock(state), dispatch)),
      Enter: run((state, dispatch) => exitEmptyLastChild(state, dispatch)),
      // Backspace at the start of a task's first note line: an empty line goes; either way the caret goes up to the title.
      Backspace: () => {
        const { state, view } = this.editor;
        const { $from, empty } = state.selection;
        if (!empty || !this.editor.isEditable || $from.parentOffset !== 0 || $from.depth < 2) return false;
        const t = $from.depth - 1;
        if ($from.node(t).type.name !== 'taskRef' || $from.index(t) !== 0) return false;
        const taskPos = $from.before(t);
        if (!$from.parent.content.size && $from.parent.type.name === 'paragraph') view.dispatch(state.tr.delete($from.before(), $from.after()));
        focusTaskTitle(view, taskPos);
        return true;
      },
      ArrowUp: () => {
        const { state, view } = this.editor;
        const { $from, empty } = state.selection;
        if (!empty || !$from.parent.isTextblock || !view.endOfTextblock('up')) return false;
        const t = firstLineOfTask($from);
        return t > 0 && focusTaskTitle(view, $from.before(t));
      },
    };
  },
});

function TaskRefView({ node, editor, getPos, selected }: ReactNodeViewProps) {
  const id = node.attrs.taskId as string;
  const task = useAnyTask(id); // own workspace, or a page shared from another one (#98)
  const loaded = useStore((s) => s.tasksLoaded);
  const members = useStore((s) => s.members);
  const me = useStore((s) => s.user?.id ?? '');
  // Tasks are edited by members (not viewers) of the task's workspace: someone editing the page
  // through a page share from outside the workspace sees its tasks read-only (#98).
  const taskRole = useStore((s) => (task ? s.workspaces.find((w) => w.id === task.workspaceId)?.role : undefined));
  // A task living on this very page is the page's content: whoever may edit the page may edit it,
  // through a page share from outside the workspace too (#98 follow-up). Tasks living elsewhere
  // and only referenced here need membership of their workspace.
  const editable = editor.isEditable && ((!!taskRole && taskRole !== 'viewer') || (!!task?.pageId && task.pageId === pageIdOf(editor)));
  const [title, setTitleState] = useState(task?.title ?? '');
  // The latest title, readable synchronously: Escape/arrows commit and then blur the input
  // in the same tick, and the blur's commit must see the cleaned-up title, not the raw text
  // from this render's closure (BUG-5).
  const titleRef = useRef(title);
  const setTitle = (v: string) => {
    titleRef.current = v;
    setTitleState(v);
  };
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useAutoHeight(inputRef, title);
  const focused = useRef(false);

  useEffect(() => {
    if (task && !focused.current) setTitle(task.title);
  }, [task?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (pendingFocus === id && inputRef.current) {
      pendingFocus = null;
      inputRef.current.focus();
    }
  });

  // Debounced save while typing so collaborators see the title evolve.
  useEffect(() => {
    if (!task || !focused.current || title === task.title || freshTasks.has(id)) return;
    const t = setTimeout(() => void updateTask(id, { title }, { silent: true }), 600);
    return () => clearTimeout(t);
  }, [title]); // eslint-disable-line react-hooks/exhaustive-deps

  const [collapsed, setCollapsedState] = useState(() => isCollapsed(id));
  const setCollapsed = (v: boolean) => {
    setCollapsedState(v);
    rememberCollapsed(id, v);
  };
  const hasNotes = node.childCount > 0;

  // A task deleted here (task panel, bulk bar) leaves its line in the page; it goes once the Undo window has passed.
  // Its notes stay on the page, where the task was: deleting a task never deletes what was written under it.
  const removeLine = () => {
    const p = (typeof getPos === 'function' ? getPos() : undefined);
    if (p === undefined || !editor.isEditable || editor.state.doc.nodeAt(p)?.attrs.taskId !== id) return;
    const gone = (tid: string) => (useStore.getState().tasks[tid] ? undefined : deletedTitles.get(tid));
    editor.view.dispatch(unwrapTask(editor.state.tr, p, [], gone));
  };
  useEffect(() => {
    if (task || !loaded || !editor.isEditable || !deletedHere.has(id)) return;
    const t = setTimeout(() => {
      if (!useStore.getState().tasks[id] && deletedHere.has(id)) removeLine();
    }, UNDO_WINDOW_MS);
    return () => clearTimeout(t);
  }, [task, loaded, id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!task) {
    return (
      <NodeViewWrapper className={`task-ref is-missing ${selected ? 'is-selected' : ''}`} data-task-id={id}>
        <div contentEditable={false} className="task-ref-inner">
          <span className="drag-handle" data-drag-handle>
            <GripVertical size={14} />
          </span>
          <FileX2 size={15} className="muted" />
          <span className="muted small">{loaded ? 'This task was deleted or is not visible to you.' : 'Loading task…'}</span>
          {loaded && editor.isEditable && (
            <button type="button" className="btn-ghost btn-sm" onClick={removeLine} title={hasNotes ? 'The notes under it stay on the page' : undefined}>
              Remove from page
            </button>
          )}
        </div>
        <NodeViewContent className="task-ref-children" />
      </NodeViewWrapper>
    );
  }

  const pos = () => (typeof getPos === 'function' ? getPos() : undefined);

  /** The (empty) task becomes an ordinary empty line in its place; the notes under it stay, below that line. */
  const toPlainLine = (p: number) => {
    void deleteTask(id);
    const tr = unwrapTask(editor.state.tr, p, [editor.state.schema.nodes.paragraph.create()]);
    tr.setSelection(TextSelection.create(tr.doc, p + 1));
    editor.view.dispatch(tr.scrollIntoView());
    editor.view.focus();
  };

  const commit = () => {
    const trimmed = titleRef.current.trim();
    if (freshTasks.has(id) && trimmed) {
      freshTasks.delete(id);
      const p = parseQuickAdd(trimmed);
      const patch: TaskPatch = { title: p.title || trimmed };
      if (p.dueDate) patch.dueDate = p.dueDate;
      if (p.dueTime) patch.dueTime = p.dueTime;
      if (p.priority) patch.priority = p.priority;
      if (p.recurrence) patch.recurrence = p.recurrence;
      const a = p.assignee ? resolveMember(p.assignee, members, me) : undefined;
      if (a) patch.assigneeId = a;
      else if (p.assignee) patch.title = trimmed.replace(/\s+/g, ' ');
      setTitle(patch.title!);
      void updateTask(id, patch, { silent: true });
    } else if (trimmed !== task.title) {
      void updateTask(id, { title: trimmed }, { silent: true });
    }
  };

  const focusEditorAt = (dir: 1 | -1) => {
    const p = pos();
    if (p === undefined) return;
    // Down goes to the first note line under the task (when they show), else past it.
    const target = dir === 1 ? (hasNotes && !collapsed ? p + 1 : p + node.nodeSize) : p;
    const { state, view } = editor;
    const sel = Selection.near(state.doc.resolve(Math.min(target, state.doc.content.size)), dir);
    view.dispatch(state.tr.setSelection(sel).scrollIntoView());
    view.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!editable && (e.key === 'Enter' || e.key === 'Backspace')) return; // they'd create or delete tasks
    const p = pos();
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      commit();
      if (p === undefined) return;
      if (!title.trim()) {
        // Empty task + Enter = leave task mode (like a checklist); its notes stay, under the new line.
        toPlainLine(p);
        return;
      }
      if (hasNotes) {
        // A task with notes: Enter starts a new first note line (a new point when they start with a list).
        if (collapsed) setCollapsed(false);
        const first = node.firstChild!;
        const { schema } = editor.state;
        const tr = editor.state.tr;
        if ((first.type.name === 'bulletList' || first.type.name === 'orderedList') && schema.nodes.listItem) {
          tr.insert(p + 2, schema.nodes.listItem.create(null, schema.nodes.paragraph.create()));
          tr.setSelection(TextSelection.create(tr.doc, p + 4));
        } else {
          tr.insert(p + 1, schema.nodes.paragraph.create());
          tr.setSelection(TextSelection.create(tr.doc, p + 2));
        }
        editor.view.dispatch(tr.scrollIntoView());
        editor.view.focus();
        return;
      }
      const newId = newTask(editor.extensionManager.extensions.find((x) => x.name === 'taskRef')!.options.pageId);
      pendingFocus = newId;
      editor.chain().insertContentAt(p + node.nodeSize, { type: 'taskRef', attrs: { taskId: newId } }).run();
    } else if (e.key === 'Backspace' && !title && p !== undefined) {
      e.preventDefault();
      // Backspace in an empty task turns it into an ordinary empty line in its place (like a
      // checklist item), so you can switch between tasks and text without leaving the spot.
      toPlainLine(p);
    } else if (e.key === 'Tab' && editable && p !== undefined && !e.altKey && !e.ctrlKey && !e.metaKey) {
      // Tab makes this task a subtask of the task just above it; Shift+Tab takes it back out.
      const { state } = editor;
      const block = { pos: p, node: state.doc.nodeAt(p)!, $pos: state.doc.resolve(p) };
      const ok = e.shiftKey ? liftOutOfTask(state, block) : indentIntoTask(state, block);
      e.preventDefault(); // stays in the title even when there's nothing to do (no jump out of the page)
      if (!ok) return;
      commit();
      pendingFocus = id;
      if (e.shiftKey) liftOutOfTask(state, block, editor.view.dispatch);
      else indentIntoTask(state, block, editor.view.dispatch);
    } else if (e.key === 'ArrowDown' || (e.key === 'Escape' && !e.defaultPrevented)) {
      e.preventDefault();
      commit();
      focusEditorAt(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      commit();
      focusEditorAt(-1);
    } else if (e.key === 'ArrowLeft' && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) {
      e.preventDefault();
      commit();
      focusEditorAt(-1);
    } else if (e.key === 'ArrowRight' && e.currentTarget.selectionStart === title.length) {
      e.preventDefault();
      commit();
      focusEditorAt(1);
    }
  };

  const done = task.status === 'done';
  return (
    <NodeViewWrapper
      className={`task-ref ${done ? 'is-done' : ''} ${selected ? 'is-selected' : ''} ${hasNotes ? 'has-notes' : ''} ${hasNotes && collapsed ? 'is-collapsed' : ''}`}
      data-task-id={id}
    >
      <div contentEditable={false} className="task-ref-inner" role="group" aria-label={`Task: ${task.title || 'untitled'}${done ? ', done' : ''}`}>
        {editable && (
          <span className="drag-handle" data-drag-handle title="Drag to move" aria-hidden="true">
            <GripVertical size={14} />
          </span>
        )}
        <TaskCheckbox task={task} onToggle={() => toggleTask(id)} disabled={!editable} />
        <textarea
          ref={inputRef}
          rows={1}
          className="task-ref-title"
          data-value={title} // textareas have no value attribute; tests and styles can match the title here
          aria-label="Task title"
          value={title}
          placeholder="Task name — e.g. “Draft agenda tomorrow p2 @sam”"
          readOnly={!editable}
          onChange={(e) => setTitle(e.target.value)}
          onFocus={() => (focused.current = true)}
          onBlur={() => {
            focused.current = false;
            commit();
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            // Pasting several lines: the first goes here, each other line becomes a task below.
            const lines = e.clipboardData.getData('text/plain').split(/\r?\n/).map((l) => l.replace(/^\s*([-*•]|\[[ x]?\]|\d+[.)])\s+/i, '').trim()).filter(Boolean);
            const p = pos();
            if (lines.length < 2 || p === undefined) return;
            e.preventDefault();
            const input = e.currentTarget;
            const next = title.slice(0, input.selectionStart ?? title.length) + lines[0] + title.slice(input.selectionEnd ?? title.length);
            setTitle(next);
            void updateTask(id, { title: next.trim() }, { silent: true });
            freshTasks.delete(id);
            const pageId = editor.extensionManager.extensions.find((x) => x.name === 'taskRef')!.options.pageId as string;
            const nodes = lines.slice(1).map((l) => ({ type: 'taskRef', attrs: { taskId: newTask(pageId, l) } }));
            editor.chain().insertContentAt(p + node.nodeSize, nodes).run();
          }}
        />
        <div className="task-ref-meta">
          {hasNotes && (
            // Fold the notes under the task away (remembered in this browser; collaborators keep their own view).
            <button
              type="button"
              className="chip chip-btn task-ref-fold"
              aria-expanded={!collapsed}
              aria-label={collapsed ? 'Show the notes under this task' : 'Hide the notes under this task'}
              title={collapsed ? 'Show notes' : 'Hide notes'}
              onClick={() => setCollapsed(!collapsed)}
            >
              {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              {collapsed && <span className="task-ref-fold-count">{noteCount(node)}</span>}
            </button>
          )}
          {(() => {
            const c = checklistCount(node);
            return c.total > 0 ? (
              <span className={`chip task-ref-checks ${c.done === c.total ? 'is-complete' : ''}`} title={`${c.done} of ${c.total} checklist items ticked`} aria-label={`Checklist ${c.done} of ${c.total} ticked`}>
                {c.done}/{c.total}
              </span>
            ) : null;
          })()}
          <PriorityChip task={task} readOnly={!editable} onChange={(priority) => void updateTask(id, { priority })} />
          <DueChip task={task} readOnly={!editable} onChange={(dueDate) => void updateTask(id, { dueDate })} />
          <AssigneeChip task={task} readOnly={!editable} onChange={(assigneeId) => void updateTask(id, { assigneeId })} />
          {editable && (
            <button
              type="button"
              className="icon-btn btn-ghost task-ref-open task-ref-add-checklist"
              title="Add checklist (its items are not tasks)"
              aria-label="Add checklist under this task"
              onClick={() => {
                const p = pos();
                if (p === undefined) return;
                if (collapsed) setCollapsed(false);
                const tr = editor.state.tr;
                if (addChecklistToTask(tr, p)) editor.view.dispatch(tr.scrollIntoView());
                editor.view.focus();
              }}
            >
              <ListChecks size={13} />
            </button>
          )}
          <button className="icon-btn btn-ghost task-ref-open" title="Open task details" aria-label="Open task details" onClick={() => ui.openTask(id)}>
            <Maximize2 size={13} />
          </button>
        </div>
      </div>
      <NodeViewContent className="task-ref-children" />
    </NodeViewWrapper>
  );
}

/** Ticked / all checklist items (plain checklists, not tasks) in a task's own notes (not in its subtasks' notes). */
export function checklistCount(node: PMNode): { done: number; total: number } {
  let done = 0;
  let total = 0;
  node.forEach(function visit(c: PMNode) {
    if (c.type.name === 'taskRef') return;
    if (c.type.name === 'taskItem') {
      total++;
      if (c.attrs.checked) done++;
    }
    if (!c.isTextblock) c.forEach(visit);
  });
  return { done, total };
}

/** "3 notes": the lines under a folded task (text lines and nested tasks, not the lists around them). */
function noteCount(node: PMNode): string {
  let n = 0;
  node.descendants((c) => {
    if (c.isTextblock || c.type.name === 'taskRef' || (c.isLeaf && c.isBlock)) n++;
    return !c.isTextblock;
  });
  return n === 1 ? '1 note' : `${n} notes`;
}

/** Which tasks' notes are folded away: per browser (like a section's open/closed state), not shared with collaborators. */
const COLLAPSED_KEY = 'notivelo.taskNotesCollapsed';
function collapsedIds(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}
const isCollapsed = (id: string) => collapsedIds().has(id);
function rememberCollapsed(id: string, collapsed: boolean) {
  const ids = collapsedIds();
  if (collapsed) ids.add(id);
  else ids.delete(id);
  try {
    // The most recent few hundred are plenty; a folded task that's gone simply drops off the end.
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids].slice(-500)));
  } catch {
    // storage full or blocked: folding just isn't remembered
  }
}

/** Append a new, focused task at the end of the note. */
export function insertTaskAtEnd(editor: Editor, pageId: string) {
  if (!tasksAllowedOn(pageId)) return;
  const id = newTask(pageId);
  pendingFocus = id;
  editor.chain().insertContentAt(editor.state.doc.content.size, { type: 'taskRef', attrs: { taskId: id } }).run();
}

/** Can the selection be converted to tasks? (for enabling menu items) */
export function canConvert(editor: Editor): boolean {
  const { $from, empty } = editor.state.selection;
  if (!editor.isEditable || !canInsertTask(editor)) return false;
  if (empty || $from.sameParent(editor.state.selection.$to)) return $from.parent.isTextblock && $from.parent.type.name !== 'codeBlock';
  return true;
}

/** Turn the line at the cursor into a task, keeping the points nested under it as the task's notes. Returns the new task id. */
export function convertLine(editor: Editor): string | null {
  const sel = editor.state.selection;
  if (!sel.empty && !sel.$from.sameParent(sel.$to)) return null;
  return convertToTasks(editor)[0] ?? null;
}

/**
 * Convert the current line or the selected lines to tasks (see the `convertToTask` command and
 * convertTransaction in ./taskChildren.ts): a line's sub-points stay under its task, and a line inside a task's
 * notes becomes a subtask of that task where it is (the server sets the parent on save).
 * Returns the ids of the tasks created, in document order. For agents/other areas:
 *   import { convertToTasks } from '../editor/TaskRef.tsx';
 *   const ids = convertToTasks(editor);
 */
export function convertToTasks(editor: Editor): string[] {
  if (!canConvert(editor) || !editor.state.schema.nodes.taskRef) return [];
  const pageId = pageIdOf(editor);
  let empty: string | null = null;
  const res = convertTransaction(editor.state, (title, done) => {
    const id = newTask(pageId, title, done ? { status: 'done' } : {});
    if (!title) empty = id;
    return id;
  });
  if (!res) return [];
  if (empty) pendingFocus = empty;
  editor.view.dispatch(res.tr);
  return res.ids;
}

/** Priority flag: shown when set (p1–p3), and on hover to set one. */
function PriorityChip({ task, onChange, readOnly }: { task: Task; onChange: (p: Priority) => void; readOnly?: boolean }) {
  const set = task.priority < 4;
  const flag = <Flag size={13} color={PRIORITY_COLORS[task.priority]} fill={set ? PRIORITY_COLORS[task.priority] : 'none'} />;
  if (readOnly) return set ? <span className="chip" title={`Priority ${task.priority}`}>{flag}</span> : null;
  return (
    <Dropdown trigger={flag} buttonClass={`chip chip-btn ${set ? '' : 'chip-empty'}`} title={set ? `Priority ${task.priority}` : 'Set priority'} placement="bottom-end">
      {(close) => (
        <PriorityMenu
          value={task.priority}
          onChange={(p) => {
            onChange(p);
            close();
          }}
        />
      )}
    </Dropdown>
  );
}

/** Sent on window when a page's text metrics change without a resize (rule lines on/off). */
export const RELAYOUT_EVENT = 'noteapp:relayout';

/** Grow a one-row textarea to fit its text, so long task titles wrap instead of scrolling sideways. */
function useAutoHeight(ref: React.RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    // The width changes with the window and the side panels, and so does the number of lines.
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return; // our own height change, not a new width
      width = el.clientWidth;
      fit();
    });
    ro.observe(el);
    // Rule lines turned on or off: the line height changes, not the width.
    window.addEventListener(RELAYOUT_EVENT, fit);
    return () => {
      ro.disconnect();
      window.removeEventListener(RELAYOUT_EVENT, fit);
    };
  }, [ref, value]);
}
