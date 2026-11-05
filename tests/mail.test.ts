import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer, { type SendMailOptions } from 'nodemailer';

process.env.MAIL_QUIET = '1';
delete process.env.SMTP_HOST;
const { sendMail, outbox, mailConfigured, setMailTransport, escapeHtml } = await import('../server/mail.ts');

test('without SMTP, sendMail logs to the outbox and reports not sent', async () => {
  assert.equal(mailConfigured(), false);
  const r = await sendMail({ to: 'a@example.com', subject: 'Hello', text: 'Link: http://x/invite/1' });
  assert.deepEqual(r, { sent: false });
  assert.equal(outbox.at(-1)?.to, 'a@example.com');
});

test('with a transport, sendMail delivers with MAIL_FROM', async () => {
  process.env.MAIL_FROM = 'Notivelo <notes@example.com>';
  const t = nodemailer.createTransport({ jsonTransport: true });
  const sent: string[] = [];
  const orig = t.sendMail.bind(t);
  t.sendMail = (async (m: SendMailOptions) => {
    const info = await orig(m);
    sent.push(String((info as unknown as { message: string }).message));
    return info;
  }) as typeof t.sendMail;
  setMailTransport(t);
  const r = await sendMail({ to: 'b@example.com', subject: 'Hi', text: 'Plain', html: '<p>Rich</p>' });
  assert.deepEqual(r, { sent: true });
  const m = JSON.parse(sent[0]);
  assert.equal(m.to[0].address, 'b@example.com');
  assert.equal(m.from.address, 'notes@example.com');
  assert.equal(m.html, '<p>Rich</p>');
  setMailTransport(undefined);
});

test('delivery failures resolve with an error instead of throwing', async () => {
  const t = nodemailer.createTransport({ jsonTransport: true });
  t.sendMail = (async () => {
    throw new Error('boom');
  }) as unknown as typeof t.sendMail;
  setMailTransport(t);
  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => errors.push(a);
  try {
    assert.deepEqual(await sendMail({ to: 'c@example.com', subject: 'x', text: 'y' }), { sent: false, error: 'boom' });
  } finally {
    console.error = orig;
    setMailTransport(undefined);
  }
});

test('escapeHtml', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});

test('in production, unsent mail logs recipient and subject but never the body (links are credentials)', async () => {
  const logs: string[] = [];
  const orig = console.log;
  const env = { NODE_ENV: process.env.NODE_ENV, MAIL_QUIET: process.env.MAIL_QUIET };
  console.log = (...a: unknown[]) => logs.push(a.join(' '));
  delete process.env.MAIL_QUIET;
  try {
    process.env.NODE_ENV = 'production';
    await sendMail({ to: 'p@example.com', subject: 'Invite', text: 'https://x/invite/SECRET' });
    process.env.NODE_ENV = 'development';
    await sendMail({ to: 'd@example.com', subject: 'Invite', text: 'https://x/invite/DEVLINK' });
  } finally {
    console.log = orig;
    process.env.NODE_ENV = env.NODE_ENV;
    process.env.MAIL_QUIET = env.MAIL_QUIET;
  }
  const all = logs.join('\n');
  assert.match(all, /to=p@example\.com subject="Invite"/);
  assert.ok(!all.includes('SECRET'));
  assert.ok(all.includes('DEVLINK'), 'dev still prints the link');
});
