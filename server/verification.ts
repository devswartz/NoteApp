// Email verification for new accounts.
//
// - A new account is unverified (users.email_verified_at NULL) unless it is a
//   bootstrap account (the very first one, or an email in ADMIN_EMAILS) or the
//   server can't send mail at all (no SMTP_HOST: dev, tests, a bare install),
//   where verification would be impossible. Accounts that existed before
//   migration 012 are backfilled as verified.
// - The token is 32 random bytes; only its SHA-256 is stored (like refresh and
//   invite tokens). One live token per user: a new request replaces the old one.
//   Single use, valid for 24 hours.
// - Pending workspace invites for the account's email are applied at the moment
//   of verification, in the same transaction, never at sign-up (an unverified
//   address proves nothing about who owns the mailbox).
// - Workspace invite links do NOT verify an email: the link's token is also
//   returned to the inviting admin (inviteUrl), so it doesn't prove the mailbox.
import crypto from 'node:crypto';
import { db, now } from './db.ts';
import { escapeHtml, mailConfigured, sendMail } from './mail.ts';
import { APP_NAME } from '../shared/config.ts';
import { publish } from './events.ts';
import { publicUrl } from './workspaces.ts';
import { adminEmails } from './admin.ts';
import { log } from './log.ts';
import type { Role } from '../shared/types.ts';

export const VERIFY_TTL_S = 24 * 60 * 60;

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * Test-only hooks (a mail outbox endpoint, and verification required even without SMTP) for the
 * e2e suite. Needs E2E_TEST_HOOKS=1 AND a non-production NODE_ENV: in production the variable is
 * ignored, so it can't be switched on there. Read on each call.
 */
export function testHooksEnabled(): boolean {
  return process.env.E2E_TEST_HOOKS === '1' && process.env.NODE_ENV !== 'production';
}

if (process.env.E2E_TEST_HOOKS && process.env.NODE_ENV === 'production')
  console.warn('[verification] E2E_TEST_HOOKS is ignored in production');

/** Whether new accounts must verify their email: only when mail can actually be delivered. */
export function verificationRequired(): boolean {
  return mailConfigured() || testHooksEnabled();
}

/** Should a brand-new account start verified? Call inside the registration transaction, before inserting the user. */
export function startsVerified(email: string): boolean {
  if (!verificationRequired()) return true;
  if (!db.prepare("SELECT 1 FROM users WHERE id <> 'deleted-user' LIMIT 1").get()) return true; // the very first account bootstraps the server
  return adminEmails().includes(email.toLowerCase());
}

/** Create (or replace) the user's verification token. Returns the raw token for the link. */
export function issueVerificationToken(userId: string, email: string): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const ts = new Date();
  db.prepare(
    `INSERT INTO email_verifications (user_id, email, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET email = excluded.email, token_hash = excluded.token_hash,
       created_at = excluded.created_at, expires_at = excluded.expires_at`,
  ).run(userId, email, hashToken(token), ts.toISOString(), new Date(ts.getTime() + VERIFY_TTL_S * 1000).toISOString());
  return token;
}

/** Issue a fresh token and email the link. Never throws; failures are logged (the user can resend). */
export async function sendVerificationEmail(user: { id: string; email: string; name: string }): Promise<boolean> {
  const link = `${publicUrl()}/verify-email?token=${encodeURIComponent(issueVerificationToken(user.id, user.email))}`;
  const r = await sendMail({
    to: user.email,
    subject: `Confirm your email for ${APP_NAME}`,
    text: `Hi ${user.name},\n\nConfirm your email address to start using ${APP_NAME}:\n${link}\n\nThe link works once, for 24 hours. If you didn't create an account, you can ignore this email.`,
    html: `<p>Hi ${escapeHtml(user.name)},</p><p><a href="${escapeHtml(link)}">Confirm your email for ${escapeHtml(APP_NAME)}</a></p><p style="color:#666;font-size:13px">Or open this link: ${escapeHtml(link)}<br>It works once, for 24 hours. If you didn't create an account, you can ignore this email.</p>`,
  });
  if (!r.sent && mailConfigured()) log.warn('verification email not sent', { userId: user.id, error: r.error });
  return r.sent;
}

/** Add the account to every workspace it has a live invite for, and consume those invites. Call inside a transaction. */
export function acceptPendingInvites(userId: string, email: string, ts = now()) {
  const live = '(expires_at IS NULL OR expires_at > ?)';
  const invites = db.prepare(`SELECT workspace_id, role FROM workspace_invites WHERE email = ? AND ${live}`).all(email, ts) as {
    workspace_id: string;
    role: Role;
  }[];
  for (const inv of invites) {
    db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(
      inv.workspace_id, userId, inv.role, ts,
    );
    publish({ type: 'members', workspaceId: inv.workspace_id });
  }
  db.prepare(`DELETE FROM workspace_invites WHERE email = ? AND ${live}`).run(email, ts);
}

/**
 * Use a token: mark the account verified and apply its pending invites, atomically.
 * Returns the user id, or null if the token is unknown, used, expired or stale.
 */
export function consumeVerificationToken(token: unknown): string | null {
  if (typeof token !== 'string' || token.length < 16 || token.length > 200) return null;
  return db.transaction(() => {
    const row = db.prepare('SELECT user_id, email, expires_at FROM email_verifications WHERE token_hash = ?').get(hashToken(token)) as
      | { user_id: string; email: string; expires_at: string }
      | undefined;
    if (!row) return null;
    const ts = now();
    db.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(row.user_id); // single use, even when expired
    if (row.expires_at < ts) return null;
    const u = db.prepare('SELECT email FROM users WHERE id = ?').get(row.user_id) as { email: string } | undefined;
    if (!u || u.email.toLowerCase() !== row.email.toLowerCase()) return null;
    db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL').run(ts, row.user_id);
    acceptPendingInvites(row.user_id, u.email.toLowerCase(), ts);
    return row.user_id;
  })();
}

/** Housekeeping: drop expired tokens (called with the refresh-token cleanup in server/index.ts). */
export function pruneEmailVerifications() {
  db.prepare('DELETE FROM email_verifications WHERE expires_at < ?').run(now());
}
