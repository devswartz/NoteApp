// Server-sent events hub: pushes task/tree changes to every connected client
// that is allowed to see them, so the dashboard and notes stay in sync live.
import type { Response } from 'express';
import { db } from './db.ts';
import { taskVisible } from './access.ts';
import type { ServerEvent } from '../shared/types.ts';

const clients = new Map<string, Set<Response>>(); // userId -> open streams

export function addClient(userId: string, res: Response) {
  let set = clients.get(userId);
  if (!set) clients.set(userId, (set = new Set()));
  set.add(res);
  res.on('close', () => {
    set!.delete(res);
    if (!set!.size) clients.delete(userId);
  });
}

function send(userId: string, ev: ServerEvent) {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients.get(userId) ?? []) res.write(data);
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
  if (ev.type === 'workspaces') return;
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

// Keep proxies from closing idle streams.
setInterval(() => {
  for (const set of clients.values()) for (const res of set) res.write(': ping\n\n');
}, 25_000).unref();
