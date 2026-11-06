// Follow-ups to email verification: a successful password reset verifies the account, and accounts that never
// confirm their email are deleted after UNVERIFIED_ACCOUNT_DAYS (default 7) by the housekeeping job.
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nodemailer from 'nodemailer';
import WS from 'ws';
import { startTestApp, type TestApp } from './helpers/app.ts';

process.env.DB_FILE = ':memory:';
process.env.JWT_SECRET ??= 'test-secret';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'noteapp-followups-'));
process.env.PUBLIC_URL = 'https://app.example.test';
process.env.MAIL_QUIET = '1';
delete process.env.SMTP_HOST;
delete process.env.E2E_TEST_HOOKS;
delete process.env.UNVERIFIED_ACCOUNT_DAYS;
const SITE_ADMIN = 'site-admin@example.com';
process.env.ADMIN_EMAILS = SITE_ADMIN;

const { setMailTransport } = await import('../server/mail.ts');
const { resetRateLimits } = await import('../server/ratelimit.ts');
const { db } = await import('../server/db.ts');
const { pruneUnverifiedAccounts, unverifiedAccountDays } = await import('../server/verification.ts');
const { deleteAccount } = await import('../server/accounts.ts');

let app: TestApp;
let owner: Awaited<ReturnType<TestApp['signUp']>>;
const mails: { to: string; subject: string; text: string }[] = [];

function smtpOn() {
  process.env.SMTP_HOST = 'smtp.example.test';
  const t = nodemailer.createTransport({ jsonTransport: true });
  t.sendMail = (async (m: { to: string; subject: string; text: string }) => {
    mails.push({ to: String(m.to), subject: m.subject, text: m.text });
    return { messageId: 'x' };
  }) as unknown as typeof t.sendMail;
  setMailTransport(t);
}
function smtpOff() {
  delete process.env.SMTP_HOST;
  setMailTransport(undefined);
}

before(async () => {
  app = await startTestApp();
  owner = await app.signUp('Fowner'); // no SMTP: verified and the bootstrap account
});
after(async () => {
  smtpOff();
  await app.close();
});
beforeEach(() => resetRateLimits());

let seq = 0;
const register = (name: string, email = `${name.toLowerCase()}-${++seq}@example.com`) =>
  app.call('POST', '/auth/register', undefined, { name, email, password: 'password123' }).then((r) => ({ ...r, email }));
