// Live event client: applies server-pushed task/tree/member changes.
import { backoffMs, freshAccessToken, reauthorize, wsProtocols, wsUrl } from '../api.ts';
import { set, st } from './state.ts';
import { loadMembers, loadTree, loadWorkspaces } from './workspace.ts';
import { loadTasks, removeTaskLocal, upsertTask } from './tasks.ts';
import type { ServerEvent } from '../../shared/types.ts';
import { commentsChanged } from '../editor/collabComments.ts';

let socket: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let attempts = 0;
let wanted = false;
/** Backoff resets only after a socket has stayed up a while (the server may accept, then close with 4401). */
let healthyTimer: ReturnType<typeof setTimeout> | null = null;
const HEALTHY_AFTER_MS = 10_000;
const debounced = new Map<string, ReturnType<typeof setTimeout>>();
function debounce(key: string, fn: () => void, ms = 250) {
  clearTimeout(debounced.get(key));
  debounced.set(key, setTimeout(fn, ms));
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
  void open(true);
}

async function open(first: boolean) {
  if (!wanted) return;
  await freshAccessToken();
  if (!wanted || socket) return;
  const ws = new WebSocket(wsUrl('/api/events'), wsProtocols());
  socket = ws;
  ws.onopen = () => {
    healthyTimer = setTimeout(() => (attempts = 0), HEALTHY_AFTER_MS);
    set({ online: true });
    // After a reconnect, resync anything we may have missed.
    if (!first && st().wsId) {
      void loadTree();
      void loadTasks();
    }
  };
  ws.onclose = (e) => {
    if (healthyTimer) clearTimeout(healthyTimer);
    if (socket !== ws) return; // replaced or disconnected deliberately
    socket = null;
    set({ online: false });
    if (!wanted) return;
    if (e.code === 4401) {
      // Access token expired or rejected: refresh, then reconnect with backoff
      // (so a server that keeps rejecting can't cause a tight loop).
      void reauthorize().then((r) => r !== 'signed-out' && schedule());
      return;
    }
    schedule();
  };
  ws.onmessage = (m) => handle(JSON.parse(String(m.data)) as ServerEvent);
}

function schedule() {
  if (!wanted) return;
  retryTimer = setTimeout(() => void open(false), backoffMs(attempts++));
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
    case 'comments':
      if (ev.workspaceId === wsId) commentsChanged(ev.pageId);
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
      void open(false);
    }
  });
  window.addEventListener('offline', () => set({ online: false }));
}
