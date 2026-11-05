// Workspace helpers used by more than one route module.
import { db, newId, now } from './db.ts';
import { seedWorkspace } from './seed.ts';

/** Create a workspace owned by `userId` and fill it with onboarding content. Call inside a transaction. */
export function createWorkspace(userId: string, name: string, personal: boolean): string {
  const id = newId();
  const ts = now();
  db.prepare('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').run(id, name, userId, ts);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").run(id, userId, ts);
  seedWorkspace(id, userId, personal);
  return id;
}

export function memberIds(workspaceId: string): string[] {
  return (db.prepare('SELECT user_id FROM workspace_members WHERE workspace_id = ?').all(workspaceId) as { user_id: string }[]).map(
    (r) => r.user_id,
  );
}
