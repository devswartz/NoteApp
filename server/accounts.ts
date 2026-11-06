// Account deletion. deleteAccount(userId) does the whole job in one transaction and is safe to reuse
// (e.g. to auto-delete accounts that never verified their email): it checks no password and sends no email.
// The password check for a signed-in user lives in the route (server/routes/auth.ts).
//
// What happens to what is documented in ARCHITECTURE.md ("Account deletion"); USER_FK_DECISIONS below is the
// same table in code, and tests/account-deletion.test.ts fails if a table gains a foreign key to users that
// isn't handled here.
import fs from 'node:fs';
import path from 'node:path';
import { db, DELETED_USER_ID } from './db.ts';
import { FILES_DIR } from './config.ts';
import { accessChanged } from './access.ts';
import { closeRoom, closeUserCollab } from './collab.ts';
import { closeUserEvents, publish } from './events.ts';
import { rowToTask } from './tasks.ts';
import type { AccountDeletionPreview } from '../shared/types.ts';

export { DELETED_USER_ID };

/**
 * Every column that references users(id) WITHOUT `ON DELETE CASCADE / SET NULL`, i.e. the ones that would block
 * the DELETE. For content that stays, they are re-pointed at the stand-in user "Deleted user" (DELETED_USER_ID).
 * Columns that cascade or null themselves are listed in ARCHITECTURE.md and checked by the FK test.
 */
export const USER_FK_DECISIONS: { table: string; column: string; note: string }[] = [
  { table: 'workspaces', column: 'created_by', note: 'workspaces that survive keep existing; creator shows as deleted' },
  { table: 'workspace_invites', column: 'invited_by', note: 'invites the user sent are deleted first; this only guards against leftovers' },
  { table: 'notebooks', column: 'created_by', note: 'private notebooks are deleted first; shared notebooks stay' },
  { table: 'pages', column: 'created_by', note: 'pages in shared notebooks stay' },
  { table: 'pages', column: 'updated_by', note: 'last editor shows as deleted' },
  { table: 'tasks', column: 'created_by', note: 'tasks in shared places stay' },
  { table: 'tasks', column: 'completed_by', note: 'completion stays, completer shows as deleted' },
  { table: 'files', column: 'created_by', note: 'files in shared places stay' },
  { table: 'notebook_shares', column: 'created_by', note: 'shares granted by the user on notebooks that stay' },
  { table: 'comment_threads', column: 'created_by', note: 'threads in shared notebooks stay' },
  { table: 'comment_threads', column: 'resolved_by', note: 'resolution stays' },
  { table: 'comments', column: 'author_id', note: 'comments stay, author shows as deleted' },
  { table: 'templates', column: 'created_by', note: 'private templates are deleted first; workspace-wide ones stay' },
];

/** Create the stand-in user if needed. It can't sign in (the hash isn't bcrypt), is never verified, and sorts last by created_at. */
function ensureTombstone() {
  db.prepare(
    `INSERT OR IGNORE INTO users (id, email, name, password_hash, color, created_at, email_verified_at)
     VALUES (?, 'deleted-user@invalid.invalid', 'Deleted user', '!', '#9ca3af', '9999-12-31T23:59:59.999Z', NULL)`,
  ).run(DELETED_USER_ID);
}

/** First column of every row. */
const ids = (sql: string, ...args: unknown[]): string[] => (db.prepare(sql).all(...args) as Record<string, string>[]).map((r) => Object.values(r)[0]);
const marks = (n: number) => Array(n).fill('?').join(',') || 'NULL';

interface OwnedPlan {
  id: string;
  name: string;
  /** keep: another owner exists. promote: the longest-standing admin becomes owner. delete: nobody to hand it to. */
  outcome: 'keep' | 'promote' | 'delete';
  newOwnerId?: string;
  newOwnerName?: string;
}

function planOwned(userId: string): OwnedPlan[] {
  const owned = db
    .prepare("SELECT w.id, w.name FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = ? AND m.role = 'owner' ORDER BY w.created_at, w.rowid")
    .all(userId) as { id: string; name: string }[];
  return owned.map((w): OwnedPlan => {
    if (db.prepare("SELECT 1 FROM workspace_members WHERE workspace_id = ? AND role = 'owner' AND user_id <> ?").get(w.id, userId)) return { ...w, outcome: 'keep' };
    const admin = db
      .prepare(
        `SELECT m.user_id AS id, u.name FROM workspace_members m JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = ? AND m.role = 'admin' AND m.user_id <> ? ORDER BY m.joined_at, m.rowid LIMIT 1`,
      )
      .get(w.id, userId) as { id: string; name: string } | undefined;
    return admin ? { ...w, outcome: 'promote', newOwnerId: admin.id, newOwnerName: admin.name } : { ...w, outcome: 'delete' };
  });
}

