// Workspace helpers used by more than one route module.
import { db, newId, now } from './db.ts';
import { seedWorkspace } from './seed.ts';
import { IS_PROD } from './config.ts';
import crypto from 'node:crypto';
import { escapeHtml, sendMail } from './mail.ts';
import { publish } from './events.ts';
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

if (IS_PROD && !process.env.PUBLIC_URL)
  console.warn('[invites] PUBLIC_URL is not set: invite emails will contain relative links. Set it (see docs/DEPLOY_CONTRACT.md).');

/**
 * The web app's origin for links in emails. Production uses PUBLIC_URL only:
 * the request's Origin header is caller-controlled, and trusting it would let a
 * forged request send the invite token to another host. In development the
 * caller's Origin (the Vite dev server) is used when PUBLIC_URL isn't set.
 */
export function publicUrl(origin?: string | null): string {
  const base = process.env.PUBLIC_URL || (IS_PROD ? '' : origin || 'http://localhost:5173');
  return base.replace(/\/+$/, '');
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

// ───────────── Page invites (sharing one page, migration 013) ─────────────
// Same token scheme as workspace invites, but the invite grants a page share
// with the invite's can_edit (applied on sign-up), not membership.

/** Create or refresh the page invite for `email`. Returns the raw token. */
export function upsertPageInvite(pageId: string, email: string, canEdit: boolean, invitedBy: string): string {
  const token = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000).toISOString();
  db.prepare(
    `INSERT INTO page_invites (page_id, email, can_edit, invited_by, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (page_id, email) DO UPDATE SET can_edit = excluded.can_edit, invited_by = excluded.invited_by,
       token_hash = excluded.token_hash, expires_at = excluded.expires_at, created_at = excluded.created_at`,
  ).run(pageId, email, canEdit ? 1 : 0, invitedBy, hashInviteToken(token), expires, now());
  return token;
}

export interface PageInvite {
  pageId: string;
  pageTitle: string;
  workspaceId: string;
  workspaceName: string;
  invitedByName: string;
  email: string;
  canEdit: boolean;
  expired: boolean;
  /** Who sent it: recorded as the share's creator once accepted. */
  invitedBy: string;
}

export function findPageInvite(token: string): PageInvite | null {
  if (typeof token !== 'string' || token.length < 16) return null;
  const r = db
    .prepare(
      `SELECT i.page_id, i.email, i.can_edit, i.expires_at, i.invited_by, p.title, n.workspace_id, w.name AS workspace_name, u.name AS inviter_name
       FROM page_invites i JOIN pages p ON p.id = i.page_id JOIN sections s ON s.id = p.section_id
       JOIN notebooks n ON n.id = s.notebook_id JOIN workspaces w ON w.id = n.workspace_id JOIN users u ON u.id = i.invited_by
       WHERE i.token_hash = ?`,
    )
    .get(hashInviteToken(token)) as
    | { page_id: string; email: string; can_edit: number; expires_at: string | null; invited_by: string; title: string; workspace_id: string; workspace_name: string; inviter_name: string }
    | undefined;
  if (!r) return null;
  return {
    pageId: r.page_id,
    pageTitle: r.title || 'Untitled',
    workspaceId: r.workspace_id,
    workspaceName: r.workspace_name,
    invitedByName: r.inviter_name,
    email: r.email,
    canEdit: !!r.can_edit,
    expired: !!r.expires_at && r.expires_at < now(),
    invitedBy: r.invited_by,
  };
}

/** Grant (or update) a page share. */
export function grantPageShare(pageId: string, userId: string, canEdit: boolean, by: string | null) {
  db.prepare(
    `INSERT INTO page_shares (page_id, user_id, can_edit, created_by, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (page_id, user_id) DO UPDATE SET can_edit = excluded.can_edit`,
  ).run(pageId, userId, canEdit ? 1 : 0, by, now());
}

