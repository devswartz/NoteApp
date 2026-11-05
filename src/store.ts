import { create } from 'zustand';
import { ApiError, del, get, getToken, patch, post, setToken } from './api.ts';
import { describeDue } from './lib/format.ts';
import type {
  Member,
  PendingInvite,
  ServerEvent,
  Task,
  TaskPatch,
  Tree,
  User,
  Workspace,
} from '../shared/types.ts';

export interface Toast {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
  tone?: 'error' | 'info';
}

export interface QuickAddDefaults {
  pageId?: string | null;
  dueDate?: string | null;
  assigneeId?: string | null;
  text?: string;
}

interface State {
  user: User | null;
  workspaces: Workspace[];
  wsId: string | null;
  tree: Tree;
  treeLoaded: boolean;
  tasks: Record<string, Task>;
  tasksLoaded: boolean;
  members: Member[];
  invites: PendingInvite[];
  /** Tasks completed moments ago stay visible briefly so the check-off animation is seen. */
  lingering: Record<string, true>;
  online: boolean;

  // UI
  sidebarOpen: boolean;
  paletteOpen: boolean;
  quickAdd: QuickAddDefaults | null;
  taskDetailId: string | null;
  shortcutsOpen: boolean;
  toasts: Toast[];
}

const emptyTree: Tree = { notebooks: [], sections: [], pages: [] };

export const useStore = create<State>(() => ({
  user: null,
  workspaces: [],
  wsId: null,
  tree: emptyTree,
  treeLoaded: false,
  tasks: {},
  tasksLoaded: false,
  members: [],
  invites: [],
  lingering: {},
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  sidebarOpen: typeof window === 'undefined' ? true : window.innerWidth >= 900,
  paletteOpen: false,
  quickAdd: null,
  taskDetailId: null,
  shortcutsOpen: false,
  toasts: [],
}));

const set = useStore.setState;
const st = useStore.getState;

// ───────────── Toasts ─────────────
let toastSeq = 0;
export function toast(message: string, opts: Omit<Toast, 'id' | 'message'> = {}) {
  const id = ++toastSeq;
  set((s) => ({ toasts: [...s.toasts.slice(-3), { id, message, ...opts }] }));
  setTimeout(() => dismissToast(id), opts.action ? 6000 : 3500);
}
export function dismissToast(id: number) {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
export function errorToast(e: unknown) {
  toast(e instanceof Error ? e.message : 'Something went wrong', { tone: 'error' });
}

// ───────────── Session ─────────────
export async function bootstrap(): Promise<boolean> {
  if (!getToken()) return false;
  try {
    const user = await get<User>('/me');
    set({ user });
    await loadWorkspaces();
    connectEvents();
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) setToken(null);
    return false;
  }
}

export async function signIn(mode: 'login' | 'register', body: Record<string, string>) {
  const r = await post<{ token: string; user: User }>(`/auth/${mode}`, body);
  setToken(r.token);
  set({ user: r.user });
  await loadWorkspaces();
  connectEvents();
}

export async function signOut() {
  setToken(null);
  events?.close();
  events = null;
  // Clear locally cached note content.
  try {
    const dbs = await indexedDB.databases?.();
    for (const d of dbs ?? []) if (d.name?.startsWith('noteapp-page-')) indexedDB.deleteDatabase(d.name);
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem('noteapp.lastWs');
  } catch {
    /* ignore */
  }
  set({ user: null, workspaces: [], wsId: null, tree: emptyTree, tasks: {}, members: [], treeLoaded: false, tasksLoaded: false });
}

export async function loadWorkspaces() {
  const workspaces = await get<Workspace[]>('/workspaces');
  set({ workspaces });
  return workspaces;
}

export async function selectWorkspace(wsId: string) {
  if (st().wsId === wsId && st().treeLoaded) return;
  set({ wsId, tree: emptyTree, tasks: {}, members: [], treeLoaded: false, tasksLoaded: false });
  try {
    localStorage.setItem('noteapp.lastWs', wsId);
  } catch {
    /* ignore */
  }
  await Promise.all([loadTree(), loadTasks(), loadMembers()]);
}

