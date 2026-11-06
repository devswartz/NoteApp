// "taskRef" — a block node that embeds a live task inside a note.
// The node stores only the task id; the task itself lives in the database and
// the app store, so it stays in sync with the Tasks dashboard everywhere.
import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { Selection, TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { useEffect, useRef, useState } from 'react';
import { GripVertical, Maximize2, FileX2, Flag } from 'lucide-react';
import { deleteTask, newTaskId, toggleTask, ui, updateTask, useStore, createTask } from '../store.ts';
import { AssigneeChip, DueChip, PRIORITY_COLORS, PriorityMenu, TaskCheckbox } from '../components/TaskControls.tsx';
import { Dropdown } from '../components/ui.tsx';
import { parseQuickAdd } from '../../shared/quickadd.ts';
import { resolveMember } from '../components/TaskRow.tsx';
import type { Priority, Task, TaskPatch } from '../../shared/types.ts';
import { markCreatedHere } from './undoTasks.ts';

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

export const TaskRef = Node.create<TaskRefOptions>({
  name: 'taskRef',
  group: 'block',
  atom: true,
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
    return [{ tag: 'div[data-type="task-ref"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'task-ref' })];
  },

  // Markdown export: a checklist line with the live task's state, due date and priority.
  renderMarkdown(node) {
    const t = useStore.getState().tasks[node.attrs?.taskId as string];
    if (!t) return '';
    const extras = [t.dueDate ? `📅 ${t.dueDate}${t.dueTime ? ` ${t.dueTime}` : ''}` : '', t.priority < 4 ? `p${t.priority}` : ''].filter(Boolean).join(' ');
    return `- [${t.status === 'done' ? 'x' : ' '}] ${t.title}${extras ? ` ${extras}` : ''}`;
  },

  // Plain-text clipboard / export representation.
  renderText({ node }) {
    const t = useStore.getState().tasks[node.attrs.taskId as string];
    return `[${t?.status === 'done' ? 'x' : ' '}] ${t?.title ?? ''}`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(TaskRefView, {
      // Let the embedded inputs/buttons handle their own events.
      stopEvent: ({ event }) => {
        const el = event.target as HTMLElement | null;
        if (!el || event.type === 'dragstart') return false;
        return !!el.closest('input, button, a, .popover');
      },
    });
  },

  addCommands() {
    return {
      insertTask:
        (title = '', patch = {}) =>
        ({ chain }) => {
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

});

function TaskRefView({ node, editor, getPos, selected }: ReactNodeViewProps) {
  const id = node.attrs.taskId as string;
  const task = useStore((s) => s.tasks[id]);
  const loaded = useStore((s) => s.tasksLoaded);
  const members = useStore((s) => s.members);
  const me = useStore((s) => s.user?.id ?? '');
  const editable = editor.isEditable;
  const [title, setTitleState] = useState(task?.title ?? '');
  // The latest title, readable synchronously: Escape/arrows commit and then blur the input
  // in the same tick, and the blur's commit must see the cleaned-up title, not the raw text
  // from this render's closure (BUG-5).
  const titleRef = useRef(title);
  const setTitle = (v: string) => {
    titleRef.current = v;
    setTitleState(v);
  };
  const inputRef = useRef<HTMLInputElement>(null);
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

  if (!task) {
    return (
      <NodeViewWrapper className={`task-ref is-missing ${selected ? 'is-selected' : ''}`} data-task-id={id}>
        <div contentEditable={false} className="task-ref-inner">
          <span className="drag-handle" data-drag-handle>
            <GripVertical size={14} />
          </span>
          <FileX2 size={15} className="muted" />
          <span className="muted small">{loaded ? 'This task was deleted or is not visible to you.' : 'Loading task…'}</span>
        </div>
      </NodeViewWrapper>
    );
  }

  const pos = () => (typeof getPos === 'function' ? getPos() : undefined);

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
    const target = dir === 1 ? p + node.nodeSize : p;
    const { state, view } = editor;
    const sel = Selection.near(state.doc.resolve(Math.min(target, state.doc.content.size)), dir);
    view.dispatch(state.tr.setSelection(sel).scrollIntoView());
    view.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const p = pos();
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      commit();
      if (p === undefined) return;
      if (!title.trim()) {
        // Empty task + Enter = leave task mode (like a checklist).
        void deleteTask(id);
        editor
          .chain()
          .insertContentAt({ from: p, to: p + node.nodeSize }, { type: 'paragraph' })
          .command(({ tr }) => {
            tr.setSelection(TextSelection.create(tr.doc, p + 1));
            return true;
          })
          .focus()
          .run();
        return;
      }
      const newId = newTask(editor.extensionManager.extensions.find((x) => x.name === 'taskRef')!.options.pageId);
      pendingFocus = newId;
      editor.chain().insertContentAt(p + node.nodeSize, { type: 'taskRef', attrs: { taskId: newId } }).run();
    } else if (e.key === 'Backspace' && !title && p !== undefined) {
      e.preventDefault();
      void deleteTask(id);
      editor.chain().deleteRange({ from: p, to: p + node.nodeSize }).run();
      const { state, view } = editor;
      const sel = Selection.near(state.doc.resolve(Math.max(0, Math.min(p, state.doc.content.size))), -1);
      view.dispatch(state.tr.setSelection(sel));
      view.focus();
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
      className={`task-ref ${done ? 'is-done' : ''} ${selected ? 'is-selected' : ''}`}
      data-task-id={id}
    >
      <div contentEditable={false} className="task-ref-inner">
        {editable && (
          <span className="drag-handle" data-drag-handle title="Drag to move">
            <GripVertical size={14} />
          </span>
        )}
        <TaskCheckbox task={task} onToggle={() => toggleTask(id)} disabled={!editable} />
        <input
          ref={inputRef}
          className="task-ref-title"
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
          <PriorityChip task={task} readOnly={!editable} onChange={(priority) => void updateTask(id, { priority })} />
          <DueChip task={task} readOnly={!editable} onChange={(dueDate) => void updateTask(id, { dueDate })} />
          <AssigneeChip task={task} readOnly={!editable} onChange={(assigneeId) => void updateTask(id, { assigneeId })} />
          <button className="icon-btn btn-ghost task-ref-open" title="Open task details" onClick={() => ui.openTask(id)}>
            <Maximize2 size={13} />
          </button>
        </div>
      </div>
    </NodeViewWrapper>
  );
}

/** Append a new, focused task at the end of the note. */
export function insertTaskAtEnd(editor: Editor, pageId: string) {
  const id = newTask(pageId);
  pendingFocus = id;
  editor.chain().insertContentAt(editor.state.doc.content.size, { type: 'taskRef', attrs: { taskId: id } }).run();
}

/** Can the selection be converted to tasks? (for enabling menu items) */
export function canConvert(editor: Editor): boolean {
  const { $from, empty } = editor.state.selection;
  if (!editor.isEditable) return false;
  if (empty || $from.sameParent(editor.state.selection.$to)) return $from.parent.isTextblock && $from.parent.type.name !== 'codeBlock';
  return true;
}

const LISTS = new Set(['bulletList', 'orderedList', 'taskList']);

const pageIdOf = (editor: Editor) =>
  (editor.extensionManager.extensions.find((x) => x.name === 'taskRef')?.options as TaskRefOptions | undefined)?.pageId ?? '';

/** Turn the line at the cursor into a task (lifting it out of lists first). Returns the new task id. */
export function convertLine(editor: Editor): string | null {
  if (!canConvert(editor)) return null;
  const done = editor.isActive('taskItem', { checked: true });
  // Lift out of lists first so the task becomes a top-level block. Each lift is its own transaction.
  for (let guard = 0; guard < 5 && (editor.isActive('listItem') || editor.isActive('taskItem')); guard++) {
    const ok = editor.isActive('taskItem') ? editor.commands.liftListItem('taskItem') : editor.commands.liftListItem('listItem');
    if (!ok) break;
  }
  const $f = editor.state.selection.$from;
  if (!$f.parent.isTextblock || $f.depth < 1) return null;
  const title = $f.parent.textContent.trim();
  const id = newTask(pageIdOf(editor), title, done ? { status: 'done' } : {});
  if (!title) pendingFocus = id;
  editor.chain().insertContentAt({ from: $f.before(), to: $f.after() }, { type: 'taskRef', attrs: { taskId: id } }).run();
  return id;
}

/**
 * Convert the current line or the selected lines to tasks (see the `convertToTask` command).
 * Returns the ids of the tasks created, in document order. For agents/other areas:
 *   import { convertToTasks } from '../editor/TaskRef.tsx';
 *   const ids = convertToTasks(editor);
 */
export function convertToTasks(editor: Editor): string[] {
  const { state } = editor;
  const { selection } = state;
  const pageId = pageIdOf(editor);
  const taskType = state.schema.nodes.taskRef;
  if (!editor.isEditable || !taskType) return [];

  // A cursor or a selection inside one line: convert that line.
  if (selection.empty || selection.$from.sameParent(selection.$to)) {
    const id = convertLine(editor);
    return id ? [id] : [];
  }

  // Several blocks: rebuild the top-level blocks the selection touches. Inside lists,
  // only the items the selection overlaps become tasks; the others stay list items
  // (a list is split around the converted items).
  const selFrom = selection.from;
  const selTo = selection.to;
  const overlaps = (pos: number, node: PMNode) => pos < selTo && pos + node.nodeSize > selFrom;
  const from = selection.$from.before(1);
  const to = selection.$to.after(1);
  const ids: string[] = [];
  const out: PMNode[] = [];
  const task = (text: string, done = false) => {
    const title = text.trim();
    if (!title) return false;
    const id = newTask(pageId, title, done ? { status: 'done' } : {});
    ids.push(id);
    out.push(taskType.create({ taskId: id }));
    return true;
  };
  /** Walk a list at `pos`; unselected runs of items are re-emitted as lists of the same type. */
  const fromList = (list: PMNode, pos: number) => {
    let keep: PMNode[] = [];
    const flush = () => {
      if (keep.length) out.push(list.type.create(list.attrs, keep));
      keep = [];
    };
    list.forEach((item, offset) => {
      const itemPos = pos + 1 + offset;
      if (!overlaps(itemPos, item)) {
        keep.push(item);
        return;
      }
      flush();
      const done = item.type.name === 'taskItem' && !!item.attrs.checked;
      item.forEach((child, childOffset) => {
        const childPos = itemPos + 1 + childOffset;
        if (LISTS.has(child.type.name)) fromList(child, childPos);
        else if (child.isTextblock) {
          if (!overlaps(childPos, child) || !task(child.textContent, done)) out.push(child);
        } else out.push(child);
      });
    });
    flush();
  };
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (pos < from || pos >= to) return false;
    if (node.type.name === 'taskRef') out.push(node);
    else if (LISTS.has(node.type.name)) fromList(node, pos);
    else if (node.isTextblock && node.type.name !== 'codeBlock') {
      if (!task(node.textContent)) out.push(node);
    } else out.push(node);
    return false; // top-level only; lists are walked by fromList
  });
  if (!ids.length) return [];
  editor.view.dispatch(state.tr.replaceWith(from, to, out).scrollIntoView());
  return ids;
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
