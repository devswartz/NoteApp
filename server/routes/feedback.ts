// "Send feedback": POST /api/feedback emails the instance admins (ADMIN_EMAILS). No table: nothing is stored
// except one structured log line (event "feedback"), so feedback is never lost when mail isn't configured.
import { Router } from 'express';
import { APP_NAME } from '../../shared/config.ts';
import { adminEmails } from '../admin.ts';
import { VERSION } from '../config.ts';
import { HttpError, h } from '../http.ts';
import { log } from '../log.ts';
import { escapeHtml, sendMail } from '../mail.ts';
import { refuse, takeFeedback } from '../ratelimit.ts';

export const FEEDBACK_MAX = 4000;
const BODY_MAX_BYTES = 16 * 1024;

export const feedbackRoutes = Router();

/** Single-line, control-character-free text (header values must never contain newlines). */
const oneLine = (v: unknown, max: number) =>
  typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** In-app path only: relative, no query or hash. Returns '' when absent; throws 400 when not a relative path. */
export function cleanPage(v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || v.length > 500) throw new HttpError(400, 'page must be a relative path');
  const path = v.split(/[?#]/)[0]!;
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u001f\u007f\s]/.test(path) || /^\/[a-z][a-z0-9+.-]*:/i.test(path))
    throw new HttpError(400, 'page must be a relative path');
  return path.slice(0, 300);
}

feedbackRoutes.post(
  '/feedback',
  h(async (req, res) => {
    if (Number(req.headers['content-length'] ?? 0) > BODY_MAX_BYTES) throw new HttpError(413, 'That is too large to send');
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.message !== 'string' || !body.message.trim()) throw new HttpError(400, 'Write a message first');
    const message = body.message.trim();
    if (message.length > FEEDBACK_MAX) throw new HttpError(413, `Feedback is too long (max ${FEEDBACK_MAX} characters)`);
    const page = cleanPage(body.page);
    const client = (body.client && typeof body.client === 'object' ? body.client : {}) as Record<string, unknown>;

    const wait = takeFeedback(req.user.id);
    if (wait) return void refuse(res, wait);

    const u = req.user;
    const name = oneLine(u.name, 80) || 'Someone';
    const email = oneLine(u.email, 200);
    const info = {
      userId: u.id,
      name,
      email,
      serverVersion: VERSION,
      clientVersion: oneLine(client.version, 40) || 'unknown',
      platform: oneLine(client.platform, 40) || 'unknown',
      userAgent: oneLine(req.get('user-agent'), 200) || 'unknown',
      page: page || 'unknown',
      workspaceId: /^\/w\/([\w-]+)/.exec(page)?.[1] ?? null,
      at: new Date().toISOString(),
    };

    const lines = [
      ['From', `${name} <${email}>`],
      ['User id', info.userId],
      ['Workspace id', info.workspaceId ?? 'unknown'],
      ['Page', info.page],
      ['Server version', info.serverVersion],
      ['App version', info.clientVersion],
      ['Platform', info.platform],
      ['User agent', info.userAgent],
      ['Sent', info.at],
    ] as const;
    const text = `${message}\n\n---\n${lines.map(([k, v]) => `${k}: ${v}`).join('\n')}\n`;
    const html =
      `<div style="white-space:pre-wrap;font-size:15px">${escapeHtml(message)}</div><hr>` +
      `<table style="font-size:13px;color:#555">${lines.map(([k, v]) => `<tr><td style="padding-right:12px">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('')}</table>`;

    const admins = adminEmails();
    let delivered = false;
    for (const to of admins) {
      try {
        const r = await sendMail({ to, subject: `Feedback from ${name} on ${APP_NAME}`, text, html, replyTo: email });
        if (r.sent) delivered = true;
      } catch (e) {
        log.error('feedback mail failed', { userId: u.id, err: e });
      }
    }
    // One line per submission. The text is only logged when it didn't reach an inbox, so nothing is lost.
    log.info('feedback', { event: 'feedback', ...info, delivered, adminCount: admins.length, ...(delivered ? {} : { message }) });
    return { ok: true, delivered };
  }),
);
