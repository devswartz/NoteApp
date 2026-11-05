// Live event client: applies server-pushed task/tree/member changes.
// Tracks the server's boot id + last sequence number, and reconnects with
// ?since= so missed events are replayed; on `resync` it reloads everything.
import { backoffMs, freshAccessToken, reauthorize, wsProtocols, wsUrl } from '../api.ts';
import { set, st } from './state.ts';
import { loadMembers, loadTree, loadWorkspaces } from './workspace.ts';
import { loadTasks, removeTaskLocal, upsertTask } from './tasks.ts';
import type { EventMessage, ServerEvent } from '../../shared/types.ts';
import { commentsChanged } from '../editor/collabComments.ts';
import { receiveNotification } from '../components/sharing/inbox.ts';
import { toast } from './toasts.ts';

let socket: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let attempts = 0;
let wanted = false;
/** Last event seen, for catch-up on reconnect. Reset when the server restarts. */
let cursor: { boot: string; seq: number } | null = null;
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
  cursor = null; // new session: start fresh (bootstrap loads everything)
  wanted = true;
  attempts = 0;
  void open(true);
}

async function open(first: boolean) {
  if (!wanted) return;
  await freshAccessToken();
  if (!wanted || socket) return;
  const since = !first && cursor ? `?since=${cursor.boot}:${cursor.seq}` : '';
  // Without a cursor we can't ask for a replay, so reload what the channel feeds once we're live:
  // - the very first connect: the initial data was loaded over REST before (or while) this socket
  //   opened, and changes made in that gap would otherwise be lost until a reload (BUG-4);
  // - a reconnect before any hello ever arrived.
  const reloadWhenLive = !cursor;
  const ws = new WebSocket(wsUrl(`/api/events${since}`), wsProtocols());
  socket = ws;
  ws.onopen = () => {
    healthyTimer = setTimeout(() => (attempts = 0), HEALTHY_AFTER_MS);
    set({ online: true });
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
  ws.onmessage = (m) => {
    let msg: EventMessage;
    try {
      msg = JSON.parse(String(m.data)) as EventMessage;
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      // Sent after any replay (or `resync`): from here on every change reaches us live.
      const hadCursor = !!cursor;
      cursor = { boot: msg.boot, seq: msg.seq };
      if (reloadWhenLive && !hadCursor) resync(); // close the gap before the first hello (see above)
      return;
    }
    if (typeof msg.seq === 'number' && cursor) cursor.seq = Math.max(cursor.seq, msg.seq);
    handle(msg);
  };
}

function schedule() {
  if (!wanted) return;
  retryTimer = setTimeout(() => void open(false), backoffMs(attempts++));
}

/** Reload everything the event channel feeds (after a gap we can't replay). */
function resync() {
  void loadWorkspaces();
  if (!st().wsId) return;
  void loadTree();
  void loadTasks();
  void loadMembers();
}

function handle(ev: ServerEvent) {
  const { wsId } = st();
  switch (ev.type) {
    case 'resync':
      resync();
      break;
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
    case 'notification':
      receiveNotification(ev.notification);
      if (ev.notification.kind === 'mention' || ev.notification.kind === 'shared' || ev.notification.kind === 'assigned')
        toast(ev.notification.title);
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
