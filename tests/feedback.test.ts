import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';

process.env.MAIL_QUIET = '1';
delete process.env.SMTP_HOST;
process.env.ADMIN_EMAILS = 'boss@example.com, Second@Example.com';

let app: TestApp;
let outbox: typeof import('../server/mail.ts').outbox;
let setMailTransport: typeof import('../server/mail.ts').setMailTransport;
before(async () => {
  app = await startTestApp();
  ({ outbox, setMailTransport } = await import('../server/mail.ts'));
});
after(() => app.close());

const send = (u: TestUser | undefined, body: unknown) => app.call('POST', '/feedback', u?.token, body);
const good = { message: 'Love it, but <b>sync</b> is slow', page: '/w/ws1/p/page1', client: { version: 'abc123', platform: 'web' } };
const mailsTo = (to: string) => outbox.filter((m) => m.to === to && m.subject.startsWith('Feedback from'));

/** Captures structured log lines written to stdout while `fn` runs. */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { result: await fn(), lines };
  } finally {
    process.stdout.write = orig;
  }
}

test('happy path: every admin gets the mail with all fields and Reply-To', async () => {
  const u = await app.signUp('Fiona Feedback', 'fiona@example.com');
  const r = await send(u, good);
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.delivered, false); // no SMTP in tests: it only reaches the outbox
  for (const to of ['boss@example.com', 'second@example.com']) {
    const m = mailsTo(to).at(-1)!;
    assert.ok(m, `mail to ${to}`);
    assert.equal(m.subject, 'Feedback from Fiona Feedback on Notivelo');
    assert.equal(m.replyTo, 'fiona@example.com');
    for (const part of ['Love it, but <b>sync</b> is slow', 'Fiona Feedback', 'fiona@example.com', u.user.id, 'abc123', 'web', '/w/ws1/p/page1', 'Workspace id: ws1', 'Server version: ', 'Sent: 20']) {
      assert.ok(m.text.includes(part), `text has ${part}`);
    }
    assert.ok(m.html!.includes('&lt;b&gt;sync&lt;/b&gt;'), 'HTML escaped');
    assert.ok(!m.html!.includes('<b>sync</b>'));
  }
});

test('page: query and hash are stripped; non-relative paths are rejected', async () => {
  const u = await app.signUp('Page Person');
  const r = await send(u, { ...good, page: '/w/ws2/tasks/today?token=SECRET#frag' });
  assert.equal(r.status, 200);
  const m = mailsTo('boss@example.com').at(-1)!;
  assert.ok(m.text.includes('Page: /w/ws2/tasks/today\n'));
  assert.ok(!m.text.includes('SECRET'));
  for (const page of ['https://evil.example/x', '//evil.example/x', 'w/ws/p', '/\\evil', '/a b', '/x\nBcc: a@b.c', 'javascript:alert(1)', 42]) {
    assert.equal((await send(u, { ...good, page })).status, 400, `page ${JSON.stringify(page)}`);
  }
});

test('header injection: newlines in the name never reach the subject or Reply-To', async () => {
  const u = await app.signUp('Eve\r\nBcc: evil@example.com', 'eve@example.com');
  assert.equal((await send(u, good)).status, 200);
  const m = mailsTo('boss@example.com').at(-1)!;
  assert.ok(!/[\r\n]/.test(m.subject), 'no newline in subject');
  assert.ok(!/[\r\n]/.test(m.replyTo!), 'no newline in Reply-To');
  assert.match(m.subject, /^Feedback from Eve .*Bcc: evil@example\.com on Notivelo$/);
  // And through a real transport the message has exactly one Bcc-free header set.
  const t = nodemailer.createTransport({ jsonTransport: true });
  const sent: Record<string, unknown>[] = [];
  const orig = t.sendMail.bind(t);
  t.sendMail = (async (o: Parameters<typeof t.sendMail>[0]) => {
    const info = await orig(o);
    sent.push(JSON.parse(String((info as unknown as { message: string }).message)));
    return info;
  }) as typeof t.sendMail;
  setMailTransport(t);
  try {
    const u2 = await app.signUp('Mallory\r\nBcc: evil@example.com');
    const r = await send(u2, good);
    assert.equal(r.data.delivered, true);
  } finally {
    setMailTransport(undefined);
  }
  assert.equal(sent.length, 2);
  assert.ok(sent.every((s) => !('bcc' in s) && (s.replyTo as { address: string }[])[0]!.address.includes('@')));
});

