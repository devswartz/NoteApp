// Invite-only sign-up (SIGNUP_MODE=invite, the production default).
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

const register = (email: string) => app.call('POST', '/auth/register', undefined, { name: email.split('@')[0], email, password: 'password123' });

test('bootstrap: the first account can sign up, then sign-up closes', async () => {
  assert.deepEqual((await app.call('GET', '/auth/config')).data, { signupMode: 'invite', signupOpen: true });
  const first = await register('founder@example.com');
  assert.equal(first.status, 200);
  assert.deepEqual((await app.call('GET', '/auth/config')).data, { signupMode: 'invite', signupOpen: false });

  const stranger = await register('stranger@example.com');
  assert.equal(stranger.status, 403);
  assert.match(stranger.data.error, /invitation/);

  // An invited email can sign up and lands in the workspace it was invited to.
  const token = first.data.accessToken as string;
  const ws = (await app.call('GET', '/workspaces', token)).data[0].id as string;
  const inv = await app.call('POST', `/workspaces/${ws}/members`, token, { email: 'friend@example.com', role: 'member' });
  assert.equal(inv.status, 200);
  const friend = await register('friend@example.com');
  assert.equal(friend.status, 200);
  const theirs = (await app.call('GET', '/workspaces', friend.data.accessToken)).data as { id: string }[];
  assert.ok(theirs.some((w) => w.id === ws));
});

test('emails in ADMIN_EMAILS can always sign up', async () => {
  process.env.ADMIN_EMAILS = 'ops@example.com';
  try {
    assert.equal((await register('ops@example.com')).status, 200);
    assert.equal((await register('other@example.com')).status, 403);
  } finally {
    delete process.env.ADMIN_EMAILS;
  }
});

test('an expired invite does not allow sign-up', async () => {
  const { db } = await import('../server/db.ts');
  const ws = (db.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string }).id;
  const owner = (db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string }).id;
  db.prepare("INSERT INTO workspace_invites (workspace_id, email, role, invited_by, created_at, expires_at) VALUES (?, 'late@example.com', 'member', ?, ?, ?)").run(
    ws, owner, new Date().toISOString(), new Date(Date.now() - 1000).toISOString(),
  );
  assert.equal((await register('late@example.com')).status, 403);
});

test('SIGNUP_MODE=open lets anyone sign up', async () => {
  process.env.SIGNUP_MODE = 'open';
  try {
    assert.equal((await register('anyone@example.com')).status, 200);
  } finally {
    process.env.SIGNUP_MODE = 'invite';
  }
});
