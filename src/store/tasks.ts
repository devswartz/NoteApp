// Task state and optimistic task actions.
import { del, patch, post } from '../api.ts';
import { cached } from './cache.ts';
import { describeDue } from '../lib/format.ts';
import { set, st } from './state.ts';
import { errorToast, toast } from './toasts.ts';
import type { Task, TaskPatch } from '../../shared/types.ts';

export async function loadTasks() {
  const wsId = st().wsId;
  if (!wsId) return;
  const list = await cached<Task[]>(`tasks:${wsId}`, `/workspaces/${wsId}/tasks`);
  if (st().wsId !== wsId) return;
  const tasks: Record<string, Task> = {};
  for (const t of list) tasks[t.id] = t;
  set({ tasks, tasksLoaded: true });
}

export function upsertTask(t: Task) {
  const prev = st().tasks[t.id];
  // Ignore stale echoes older than what we already have.
  if (prev && prev.updatedAt > t.updatedAt) return;
  set((s) => ({ tasks: { ...s.tasks, [t.id]: t } }));
}

export function removeTaskLocal(id: string) {
  set((s) => {
    const tasks = { ...s.tasks };
    delete tasks[id];
    return { tasks, taskDetailId: s.taskDetailId === id ? null : s.taskDetailId };
  });
}

export function newTaskId(): string {
  return crypto.randomUUID();
}

export async function createTask(input: TaskPatch & { title: string; id?: string }): Promise<Task | null> {
  const { wsId, user } = st();
  if (!wsId || !user) return null;
  const id = input.id ?? newTaskId();
  const ts = new Date().toISOString();
  const optimistic: Task = {
    id,
    workspaceId: wsId,
    title: input.title,
    description: input.description ?? '',
    status: 'open',
    priority: input.priority ?? 4,
    dueDate: input.dueDate ?? null,
    dueTime: input.dueTime ?? null,
    recurrence: input.recurrence ?? null,
    reminderAt: input.reminderAt ?? null,
    assigneeId: input.assigneeId ?? null,
    createdBy: user.id,
    pageId: input.pageId ?? null,
    parentId: input.parentId ?? null,
    completedAt: null,
    completedBy: null,
    createdAt: ts,
    updatedAt: '', // so the server's copy always wins
  };
  set((s) => ({ tasks: { ...s.tasks, [id]: optimistic } }));
  try {
    const t = await post<Task>(`/workspaces/${wsId}/tasks`, { ...input, id });
    upsertTask(t);
    return t;
  } catch (e) {
    removeTaskLocal(id);
    errorToast(e);
    return null;
  }
}

/** Optimistic update with rollback. */
export async function updateTask(id: string, p: TaskPatch, opts: { silent?: boolean } = {}) {
  const prev = st().tasks[id];
  if (!prev) return;
  const optimistic: Task = { ...prev, ...p };
  if (p.status === 'done' && prev.status === 'open') {
    optimistic.completedAt = new Date().toISOString();
    optimistic.completedBy = st().user?.id ?? null;
  }
  set((s) => ({ tasks: { ...s.tasks, [id]: optimistic } }));
  try {
    const t = await patch<Task>(`/tasks/${id}`, p);
    set((s) => ({ tasks: { ...s.tasks, [id]: t } }));
    if (!opts.silent && p.status === 'done' && prev.recurrence && t.status === 'open') {
      toast(`Recurring task — next due ${describeDue(t.dueDate).toLowerCase()}`);
    }
    return t;
  } catch (e) {
    set((s) => ({ tasks: { ...s.tasks, [id]: prev } }));
    errorToast(e);
  }
}

export function toggleTask(id: string) {
  const t = st().tasks[id];
  if (!t) return;
  if (t.status === 'open') {
    set((s) => ({ lingering: { ...s.lingering, [id]: true } }));
    setTimeout(() => {
      set((s) => {
        const lingering = { ...s.lingering };
        delete lingering[id];
        return { lingering };
      });
    }, 1400);
    void updateTask(id, { status: 'done' });
    if (!t.recurrence) toast('Task completed', { action: { label: 'Undo', run: () => void updateTask(id, { status: 'open' }) } });
  } else {
    void updateTask(id, { status: 'open' });
  }
}

export async function deleteTask(id: string) {
  const prev = st().tasks[id];
  const children = Object.values(st().tasks).filter((t) => t.parentId === id);
  removeTaskLocal(id);
  for (const c of children) removeTaskLocal(c.id); // the server deletes subtasks with their parent
  try {
    await del(`/tasks/${id}`);
  } catch (e) {
    if (prev) set((s) => ({ tasks: { ...s.tasks, [id]: prev, ...Object.fromEntries(children.map((c) => [c.id, c])) } }));
    errorToast(e);
  }
}

/**
 * Apply one patch to many tasks (bulk actions). Each task is updated
 * optimistically on its own; one toast offers to undo the whole batch.
 */
export async function bulkUpdate(ids: string[], p: TaskPatch, label: string) {
  const before = ids.map((id) => st().tasks[id]).filter((t): t is Task => !!t);
  if (!before.length) return;
  await Promise.all(before.map((t) => updateTask(t.id, p, { silent: true })));
  toast(`${label} · ${before.length} task${before.length === 1 ? '' : 's'}`, {
    action: {
      label: 'Undo',
      run: () => {
        for (const t of before) {
          const undo: TaskPatch = {};
          for (const k of Object.keys(p) as (keyof TaskPatch)[]) (undo as Record<string, unknown>)[k] = t[k];
          void updateTask(t.id, undo, { silent: true });
        }
      },
    },
  });
}

export async function bulkDelete(ids: string[]) {
  await Promise.all(ids.map((id) => deleteTask(id)));
  toast(`Deleted ${ids.length} task${ids.length === 1 ? '' : 's'}`);
}
