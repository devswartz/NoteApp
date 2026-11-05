import { memo, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { FileText, AlignLeft, CornerDownRight, ListChecks, Plus } from 'lucide-react';
import { TaskIndicators } from './notifications/TaskIndicators.tsx';
import { createTask, toggleTask, ui, updateTask, useStore } from '../store.ts';
import type { PageMeta, Task } from '../../shared/types.ts';
import { AssigneeChip, DueChip, PriorityChip, TaskCheckbox } from './TaskControls.tsx';
import { subtaskIndex, type Group } from '../lib/taskViews.ts';
import { parseQuickAdd } from '../../shared/quickadd.ts';
import { selection, useSelection } from '../pages/tasks/selection.ts';
import { RENAME_EVENT } from '../pages/tasks/commands.tsx';

/** id → page, cached per tree.pages array so each row's lookup is O(1). */
const pageMaps = new WeakMap<PageMeta[], Map<string, PageMeta>>();
function pageIndex(pages: PageMeta[]) {
  let m = pageMaps.get(pages);
  if (!m) pageMaps.set(pages, (m = new Map(pages.map((p) => [p.id, p]))));
  return m;
}

export const TaskRow = memo(function TaskRow({
  task,
  showSource = true,
  draggable,
}: {
  task: Task;
  showSource?: boolean;
  draggable?: boolean;
}) {
  const { wsId } = useParams();
  const page = useStore((s) => (task.pageId ? pageIndex(s.tree.pages).get(task.pageId) : undefined));
  const canEdit = useStore((s) => s.workspaces.find((w) => w.id === s.wsId)?.role !== 'viewer');
  const lingering = useStore((s) => !!s.lingering[task.id]);
  const [editing, setEditing] = useState(false);
  // A click on the title waits briefly so a double-click can start renaming instead of opening the sheet.
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const rowRef = useRef<HTMLDivElement>(null);
  const selected = useSelection((s) => s.ids.has(task.id));
  const subs = useStore((s) => subtaskIndex(s.tasks).get(task.id));
  const subsDone = subs?.filter((x) => x.status === 'done').length ?? 0;
  const parent = useStore((s) => (task.parentId ? s.tasks[task.parentId] : undefined));
  const done = task.status === 'done';
  // The R shortcut (pages/tasks/commands.tsx) asks the focused row to rename itself.
  useEffect(() => {
    const el = rowRef.current;
    if (!el || !canEdit) return;
    const start = () => setEditing(true);
    el.addEventListener(RENAME_EVENT, start);
    return () => el.removeEventListener(RENAME_EVENT, start);
  }, [canEdit]);
  return (
    <div
      ref={rowRef}
      data-task-id={task.id}
      aria-selected={selected || undefined}
      className={`task-row ${done ? 'is-done' : ''} ${lingering ? 'is-lingering' : ''} ${selected ? 'is-selected' : ''}`}
      onMouseDown={(e) => {
        if (e.shiftKey && canEdit) e.preventDefault(); // no text selection on Shift-click
      }}
      onClick={(e) => {
        if (editing) return;
        // Ctrl/⌘-click toggles, Shift-click selects a range (bulk actions).
        if (canEdit && (e.metaKey || e.ctrlKey || e.shiftKey)) {
          e.preventDefault();
          if (e.shiftKey) selection.extendTo(task.id);
          else selection.toggle(task.id);
          return;
        }
        if (useSelection.getState().ids.size) {
          selection.toggle(task.id);
          return;
        }
        clearTimeout(clickTimer.current);
        if (canEdit && (e.target as HTMLElement).closest('.task-title')) {
          if (e.detail < 2) clickTimer.current = setTimeout(() => ui.openTask(task.id), 250);
          return;
        }
        ui.openTask(task.id);
      }}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-task', task.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        // Other row keys (X, D, A, R, S, 1–4, J/K) are registered as shortcuts in pages/tasks/commands.tsx.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') ui.openTask(task.id);
        if (e.key === ' ' && canEdit) {
          e.preventDefault();
          toggleTask(task.id);
        }
      }}
    >
      <TaskCheckbox task={task} onToggle={() => toggleTask(task.id)} disabled={!canEdit} />
      <div className="task-main">
        {editing ? (
          <TitleEditor
            task={task}
            onDone={(viaKey) => {
              setEditing(false);
              if (viaKey) rowRef.current?.focus();
            }}
          />
        ) : (
          <div
            className="task-title"
            title={canEdit ? 'Double-click (or press R) to rename' : undefined}
            onDoubleClick={(e) => {
              if (!canEdit) return;
              e.stopPropagation();
              clearTimeout(clickTimer.current);
              setEditing(true);
            }}
          >
            {task.title || <span className="muted">Untitled task</span>}
          </div>
        )}
        <div className="task-meta">
          <DueChip task={task} readOnly={!canEdit} onChange={(dueDate) => void updateTask(task.id, { dueDate })} />
          <PriorityChip task={task} readOnly={!canEdit} onChange={(priority) => void updateTask(task.id, { priority })} />
          {subs && subs.length > 0 && (
            <span className={`chip ${subsDone === subs.length ? 'chip-active' : ''}`} title={`${subsDone} of ${subs.length} subtasks done`}>
              <ListChecks size={12} /> {subsDone}/{subs.length}
            </span>
          )}
          {parent && (
            <button
              className="chip chip-btn chip-parent"
              title={`Subtask of “${parent.title || 'Untitled'}”`}
              onClick={(e) => {
                e.stopPropagation();
                ui.openTask(parent.id);
              }}
            >
              <CornerDownRight size={12} /> <span className="truncate">{parent.title || 'Untitled'}</span>
            </button>
          )}
          {task.description && <AlignLeft size={13} className="muted" aria-label="Has description" />}
          <TaskIndicators task={task} />
          {showSource && page && (
            <Link
              to={`/w/${wsId}/p/${page.id}?task=${task.id}`}
              className="chip chip-link"
              onClick={(e) => e.stopPropagation()}
              title="Open in note"
            >
              <FileText size={12} />
              <span className="truncate">{page.title || 'Untitled'}</span>
            </Link>
          )}
        </div>
      </div>
      <div className="task-side">
        <AssigneeChip task={task} readOnly={!canEdit} onChange={(assigneeId) => void updateTask(task.id, { assigneeId })} />
      </div>
    </div>
  );
});

