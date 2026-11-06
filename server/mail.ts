// Outgoing email over SMTP (AWS SES in production), configured by the
// SMTP_* / MAIL_FROM variables in docs/DEPLOY_CONTRACT.md.
//
//   import { sendMail } from './mail.ts';
//   await sendMail({ to: 'sam@example.com', subject: 'Hi', text: 'Plain body', html: '<p>Optional HTML</p>' });
//
// If SMTP isn't configured the app still works: sendMail resolves with
// { sent: false } and logs the recipient and subject. Outside production it
// also logs the body, so invite links can be copied from the dev server log;
// in production bodies are never logged, because invite links are credentials. sendMail never throws; delivery failures are logged and
// reported as { sent: false, error }.
// Owner: Collaboration & Access. Also used by Reminders.
import nodemailer, { type Transporter } from 'nodemailer';
import { APP_NAME } from '../shared/config.ts';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Where replies go (a single address; newlines are stripped). */
  replyTo?: string;
}

export interface MailResult {
  sent: boolean;
  error?: string;
}

/** Messages "sent" while SMTP is unconfigured (newest last, capped). Tests read this. */
export const outbox: MailMessage[] = [];
const OUTBOX_MAX = 50;

let transport: Transporter | null | undefined; // undefined = not yet created
let warned = false;

// SES (and most providers) reject mail from an unverified sender, so a missing MAIL_FROM is a config error.
if (process.env.SMTP_HOST && !process.env.MAIL_FROM)
  console.warn('[mail] SMTP_HOST is set but MAIL_FROM is not: set MAIL_FROM to a verified sender (see docs/DEPLOY_CONTRACT.md)');

function from(): string {
  return process.env.MAIL_FROM || `${APP_NAME} <no-reply@localhost>`;
}

/** True when SMTP_HOST is set (and so mail is really delivered). */
export function mailConfigured(): boolean {
  return !!process.env.SMTP_HOST;
}

function getTransport(): Transporter | null {
  if (transport !== undefined) return transport;
  if (!mailConfigured()) {
    transport = null;
    return null;
  }
  const port = Number(process.env.SMTP_PORT || 587);
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465, // 587 upgrades with STARTTLS
    requireTLS: port !== 465 && port !== 25,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' } : undefined,
    // Don't let a slow SMTP server hang a request.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transport;
}

/** Send one email. Resolves { sent: true } on delivery to the SMTP server. Never throws. */
export async function sendMail(msg: MailMessage): Promise<MailResult> {
  const t = getTransport();
  if (!t) {
    if (!warned && process.env.NODE_ENV !== 'test') {
      console.warn('[mail] SMTP_HOST is not set; emails are logged instead of sent');
      warned = true;
    }
    outbox.push(msg);
    if (outbox.length > OUTBOX_MAX) outbox.shift();
    if (!process.env.MAIL_QUIET)
      console.log(`[mail] (not sent) to=${msg.to} subject=${JSON.stringify(msg.subject)}${process.env.NODE_ENV === 'production' ? '' : `\n${msg.text}`}`);
    return { sent: false };
  }
  try {
    await t.sendMail({ from: from(), to: msg.to, subject: msg.subject, text: msg.text, html: msg.html, ...(msg.replyTo ? { replyTo: msg.replyTo } : {}) });
    return { sent: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[mail] sending to ${msg.to} failed: ${error}`);
    return { sent: false, error };
  }
}

/** Tests only: replace the transport (e.g. nodemailer's jsonTransport), or pass undefined to re-read the env. */
export function setMailTransport(t: Transporter | null | undefined) {
  transport = t;
}

/** Escape text for inclusion in an HTML email body. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
