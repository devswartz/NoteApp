// "taskRef" — a block node that embeds a live task inside a note.
// The node stores only the task id; the task itself lives in the database and
// the app store, so it stays in sync with the Tasks dashboard everywhere.
import { InputRule, Node, mergeAttributes, type Editor } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { Selection, TextSelection } from '@tiptap/pm/state';
import { useEffect, useRef, useState } from 'react';
import { GripVertical, Maximize2, FileX2 } from 'lucide-react';
import { deleteTask, newTaskId, toggleTask, ui, updateTask, useStore, createTask } from '../store.ts';
import { AssigneeChip, DueChip, TaskCheckbox } from '../components/TaskControls.tsx';
import { parseQuickAdd } from '../../shared/quickadd.ts';
import { resolveMember } from '../components/TaskRow.tsx';
import type { TaskPatch } from '../../shared/types.ts';

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
    };
  }
}

/** Task ids that should grab focus when their node view mounts. */
let pendingFocus: string | null = null;
/** Tasks created empty in this session: natural-language parsing applies to their first title. */
const freshTasks = new Set<string>();

function newTask(pageId: string, title = '', patch: TaskPatch = {}): string {
  const id = newTaskId();
  const me = useStore.getState().user?.id ?? null;
  if (!title) freshTasks.add(id);
  void createTask({ id, title, pageId, assigneeId: me, ...patch });
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
      convertBlockToTask:
        () =>
        ({ editor, state, chain }) => {
          const { $from } = state.selection;
          const block = $from.parent;
          if (!block.isTextblock || block.type.name === 'codeBlock') return false;
          // Lift out of lists first so the task becomes a top-level block.
          let guard = 0;
          while (guard++ < 5 && (editor.isActive('listItem') || editor.isActive('taskItem'))) {
            const ok = editor.isActive('taskItem') ? editor.commands.liftListItem('taskItem') : editor.commands.liftListItem('listItem');
            if (!ok) break;
          }
          const s = editor.state;
          const $f = s.selection.$from;
          const title = $f.parent.textContent.trim();
          const id = newTask(this.options.pageId, title);
          if (!title) pendingFocus = id;
          const from = $f.before();
          const to = $f.after();
          return chain()
            .insertContentAt({ from, to }, { type: this.name, attrs: { taskId: id } })
            .run();
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Enter': () => this.editor.commands.convertBlockToTask(),
    };
  },

  addInputRules() {
    // "[] " or "[ ] " at the start of an empty paragraph creates a task.
    return [
      new InputRule({
        find: /^\s*\[\s?\]\s$/,
        handler: ({ state, range, chain }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.name !== 'paragraph') return null;
          const id = newTask(this.options.pageId);
          pendingFocus = id;
          chain()
            .insertContentAt({ from: $from.before(), to: $from.after() }, { type: this.name, attrs: { taskId: id } })
            .run();
        },
      }),
    ];
  },
});

function TaskRefView({ node, editor, getPos, selected }: ReactNodeViewProps) {
  const id = node.attrs.taskId as string;
  const task = useStore((s) => s.tasks[id]);
  const loaded = useStore((s) => s.tasksLoaded);
  const members = useStore((s) => s.members);
  const me = useStore((s) => s.user?.id ?? '');
  const editable = editor.isEditable;
  const [title, setTitle] = useState(task?.title ?? '');
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
    const trimmed = title.trim();
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
        />
        <div className="task-ref-meta">
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
