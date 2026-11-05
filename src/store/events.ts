// Live event client: applies server-pushed task/tree/member changes.
import { getToken } from '../api.ts';
import { set, st } from './state.ts';
import { loadMembers, loadTree, loadWorkspaces } from './workspace.ts';
import { loadTasks, removeTaskLocal, upsertTask } from './tasks.ts';
import type { ServerEvent } from '../../shared/types.ts';

let events: EventSource | null = null;
const debounced = new Map<string, ReturnType<typeof setTimeout>>();
function debounce(key: string, fn: () => void, ms = 250) {
  clearTimeout(debounced.get(key));
  debounced.set(key, setTimeout(fn, ms));
}

export function disconnectEvents() {
  events?.close();
  events = null;
}

export function connectEvents() {
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