async function mailTo(email: string, subjectStart: string) {
  for (let i = 0; i < 100; i++) {
    const m = mails.filter((x) => x.to === email && x.subject.startsWith(subjectStart));
    if (m.length) return m.at(-1)!;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no "${subjectStart}" mail to ${email}`);
}
async function resetToken(email: string) {
  const n = mails.filter((x) => x.to === email && x.subject.startsWith('Reset your')).length;
  assert.equal((await app.call('POST', '/auth/forgot', undefined, { email })).status, 200);
  for (let i = 0; i < 100 && mails.filter((x) => x.to === email && x.subject.startsWith('Reset your')).length === n; i++) await new Promise((r) => setTimeout(r, 20));
  return decodeURIComponent(/token=([^\s"&]+)/.exec((await mailTo(email, 'Reset your')).text)![1]!);
}
const reset = (token: unknown, password = 'brand-new-pass') => app.call('POST', '/auth/reset', undefined, { token, password });
const verifiedAt = (id: string) => (db.prepare('SELECT email_verified_at AS v FROM users WHERE id = ?').get(id) as { v: string | null } | undefined)?.v;
const exists = (id: string) => !!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id);

// ── Part 1: password reset verifies the email ──

test('a successful reset verifies the account, accepts its invites, publishes members, drops the token, keeps revoking sessions', async () => {
  smtpOn();
  const ws = (await app.call('POST', '/workspaces', owner.token, { name: 'Reset invite' })).data.id as string;
  const email = `resetter-${++seq}@example.com`;
  assert.equal((await app.call('POST', `/workspaces/${ws}/members`, owner.token, { email, role: 'admin' })).data.status, 'invited');
  const events: { type: string; workspaceId?: string }[] = [];
  const sock = new WS(`${app.wsOrigin}/api/events`, ['noteapp.v1', `bearer.${owner.token}`]);
  sock.on('message', (m) => events.push(JSON.parse(String(m))));
  after(() => sock.terminate());
  await new Promise((res) => sock.once('open', res));

  const r = await register('Resetter', email);
  const uid = r.data.user.id as string;
  assert.equal(verifiedAt(uid), null);
  assert.ok(db.prepare('SELECT 1 FROM email_verifications WHERE user_id = ?').get(uid), 'a verification token is outstanding');
  const oldVerifyToken = /verify-email\?token=([\w-]+)/.exec((await mailTo(email, 'Confirm your email')).text)![1]!;

  const token = await resetToken(email);
  assert.equal((await reset(token)).status, 200);
  assert.ok(verifiedAt(uid), 'verified');
  assert.equal(db.prepare('SELECT 1 FROM email_verifications WHERE user_id = ?').get(uid), undefined, 'token deleted');
  assert.equal((await app.call('POST', '/auth/verify-email', undefined, { token: oldVerifyToken })).status, 400, 'the old link is dead');
  assert.deepEqual(db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(ws, uid), { role: 'admin' });
  assert.equal(db.prepare('SELECT 1 FROM workspace_invites WHERE workspace_id = ? AND email = ?').get(ws, email), undefined, 'invite consumed');
  for (let i = 0; i < 50 && !events.some((e) => e.type === 'members' && e.workspaceId === ws); i++) await new Promise((res) => setTimeout(res, 20));
  assert.ok(events.some((e) => e.type === 'members' && e.workspaceId === ws), 'members event published');
  sock.close();

  assert.equal((await app.call('POST', '/auth/refresh', undefined, { refreshToken: r.data.refreshToken })).status, 401, 'old sessions revoked');
  const login = await app.call('POST', '/auth/login', undefined, { email, password: 'brand-new-pass' });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.emailVerified, true);
  assert.equal((await app.call('GET', '/workspaces', login.data.accessToken)).status, 200, 'can use the app');
});

test('an invalid, malformed, used or stale reset token verifies nothing', async () => {
  smtpOn();
  const r = await register('Nope');
  const uid = r.data.user.id as string;
  const ws = (await app.call('POST', '/workspaces', owner.token, { name: 'Nope invite' })).data.id as string;
  await app.call('POST', `/workspaces/${ws}/members`, owner.token, { email: r.email, role: 'member' });
  assert.equal((await reset('garbage-token')).status, 400);
  assert.equal((await reset(undefined)).status, 400);
  assert.equal((await reset({ $ne: 1 })).status, 400);

  const token = await resetToken(r.email);
  assert.equal((await reset(token, 'short')).status, 400, 'too-short password is refused and verifies nothing');
  assert.equal(verifiedAt(uid), null);
  // A tampered token is refused.
  assert.equal((await reset(token.slice(0, -2) + 'xx')).status, 400);
  assert.equal(verifiedAt(uid), null);
  assert.ok(db.prepare('SELECT 1 FROM email_verifications WHERE user_id = ?').get(uid), 'verification token untouched');
  assert.equal(db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(ws, uid), undefined);
  assert.ok(db.prepare('SELECT 1 FROM workspace_invites WHERE workspace_id = ? AND email = ?').get(ws, r.email), 'invite still pending');

  // Stale: the password changed some other way after the link was issued.
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run('$2a$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz01234', uid);
  assert.equal((await reset(token)).status, 400);
  assert.equal(verifiedAt(uid), null);

  // A reset that succeeds, used a second time, does nothing more.
  const fresh = await register('Twice');
  const t2 = await resetToken(fresh.email);
  assert.equal((await reset(t2)).status, 200);
  const stamp = verifiedAt(fresh.data.user.id);
  assert.ok(stamp);
  assert.equal((await reset(t2, 'another-pass-1')).status, 400);
  assert.equal(verifiedAt(fresh.data.user.id), stamp);
});

test('an expired reset token verifies nothing', async () => {
  smtpOn();
  const r = await register('Expired');
  const jwt = (await import('jsonwebtoken')).default;
  const good = await resetToken(r.email);
  const payload = jwt.decode(good) as Record<string, unknown>;
  const expired = jwt.sign({ ...payload, iat: 1000, exp: 2000 }, process.env.JWT_SECRET!);
  assert.equal((await reset(expired)).status, 400);
  assert.equal(verifiedAt(r.data.user.id), null);
});

test('resetting the password of an already verified account leaves its verification untouched', async () => {
  smtpOn();
  const r = await register('Already');
  const uid = r.data.user.id as string;
  const stamp = '2020-01-01T00:00:00.000Z';
  db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(stamp, uid);
  // A pending invite for a verified user is not this path's business (it was accepted at verification or invite time).
  const ws = (await app.call('POST', '/workspaces', owner.token, { name: 'Already invite' })).data.id as string;
  db.prepare("INSERT INTO workspace_invites (workspace_id, email, role, invited_by, created_at) VALUES (?, ?, 'member', ?, ?)").run(ws, r.email, owner.user.id, new Date().toISOString());
  const token = await resetToken(r.email);
  assert.equal((await reset(token)).status, 200);
  assert.equal(verifiedAt(uid), stamp, 'timestamp not rewritten');
  assert.ok(db.prepare('SELECT 1 FROM workspace_invites WHERE workspace_id = ? AND email = ?').get(ws, r.email), 'invite not touched');
  assert.equal(db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(ws, uid), undefined);
});

// ── Part 2: unconfirmed accounts are deleted after UNVERIFIED_ACCOUNT_DAYS ──

const DAY = 24 * 3600_000;
/** An account (verified at sign-up, SMTP off) turned into an unverified one created `ageMs` ago. */
async function unverified(name: string, ageMs: number, email?: string) {
  smtpOff();
  const u = await app.signUp(name, email);
  db.prepare('UPDATE users SET email_verified_at = NULL, created_at = ? WHERE id = ?').run(new Date(Date.now() - ageMs).toISOString(), u.user.id);
  return u;
}

test('the setting defaults to 7 days, is at least 1, and ignores junk', () => {
  const was = process.env.UNVERIFIED_ACCOUNT_DAYS;
  try {
    const days = (v?: string) => {
      if (v === undefined) delete process.env.UNVERIFIED_ACCOUNT_DAYS;
      else process.env.UNVERIFIED_ACCOUNT_DAYS = v;
      return unverifiedAccountDays();
    };
    assert.equal(days(undefined), 7);
    assert.equal(days(''), 7);
    assert.equal(days('abc'), 7);
    assert.equal(days('3'), 3);
    assert.equal(days('0'), 7, 'below the minimum falls back to the default');
    assert.equal(days('-2'), 7);
    assert.equal(days('1'), 1);
  } finally {
    if (was === undefined) delete process.env.UNVERIFIED_ACCOUNT_DAYS;
    else process.env.UNVERIFIED_ACCOUNT_DAYS = was;
  }
});

test('cleanup: 7-day boundary; verified, recent and ADMIN_EMAILS accounts are never touched', async () => {
  const old = await unverified('Old', 7 * DAY + 60_000);
  const edge = await unverified('Edge', 7 * DAY - 60_000);
  const recent = await unverified('Recent', 1 * DAY);
  const verifiedOld = await app.signUp('VerifiedOld');
  db.prepare('UPDATE users SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 400 * DAY).toISOString(), verifiedOld.user.id);
  const admin = await unverified('SiteAdmin', 30 * DAY, SITE_ADMIN.toUpperCase());
  const r = pruneUnverifiedAccounts();
  assert.equal(r.deleted, 1);
  assert.equal(r.failed, 0);
  assert.equal(exists(old.user.id), false, 'older than 7 days: deleted');
  assert.equal(exists(edge.user.id), true, 'just under 7 days: kept');
  assert.equal(exists(recent.user.id), true);
  assert.equal(exists(verifiedOld.user.id), true, 'verified: kept however old');
  assert.equal(exists(admin.user.id), true, 'ADMIN_EMAILS (case-insensitive): kept');
  // The injectable clock moves the boundary.
  assert.equal(pruneUnverifiedAccounts({ nowMs: Date.now() + 2 * DAY }).deleted, 1);
  assert.equal(exists(edge.user.id), false);
  assert.equal(exists(recent.user.id), true);
  // The stand-in user (never verified, created in year 9999) is never a candidate, and a second run does nothing.
  assert.ok(exists('deleted-user'), 'the stand-in exists by now (deleteAccount created it)');
  assert.deepEqual(pruneUnverifiedAccounts({ nowMs: Date.now() + 2 * DAY }), { deleted: 0, failed: 0 });
  assert.ok(exists('deleted-user'), 'and survives');
});

test('UNVERIFIED_ACCOUNT_DAYS changes the window', async () => {
  const u = await unverified('Window', 3 * DAY);
  process.env.UNVERIFIED_ACCOUNT_DAYS = '2';
  try {
    assert.equal(pruneUnverifiedAccounts().deleted, 1);
  } finally {
    delete process.env.UNVERIFIED_ACCOUNT_DAYS;
  }
  assert.equal(exists(u.user.id), false);
});

test('cleanup really calls deleteAccount: workspace, content, files and sockets go; other people keep shared work', async () => {
  smtpOff();
  const gone = await app.signUp('Goner'); // verified for now, so it can create content and open sockets
  const friend = await app.signUp('Friend');
  // Goner owns a workspace with a page, and is a member of another one with a shared notebook of their own.
  const nb = (await app.call('POST', `/workspaces/${gone.wsId}/notebooks`, gone.token, { name: 'Mine', visibility: 'shared' })).data.id as string;
  const sec = (await app.call('POST', `/notebooks/${nb}/sections`, gone.token, { name: 'S' })).data.id as string;
  await app.call('POST', `/sections/${sec}/pages`, gone.token, { title: 'P' });
  await app.call('POST', `/workspaces/${friend.wsId}/members`, friend.token, { email: gone.user.email, role: 'member' });
  const sock = new WS(`${app.wsOrigin}/api/events`, ['noteapp.v1', `bearer.${gone.token}`]);
  after(() => sock.terminate());
  await new Promise((res) => sock.once('open', res));
  const closed = new Promise<number>((res) => sock.once('close', (c) => res(c)));
  assert.ok(db.prepare('SELECT 1 FROM pages p JOIN sections s ON s.id = p.section_id JOIN notebooks n ON n.id = s.notebook_id WHERE n.workspace_id = ?').get(gone.wsId), 'content exists');
  db.prepare('UPDATE users SET email_verified_at = NULL, created_at = ? WHERE id = ?').run(new Date(Date.now() - 8 * DAY).toISOString(), gone.user.id);

  assert.equal(pruneUnverifiedAccounts().deleted, 1);
  assert.equal(exists(gone.user.id), false);
  assert.equal(db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(gone.wsId), undefined, 'their own workspace is gone');
  assert.equal(db.prepare('SELECT 1 FROM notebooks WHERE workspace_id = ?').get(gone.wsId), undefined);
  assert.equal(db.prepare('SELECT 1 FROM workspace_members WHERE user_id = ?').get(gone.user.id), undefined);
  assert.equal(db.prepare('SELECT 1 FROM refresh_tokens WHERE user_id = ?').get(gone.user.id), undefined);
  assert.ok(db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(friend.wsId), "the friend's workspace stays");
  await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error('socket still open')), 3000))]);
});

test('the cap limits one run (oldest first) and the rest go on the next', async () => {
  const a = await unverified('CapA', 20 * DAY);
  const b = await unverified('CapB', 19 * DAY);
  const c = await unverified('CapC', 18 * DAY);
  assert.deepEqual(pruneUnverifiedAccounts({ cap: 2 }), { deleted: 2, failed: 0 });
  assert.equal(exists(a.user.id), false);
  assert.equal(exists(b.user.id), false);
  assert.equal(exists(c.user.id), true);
  assert.deepEqual(pruneUnverifiedAccounts({ cap: 2 }), { deleted: 1, failed: 0 });
  assert.equal(exists(c.user.id), false);
});

test('one failure is logged by id (no email) and does not stop the others', async () => {
  const a = await unverified('FailA', 25 * DAY);
  const b = await unverified('FailB', 24 * DAY);
  const c = await unverified('FailC', 23 * DAY);
  const calls: string[] = [];
  const written: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => (written.push(String(chunk)), true)) as typeof process.stderr.write;
  let r;
  try {
    r = pruneUnverifiedAccounts({
      remove: (id) => {
        calls.push(id);
        if (id === b.user.id) throw new Error('boom');
        return deleteAccount(id);
      },
    });
  } finally {
    process.stderr.write = realWrite;
  }
  assert.deepEqual(calls, [a.user.id, b.user.id, c.user.id]);
  assert.deepEqual(r, { deleted: 2, failed: 1 });
  assert.equal(exists(a.user.id), false);
  assert.equal(exists(b.user.id), true, 'the failing one stays for the next run');
  assert.equal(exists(c.user.id), false);
  const line = written.join('');
  assert.match(line, new RegExp(b.user.id));
  assert.ok(!line.includes(b.user.email), 'no email in the log');
  pruneUnverifiedAccounts(); // clean up
});

test('cleanup sends no mail', async () => {
  smtpOn();
  await unverified('Quiet', 9 * DAY);
  smtpOn();
  const before = mails.length;
  assert.equal(pruneUnverifiedAccounts().deleted, 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mails.length, before);
  smtpOff();
});