/** What deleting this account would do to workspaces and private notebooks (read-only). */
export function deletionPreview(userId: string): AccountDeletionPreview {
  const plan = planOwned(userId);
  const left = db
    .prepare("SELECT w.id, w.name FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = ? AND m.role <> 'owner' ORDER BY w.name")
    .all(userId) as { id: string; name: string }[];
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM notebooks WHERE created_by = ? AND visibility = 'private'").get(userId) as { n: number };
  return {
    deletedWorkspaces: plan.filter((p) => p.outcome === 'delete').map((p) => ({ id: p.id, name: p.name })),
    transferredWorkspaces: plan.filter((p) => p.outcome === 'promote').map((p) => ({ id: p.id, name: p.name, newOwnerName: p.newOwnerName! })),
    sharedOwnership: plan.filter((p) => p.outcome === 'keep').map((p) => ({ id: p.id, name: p.name })),
    leftWorkspaces: left,
    privateNotebooks: n,
  };
}

/**
 * Delete a user and everything that is theirs; content they shared with others stays (ARCHITECTURE.md).
 * One transaction; file bytes are removed after it commits. Returns false if there is no such user.
 * Never checks a password and never sends mail.
 */
export function deleteAccount(userId: string): boolean {
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as { email: string } | undefined;
  if (!user || userId === DELETED_USER_ID) return false;

  const memberWorkspaces = new Set<string>(); // surviving workspaces whose member list changed
  const treeWorkspaces = new Set<string>(); // surviving workspaces that lost a private notebook
  const newOwners = new Set<string>();
  const goneTasks: { id: string; workspaceId: string }[] = [];
  let unassigned: string[] = [];
  const pageIds: string[] = [];
  const filePaths: string[] = [];
  let deletedWorkspaceMembers: string[] = [];

  db.transaction(() => {
    ensureTombstone();
    const plan = planOwned(userId);
    const doomed = plan.filter((p) => p.outcome === 'delete').map((p) => p.id);

    for (const w of ids('SELECT workspace_id FROM workspace_members WHERE user_id = ?', userId)) if (!doomed.includes(w)) memberWorkspaces.add(w);
    if (doomed.length)
      deletedWorkspaceMembers = ids(`SELECT DISTINCT user_id FROM workspace_members WHERE workspace_id IN (${marks(doomed.length)}) AND user_id <> ?`, ...doomed, userId);

    // 1. Private notebooks the user created, and the pages in them (and the pages of workspaces that go).
    const nbs = db.prepare("SELECT id, workspace_id FROM notebooks WHERE created_by = ? AND visibility = 'private'").all(userId) as { id: string; workspace_id: string }[];
    const nbIds = nbs.map((n) => n.id);
    for (const n of nbs) if (!doomed.includes(n.workspace_id)) treeWorkspaces.add(n.workspace_id);
    const pagesOf = (notebooks: string[]) =>
      notebooks.length ? ids(`SELECT p.id FROM pages p JOIN sections s ON s.id = p.section_id WHERE s.notebook_id IN (${marks(notebooks.length)})`, ...notebooks) : [];
    const doomedNbIds = doomed.length ? ids(`SELECT id FROM notebooks WHERE workspace_id IN (${marks(doomed.length)})`, ...doomed) : [];
    const privatePageIds = pagesOf(nbIds);
    pageIds.push(...privatePageIds, ...pagesOf(doomedNbIds));

    // 2. Tasks: on those private pages, plus the user's own tasks that only they can see (with their subtasks).
    const roots = [
      ...ids('SELECT id FROM tasks WHERE private_owner_only = 1 AND created_by = ? AND (assignee_id IS NULL OR assignee_id = ?)', userId, userId),
      ...(privatePageIds.length ? ids(`SELECT id FROM tasks WHERE page_id IN (${marks(privatePageIds.length)})`, ...privatePageIds) : []),
    ];
    const taskIds = new Set(roots);
    for (const r of roots) for (const c of ids('SELECT id FROM tasks WHERE parent_id = ?', r)) taskIds.add(c);
    for (const id of taskIds) {
      const t = db.prepare('SELECT workspace_id FROM tasks WHERE id = ?').get(id) as { workspace_id: string };
      if (!doomed.includes(t.workspace_id)) goneTasks.push({ id, workspaceId: t.workspace_id });
    }
    // Tasks that stay but lose their assignee (the FK nulls it; remember them to tell clients).
    unassigned = ids('SELECT id FROM tasks WHERE assignee_id = ?', userId).filter((id) => !taskIds.has(id));
    for (const id of taskIds) db.prepare('DELETE FROM tasks WHERE id = ?').run(id);

    // 3. Files whose bytes must go: in workspaces that are deleted, on deleted pages, copies owned by private templates,
    //    and the user's detached files (no workspace: only the uploader could see them).
    const privTemplates = ids("SELECT id FROM templates WHERE created_by = ? AND visibility = 'private'", userId);
    const fileRows = new Map<string, string>();
    const collect = (sql: string, ...args: unknown[]) => {
      for (const r of db.prepare(sql).all(...args) as { id: string; ext: string }[]) fileRows.set(r.id, r.ext);
    };
    if (doomed.length) collect(`SELECT id, ext FROM files WHERE workspace_id IN (${marks(doomed.length)})`, ...doomed);
    if (pageIds.length) collect(`SELECT id, ext FROM files WHERE page_id IN (${marks(pageIds.length)})`, ...pageIds);
    if (privTemplates.length) collect(`SELECT id, ext FROM files WHERE template_id IN (${marks(privTemplates.length)})`, ...privTemplates);
    collect('SELECT id, ext FROM files WHERE created_by = ? AND workspace_id IS NULL', userId);
    for (const [id, ext] of fileRows) {
      filePaths.push(path.join(FILES_DIR, id + ext));
      db.prepare('DELETE FROM files WHERE id = ?').run(id);
    }

    // 4. Search index and activity entries about what goes (neither has a foreign key).
    for (const id of pageIds) db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(id);
    for (const id of [...nbIds, ...doomedNbIds]) db.prepare('DELETE FROM activity WHERE notebook_id = ?').run(id);
    db.prepare('DELETE FROM activity WHERE private = 1 AND actor_id = ?').run(userId);

    // 5. Delete private templates, private notebooks (sections, pages, versions, threads, comments, shares cascade), then doomed workspaces.
    for (const id of privTemplates) db.prepare('DELETE FROM templates WHERE id = ?').run(id);
    for (const id of nbIds) db.prepare('DELETE FROM notebooks WHERE id = ?').run(id);
    for (const id of doomed) db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);

    // 6. Ownership handover.
    for (const p of plan) {
      if (p.outcome !== 'promote') continue;
      db.prepare("UPDATE workspace_members SET role = 'owner' WHERE workspace_id = ? AND user_id = ?").run(p.id, p.newOwnerId);
      newOwners.add(p.newOwnerId!);
    }

    // 7. Invites they sent (all still pending: accepting deletes the row) and invites addressed to their email.
    db.prepare('DELETE FROM workspace_invites WHERE invited_by = ? OR email = ?').run(userId, user.email);
    db.prepare('DELETE FROM page_invites WHERE email = ?').run(user.email); // those they sent cascade

    // 8. Re-point authorship in what stays, then delete the user. Memberships, notebook shares, sessions, push and device
    //    tokens, notifications, reminders and settings cascade; assignee, activity actor and version author become NULL.
    for (const d of USER_FK_DECISIONS) db.prepare(`UPDATE ${d.table} SET ${d.column} = ? WHERE ${d.column} = ?`).run(DELETED_USER_ID, userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  })();

  // After commit: bytes, sockets, access caches, events. Nothing here can fail the deletion.
  for (const p of filePaths) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* already gone */
    }
  }
  closeUserEvents(userId);
  closeUserCollab(userId);
  for (const id of pageIds) closeRoom(id);
  accessChanged(); // other people's open pages in notebooks that disappeared or were shared by the user
  for (const g of goneTasks) publish({ type: 'task-deleted', id: g.id, workspaceId: g.workspaceId });
  for (const id of unassigned) {
    const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Parameters<typeof rowToTask>[0] | undefined;
    if (r) publish({ type: 'task', task: rowToTask(r) });
  }
  for (const w of treeWorkspaces) publish({ type: 'tree', workspaceId: w });
  for (const w of memberWorkspaces) publish({ type: 'members', workspaceId: w });
  if (deletedWorkspaceMembers.length) publish({ type: 'workspaces' }, { userIds: deletedWorkspaceMembers });
  if (newOwners.size) publish({ type: 'workspaces' }, { userIds: [...newOwners] });
  return true;
}