/** In-place title editor for a dashboard row: Enter or blur saves, Escape cancels. */
function TitleEditor({ task, onDone }: { task: Task; onDone: (viaKey: boolean) => void }) {
  const [value, setValue] = useState(task.title);
  const done = useRef(false);
  const commit = (viaKey: boolean) => {
    if (done.current) return;
    done.current = true;
    const v = value.trim();
    if (v && v !== task.title) void updateTask(task.id, { title: v });
    onDone(viaKey);
  };
  return (
    <input
      autoFocus
      className="input input-sm task-title-input"
      value={value}
      aria-label="Task title"
      maxLength={1000}
      onFocus={(e) => e.target.select()}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => commit(false)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commit(true);
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          done.current = true;
          onDone(true);
        }
      }}
    />
  );
}

/** Inline "Add task" row inside a group; inherits the group's date/assignee. */
export function InlineAdd({ group, defaults }: { group?: Group; defaults?: { pageId?: string; assigneeId?: string | null } }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const members = useStore((s) => s.members);
  const me = useStore((s) => s.user!.id);
  const canEdit = useStore((s) => s.workspaces.find((w) => w.id === s.wsId)?.role !== 'viewer');
  if (!canEdit) return null;
  if (!open)
    return (
      <button className="inline-add" onClick={() => setOpen(true)}>
        <Plus size={15} /> Add task
      </button>
    );
  const submit = () => {
    const raw = value.trim();
    if (!raw) return setOpen(false);
    const p = parseQuickAdd(raw);
    const assignee = p.assignee ? resolveMember(p.assignee, members, me) : undefined;
    void createTask({
      title: p.title || raw,
      dueDate: p.dueDate ?? group?.dueDate ?? null,
      dueTime: p.dueTime,
      priority: p.priority ?? 4,
      recurrence: p.recurrence,
      assigneeId: assignee ?? (group && 'assigneeId' in group ? group.assigneeId : defaults?.assigneeId ?? me),
      pageId: defaults?.pageId ?? null,
    });
    setValue('');
  };
  return (
    <form
      className="inline-add-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        autoFocus
        className="input"
        placeholder="Task name — try “tomorrow p2 @name”"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && (setOpen(false), setValue(''))}
        onBlur={() => !value && setOpen(false)}
      />
    </form>
  );
}

export function resolveMember(mention: string, members: { id: string; name: string; email: string }[], me: string) {
  const q = mention.toLowerCase();
  if (q === 'me') return me;
  const m =
    members.find((x) => x.name.toLowerCase().split(/\s+/)[0] === q) ??
    members.find((x) => x.name.toLowerCase().replace(/\s+/g, '').startsWith(q)) ??
    members.find((x) => x.email.toLowerCase().startsWith(q));
  return m?.id;
}

export function TaskGroups({
  groups,
  emptyText,
  showSource,
  addable = true,
  hideEmptyGroups,
}: {
  groups: Group[];
  emptyText: string;
  showSource?: boolean;
  addable?: boolean;
  hideEmptyGroups?: boolean;
}) {
  const total = groups.reduce((n, g) => n + g.tasks.length, 0);
  const shown = hideEmptyGroups ? groups.filter((g) => g.tasks.length || g.key === 'today') : groups;
  return (
    <div className="task-groups">
      {shown.map((g) => (
        <section key={g.key} className="task-group">
          {g.label && (
            <h3 className={`group-title ${g.tone === 'danger' ? 'danger' : ''}`}>
              {g.label}
              <span className="group-count">{g.tasks.length || ''}</span>
            </h3>
          )}
          <RowList tasks={g.tasks} showSource={showSource} />
          {addable && g.key !== 'overdue' && g.key !== '!overdue' && <InlineAdd group={g} />}
        </section>
      ))}
      {total === 0 && !addable && <div className="empty">{emptyText}</div>}
    </div>
  );
}

const PAGE = 150;

/**
 * Renders task rows a page at a time, so views with thousands of tasks stay
 * fast. The rest appear behind a "Show more" button (keyboard reachable).
 */
export function RowList({ tasks, showSource }: { tasks: Task[]; showSource?: boolean }) {
  const [limit, setLimit] = useState(PAGE);
  const shown = tasks.length > limit ? tasks.slice(0, limit) : tasks;
  return (
    <>
      {shown.map((t) => (
        <TaskRow key={t.id} task={t} showSource={showSource} />
      ))}
      {tasks.length > limit && (
        <button className="inline-add show-more" onClick={() => setLimit((n) => n + PAGE * 2)}>
          Show {Math.min(PAGE * 2, tasks.length - limit)} more of {tasks.length - limit}
        </button>
      )}
    </>
  );
}
