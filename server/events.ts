// Live event hub: pushes task/tree/member changes over the /api/events
// WebSocket to every connected client allowed to see them, so the dashboard
// and open notes stay in sync. Server → client only; messages are JSON
// EventMessage objects (shared/types.ts).
//
// Reliability: every published event gets a sequence number and is kept in a
// bounded in-memory buffer. A client that reconnects with `?since=<boot>:<seq>`
// first gets every event it missed replayed (filtered for it as of now), or a
// single `resync` if the gap is no longer buffered or the server restarted
// (new boot id), in which case it reloads everything. Then the server sends
// `hello {boot, seq}`, which the client keeps as its cursor.
import type { IncomingMessage } from 'node:http';
import crypto from 'node:crypto';
import { WebSocket, type WebSocketServer } from 'ws';
import { db } from './db.ts';
import { pageAccess, pageLockedBy, taskVisible } from './access.ts';
import { runAsViewer } from './viewer.ts';
import { LOCKED_TASK_TITLE } from '../shared/config.ts';
import { tokenFromUpgrade, verifyAccessToken } from './auth.ts';
import type { EventMessage, ServerEvent } from '../shared/types.ts';

/** Identifies this server process; sequence numbers are only comparable within one boot. */
export const BOOT = crypto.randomBytes(6).toString('base64url');
const BUFFER_MAX = 2000;

interface Entry {
  seq: number;
  ev: ServerEvent;
  userIds?: string[];
}
const buffer: Entry[] = [];
let seq = 0;

const clients = new Map<string, Set<WebSocket>>(); // userId -> open sockets
/** The sign-in behind each socket: what its user's locked pages (server/locks.ts) look like depends on it. */
const socketSid = new WeakMap<WebSocket, string | null>();

function addClient(userId: string, ws: WebSocket) {
  let set = clients.get(userId);
  if (!set) clients.set(userId, (set = new Set()));
  set.add(ws);
  ws.on('close', () => {
    set!.delete(ws);
    if (!set!.size) clients.delete(userId);
  });
}

/** Parse `?since=<boot>:<seq>`. */
function parseSince(req: IncomingMessage): { boot: string; seq: number } | null {
  const raw = new URL(req.url ?? '', 'http://x').searchParams.get('since');
  const m = raw?.match(/^([\w-]+):(\d+)$/);
  return m ? { boot: m[1], seq: Number(m[2]) } : null;
}

