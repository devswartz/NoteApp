// Invite-only sign-up must hold under concurrency (own process: starts with an empty DB).
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers/app.ts';

let app: TestApp;
before(async () => {
  process.env.SIGNUP_MODE = 'invite';
  delete process.env.ADMIN_EMAILS;
  app = await startTestApp();
});
after(() => app.close());

const register = (email: string) => app.call('POST', '/auth/register', undefined, { name: 'X', email, password: 'password123' });

test('two simultaneous sign-ups on an empty server: only one becomes the bootstrap account', async () => {
  const results = await Promise.all([register('a@example.com'), register('b@example.com'), register('c@example.com')]);
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 403, 403]);
  const { db } = await import('../server/db.ts');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 1);
});

test('an invite revoked while the password is being hashed no longer works', async () => {
  const { db } = await import('../server/db.ts');
  const owner = db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string };
  const ws = (db.prepare('SELECT workspace_id FROM workspace_members WHERE user_id = ?').get(owner.id) as { workspace_id: string }).workspace_id;
  db.prepare("INSERT INTO workspace_invites (workspace_id, email, role, invited_by, created_at) VALUES (?, 'late@example.com', 'member', ?, ?)").run(ws, owner.id, new Date().toISOString());
  // Revoke the invite exactly while the server is hashing (after its early check passed).
  const bcrypt = (await import('bcryptjs')).default;
  const realHash = bcrypt.hash;
  (bcrypt as { hash: unknown }).hash = async (...args: Parameters<typeof realHash>) => {
    db.prepare("DELETE FROM workspace_invites WHERE email = 'late@example.com'").run();
    return realHash(...args);
  };
  try {
    assert.equal((await register('late@example.com')).status, 403);
  } finally {
    (bcrypt as { hash: unknown }).hash = realHash;
  }
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'late@example.com'").get() as { n: number }).n, 0);
});