export async function loadTree() {
  const wsId = st().wsId;
  if (!wsId) return;
  const tree = await get<Tree>(`/workspaces/${wsId}/tree`);
  if (st().wsId === wsId) set({ tree, treeLoaded: true });
}

export async function loadTasks() {
  const wsId = st().wsId;
  if (!wsId) return;
  const list = await get<Task[]>(`/workspaces/${wsId}/tasks`);
  if (st().wsId !== wsId) return;
  const tasks: Record<string, Task> = {};
  for (const t of list) tasks[t.id] = t;
  set({ tasks, tasksLoaded: true });
}

export async function loadMembers() {
  const wsId = st().wsId;
  if (!wsId) return;
  const r = await get<{ members: Member[]; invites: PendingInvite[] }>(`/workspaces/${wsId}/members`);
  if (st().wsId === wsId) set({ members: r.members, invites: r.invites });
}

// ───────────── Live events ─────────────
let events: EventSource | null = null;
const debounced = new Map<string, ReturnType<typeof setTimeout>>();
function debounce(key: string, fn: () => void, ms = 250) {
  clearTimeout(debounced.get(key));
  debounced.set(key, setTimeout(fn, ms));
}

function connectEvents() {
  events?.close();
  const token = getToken();
  if (!token) return;
  events = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  let first = true;
  events.onopen = () => {
    set({ online: true });
    // After a reconnect, resync anything we may have missed.
    if (!first && st().wsId) {
      void loadTree();
      void loadTasks();
    }
    first = false;
  };
  events.onerror = () => set({ online: navigator.onLine && events?.readyState === EventSource.OPEN });
  events.onmessage = (m) => {
    const ev = JSON.parse(m.data) as ServerEvent;
    const { wsId } = st();
    switch (ev.type) {
      case 'task':
        if (ev.task.workspaceId === wsId) upsertTask(ev.task);
        break;
      case 'task-deleted':
        if (ev.workspaceId === wsId) removeTaskLocal(ev.id);
        break;
      case 'tree':
        if (ev.workspaceId === wsId) debounce('tree', () => void loadTree(), 400);
        break;
      case 'members':
        if (ev.workspaceId === wsId) debounce('members', () => void loadMembers());
        break;
      case 'workspaces':
        debounce('ws', () => void loadWorkspaces());
        break;
    }
  };
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => set({ online: true }));
  window.addEventListener('offline', () => set({ online: false }));
}

// ───────────── Tasks ─────────────
function upsertTask(t: Task) {
  const prev = st().tasks[t.id];
  // Ignore stale echoes older than what we already have.
  if (prev && prev.updatedAt > t.updatedAt) return;
  set((s) => ({ tasks: { ...s.tasks, [t.id]: t } }));
}

function removeTaskLocal(id: string) {
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
  removeTaskLocal(id);
  try {
    await del(`/tasks/${id}`);
  } catch (e) {
    if (prev) set((s) => ({ tasks: { ...s.tasks, [id]: prev } }));
    errorToast(e);
  }
}

// ───────────── UI helpers ─────────────
export const ui = {
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  openQuickAdd: (d: QuickAddDefaults = {}) => set({ quickAdd: d }),
  closeQuickAdd: () => set({ quickAdd: null }),
  openTask: (id: string | null) => set({ taskDetailId: id }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebar: (open: boolean) => set({ sidebarOpen: open }),
  setShortcuts: (open: boolean) => set({ shortcutsOpen: open }),
};

export function memberById(id: string | null | undefined): Member | undefined {
  return id ? st().members.find((m) => m.id === id) : undefined;
}

export function canEditWorkspace(): boolean {
  const { workspaces, wsId } = st();
  const role = workspaces.find((w) => w.id === wsId)?.role;
  return role !== undefined && role !== 'viewer';
}
