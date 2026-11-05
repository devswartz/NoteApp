import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';
process.env.JWT_SECRET = 'test';
process.env.DEMO_PASSWORD = 'demo-password';
const { seedDemoIfEmpty } = await import('../server/demo.ts');
const { db } = await import('../server/db.ts');

test('SEED_DEMO seeds an empty database once', () => {
  assert.equal(seedDemoIfEmpty(), true);
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  const tasks = db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
  assert.equal(users.n, 2);
  assert.ok(tasks.n >= 5);
  assert.equal(seedDemoIfEmpty(), false, 'second run is a no-op');
});
