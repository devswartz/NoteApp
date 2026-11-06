// Email verification for sign-up: token lifecycle, resend limits, the invite rule, the middleware that
// keeps unverified users out of everything else (REST, WebSockets, uploads), the e2e-only test hooks, cleanup.
// Bootstrap accounts (first account / ADMIN_EMAILS) are in tests/email-verification-bootstrap.test.ts (needs an empty DB).
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nodemailer from 'nodemailer';
import WS from 'ws';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';
import { APP_NAME } from '../shared/config.ts';

process.env.DB_FILE = ':memory:'; // set before the server modules are imported below (startTestApp does it too, but later)
process.env.JWT_SECRET ??= 'test-secret';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'noteapp-verify-'));
process.env.PUBLIC_URL ='https://app.example.test';
process.env.MAIL_QUIET = '1';
delete process.env.SMTP_HOST;
delete process.env.E2E_TEST_HOOKS;
process.env.ADMIN_EMAILS = 'site-admin@example.com'; // so the first account isn't an instance admin by accident

const { setMailTransport } = await import('../server/mail.ts');
const { resetRateLimits, setRateLimitClock } = await import('../server/ratelimit.ts');
const { db } = await import('../server/db.ts');
const { pruneEmailVerifications, verificationRequired, testHooksEnabled } = await import('../server/verification.ts');

let app: TestApp;
let owner: TestUser;
const mails: { to: string; subject: string; text: string }[] = [];

/** From now on mail "is configured" and delivered to `mails` (nodemailer's JSON transport). */
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
  owner = await app.signUp('Vowner'); // no SMTP yet: auto-verified (and the bootstrap account)
});
after(async () => {
  smtpOff();
  setRateLimitClock(undefined);
  await app.close();
});
beforeEach(() => resetRateLimits());

let seq = 0;
const register = (name: string, email = `${name.toLowerCase()}-${++seq}@example.com`) =>
  app.call('POST', '/auth/register', undefined, { name, email, password: 'password123' }).then((r) => ({ ...r, email }));

