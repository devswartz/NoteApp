// Task state and optimistic task actions.
import { del, patch, post } from '../api.ts';
import { cached } from './cache.ts';
import { describeDue } from '../lib/format.ts';
import { set, st } from './state.ts';
import { errorToast, toast } from './toasts.ts';
import type { Task, TaskPatch } from '../../shared/types.ts';
import { TaskWrites } from './taskWrites.ts';

/** Orders each task's create / update / delete requests (see taskWrites.ts, BUG-6). */
const writes = new TaskWrites<Task, TaskPatch>();

/**
 * Tasks on pages shared from workspaces I'm not working in (#98) live in their own store
 * (components/sharing/sharedPages.ts), which plugs itself in here so the same task actions
 * (create, tick, edit, delete) work on them: they go to the task's own workspace.
 */
export interface ForeignTasks {
  get(id: string): Task | undefined;
  put(t: Task): void;
  remove(id: string): void;
  /** The workspace of a shared page that isn't the current workspace, if `pageId` is one. */
  workspaceOfPage(pageId: string): string | undefined;
}
let foreign: ForeignTasks | null = null;
export function setForeignTasks(f: ForeignTasks) {
  foreign = f;
}
/** A task from the workspace store, or else from a shared page's (with `own` saying which). */
function lookup(id: string): { t: Task | undefined; own: boolean } {
  const t = st().tasks[id];
  return t ? { t, own: true } : { t: foreign?.get(id), own: false };
}
function store(t: Task, own: boolean) {
  if (own) set((s) => ({ tasks: { ...s.tasks, [t.id]: t } }));
  else foreign?.put(t);
}

/** The local copy of a task from the server, with edits that are still on their way laid over it. */
function withUnsaved(t: Task): Task {
  const o = writes.overlay(t.id);
  return o ? { ...t, ...o } : t;
}

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
  // A task deleted here stays deleted, even if its create response or an echo arrives later.
  if (writes.isDeleted(t.id)) return;
  const prev = st().tasks[t.id];
  // Ignore stale echoes older than what we already have.
  if (prev && prev.updatedAt > t.updatedAt) return;
  set((s) => ({ tasks: { ...s.tasks, [t.id]: withUnsaved(t) } }));
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
  const { wsId: current, user } = st();
  if (!current || !user) return null;
  // On a page shared from another workspace, the task belongs to that workspace (#98).
  const other = input.pageId ? foreign?.workspaceOfPage(input.pageId) : undefined;
  const wsId = other ?? current;
  const own = !other;
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
    teamId: input.teamId ?? null,
    tagIds: input.tagIds ?? [],
    assignedBy: input.assigneeId ? user.id : null,
    completedAt: null,
    completedBy: null,
    createdAt: ts,
    updatedAt: '', // so the server's copy always wins
  };
  store(optimistic, own);
  try {
    const t = await writes.create(id, () => post<Task>(`/workspaces/${wsId}/tasks`, { ...input, id }));
    if (writes.isDeleted(id)) return null; // deleted while the create was in flight; the DELETE follows
    if (own) upsertTask(t);
    else foreign?.put(t);
    return t;
  } catch (e) {
    if (writes.isDeleted(id)) return null;
    if (own) removeTaskLocal(id);
    else foreign?.remove(id);
    errorToast(e);
    return null;
  }
}

/** Optimistic update with rollback. */
export async function updateTask(id: string, p: TaskPatch, opts: { silent?: boolean } = {}) {
  const { t: prev, own } = lookup(id);
  if (!prev) return;
  const optimistic: Task = { ...prev, ...p };
  if (p.assigneeId !== undefined && p.assigneeId !== prev.assigneeId) optimistic.assignedBy = p.assigneeId ? (st().user?.id ?? null) : null;
  if (p.status === 'done' && prev.status === 'open') {
    optimistic.completedAt = new Date().toISOString();
    optimistic.completedBy = st().user?.id ?? null;
  }
  store(optimistic, own);
  try {
    // Waits behind the task's create (and earlier writes); patches queued meanwhile go as one PATCH.
    const t = await writes.update(id, p, (merged) => patch<Task>(`/tasks/${id}`, merged));
    if (!t || writes.isDeleted(id)) return; // dropped: the task was deleted or never created
    store(withUnsaved(t), own);
    if (!opts.silent && p.status === 'done' && prev.recurrence && t.status === 'open') {
      toast(`Recurring task — next due ${describeDue(t.dueDate).toLowerCase()}`);
    }
    return t;
  } catch (e) {
    if (writes.isDeleted(id) || !lookup(id).t) return;
    store(prev, own);
    errorToast(e);
  }
}

