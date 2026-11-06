// SEED_DEMO accounts must be usable where email verification is required (staging runs SEED_DEMO=1 with SMTP).
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers/app.ts';

let app: TestApp;
before(async () => {
  process.env.DEMO_PASSWORD = 'demo-password';
  app = await startTestApp();
});
after(() => app.close());

test('seeded demo accounts are verified and can use the app while verification is required', async () => {
  const { seedDemoIfEmpty, DEMO_USERS } = await import('../server/demo.ts');
  const { verificationRequired } = await import('../server/verification.ts');
  const { setMailTransport } = await import('../server/mail.ts');
  const nodemailer = (await import('nodemailer')).default;
  process.env.SMTP_HOST = 'smtp.example.test';
  setMailTransport(nodemailer.createTransport({ jsonTransport: true }));
  try {
    assert.ok(verificationRequired(), 'with SMTP configured, new accounts must verify');
    assert.equal(seedDemoIfEmpty(), true);
    const { db } = await import('../server/db.ts');
    for (const u of DEMO_USERS) {
      const row = db.prepare('SELECT email_verified_at FROM users WHERE email = ?').get(u.email) as { email_verified_at: string | null };
      assert.ok(row.email_verified_at, `${u.email} is verified`);
      const login = await app.call('POST', '/auth/login', undefined, { email: u.email, password: 'demo-password' });
      assert.equal(login.status, 200);
      assert.equal(login.data.user.emailVerified, true);
      const ws = await app.call('GET', '/workspaces', login.data.accessToken);
      assert.equal(ws.status, 200, `${u.email} is not stuck on "Check your email"`);
    }
  } finally {
    delete process.env.SMTP_HOST;
    setMailTransport(undefined);
  }
});
