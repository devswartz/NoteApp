import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers/app.ts';

process.env.MAIL_QUIET = '1';
delete process.env.SMTP_HOST;
process.env.PUBLIC_URL = 'https://notes.example.com';

let app: TestApp;
let outbox: { to: string; subject: string; text: string }[];
before(async () => {
  app = await startTestApp();
  outbox = (await import('../server/mail.ts')).outbox;
});
after(() => app.close());

const tokenFrom = (url: string) => url.split('/invite/')[1];

test('inviting a new email sends a link; accepting it joins with the invited role', async () => {
  const owner = await app.signUp('Olive');
  const r = await app.call('POST', `/workspaces/${owner.wsId}/members`, owner.token, { email: 'New.Person@Example.com', role: 'viewer' });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'invited');
  assert.equal(r.data.emailed, false, 'SMTP not configured in tests');
  assert.match(r.data.inviteUrl, /^https:\/\/notes\.example\.com\/invite\/[\w-]{20,}$/);
  const mail = outbox.at(-1)!;
  assert.equal(mail.to, 'new.person@example.com');
  assert.ok(mail.text.includes(r.data.inviteUrl));
  assert.match(mail.subject, /Olive invited you/);

  // Pending list (admins only) shows it with an expiry.
  const list = await app.call('GET', `/workspaces/${owner.wsId}/members`, owner.token);
  const inv = list.data.invites.find((i: { email: string }) => i.email === 'new.person@example.com');
  assert.equal(inv.role, 'viewer');
  assert.ok(inv.expiresAt > new Date().toISOString());
  assert.equal(inv.invitedBy, owner.user.id);

  // The landing page can read the invite without a token.
  const token = tokenFrom(r.data.inviteUrl);
  const info = await app.call('GET', `/invites/${token}`);
  assert.equal(info.status, 200);
  assert.equal(info.data.workspaceName, "Olive's Space");
  assert.equal(info.data.invitedByName, 'Olive');
  assert.equal(info.data.expired, false);

  // Someone signs up with a different email and accepts the link.
  const joiner = await app.signUp('Nina');
  const acc = await app.call('POST', `/invites/${token}/accept`, joiner.token);
  assert.equal(acc.status, 200);
  assert.equal(acc.data.workspaceId, owner.wsId);
  const ws = await app.call('GET', '/workspaces', joiner.token);
  assert.equal(ws.data.find((w: { id: string }) => w.id === owner.wsId).role, 'viewer');
  // The link is single use.
  assert.equal((await app.call('POST', `/invites/${token}/accept`, joiner.token)).status, 404);
  assert.equal((await app.call('GET', `/invites/${token}`)).status, 404);
});

test('signing up with the invited email joins automatically', async () => {
  const owner = await app.signUp('Pat');
  await app.call('POST', `/workspaces/${owner.wsId}/members`, owner.token, { email: 'quinn-auto@example.com', role: 'member' });
  const quinn = await app.signUp('Quinn', 'quinn-auto@example.com');
  const ws = await app.call('GET', '/workspaces', quinn.token);
  assert.ok(ws.data.some((w: { id: string; role: string }) => w.id === owner.wsId && w.role === 'member'));
  const list = await app.call('GET', `/workspaces/${owner.wsId}/members`, owner.token);
  assert.equal(list.data.invites.length, 0);
});

test('inviting an existing user adds them and emails them', async () => {
  const owner = await app.signUp('Rae');
  const sam = await app.signUp('Sam');
  const r = await app.call('POST', `/workspaces/${owner.wsId}/members`, owner.token, { email: sam.user.email, role: 'member' });
  assert.equal(r.data.status, 'added');
  assert.equal(outbox.at(-1)!.to, sam.user.email);
  assert.equal((await app.call('POST', `/workspaces/${owner.wsId}/members`, owner.token, { email: sam.user.email })).status, 409);
});

test('resending rotates the link; revoking kills it; expired links are refused', async () => {
  const owner = await app.signUp('Tess');
  const first = await app.call('POST', `/workspaces/${owner.wsId}/members`, owner.token, { email: 'uma@example.com' });
  const second = await app.call('POST', `/workspaces/${owner.wsId}/invites/${encodeURIComponent('uma@example.com')}/resend`, owner.token);
  assert.equal(second.status, 200);
  assert.notEqual(second.data.inviteUrl, first.data.inviteUrl);
  assert.equal((await app.call('GET', `/invites/${tokenFrom(first.data.inviteUrl)}`)).status, 404, 'old link stops working');
  assert.equal((await app.call('GET', `/invites/${tokenFrom(second.data.inviteUrl)}`)).status, 200);

  // Expire it.
  const { db } = await import('../server/db.ts');
  db.prepare("UPDATE workspace_invites SET expires_at = '2000-01-01T00:00:00.000Z' WHERE email = 'uma@example.com'").run();
  const token = tokenFrom(second.data.inviteUrl);
  assert.equal((await app.call('GET', `/invites/${token}`)).data.expired, true);
  const someone = await app.signUp('Val');
  assert.equal((await app.call('POST', `/invites/${token}/accept`, someone.token)).status, 410);

  assert.equal((await app.call('DELETE', `/workspaces/${owner.wsId}/invites/${encodeURIComponent('UMA@example.com')}`, owner.token)).status, 200);
  assert.equal((await app.call('GET', `/invites/${token}`)).status, 404);
});

test('only admins can invite, and only owners can invite owners', async () => {
  const owner = await app.signUp('Wes');
  const member = await app.signUp('Xia');
  const admin = await app.signUp('Yan');
  await app.call('POST', `/workspaces/${owner.wsId}/members`, owner.token, { email: member.user.email, role: 'member' });
  await app.call('POST', `/workspaces/${owner.wsId}/members`, owner.token, { email: admin.user.email, role: 'admin' });
  assert.equal((await app.call('POST', `/workspaces/${owner.wsId}/members`, member.token, { email: 'z1@example.com' })).status, 403);
  assert.equal((await app.call('POST', `/workspaces/${owner.wsId}/members`, admin.token, { email: 'z2@example.com', role: 'owner' })).status, 403);
  assert.equal((await app.call('POST', `/workspaces/${owner.wsId}/members`, admin.token, { email: 'z3@example.com', role: 'admin' })).status, 200);
  assert.equal((await app.call('POST', `/workspaces/${owner.wsId}/members`, admin.token, { email: 'not-an-email' })).status, 400);
  // Members don't see pending invites.
  assert.deepEqual((await app.call('GET', `/workspaces/${owner.wsId}/members`, member.token)).data.invites, []);
});