export function toggleTask(id: string) {
  const { t } = lookup(id);
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
  const { t: prev, own } = lookup(id);
  if (!own) {
    foreign?.remove(id);
    try {
      await writes.remove(id, () => del(`/tasks/${id}`));
    } catch (e) {
      writes.undelete(id);
      if (prev) foreign?.put(prev);
      errorToast(e);
    }
    return;
  }
  const children = Object.values(st().tasks).filter((t) => t.parentId === id);
  removeTaskLocal(id);
  for (const c of children) removeTaskLocal(c.id); // the server deletes subtasks with their parent
  try {
    // Waits for a create still in flight, so the server never sees DELETE before POST.
    await writes.remove(id, () => del(`/tasks/${id}`));
  } catch (e) {
    writes.undelete(id);
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

/** Tasks deleted from the task panel or the bulk bar in this tab: their placeholder in a page goes after the Undo window. */
export const deletedHere = new Set<string>();
/** Titles of tasks deleted from the task panel or the bulk bar in this tab (their subtasks too), by id. */
export const deletedTitles = new Map<string, string>();
/** How long the Undo toast stays (toasts.ts), plus a moment: a page's placeholder for the task is removed after it. */
export const UNDO_WINDOW_MS = 7000;

/** Delete tasks (and their subtasks) with an Undo toast; Undo brings them back with the same ids, so a page's task line is live again. */
export async function deleteTasksWithUndo(ids: string[]) {
  const all = st().tasks;
  const snap = new Map<string, Task>();
  for (const id of ids) {
    const t = all[id];
    if (!t) continue;
    snap.set(id, t);
    for (const c of Object.values(all)) if (c.parentId === id) snap.set(c.id, c);
  }
  if (!snap.size) return;
  ids.forEach((id) => deletedHere.add(id));
  // Subtasks go with their task. Where one is written in the task's notes, the task's line going leaves it as a
  // plain line with its title (deletedTitles), so nothing written in the page is lost.
  for (const t of snap.values()) deletedTitles.set(t.id, t.title);
  await Promise.all(ids.map((id) => deleteTask(id)));
  const onPage = [...snap.values()].some((t) => t.pageId && !t.parentId);
  const n = ids.length;
  toast(`${n === 1 ? 'Task' : `${n} tasks`} deleted${onPage ? ' (and removed from the page)' : ''}`, {
    action: {
      label: 'Undo',
      run: () => void restoreTasks([...snap.values()]).then(() => ids.forEach((id) => deletedHere.delete(id))),
    },
  });
}

/** Put deleted tasks back with their old ids (parents first), including done ones. */
async function restoreTasks(tasks: Task[]) {
  for (const t of [...tasks].sort((a, b) => Number(!!a.parentId) - Number(!!b.parentId))) {
    const back = await createTask({
      id: t.id,
      title: t.title,
      description: t.description,
      priority: t.priority,
      dueDate: t.dueDate,
      dueTime: t.dueTime,
      recurrence: t.recurrence,
      reminderAt: t.reminderAt,
      assigneeId: t.assigneeId,
      pageId: t.pageId,
      parentId: t.parentId,
      teamId: t.teamId,
      tagIds: t.tagIds,
    });
    if (back && t.status === 'done') await toggleTask(t.id);
  }
  toast('Restored');
}

export async function bulkDelete(ids: string[]) {
  await deleteTasksWithUndo(ids);
}
