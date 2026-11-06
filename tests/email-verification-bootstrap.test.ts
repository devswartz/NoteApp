// Which accounts skip email verification: bootstrap accounts (the very first, an email in ADMIN_EMAILS)
// and every account on a server with no SMTP. Needs an empty database, hence its own file.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { startTestApp, type TestApp } from './helpers/app.ts';

process.env.MAIL_QUIET = '1';
process.env.SMTP_HOST = 'smtp.example.test'; // mail is configured, so verification is required
process.env.ADMIN_EMAILS = 'Boss@example.com';
const sent: string[] = [];
const { setMailTransport } = await import('../server/mail.ts');
const transport = nodemailer.createTransport({ jsonTransport: true });
transport.sendMail = (async (m: { to: string }) => {
  sent.push(String(m.to));
  return { messageId: 'x' };
}) as unknown as typeof transport.sendMail;
setMailTransport(transport);

let app: TestApp;
before(async () => {
  app = await startTestApp();
});
after(async () => {
  setMailTransport(undefined);
  await app.close();
});

const register = (email: string) => app.call('POST', '/auth/register', undefined, { name: 'Pat', email, password: 'password123' });
const settle = () => new Promise((r) => setTimeout(r, 100));

test('with SMTP: the first account is verified (bootstrap), an ADMIN_EMAILS address is verified, everyone else is not', async () => {
  const first = await register('founder@example.com');
  assert.equal(first.data.user.emailVerified, true);
  assert.equal((await app.call('GET', '/workspaces', first.data.accessToken)).status, 200);

  const boss = await register('boss@example.com'); // ADMIN_EMAILS is case-insensitive
  assert.equal(boss.data.user.emailVerified, true);
  assert.equal((await app.call('GET', '/me', boss.data.accessToken)).data.emailVerified, true);

  const plain = await register('plain@example.com');
  assert.equal(plain.data.user.emailVerified, false);
  assert.equal((await app.call('GET', '/workspaces', plain.data.accessToken)).status, 403);

  await settle();
  assert.deepEqual(sent, ['plain@example.com'], 'only the unverified account is mailed');
});

test('without SMTP everyone is verified, even with the same configuration otherwise', async () => {
  delete process.env.SMTP_HOST;
  setMailTransport(undefined);
  try {
    const r = await register('anyone@example.com');
    assert.equal(r.data.user.emailVerified, true);
    assert.equal((await app.call('GET', '/workspaces', r.data.accessToken)).status, 200);
  } finally {
    process.env.SMTP_HOST = 'smtp.example.test';
  }
});