test('message validation: empty 400, over 4000 chars 413, huge body 413', async () => {
  const u = await app.signUp('Val Idate');
  assert.equal((await send(u, { ...good, message: '   ' })).status, 400);
  assert.equal((await send(u, { page: '/x' })).status, 400);
  assert.equal((await send(u, { ...good, message: 42 })).status, 400);
  assert.equal((await send(u, { ...good, message: 'x'.repeat(4001) })).status, 413);
  assert.equal((await send(u, { ...good, message: 'x'.repeat(4000) })).status, 200);
  assert.equal((await send(u, { ...good, message: 'x'.repeat(40_000) })).status, 413);
});

test('auth: 401 without a token; 403 email_unverified for an unverified user', async () => {
  assert.equal((await send(undefined, good)).status, 401);
  process.env.SMTP_HOST = 'smtp.example.test';
  setMailTransport(nodemailer.createTransport({ jsonTransport: true }));
  let token: string;
  try {
    const r = await app.call('POST', '/auth/register', undefined, { name: 'Unver', email: 'unver-fb@example.com', password: 'password123' });
    assert.equal(r.data.user.emailVerified, false);
    token = r.data.accessToken;
  } finally {
    delete process.env.SMTP_HOST;
    setMailTransport(undefined);
  }
  const before = outbox.length;
  const r = await app.call('POST', '/feedback', token, good);
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'email_unverified');
  assert.equal(outbox.filter((m) => m.subject.startsWith('Feedback from')).length, outbox.slice(0, before).filter((m) => m.subject.startsWith('Feedback from')).length);
});

test('rate limit: five an hour per user, then 429 with Retry-After; other users unaffected', async () => {
  const u = await app.signUp('Rate Limited');
  for (let i = 0; i < 5; i++) assert.equal((await send(u, good)).status, 200, `send ${i + 1}`);
  const res = await fetch(`${app.origin}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${u.token}` },
    body: JSON.stringify(good),
  });
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  const other = await app.signUp('Other Person');
  assert.equal((await send(other, good)).status, 200);
});

test('mail failure never returns 500: logged, delivered:false', async () => {
  const u = await app.signUp('Mail Fail');
  const t = nodemailer.createTransport({ jsonTransport: true });
  t.sendMail = (async () => {
    throw new Error('smtp down');
  }) as unknown as typeof t.sendMail;
  setMailTransport(t);
  const origErr = console.error;
  console.error = () => {};
  try {
    const { result, lines } = await captureLogs(() => send(u, good));
    assert.equal(result.status, 200);
    assert.equal(result.data.delivered, false);
    assert.ok(lines.some((l) => l.startsWith('feedback ') && l.includes('Love it')));
  } finally {
    console.error = origErr;
    setMailTransport(undefined);
  }
});

test('no ADMIN_EMAILS: one structured log line with the fields, 200 and delivered:false', async () => {
  const u = await app.signUp('No Admins', 'noadmins@example.com');
  const saved = process.env.ADMIN_EMAILS;
  delete process.env.ADMIN_EMAILS;
  try {
    const before = outbox.length;
    const { result, lines } = await captureLogs(() => send(u, good));
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { ok: true, delivered: false });
    assert.equal(outbox.length, before, 'nothing mailed');
    const fb = lines.filter((l) => l.startsWith('feedback '));
    assert.equal(fb.length, 1);
    const rec = JSON.parse(fb[0]!.slice('feedback '.length));
    assert.equal(rec.event, 'feedback');
    assert.equal(rec.userId, u.user.id);
    assert.equal(rec.email, 'noadmins@example.com');
    assert.equal(rec.name, 'No Admins');
    assert.equal(rec.message, good.message);
    assert.equal(rec.page, '/w/ws1/p/page1');
    assert.equal(rec.workspaceId, 'ws1');
    assert.equal(rec.clientVersion, 'abc123');
    assert.equal(rec.platform, 'web');
    assert.equal(rec.delivered, false);
    assert.ok(rec.serverVersion && rec.at && rec.userAgent);
  } finally {
    process.env.ADMIN_EMAILS = saved;
  }
});
