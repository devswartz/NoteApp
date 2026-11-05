import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

process.env.DB_FILE = ':memory:';
const { loadMigrations, migrate } = await import('../server/db.ts');

test('migrations are numbered 001… without gaps and apply to an empty DB', () => {
  const list = loadMigrations();
  assert.ok(list.length >= 1);
  const db = new Database(':memory:');
  migrate(db, list);
  assert.equal(db.pragma('user_version', { simple: true }), list.at(-1)!.version);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'tasks'").get());
  // Running again is a no-op.
  migrate(db, list);
});
