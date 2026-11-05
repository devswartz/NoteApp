// Email delivery channel (server/mail.ts). Skipped when SMTP isn't configured
// or the user turned email off.
import { db } from '../db.ts';
import { mailEnabled, sendMail } from '../mail.ts';
import { getSettings } from './settings.ts';
import type { DeliveryChannel, Notice } from './channels.ts';

const PUBLIC_URL = () => (process.env.PUBLIC_URL ?? '').replace(/\/$/, '');

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function emailChannel(opts: { force?: boolean } = {}): DeliveryChannel {
  return {
    name: 'email',
    available: () => opts.force || mailEnabled(),
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
        `<p>${escapeHtml(n.body).replace(/\n/g, '<br>')}</p>${link ? `<p><a href="${escapeHtml(link)}">Open in NoteApp</a></p>` : ''}`;
      const r = await sendMail({ to, subject: n.title, text, html });
      if (!r.sent) throw new Error(r.skipped ?? 'Email not sent');
    },
  };
}
