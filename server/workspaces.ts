// Workspace helpers used by more than one route module.
import { db, newId, now } from './db.ts';
import { seedWorkspace } from './seed.ts';
import crypto from 'node:crypto';
import { escapeHtml, sendMail } from './mail.ts';
import { APP_NAME } from '../shared/config.ts';
import type { InviteInfo, Role } from '../shared/types.ts';

/** Create a workspace owned by `userId` and fill it with onboarding content. Call inside a transaction. */
export function createWorkspace(userId: string, name: string, personal: boolean): string {
  const id = newId();
  const ts = now();
  db.prepare('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').run(id, name, userId, ts);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").run(id, userId, ts);
  seedWorkspace(id, userId, personal);
  return id;
}

export function memberIds(workspaceId: string): string[] {
  return (db.prepare('SELECT user_id FROM workspace_members WHERE workspace_id = ?').all(workspaceId) as { user_id: string }[]).map(
    (r) => r.user_id,
  );
}

// ───────────── Invites ─────────────
// An invite is a row in workspace_invites keyed by (workspace, email). The
// emailed link carries a random token; only its SHA-256 is stored. A pending
// invite is also applied automatically when that email signs up.


export const INVITE_TTL_DAYS = 14;

export const hashInviteToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** The web app's origin for links in emails: PUBLIC_URL, else the caller's Origin, else localhost. */
export function publicUrl(origin?: string | null): string {
  return (process.env.PUBLIC_URL || origin || 'http://localhost:5173').replace(/\/+$/, '');
}

/** Create or refresh the invite for `email` with a new token. Returns the raw token (for the link). */
export function upsertInvite(workspaceId: string, email: string, role: Role, invitedBy: string): string {
  const token = crypto.randomBytes(24).toString('base64url');
  const ts = now();
  const expires = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000).toISOString();
  db.prepare(
    `INSERT INTO workspace_invites (workspace_id, email, role, invited_by, created_at, token_hash, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, email) DO UPDATE SET role = excluded.role, invited_by = excluded.invited_by,
       created_at = excluded.created_at, token_hash = excluded.token_hash, expires_at = excluded.expires_at`,
  ).run(workspaceId, email, role, invitedBy, ts, hashInviteToken(token), expires);
  return token;
}

interface InviteRow {
  workspace_id: string;
  email: string;
  role: Role;
  expires_at: string | null;
  workspace_name: string;
  inviter_name: string;
}

export function findInvite(token: string): (InviteInfo & { expiresAt: string | null }) | null {
  if (typeof token !== 'string' || token.length < 16) return null;
  const r = db
    .prepare(
      `SELECT i.workspace_id, i.email, i.role, i.expires_at, w.name AS workspace_name, u.name AS inviter_name
       FROM workspace_invites i JOIN workspaces w ON w.id = i.workspace_id JOIN users u ON u.id = i.invited_by
       WHERE i.token_hash = ?`,
    )
    .get(hashInviteToken(token)) as InviteRow | undefined;
  if (!r) return null;
  return {
    workspaceId: r.workspace_id,
    workspaceName: r.workspace_name,
    invitedByName: r.inviter_name,
    email: r.email,
    role: r.role,
    expired: !!r.expires_at && r.expires_at < now(),
    expiresAt: r.expires_at,
  };
}

/** Email an invite link. Never throws; resolves { sent } (false when SMTP isn't configured — the link is logged). */
export async function sendInviteEmail(opts: { to: string; link: string; workspaceName: string; inviterName: string; role: Role }) {
  const { to, link, workspaceName, inviterName, role } = opts;
  const subject = `${inviterName} invited you to ${workspaceName} on ${APP_NAME}`;
  const text = `${inviterName} invited you to join "${workspaceName}" on ${APP_NAME} as ${role === 'admin' ? 'an' : 'a'} ${role}.

Accept the invite: ${link}

The link works for ${INVITE_TTL_DAYS} days. If you weren't expecting this, you can ignore this email.`;
  const html = `<p>${escapeHtml(inviterName)} invited you to join <strong>${escapeHtml(workspaceName)}</strong> on ${escapeHtml(APP_NAME)} as ${role === 'admin' ? 'an' : 'a'} ${role}.</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 16px;background:#6366f1;color:#fff;border-radius:6px;text-decoration:none">Accept invite</a></p>
<p style="color:#666;font-size:13px">Or open this link: ${escapeHtml(link)}<br>It works for ${INVITE_TTL_DAYS} days. If you weren't expecting this, you can ignore this email.</p>`;
  return sendMail({ to, subject, text, html });
}

/** Tell an existing user they were added to a workspace. */
export async function sendAddedEmail(opts: { to: string; link: string; workspaceName: string; inviterName: string; role: Role }) {
  const { to, link, workspaceName, inviterName, role } = opts;
  return sendMail({
    to,
    subject: `${inviterName} added you to ${workspaceName} on ${APP_NAME}`,
    text: `${inviterName} added you to "${workspaceName}" on ${APP_NAME} as ${role === 'admin' ? 'an' : 'a'} ${role}.\n\nOpen it: ${link}`,
    html: `<p>${escapeHtml(inviterName)} added you to <strong>${escapeHtml(workspaceName)}</strong> on ${escapeHtml(APP_NAME)} as ${role === 'admin' ? 'an' : 'a'} ${role}.</p><p><a href="${escapeHtml(link)}">Open ${escapeHtml(workspaceName)}</a></p>`,
  });
}
