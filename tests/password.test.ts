import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers/app.ts';

let app: TestApp;
before(async () => {
  delete process.env.SMTP_HOST; // mail goes to the outbox
  app = await startTestApp();
});
after(() => app.close());

const login = (email: string, password: string) => app.call('POST', '/auth/login', undefined, { email, password });

async function resetLink(email: string): Promise<string> {
  const { outbox } = await import('../server/mail.ts');
  const before = outbox.length;
  assert.equal((await app.call('POST', '/auth/forgot', undefined, { email })).status, 200);
  assert.equal(outbox.length, before + 1, 'one email sent');
  const msg = outbox.at(-1)!;
  assert.equal(msg.to, email);
  return decodeURIComponent(/token=([^\s"&]+)/.exec(msg.text)![1]);
}

test('forgot password: same answer for unknown emails, and no mail sent', async () => {
  const { outbox } = await import('../server/mail.ts');
  const n = outbox.length;
  const r = await app.call('POST', '/auth/forgot', undefined, { email: 'nobody@example.com' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true });
  assert.equal(outbox.length, n);
});

test('reset link sets a new password, signs out everywhere and works only once', async () => {
  const u = await app.signUp('Rita', 'rita@example.com');
  const token = await resetLink('rita@example.com');
  assert.equal((await app.call('POST', '/auth/reset', undefined, { token, password: 'short' })).status, 400);
  assert.equal((await app.call('POST', '/auth/reset', undefined, { token, password: 'brand-new-pass' })).status, 200);
  assert.equal((await login('rita@example.com', 'password123')).status, 401);
  assert.equal((await login('rita@example.com', 'brand-new-pass')).status, 200);
  assert.equal((await app.call('POST', '/auth/refresh', undefined, { refreshToken: u.refreshToken })).status, 401, 'old sessions revoked');
  assert.equal((await app.call('POST', '/auth/reset', undefined, { token, password: 'another-pass-1' })).status, 400, 'single use');
});

test('a second reset email within a minute is not sent', async () => {
  await app.signUp('Sid', 'sid@example.com');
  await resetLink('sid@example.com');
  const { outbox } = await import('../server/mail.ts');
  const n = outbox.length;
  await app.call('POST', '/auth/forgot', undefined, { email: 'sid@example.com' });
  assert.equal(outbox.length, n);
});

test('change password needs the current one and keeps only this device signed in', async () => {
  const u = await app.signUp('Tom', 'tom@example.com');
  const other = await login('tom@example.com', 'password123');
  const bad = await app.call('POST', '/me/password', u.token, { currentPassword: 'wrong-pass', newPassword: 'new-password-1' });
  assert.equal(bad.status, 400);
  const ok = await app.call('POST', '/me/password', u.token, { currentPassword: 'password123', newPassword: 'new-password-1' });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.refreshToken);
  assert.equal((await app.call('POST', '/auth/refresh', undefined, { refreshToken: other.data.refreshToken })).status, 401);
  assert.equal((await app.call('POST', '/auth/refresh', undefined, { refreshToken: ok.data.refreshToken })).status, 200);
  assert.equal((await login('tom@example.com', 'new-password-1')).status, 200);
});

test("passwords longer than bcrypt's 72 bytes are refused everywhere", async () => {
  const long = 'a'.repeat(73);
  const emoji = '😀'.repeat(19); // 19 × 4 bytes = 76 bytes, only 19 characters
  for (const pw of [long, emoji]) {
    const r = await app.call('POST', '/auth/register', undefined, { name: 'Len', email: `len${pw.length}@example.com`, password: pw });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /too long/);
  }
  assert.equal((await app.call('POST', '/auth/register', undefined, { name: 'Ok', email: 'ok72@example.com', password: 'a'.repeat(72) })).status, 200);
  const u = await app.signUp('Lenny');
  const ch = await app.call('POST', '/me/password', u.token, { currentPassword: 'password123', newPassword: long });
  assert.equal(ch.status, 400);
});

test('login takes about as long for an unknown email as for a wrong password (no account enumeration by timing)', async () => {
  await app.signUp('Tim', 'tim@example.com');
  const time = async (email: string) => {
    const t = performance.now();
    const r = await app.call('POST', '/auth/login', undefined, { email, password: 'wrong-password-1' });
    assert.equal(r.status, 401);
    return performance.now() - t;
  };
  await time('tim@example.com'); // warm up
  const known: number[] = [];
  const unknown: number[] = [];
  for (let i = 0; i < 5; i++) {
    known.push(await time('tim@example.com'));
    unknown.push(await time(`nobody${i}@example.com`));
  }
  const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const [k, u] = [median(known), median(unknown)];
  // Both run one bcrypt comparison; without the dummy hash the unknown case is ~1 ms vs ~50 ms.
  assert.ok(u > k * 0.5 && u < k * 2, `unknown ${u.toFixed(1)} ms vs known ${k.toFixed(1)} ms`);
  assert.equal((await app.call('POST', '/auth/login', undefined, { email: 'tim@example.com', password: 'password123' })).status, 200);
});

test('two submissions of one reset link: only one succeeds', async () => {
  await app.signUp('Una', 'una@example.com');
  const token = await resetLink('una@example.com');
  const [a, b] = await Promise.all([
    app.call('POST', '/auth/reset', undefined, { token, password: 'first-new-pass' }),
    app.call('POST', '/auth/reset', undefined, { token, password: 'second-new-pass' }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 400]);
});
