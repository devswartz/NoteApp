import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

process.env.DB_FILE = ':memory:';
const { loadMigrations, migrate } = await import('../server/db.ts');

function dir(files: Record<string, string>) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  for (const [f, sql] of Object.entries(files)) fs.writeFileSync(path.join(d, f), sql);
  return d;
}
const tables = (db: Database.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 't%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

test('the real migrations apply to an empty DB, and re-running is a no-op', () => {
  const list = loadMigrations();
  const db = new Database(':memory:');
  migrate(db, list);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'tasks'").get());
  const n = (db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n;
  assert.equal(n, list.length);
  migrate(db, list);
});

test('duplicate numbers are rejected', () => {
  assert.throws(() => loadMigrations(dir({ '001-a.sql': '', '001-b.sql': '' })), /share number 1/);
});

test('a lower number that lands after a higher one still gets applied', () => {
  const db = new Database(':memory:');
  migrate(db, loadMigrations(dir({ '001-a.sql': 'CREATE TABLE t1 (x);', '006-f.sql': 'CREATE TABLE t6 (x);' })));
  migrate(db, loadMigrations(dir({ '001-a.sql': 'CREATE TABLE t1 (x);', '004-d.sql': 'CREATE TABLE t4 (x);', '006-f.sql': 'CREATE TABLE t6 (x);' })));
  assert.deepEqual(tables(db), ['t1', 't4', 't6']);
});

test('legacy DBs tracked by user_version are not re-migrated', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t1 (x); CREATE TABLE t2 (x);');
  db.pragma('user_version = 2');
  migrate(db, loadMigrations(dir({ '001-a.sql': 'CREATE TABLE t1 (x);', '002-b.sql': 'CREATE TABLE t2 (x);', '003-c.sql': 'CREATE TABLE t3 (x);' })));
  assert.deepEqual(tables(db), ['t1', 't2', 't3']);
});

test('a failing migration rolls back and is retried on the next start', () => {
  const d = dir({ '001-a.sql': 'CREATE TABLE t1 (x);', '002-bad.sql': 'CREATE TABLE t2 (x); SELECT * FROM nope;' });
  const db = new Database(':memory:');
  assert.throws(() => migrate(db, loadMigrations(d)));
  assert.deepEqual(tables(db), ['t1'], '002 rolled back entirely');
  fs.writeFileSync(path.join(d, '002-bad.sql'), 'CREATE TABLE t2 (x);');
  migrate(db, loadMigrations(d));
  assert.deepEqual(tables(db), ['t1', 't2']);
});

test('two connections migrating the same file DB apply each migration once', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'migdb-')), 'x.db');
  const d = dir({ '001-a.sql': 'CREATE TABLE t1 (x);', '002-b.sql': 'CREATE TABLE t2 (x);' });
  const a = new Database(file);
  const b = new Database(file);
  migrate(a, loadMigrations(d));
  migrate(b, loadMigrations(d)); // would throw "table t1 already exists" if it re-applied
  assert.equal((b.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n, 2);
});

test('011 (user templates) applies on top of an existing database and keeps its files', () => {
  const all = loadMigrations();
  const before = all.filter((m) => m.version < 11);
  assert.ok(all.some((m) => m.version === 11), '011 exists');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, before);
  const run = (sql: string) => db.prepare(sql).run();
  run("INSERT INTO users (id, email, name, password_hash, color, created_at) VALUES ('u', 'u@example.com', 'U', 'x', '#000000', 't')");
  run("INSERT INTO workspaces (id, name, created_by, created_at) VALUES ('w', 'W', 'u', 't')");
  run("INSERT INTO files (id, workspace_id, name, ext, mime, size, created_by, created_at) VALUES ('f1', 'w', 'a.txt', '.txt', 'text/plain', 1, 'u', 't')");
  migrate(db, all);
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  assert.equal(n("SELECT COUNT(*) AS n FROM files WHERE id = 'f1' AND template_id IS NULL"), 1);
  run("INSERT INTO templates (id, workspace_id, name, content, created_by, created_at, updated_at) VALUES ('t', 'w', 'T', '{}', 'u', 't', 't')");
  run("INSERT INTO files (id, workspace_id, template_id, name, ext, mime, size, created_by, created_at) VALUES ('f2', 'w', 't', 'a.txt', '.txt', 'text/plain', 1, 'u', 't')");
  assert.throws(() =>
    run("INSERT INTO templates (id, workspace_id, name, visibility, content, created_by, created_at, updated_at) VALUES ('t2', 'w', 'T', 'bogus', '{}', 'u', 't', 't')"),
  );
  run("DELETE FROM templates WHERE id = 't'");
  assert.equal(n("SELECT COUNT(*) AS n FROM files WHERE id = 'f2'"), 0, 'template files go with the template');
  assert.equal(n("SELECT COUNT(*) AS n FROM files WHERE id = 'f1'"), 1);
  migrate(db, all); // idempotent
});
