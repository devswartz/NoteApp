// Email delivery channel (server/mail.ts). Skipped when SMTP isn't configured
// or the user turned email off.
import { db } from '../db.ts';
import { APP_NAME } from '../../shared/config.ts';
import { escapeHtml, mailConfigured, sendMail, type MailMessage, type MailResult } from '../mail.ts';
import { getSettings } from './settings.ts';
import type { DeliveryChannel, Notice } from './channels.ts';

const PUBLIC_URL = () => (process.env.PUBLIC_URL ?? '').replace(/\/$/, '');

export { escapeHtml };

/** `send` and `force` are for tests (capture mail without SMTP). */
export function emailChannel(opts: { force?: boolean; send?: (m: MailMessage) => Promise<MailResult> } = {}): DeliveryChannel {
  const send = opts.send ?? sendMail;
  return {
    name: 'email',
    available: () => !!opts.force || mailConfigured(),
    targets(userId) {
      if (!getSettings(userId).emailEnabled) return [];
      const u = db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as { email: string } | undefined;
      return u ? [u.email] : [];
    },
    async send(to, n: Notice) {
      const link = PUBLIC_URL() ? `${PUBLIC_URL()}${n.path}` : '';
      const text = `${n.body}${link ? `\n\nOpen: ${link}` : ''}`;
      const html =
        n.html ??
        `<p>${escapeHtml(n.body).replace(/\n/g, '<br>')}</p>${link ? `<p><a href="${escapeHtml(link)}">Open in ${escapeHtml(APP_NAME)}</a></p>` : ''}`;
      const r = await send({ to, subject: n.title, text, html });
      if (!r.sent) throw new Error(r.error ?? 'Email not sent');
    },
  };
}
