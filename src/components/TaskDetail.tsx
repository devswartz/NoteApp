import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, CalendarDays, Clock, CornerDownRight, FileText, Flag, ListChecks, Plus, Repeat, Trash2, UserRound, X } from 'lucide-react';
import { createTask, deleteTask, errorToast, memberById, toggleTask, ui, updateTask, useStore } from '../store.ts';
import { subtaskIndex } from '../lib/taskViews.ts';
import { parseQuickAdd } from '../../shared/quickadd.ts';
import { resolveMember } from './TaskRow.tsx';
import type { Task } from '../../shared/types.ts';
import { Avatar, Dropdown, Modal } from './ui.tsx';
import { AssigneeMenu, DueMenu, PRIORITY_COLORS, PriorityMenu, TaskCheckbox } from './TaskControls.tsx';
import { RecurrencePicker, ReminderPicker } from './notifications/index.ts';
import { describeDue, dueTone, PRIORITY_LABEL, relativeTime } from '../lib/format.ts';
import { today } from '../../shared/dates.ts';
import { describeRecurrence, firstOccurrence } from '../../shared/recurrence.ts';

/** Side sheet (desktop) / bottom sheet (mobile) for viewing and editing one task. */
export function TaskDetail() {
  const id = useStore((s) => s.taskDetailId);
  const task = useStore((s) => (id ? s.tasks[id] : undefined));
  const wsId = useStore((s) => s.wsId);
  const page = useStore((s) => (task?.pageId ? s.tree.pages.find((p) => p.id === task.pageId) : undefined));
  const canEdit = useStore((s) => s.workspaces.find((w) => w.id === s.wsId)?.role !== 'viewer');
  const members = useStore((s) => s.members);
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const titleRef = useRef<HTMLTextAreaElement>(null);

  // Sync local fields when switching tasks or when a remote change arrives
  // (but not while the user is typing in that field).
  useEffect(() => {
    if (!task) return;
    if (document.activeElement?.id !== 'task-title') setTitle(task.title);
    if (document.activeElement?.id !== 'task-desc') setDesc(task.description);
  }, [task?.id, task?.title, task?.description]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (id && !task) ui.openTask(null); // deleted or no longer visible
  }, [id, task]);

  if (!task) return null;
  const close = () => ui.openTask(null);
  const commitTitle = () => title.trim() !== task.title && title.trim() && void updateTask(task.id, { title: title.trim() });
  const commitDesc = () => desc !== task.description && void updateTask(task.id, { description: desc });
  const creator = members.find((m) => m.id === task.createdBy);
  const completer = memberById(task.completedBy);
  const assignee = memberById(task.assigneeId);

  return (
    <Modal open onClose={close} className="sheet" label="Task details">
      <div className="sheet-head">
        <div className="sheet-crumb">
          {task.parentId ? (
            <ParentCrumb parentId={task.parentId} />
          ) : page ? (
            <Link to={`/w/${wsId}/p/${page.id}?task=${task.id}`} className="chip chip-link" onClick={close}>
              <FileText size={13} /> <span className="truncate">{page.title || 'Untitled'}</span>
            </Link>
          ) : (
            <span className="muted small">Standalone task</span>
          )}
        </div>
        {canEdit && (
          <button
            className="btn-ghost icon-btn"
            title="Delete task"
            onClick={() => {
              const n = Object.values(useStore.getState().tasks).filter((t) => t.parentId === task.id).length;
              const extra = n ? ` Its ${n} subtask${n === 1 ? '' : 's'} will be deleted too.` : '';
              if (confirm((page && !task.parentId ? 'Delete this task? It will also be removed from its note.' : 'Delete this task?') + extra)) {
                void deleteTask(task.id);
                close();
              }
            }}
          >
            <Trash2 size={16} />
          </button>
        )}
        <button className="btn-ghost icon-btn" onClick={close} title="Close (Esc)">
          <X size={18} />
        </button>
      </div>

      <div className="sheet-body">
        <div className="row gap-10 align-start">
          <div style={{ paddingTop: 6 }}>
            <TaskCheckbox task={task} onToggle={() => toggleTask(task.id)} disabled={!canEdit} />
          </div>
          <textarea
            id="task-title"
            ref={titleRef}
            className={`detail-title ${task.status === 'done' ? 'is-done' : ''}`}
            value={title}
            rows={1}
            readOnly={!canEdit}
            onChange={(e) => setTitle(e.target.value.replace(/\n/g, ''))}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                (e.target as HTMLTextAreaElement).blur();
              }
            }}
          />
        </div>

        <div className="props">
          <Prop icon={<UserRound size={15} />} label="Assignee">
            <Dropdown
              disabled={!canEdit}
              buttonClass="prop-btn"
              trigger={assignee ? <><Avatar user={assignee} size={18} /> {assignee.name}</> : <span className="muted">Unassigned</span>}
            >
              <AssigneeMenu value={task.assigneeId} onChange={(assigneeId) => void updateTask(task.id, { assigneeId })} />
            </Dropdown>
          </Prop>
          <Prop icon={<CalendarDays size={15} />} label="Due date">
            <Dropdown
              disabled={!canEdit}
              buttonClass={`prop-btn due-${task.status === 'done' ? 'none' : dueTone(task.dueDate)}`}
              trigger={task.dueDate ? describeDue(task.dueDate) : <span className="muted">No date</span>}
            >
              <DueMenu value={task.dueDate} onChange={(dueDate) => void updateTask(task.id, { dueDate })} />
            </Dropdown>
          </Prop>
          <Prop icon={<Clock size={15} />} label="Time">
            <input
              type="time"
              className="prop-input"
              disabled={!canEdit}
              value={task.dueTime ?? ''}
              onChange={(e) => void updateTask(task.id, { dueTime: e.target.value || null, ...(e.target.value && !task.dueDate ? { dueDate: today() } : {}) })}
            />
          </Prop>
          <Prop icon={<Flag size={15} />} label="Priority">
            <Dropdown
              disabled={!canEdit}
              buttonClass="prop-btn"
              trigger={<><Flag size={14} color={PRIORITY_COLORS[task.priority]} fill={task.priority < 4 ? PRIORITY_COLORS[task.priority] : 'none'} /> {PRIORITY_LABEL[task.priority]}</>}
            >
              <PriorityMenu value={task.priority} onChange={(priority) => void updateTask(task.id, { priority })} />
            </Dropdown>
          </Prop>
          <Prop icon={<Repeat size={15} />} label="Repeat">
            <Dropdown
              disabled={!canEdit}
              buttonClass="prop-btn"
              trigger={task.recurrence ? describeRecurrence(task.recurrence, task.dueDate) : <span className="muted">Does not repeat</span>}
            >
              {(closeMenu) => (
                <RecurrencePicker
                  value={task.recurrence}
                  dueDate={task.dueDate}
                  onDone={closeMenu}
                  onChange={(recurrence) =>
                    void updateTask(task.id, {
                      recurrence,
                      ...(recurrence && !task.dueDate ? { dueDate: firstOccurrence(recurrence, today()) } : {}),
                    })
                  }
                />
              )}
            </Dropdown>
          </Prop>
          <Prop icon={<Bell size={15} />} label="Reminders">
            <div>
              {task.reminderAt && (
                // The original single reminder field: still shown and clearable; new ones go through ReminderPicker.
                <div className="rm-item">
                  <Bell size={13} />
                  <span className="rm-label">{new Date(task.reminderAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                  {canEdit && (
                    <button type="button" className="icon-btn btn-ghost" aria-label="Remove reminder" title="Remove reminder" onClick={() => void updateTask(task.id, { reminderAt: null })}>
                      <X size={13} />
                    </button>
                  )}
                </div>
              )}
              <ReminderPicker task={task} onError={errorToast} />
            </div>
          </Prop>
        </div>

        <textarea
          id="task-desc"
          className="detail-desc"
          placeholder={canEdit ? 'Add details…' : 'No details'}
          value={desc}
          readOnly={!canEdit}
          onChange={(e) => setDesc(e.target.value)}
          onBlur={commitDesc}
        />

        {!task.parentId && <Subtasks task={task} canEdit={canEdit} />}

        <div className="detail-foot muted small">
          Created by {creator?.name ?? (task.createdBy === 'deleted-user' ? 'a deleted user' : 'someone')} · {relativeTime(task.createdAt)}
          {task.status === 'done' && task.completedAt && (
            <>
              <br />
              Completed by {completer?.name ?? (task.completedBy === 'deleted-user' ? 'a deleted user' : 'someone')} · {relativeTime(task.completedAt)}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Prop({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="prop">
      <div className="prop-label">
        {icon}
        {label}
      </div>
      <div className="prop-value">{children}</div>
    </div>
  );
}

function ParentCrumb({ parentId }: { parentId: string }) {
  const parent = useStore((s) => s.tasks[parentId]);
  return (
    <button className="chip chip-link" onClick={() => ui.openTask(parentId)} title="Open the parent task">
      <CornerDownRight size={13} /> <span className="truncate">Subtask of {parent?.title || 'a task'}</span>
    </button>
  );
}

/** One level of subtasks with progress; the input understands quick-add syntax. */
function Subtasks({ task, canEdit }: { task: Task; canEdit: boolean }) {
  const subs = useStore((s) => subtaskIndex(s.tasks).get(task.id)) ?? [];
  const members = useStore((s) => s.members);
  const me = useStore((s) => s.user!.id);
  const [value, setValue] = useState('');
  const done = subs.filter((x) => x.status === 'done').length;
  const add = () => {
    const raw = value.trim();
    if (!raw) return;
    const p = parseQuickAdd(raw);
    const assignee = p.assignee ? resolveMember(p.assignee, members, me) : undefined;
    void createTask({
      title: p.title || raw,
      parentId: task.id,
      pageId: task.pageId,
      dueDate: p.dueDate,
      dueTime: p.dueTime,
      priority: p.priority ?? 4,
      assigneeId: assignee ?? task.assigneeId,
    });
    setValue('');
  };
  if (!subs.length && !canEdit) return null;
  return (
    <section className="subtasks" aria-label="Subtasks">
      <div className="subtasks-head">
        <ListChecks size={15} /> Subtasks
        {subs.length > 0 && (
          <span className="muted small">
            {done}/{subs.length}
          </span>
        )}
      </div>
      {subs.length > 0 && (
        <div className="progress subtasks-progress">
          <div style={{ width: `${(done / subs.length) * 100}%` }} />
        </div>
      )}
      {subs.map((x) => (
        <div key={x.id} className={`subtask ${x.status === 'done' ? 'is-done' : ''}`}>
          <TaskCheckbox task={x} onToggle={() => toggleTask(x.id)} disabled={!canEdit} />
          <button className="subtask-title" onClick={() => ui.openTask(x.id)}>
            {x.title || <span className="muted">Untitled</span>}
          </button>
        </div>
      ))}
      {canEdit && (
        <form
          className="subtask-add"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Plus size={15} className="muted" />
          <input className="prop-input" placeholder="Add a subtask — “tomorrow @sam” works too" value={value} onChange={(e) => setValue(e.target.value)} />
        </form>
      )}
    </section>
  );
}