export function attachEvents(wss: WebSocketServer) {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const auth = verifyAccessToken(tokenFromUpgrade(req));
    if (!auth) {
      ws.close(4401, 'Unauthorized');
      return;
    }
    if (!auth.user.emailVerified) {
      ws.close(4403, 'Email not verified');
      return;
    }
    socketSid.set(ws, auth.sid);
    addClient(auth.user.id, ws);
    // Close when the access token lapses; the client refreshes, reconnects and catches up.
    const expiry = setTimeout(() => {
      ws.close(4401, 'Token expired');
      setTimeout(() => ws.readyState !== WebSocket.CLOSED && ws.terminate(), 2000).unref();
    }, Math.max(0, auth.expiresAt - Date.now()));
    const since = parseSince(req);
    if (since) catchUp(ws, auth.user.id, since);
    // After any replay: the client adopts this as its cursor. If the socket drops before
    // hello arrives, the client still has its old cursor and the replay simply repeats.
    raw(ws, { type: 'hello', boot: BOOT, seq });
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

function catchUp(ws: WebSocket, userId: string, since: { boot: string; seq: number }) {
  if (since.boot !== BOOT || since.seq > seq) return raw(ws, { type: 'resync' });
  if (since.seq === seq) return; // nothing missed
  const oldest = buffer[0]?.seq ?? seq + 1;
  if (since.seq + 1 < oldest) return raw(ws, { type: 'resync' });
  for (const e of buffer) {
    if (e.seq <= since.seq) continue;
    const msg = forSocket(ws, userId, e);
    if (msg) raw(ws, msg);
  }
}

/** Close every event socket of one user (their account was deleted). 4401 = unauthorized: the client can't get a session back. */
export function closeUserEvents(userId: string) {
  for (const ws of [...(clients.get(userId) ?? [])]) {
    ws.close(4401, 'Account deleted');
    setTimeout(() => ws.readyState !== WebSocket.CLOSED && ws.terminate(), 2000).unref();
  }
}

/** Close every event socket (on shutdown). 1012 = service restart; clients reconnect. */
export function closeAllEvents() {
  for (const set of clients.values()) for (const ws of set) ws.close(1012, 'Server restarting');
}

function raw(ws: WebSocket, msg: EventMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function isMember(workspaceId: string, userId: string): boolean {
  return !!db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(workspaceId, userId);
}

/** Does what this event carries for `userId` depend on whether their sign-in has their locked pages unlocked? */
function lockSensitive(ev: ServerEvent, userId: string): boolean {
  const page = ev.type === 'task' ? ev.task.pageId : ev.type === 'comments' ? ev.pageId : null;
  return pageLockedBy(page) === userId;
}

/**
 * messageFor, as the socket's own sign-in: a task on its user's locked page goes out as "Locked task" (title and
 * text withheld) unless this sign-in has it unlocked, and comment events on it only while unlocked.
 */
function forSocket(ws: WebSocket, userId: string, e: Entry): EventMessage | null {
  return runAsViewer({ userId, sid: socketSid.get(ws) ?? null }, () => {
    const msg = messageFor(userId, e);
    if (msg?.type !== 'task' || !msg.task.pageId || pageLockedBy(msg.task.pageId) !== userId || pageAccess(msg.task.pageId, userId)) return msg;
    return { ...msg, task: { ...msg.task, title: LOCKED_TASK_TITLE, description: '', tagIds: [], locked: true } };
  });
}

/** What `userId` should receive for buffered entry `e`, judged by current permissions (null = nothing). */
function messageFor(userId: string, e: Entry): EventMessage | null {
  const { ev } = e;
  if (e.userIds) return e.userIds.includes(userId) ? { ...ev, seq: e.seq } : null;
  // User-targeted only: never broadcast (a notification without explicit recipients goes nowhere).
  if (ev.type === 'workspaces' || ev.type === 'resync' || ev.type === 'notification' || ev.type === 'shared-pages') return null;
  const wsId = ev.type === 'task' ? ev.task.workspaceId : ev.workspaceId;
  // Comments go to whoever can see the page (members of its notebook, and page shares, #98);
  // withheld from anyone else, live and on replay.
  if (ev.type === 'comments') return pageAccess(ev.pageId, userId) ? { ...ev, seq: e.seq } : null;
  if (!isMember(wsId, userId)) {
    // Outside the workspace, only tasks on a page shared with you (TASK_VISIBLE covers that).
    if (ev.type !== 'task') return null;
    // Never a task-deleted here: that would hand strangers task ids on replay.
    return taskVisible(ev.task.id, userId) ? { ...ev, seq: e.seq } : null;
  }
  if (ev.type === 'task' && !taskVisible(ev.task.id, userId)) {
    // Tell clients that may have previously seen it to drop it.
    return { type: 'task-deleted', id: ev.task.id, workspaceId: wsId, seq: e.seq };
  }
  return { ...ev, seq: e.seq };
}

/** People holding a page share on `pageId` (they may be outside the workspace). */
function pageShareHolders(pageId: string | null | undefined): string[] {
  if (!pageId) return [];
  return (db.prepare('SELECT user_id FROM page_shares WHERE page_id = ?').all(pageId) as { user_id: string }[]).map((r) => r.user_id);
}

function membersOf(workspaceId: string): string[] {
  return (
    db.prepare('SELECT user_id FROM workspace_members WHERE workspace_id = ?').all(workspaceId) as { user_id: string }[]
  ).map((r) => r.user_id);
}

/**
 * Publish an event to everyone allowed to see it (workspace members, filtered
 * per user for tasks), or only to `userIds`. Every publish is buffered with a
 * sequence number for catch-up after a reconnect.
 */
export function publish(ev: ServerEvent, opts: { userIds?: string[] } = {}) {
  const entry: Entry = { seq: ++seq, ev, userIds: opts.userIds };
  buffer.push(entry);
  if (buffer.length > BUFFER_MAX) buffer.splice(0, buffer.length - BUFFER_MAX);
  let recipients: string[];
  if (opts.userIds) recipients = opts.userIds;
  else if (ev.type === 'workspaces' || ev.type === 'resync' || ev.type === 'notification' || ev.type === 'shared-pages') recipients = [];
  else {
    recipients = membersOf(ev.type === 'task' ? ev.task.workspaceId : ev.workspaceId);
    const page = ev.type === 'task' ? ev.task.pageId : ev.type === 'comments' ? ev.pageId : null;
    if (page) recipients = [...new Set([...recipients, ...pageShareHolders(page)])];
  }
  for (const userId of recipients) {
    const sockets = clients.get(userId);
    if (!sockets?.size) continue;
    // One message per user, except where a locked page is involved: then each socket gets what its sign-in may see.
    const perSocket = lockSensitive(entry.ev, userId);
    const shared = perSocket ? null : messageFor(userId, entry);
    if (!perSocket && !shared) continue;
    const data = shared && JSON.stringify(shared);
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (data) ws.send(data);
      else {
        const msg = forSocket(ws, userId, entry);
        if (msg) ws.send(JSON.stringify(msg));
      }
    }
  }
}

/** For /api/admin/stats. */
export function eventStats() {
  let sockets = 0;
  for (const set of clients.values()) sockets += set.size;
  return { users: clients.size, sockets };
}
