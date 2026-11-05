// Tree helpers (notebooks / sections / pages) used by more than one route module.
import { db } from './db.ts';
import { publish } from './events.ts';
import { rowToTask } from './tasks.ts';
import { closeRoom } from './collab.ts';

type TaskRow = Parameters<typeof rowToTask>[0];

/** Next position at the end of a sibling list. */
export const nextPos = (table: 'notebooks' | 'sections' | 'pages', col: string, id: string) =>
  ((db.prepare(`SELECT MAX(position) AS m FROM ${table} WHERE ${col} = ?`).get(id) as { m: number | null }).m ?? 0) + 1;

/** Re-broadcast tasks whose visibility may have changed. */
export function refreshTasksForNotebook(notebookId: string) {
  const rows = db
    .prepare('SELECT t.* FROM tasks t JOIN pages p ON p.id = t.page_id JOIN sections s ON s.id = p.section_id WHERE s.notebook_id = ?')
    .all(notebookId) as TaskRow[];
  for (const r of rows) publish({ type: 'task', task: rowToTask(r) });
}

/** Deleting notes never deletes their tasks: they become standalone tasks. `del` runs the actual DELETE. */
export function detachPagesTasks(pageIds: string[], del: () => void) {
  const affected: string[] = [];
  db.transaction(() => {
    for (const id of pageIds) {
      affected.push(...(db.prepare('SELECT id FROM tasks WHERE page_id = ?').all(id) as { id: string }[]).map((r) => r.id));
      db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(id);
    }
    del();
  })();
  for (const id of pageIds) closeRoom(id);
  for (const id of affected) {
    const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    if (r) publish({ type: 'task', task: rowToTask(r) });
  }
}
