import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

process.env.DB_FILE = ':memory:';
const { loadMigrations, migrate } = await import('../server/db.ts');

test('tasks_fts follows inserts, title edits and deletes (migration 003)', () => {
  const db = new Database(':memory:');
  migrate(db, loadMigrations());
  const ts = new Date().toISOString();
  db.prepare("INSERT INTO users (id, email, name, password_hash, color, created_at) VALUES ('u', 'u@x', 'U', '', '#000', ?)").run(ts);
  db.prepare("INSERT INTO workspaces (id, name, created_by, created_at) VALUES ('w', 'W', 'u', ?)").run(ts);
  const ins = db.prepare(
    "INSERT INTO tasks (id, workspace_id, title, created_by, created_at, updated_at) VALUES (?, 'w', ?, 'u', ?, ?)",
  );
  ins.run('t1', 'Renew passport', ts, ts);
  const hits = (q: string) => (db.prepare('SELECT task_id FROM tasks_fts WHERE tasks_fts MATCH ?').all(q) as { task_id: string }[]).map((r) => r.task_id);
  assert.deepEqual(hits('passport'), ['t1']);
  db.prepare("UPDATE tasks SET title = 'Book flights' WHERE id = 't1'").run();
  assert.deepEqual(hits('passport'), []);
  assert.deepEqual(hits('flight'), ['t1']); // porter stemming
  db.prepare("DELETE FROM tasks WHERE id = 't1'").run();
  assert.deepEqual(hits('flight'), []);
});
