// Live event hub: pushes task/tree/member changes over the /api/events
// WebSocket to every connected client allowed to see them, so the dashboard
// and open notes stay in sync. Server → client only; messages are JSON
// ServerEvent objects (shared/types.ts).
import type { IncomingMessage } from 'node:http';
import { WebSocket, type WebSocketServer } from 'ws';
import { db } from './db.ts';
import { taskVisible } from './access.ts';
import { tokenFromUpgrade, verifyAccessToken } from './auth.ts';
import type { ServerEvent } from '../shared/types.ts';

const clients = new Map<string, Set<WebSocket>>(); // userId -> open sockets

function addClient(userId: string, ws: WebSocket) {
  let set = clients.get(userId);
  if (!set) clients.set(userId, (set = new Set()));
  set.add(ws);
  ws.on('close', () => {
    set!.delete(ws);
    if (!set!.size) clients.delete(userId);
  });
}

export function attachEvents(wss: WebSocketServer) {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const auth = verifyAccessToken(tokenFromUpgrade(req));
    if (!auth) {
      ws.close(4401, 'Unauthorized');
      return;
    }
    addClient(auth.user.id, ws);
    // Close when the access token lapses; the client refreshes, reconnects and resyncs.
    const expiry = setTimeout(() => {
      ws.close(4401, 'Token expired');
      setTimeout(() => ws.readyState !== WebSocket.CLOSED && ws.terminate(), 2000).unref();
    }, Math.max(0, auth.expiresAt - Date.now()));
    // Detect dead connections (and keep proxies from closing idle ones).
    let alive = true;
    ws.on('pong', () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 25_000);
    ws.on('close', () => {
      clearInterval(ping);
      clearTimeout(expiry);
    });
    ws.on('error', () => ws.terminate());
  });
}

/** Close every event socket (on shutdown). 1012 = service restart; clients reconnect. */
export function closeAllEvents() {
  for (const set of clients.values()) for (const ws of set) ws.close(1012, 'Server restarting');
}

function send(userId: string, ev: ServerEvent) {
  const data = JSON.stringify(ev);
  for (const ws of clients.get(userId) ?? []) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

function membersOf(workspaceId: string): string[] {
  return (
    db.prepare('SELECT user_id FROM workspace_members WHERE workspace_id = ?').all(workspaceId) as { user_id: string }[]
  ).map((r) => r.user_id);
}

export function publish(ev: ServerEvent, opts: { userIds?: string[] } = {}) {
  if (opts.userIds) {
    for (const u of opts.userIds) send(u, ev);
    return;
  }
  if (ev.type === 'workspaces' || ev.type === 'resync' || ev.type === 'notification') return; // user-targeted only
  const ws = ev.type === 'task' ? ev.task.workspaceId : ev.workspaceId;
  for (const userId of membersOf(ws)) {
    if (!clients.has(userId)) continue;
    if (ev.type === 'task' && !taskVisible(ev.task.id, userId)) {
      // Tell clients that may have previously seen it to drop it.
      send(userId, { type: 'task-deleted', id: ev.task.id, workspaceId: ws });
      continue;
    }
    send(userId, ev);
  }
}