/** Wait for the n-th confirmation mail to `email` (mail is sent without blocking the response). */
async function mailTo(email: string, nth = 1) {
  for (let i = 0; i < 100; i++) {
    const m = mails.filter((x) => x.to === email && x.subject.startsWith('Confirm your email'));
    if (m.length >= nth) return m[nth - 1]!;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no mail #${nth} to ${email}`);
}
const tokenIn = (m: { text: string }) => /verify-email\?token=([\w-]+)/.exec(m.text)![1]!;
const verify = (token: unknown) => app.call('POST', '/auth/verify-email', undefined, { token });
const me = (u: { token: string }) => app.call('GET', '/me', u.token).then((r) => r.data);

test('without SMTP everyone is verified at sign-up and no mail is sent', async () => {
  smtpOff();
  const r = await register('Nosmtp');
  assert.equal(r.status, 200);
  assert.equal(r.data.user.emailVerified, true);
  assert.equal((await me({ token: r.data.accessToken })).emailVerified, true);
  assert.equal((await app.call('GET', '/workspaces', r.data.accessToken)).status, 200);
  assert.equal(mails.filter((m) => m.to === r.email).length, 0);
});

test('with SMTP a new account starts unverified, gets one email, and the link verifies it (happy path)', async () => {
  smtpOn();
  const r = await register('Happy');
  assert.equal(r.status, 200, 'registration works');
  assert.equal(r.data.user.emailVerified, false);
  const m = await mailTo(r.email);
  assert.equal(m.subject, `Confirm your email for ${APP_NAME}`);
  assert.match(m.text, /^Hi Happy,/);
  assert.match(m.text, /https:\/\/app\.example\.test\/verify-email\?token=[\w-]{43}/, '32 random bytes, in a PUBLIC_URL link');
  const me1 = await me({ token: r.data.accessToken });
  assert.equal(me1.emailVerified, false);
  // Only a hash is stored.
  const stored = db.prepare('SELECT token_hash FROM email_verifications WHERE user_id = ?').get(r.data.user.id) as { token_hash: string };
  assert.ok(!stored.token_hash.includes(tokenIn(m)));

  const v = await verify(tokenIn(m)); // public: no bearer token
  assert.equal(v.status, 200);
  assert.deepEqual(v.data, { ok: true, emailVerified: true });
  assert.equal((await me({ token: r.data.accessToken })).emailVerified, true, 'the signed-in session is verified now');
  assert.equal((await app.call('GET', '/workspaces', r.data.accessToken)).status, 200);
  const login = await app.call('POST', '/auth/login', undefined, { email: r.email, password: 'password123' });
  assert.equal(login.data.user.emailVerified, true);
});

test('a token works once, and wrong or malformed tokens are refused', async () => {
  smtpOn();
  const r = await register('Once');
  const token = tokenIn(await mailTo(r.email));
  assert.equal((await verify(token + 'x')).status, 400, 'wrong token');
  assert.equal((await verify('')).status, 400);
  assert.equal((await verify(undefined)).status, 400);
  assert.equal((await verify({ $ne: 1 })).status, 400);
  assert.equal((await verify(token)).status, 200);
  const again = await verify(token);
  assert.equal(again.status, 400, 'reuse');
  assert.match(again.data.error, /invalid or has expired/);
});

test('a token expires after 24 hours (and expired rows are cleaned up)', async () => {
  smtpOn();
  const r = await register('Late');
  const token = tokenIn(await mailTo(r.email));
  const row = db.prepare('SELECT created_at, expires_at FROM email_verifications WHERE user_id = ?').get(r.data.user.id) as { created_at: string; expires_at: string };
  assert.equal(Date.parse(row.expires_at) - Date.parse(row.created_at), 24 * 3600 * 1000);
  db.prepare('UPDATE email_verifications SET expires_at = ? WHERE user_id = ?').run(new Date(Date.now() - 1000).toISOString(), r.data.user.id);
  assert.equal((await verify(token)).status, 400);
  assert.equal((await me({ token: r.data.accessToken })).emailVerified, false, 'still unverified');

  // pruneEmailVerifications (the housekeeping job in server/index.ts) drops expired rows only.
  const other = await register('Fresh');
  await mailTo(other.email);
  db.prepare('INSERT OR REPLACE INTO email_verifications (user_id, email, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    r.data.user.id, r.email, 'h', new Date().toISOString(), new Date(Date.now() - 1000).toISOString(),
  );
  pruneEmailVerifications();
  assert.equal(db.prepare('SELECT 1 FROM email_verifications WHERE user_id = ?').get(r.data.user.id), undefined);
  assert.ok(db.prepare('SELECT 1 FROM email_verifications WHERE user_id = ?').get(other.data.user.id));
});

test('resend sends a new link and invalidates the older one; verified users get nothing', async () => {
  smtpOn();
  const r = await register('Resender');
  const first = tokenIn(await mailTo(r.email, 1));
  const res = await app.call('POST', '/auth/resend-verification', r.data.accessToken);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { ok: true, alreadyVerified: false });
  const second = tokenIn(await mailTo(r.email, 2));
  assert.notEqual(first, second);
  assert.equal((await verify(first)).status, 400, 'the older link no longer works');
  assert.equal((await verify(second)).status, 200);

  const before = mails.length;
  const again = await app.call('POST', '/auth/resend-verification', r.data.accessToken);
  assert.deepEqual(again.data, { ok: true, alreadyVerified: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mails.length, before, 'no mail for a verified account');
  assert.equal((await app.call('POST', '/auth/resend-verification')).status, 401, 'needs a signed-in user');
});

test('resend is limited: one a minute and five an hour per user (429 + Retry-After)', async () => {
  smtpOn();
  let t = Date.now();
  setRateLimitClock(() => t);
  try {
    const r = await register('Limited');
    const resend = () => fetch(`${app.origin}/api/auth/resend-verification`, { method: 'POST', headers: { authorization: `Bearer ${r.data.accessToken}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await resend()).status, 200);
    const blocked = await resend();
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    assert.match((await blocked.json()).error, /Too many attempts/);
    // Another user isn't affected by it.
    const other = await register('Unlimited');
    assert.equal((await app.call('POST', '/auth/resend-verification', other.data.accessToken)).status, 200);
    // After a minute, one more; then the hourly cap (5) bites.
    let sent = 1;
    for (let i = 0; i < 6; i++) {
      t += 61_000;
      const s = (await resend()).status;
      if (s === 200) sent++;
      else assert.equal(s, 429);
    }
    assert.equal(sent, 5, 'five an hour');
    t += 3600_000;
    assert.equal((await resend()).status, 200, 'and it refills');
  } finally {
    setRateLimitClock(undefined);
  }
});

test('invites for an email are not accepted at sign-up, only when the email is verified (and the same events fire)', async () => {
  smtpOn();
  const ws = (await app.call('POST', '/workspaces', owner.token, { name: 'Invite rule' })).data.id as string;
  const email = `invitee-${++seq}@example.com`;
  const inv = await app.call('POST', `/workspaces/${ws}/members`, owner.token, { email, role: 'member' });
  assert.equal(inv.data.status, 'invited');

  // Listen as the owner: the members event must arrive when the invite is accepted.
  const events: { type: string; workspaceId?: string }[] = [];
  const sock = new WS(`${app.wsOrigin}/api/events`, ['noteapp.v1', `bearer.${owner.token}`]);
  sock.on('message', (m) => events.push(JSON.parse(String(m))));
  after(() => sock.terminate()); // even if an assertion below fails
  await new Promise((res) => sock.once('open', res));

  const r = await register('Invitee', email);
  assert.equal(r.status, 200);
  assert.equal(r.data.user.emailVerified, false);
  const member = () => db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(ws, r.data.user.id) as { role: string } | undefined;
  const pending = () => db.prepare('SELECT 1 FROM workspace_invites WHERE workspace_id = ? AND email = ?').get(ws, email);
  assert.equal(member(), undefined, 'not a member after sign-up');
  assert.ok(pending(), 'the invite is still pending');
  assert.equal((await app.call('GET', `/workspaces/${ws}/tree`, r.data.accessToken)).status, 403);
  // The invite link itself can't be used either (it needs an unverified-proof account).
  const token = inv.data.inviteUrl.split('/invite/')[1] as string;
  assert.equal((await app.call('POST', `/invites/${token}/accept`, r.data.accessToken)).status, 403);
  await new Promise((res) => setTimeout(res, 100));
  assert.ok(!events.some((e) => e.type === 'members' && e.workspaceId === ws), 'no members event yet');

  assert.equal((await verify(tokenIn(await mailTo(email)))).status, 200);
  assert.equal(member()?.role, 'member', 'joined at verification');
  assert.equal(pending(), undefined, 'invite consumed');
  for (let i = 0; i < 50 && !events.some((e) => e.type === 'members' && e.workspaceId === ws); i++) await new Promise((res) => setTimeout(res, 20));
  assert.ok(events.some((e) => e.type === 'members' && e.workspaceId === ws), 'members event published');
  sock.close();
  assert.ok((await app.call('GET', '/workspaces', r.data.accessToken)).data.some((w: { id: string }) => w.id === ws));
});

test('inviting the email of an existing unverified account makes a pending invite instead of adding it', async () => {
  smtpOn();
  const r = await register('Squatter');
  const ws = (await app.call('POST', '/workspaces', owner.token, { name: 'No squatting' })).data.id as string;
  const inv = await app.call('POST', `/workspaces/${ws}/members`, owner.token, { email: r.email, role: 'admin' });
  assert.equal(inv.data.status, 'invited');
  assert.equal(db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(ws, r.data.user.id), undefined);
  assert.equal((await verify(tokenIn(await mailTo(r.email)))).status, 200);
  assert.deepEqual(db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(ws, r.data.user.id), { role: 'admin' });
});

test('an expired invite is not accepted at verification either', async () => {
  smtpOn();
  const ws = (await app.call('POST', '/workspaces', owner.token, { name: 'Expired invite' })).data.id as string;
  const email = `expired-${++seq}@example.com`;
  await app.call('POST', `/workspaces/${ws}/members`, owner.token, { email, role: 'member' });
  db.prepare('UPDATE workspace_invites SET expires_at = ? WHERE workspace_id = ?').run(new Date(Date.now() - 1000).toISOString(), ws);
  const r = await register('Expired', email);
  assert.equal((await verify(tokenIn(await mailTo(email)))).status, 200);
  assert.equal(db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(ws, r.data.user.id), undefined);
});

// ── The middleware: unverified users can sign in and out and nothing else ──

function connect(path: string, token: string): Promise<number | null> {
  return new Promise((resolve) => {
    const ws = new WS(`${app.wsOrigin}${path}`, ['noteapp.v1', `bearer.${token}`]);
    let opened = false;
    ws.on('open', () => {
      opened = true;
      setTimeout(() => (ws.terminate(), resolve(null)), 200); // still open after the auth check
    });
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => !opened && resolve(-1));
  });
}

test('an unverified user is refused everywhere except /me and resend (REST, uploads, both WebSockets)', async () => {
  smtpOn();
  const r = await register('Blocked');
  const tok = r.data.accessToken as string;
  // Make them a member of a real workspace with a real page, so a refusal can't be "not found".
  const ws = (await app.call('POST', '/workspaces', owner.token, { name: 'Blocked ws' })).data.id as string;
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").run(ws, r.data.user.id, new Date().toISOString());
  const nb = (await app.call('POST', `/workspaces/${ws}/notebooks`, owner.token, { name: 'NB' })).data;
  const page = (await app.call('POST', `/sections/${nb.sectionId}/pages`, owner.token, { title: 'P' })).data.id as string;

  const denied: [string, string, unknown?][] = [
    ['GET', '/workspaces'],
    ['GET', `/workspaces/${ws}/tree`],
    ['POST', '/workspaces', { name: 'Mine' }],
    ['GET', `/pages/${page}`],
    ['PATCH', '/me', { name: 'New Name' }],
    ['POST', '/me/password', { currentPassword: 'password123', newPassword: 'another-password-1' }], // change password is NOT allowed
    ['GET', '/notifications'],
    ['GET', '/admin/stats'],
    ['POST', '/invites/some-token/accept'],
    ['GET', '/ME'], // odd spellings fall through to the refusal
    ['GET', '/does-not-exist'],
  ];
  for (const [method, path, body] of denied) {
    const res = await app.call(method, path, tok, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(res.data.code, 'email_unverified', `${method} ${path}`);
  }
  for (const path of [`/uploads`, `/workspaces/${ws}/files?pageId=${page}`]) {
    const up = await fetch(`${app.origin}/api${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'text/plain', 'x-filename': 'a.txt' },
      body: 'hello',
    });
    assert.equal(up.status, 403, path);
    assert.equal((await up.json()).code, 'email_unverified');
  }
  assert.equal(await connect('/api/events', tok), 4403);
  assert.equal(await connect(`/collab/${page}`, tok), 4403);

  // Allowed: who am I, ask for a new link, sign out; and the public sign-in routes.
  const profile = await app.call('GET', '/me', tok);
  assert.equal(profile.status, 200);
  assert.equal(profile.data.emailVerified, false);
  assert.equal((await app.call('POST', '/auth/resend-verification', tok)).status, 200);
  assert.equal((await app.call('POST', '/auth/refresh', undefined, { refreshToken: r.data.refreshToken })).status, 200);
  assert.equal((await app.call('POST', '/auth/logout', undefined, { refreshToken: r.data.refreshToken })).status, 200);
  assert.equal((await app.call('POST', '/auth/login', undefined, { email: r.email, password: 'password123' })).data.user.emailVerified, false);

  // After verification the same token works everywhere.
  assert.equal((await verify(tokenIn(await mailTo(r.email, 2)))).status, 200);
  assert.equal((await app.call('GET', '/workspaces', tok)).status, 200);
  assert.equal(await connect('/api/events', tok), null);
  assert.equal(await connect(`/collab/${page}`, tok), null);
});

// ── e2e-only hooks ──

test('test hooks need E2E_TEST_HOOKS=1 and a non-production NODE_ENV', async () => {
  smtpOff();
  const { createServer } = await import('../server/app.ts');
  const env = { hooks: process.env.E2E_TEST_HOOKS, node: process.env.NODE_ENV };
  const outboxUrl = (origin: string) => `${origin}/api/__test/outbox?to=hooks@example.com`;
  const serve = async () => {
    const { server } = createServer({ serveWeb: false });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return { origin, close: () => new Promise<void>((res) => (server.closeAllConnections(), server.close(() => res()))) };
  };
  try {
    // Off by default: not mounted, and verification isn't required without SMTP.
    delete process.env.E2E_TEST_HOOKS;
    process.env.NODE_ENV = 'test';
    assert.equal(testHooksEnabled(), false);
    assert.equal(verificationRequired(), false);
    let s = await serve();
    assert.equal((await fetch(outboxUrl(s.origin))).status, 401, 'falls through to the authenticated API');
    await s.close();

    // On in a test environment: the outbox is readable and verification is required without SMTP.
    process.env.E2E_TEST_HOOKS = '1';
    assert.equal(testHooksEnabled(), true);
    assert.equal(verificationRequired(), true);
    s = await serve();
    const { sendMail } = await import('../server/mail.ts');
    await sendMail({ to: 'hooks@example.com', subject: 'Hi', text: 'Body' });
    const res = await fetch(outboxUrl(s.origin));
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { subject: string }[]).map((m) => m.subject), ['Hi']);

    // Production: ignored. Even a server built a moment earlier stops answering.
    process.env.NODE_ENV = 'production';
    assert.equal(testHooksEnabled(), false);
    assert.equal(verificationRequired(), false);
    assert.equal((await fetch(outboxUrl(s.origin))).status, 404);
    await s.close();
    s = await serve();
    assert.notEqual((await fetch(outboxUrl(s.origin))).status, 200);
    await s.close();
  } finally {
    if (env.hooks === undefined) delete process.env.E2E_TEST_HOOKS;
    else process.env.E2E_TEST_HOOKS = env.hooks;
    if (env.node === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = env.node;
  }
});