/** Turn every live page invite for `email` into a page share for `userId`. Returns how many. Call inside a transaction. */
export function acceptPendingPageInvites(userId: string, email: string, ts = now()): number {
  const live = '(expires_at IS NULL OR expires_at > ?)';
  const rows = db.prepare(`SELECT page_id, can_edit, invited_by FROM page_invites WHERE email = ? AND ${live}`).all(email, ts) as {
    page_id: string;
    can_edit: number;
    invited_by: string;
  }[];
  for (const r of rows)
    // With the rights the invite asked for: outsiders may hold edit shares too (#98 follow-up).
    db.prepare('INSERT OR IGNORE INTO page_shares (page_id, user_id, can_edit, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(
      r.page_id, userId, r.can_edit ? 1 : 0, r.invited_by, ts,
    );
  db.prepare(`DELETE FROM page_invites WHERE email = ? AND ${live}`).run(email, ts);
  return rows.length;
}

/** Tell someone a page was shared with them (with a link to it, or to the invite when they have no account yet). */
export async function sendPageSharedEmail(opts: { to: string; link: string; pageTitle: string; inviterName: string; canEdit: boolean; invite: boolean }) {
  const { to, link, pageTitle, inviterName, canEdit, invite } = opts;
  const what = canEdit ? 'edit' : 'view';
  const tail = invite ? `\n\nThe link works for ${INVITE_TTL_DAYS} days. If you weren't expecting this, you can ignore this email.` : '';
  return sendMail({
    to,
    subject: `${inviterName} shared “${pageTitle}” with you on ${APP_NAME}`,
    text: `${inviterName} shared the page "${pageTitle}" with you on ${APP_NAME}. You can ${what} it.\n\n${invite ? 'Accept and open it' : 'Open it'}: ${link}${tail}`,
    html: `<p>${escapeHtml(inviterName)} shared the page <strong>${escapeHtml(pageTitle)}</strong> with you on ${escapeHtml(APP_NAME)}. You can ${what} it.</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 16px;background:#6366f1;color:#fff;border-radius:6px;text-decoration:none">${invite ? 'Accept and open' : 'Open page'}</a></p>
<p style="color:#666;font-size:13px">Or open this link: ${escapeHtml(link)}${invite ? `<br>It works for ${INVITE_TTL_DAYS} days. If you weren't expecting this, you can ignore this email.` : ''}</p>`,
  });
}

/**
 * A notebook was made private: page shares on its pages that someone other than its creator
 * granted end (the creator's own stay). Also drops such pending page invites. Returns how many
 * shares were removed; the caller calls accessChanged(). Holders are told to refresh.
 */
export function dropForeignPageShares(notebookId: string): number {
  const pagesOf = `SELECT p.id FROM pages p JOIN sections s ON s.id = p.section_id WHERE s.notebook_id = @nb`;
  const creator = `(SELECT created_by FROM notebooks WHERE id = @nb)`;
  const users = (
    db.prepare(`SELECT DISTINCT user_id FROM page_shares WHERE page_id IN (${pagesOf}) AND created_by IS NOT ${creator}`).all({ nb: notebookId }) as { user_id: string }[]
  ).map((r) => r.user_id);
  const n = db.prepare(`DELETE FROM page_shares WHERE page_id IN (${pagesOf}) AND created_by IS NOT ${creator}`).run({ nb: notebookId }).changes;
  db.prepare(`DELETE FROM page_invites WHERE page_id IN (${pagesOf}) AND invited_by IS NOT ${creator}`).run({ nb: notebookId });
  if (users.length) publish({ type: 'shared-pages' }, { userIds: users });
  return n;
}

/**
 * A page moved into a private notebook: its page shares (and pending invites) that the new
 * notebook's creator didn't grant end, as if that notebook had just been made private. Returns
 * how many shares were removed; the caller calls accessChanged().
 */
export function dropForeignSharesOnPage(pageId: string, notebookId: string): number {
  const creator = (db.prepare('SELECT created_by FROM notebooks WHERE id = ?').get(notebookId) as { created_by: string }).created_by;
  const users = (db.prepare('SELECT user_id FROM page_shares WHERE page_id = ? AND created_by IS NOT ?').all(pageId, creator) as { user_id: string }[]).map((r) => r.user_id);
  const n = db.prepare('DELETE FROM page_shares WHERE page_id = ? AND created_by IS NOT ?').run(pageId, creator).changes;
  db.prepare('DELETE FROM page_invites WHERE page_id = ? AND invited_by IS NOT ?').run(pageId, creator);
  if (users.length) publish({ type: 'shared-pages' }, { userIds: users });
  return n;
}
