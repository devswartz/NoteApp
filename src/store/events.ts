// Live event client: applies server-pushed task/tree/member changes.
import { getToken } from '../api.ts';
import { set, st } from './state.ts';
import { loadMembers, loadTree, loadWorkspaces } from './workspace.ts';
import { loadTasks, removeTaskLocal, upsertTask } from './tasks.ts';
import type { ServerEvent } from '../../shared/types.ts';

let socket: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let attempts = 0;
let wanted = false;
const debounced = new Map<string, ReturnType<typeof setTimeout>>();
function debounce(key: string, fn: () => void, ms = 250) {
  clearTimeout(debounced.get(key));
  debounced.set(key, setTimeout(fn, ms));
}

function eventsUrl(token: string) {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events?token=${encodeURIComponent(token)}`;
}

export function disconnectEvents() {
  wanted = false;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  socket?.close();
  socket = null;
}

/** Open the live event socket; reconnects with backoff until disconnectEvents(). */
export function connectEvents() {
  disconnectEvents();
  wanted = true;
  attempts = 0;
  open(true);
}

function open(first: boolean) {
  const token = getToken();
  if (!token || !wanted) return;
  const ws = new WebSocket(eventsUrl(token));
  socket = ws;
  ws.onopen = () => {
    attempts = 0;
    set({ online: true });
    // After a reconnect, resync anything we may have missed.
    if (!first && st().wsId) {
      void loadTree();
      void loadTasks();
    }
  };
  ws.onclose = (e) => {
    if (socket !== ws) return; // replaced or disconnected deliberately
    socket = null;
    set({ online: false });
    if (!wanted || e.code === 4401) return; // signed out / token rejected
    const delay = Math.min(30_000, 1000 * 2 ** attempts++) * (0.75 + Math.random() / 2);
    retryTimer = setTimeout(() => open(false), delay);
  };
  ws.onmessage = (m) => handle(JSON.parse(String(m.data)) as ServerEvent);
}

function handle(ev: ServerEvent) {
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
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    set({ online: true });
    // Reconnect right away instead of waiting out the backoff.
    if (wanted && !socket) {
      if (retryTimer) clearTimeout(retryTimer);
      attempts = 0;
      open(false);
    }
  });
  window.addEventListener('offline', () => set({ online: false }));
}
