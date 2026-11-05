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
