// Sign-up, sign-in and the current user. Owner: Foundation.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, newId, now, pickColor } from '../db.ts';
import {
  getUser,
  issueSession,
  revokeAllForUser,
  revokeRefreshToken,
  rotateRefreshToken,
  signResetToken,
  verifyResetToken,
} from '../auth.ts';
import { escapeHtml, sendMail } from '../mail.ts';
import { PUBLIC_URL } from '../config.ts';
import { APP_NAME } from '../../shared/config.ts';
import { publish } from '../events.ts';
import { createWorkspace } from '../workspaces.ts';
import { HttpError, h, str } from '../http.ts';
import type { AuthSession, Role } from '../../shared/types.ts';

/** bcrypt only uses the first 72 bytes; anything longer would be silently truncated. */
export const MAX_PASSWORD_BYTES = 72;

function validPassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES)
    throw new HttpError(400, `Password is too long (at most ${MAX_PASSWORD_BYTES} characters, fewer with accents or emoji)`);
  return password;
}

// bcrypt runs asynchronously (off the event loop) everywhere.
const BCRYPT_ROUNDS = 10;
const hashPassword = (password: string) => bcrypt.hash(password, BCRYPT_ROUNDS);

/**
 * Login compares against this when the email is unknown, so the response takes
 * as long as for a real account and timing doesn't reveal who has one.
 */
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-just-for-timing', BCRYPT_ROUNDS);

/** Set a new password and end every existing sign-in. */
async function setPassword(userId: string, password: string) {
  const hash = await hashPassword(password);
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
    revokeAllForUser(userId);
  })();
}

/** Routes that work without a token. */
export const publicAuthRoutes = Router();
/** Routes for the signed-in user. */
export const authRoutes = Router();

publicAuthRoutes.post(
  '/auth/register',
  h(async (req) => {
    const email = str(req.body.email, 'Email', 200).toLowerCase();
    const name = str(req.body.name, 'Name', 100);
    const password = req.body.password;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address');
    validPassword(password);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'An account with that email already exists');
    const id = newId();
    const ts = now();
    const color = pickColor();
    const hash = await hashPassword(password);
    db.transaction(() => {
      // Re-check: another sign-up with this email may have landed while hashing.
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'An account with that email already exists');
      db.prepare('INSERT INTO users (id, email, name, password_hash, color, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        id, email, name, hash, color, ts,
      );
      // Accept any pending, unexpired invitations for this email (expired ones stay listed for admins to resend).
      const live = '(expires_at IS NULL OR expires_at > ?)';
      const invites = db.prepare(`SELECT workspace_id, role FROM workspace_invites WHERE email = ? AND ${live}`).all(email, ts) as {
        workspace_id: string;
        role: Role;
      }[];
      for (const inv of invites) {
        db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(
          inv.workspace_id, id, inv.role, ts,
        );
        publish({ type: 'members', workspaceId: inv.workspace_id });
      }
      db.prepare(`DELETE FROM workspace_invites WHERE email = ? AND ${live}`).run(email, ts);
      createWorkspace(id, `${name.split(' ')[0]}'s Space`, true);
    })();
    return { ...issueSession(id, req.get('user-agent') ?? null), user: { id, email, name, color } } satisfies AuthSession;
  }),
);

publicAuthRoutes.post(
  '/auth/login',
  h(async (req) => {
    const email = String(req.body.email ?? '').trim();
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as
      | { id: string; email: string; name: string; color: string; password_hash: string }
      | undefined;
    const password = String(req.body.password ?? '').slice(0, 1024);
    // Always run exactly one bcrypt comparison, real or dummy, so timing is the same either way.
    const ok = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok) throw new HttpError(401, 'Incorrect email or password');
    return {
      ...issueSession(row.id, req.get('user-agent') ?? null),
      user: { id: row.id, email: row.email, name: row.name, color: row.color },
    } satisfies AuthSession;
  }),
);

// Exchange a refresh token for a new access + refresh pair (the old refresh token is retired).
publicAuthRoutes.post(
  '/auth/refresh',
  h((req) => {
    const r = rotateRefreshToken(req.body.refreshToken, req.get('user-agent') ?? null);
    if (!r) throw new HttpError(401, 'Session expired, please sign in again');
    const { userId, ...tokens } = r;
    return { ...tokens, user: getUser(userId)! } satisfies AuthSession;
  }),
);

// Sign out: revokes this sign-in's refresh tokens. Works with an expired access token.
publicAuthRoutes.post(
  '/auth/logout',
  h((req) => {
    revokeRefreshToken(req.body.refreshToken);
    return { ok: true };
  }),
);

// ── Password reset ──
// Always answers the same way, so it can't be used to find out who has an account.
const lastResetMail = new Map<string, number>(); // email -> time, simple flood guard
publicAuthRoutes.post(
  '/auth/forgot',
  h((req) => {
    const email = String(req.body.email ?? '').trim().toLowerCase();
    const row = db.prepare('SELECT id, name, password_hash FROM users WHERE email = ?').get(email) as
      | { id: string; name: string; password_hash: string }
      | undefined;
    const last = lastResetMail.get(email) ?? 0;
    if (row && Date.now() - last > 60_000) {
      lastResetMail.set(email, Date.now());
      const link = `${PUBLIC_URL}/reset?token=${encodeURIComponent(signResetToken(row.id, row.password_hash))}`;
      // Not awaited: waiting for SMTP only when the account exists would reveal it by timing.
      void sendMail({
        to: email,
        subject: `Reset your ${APP_NAME} password`,
        text: `Hi ${row.name},\n\nUse this link within an hour to choose a new password:\n${link}\n\nIf you didn't ask for this, you can ignore this email.`,
        html: `<p>Hi ${escapeHtml(row.name)},</p><p><a href="${escapeHtml(link)}">Choose a new password</a> (the link works for an hour).</p><p>If you didn't ask for this, you can ignore this email.</p>`,
      });
    }
    return { ok: true };
  }),
);

publicAuthRoutes.post(
  '/auth/reset',
  h(async (req) => {
    const invalid = () => new HttpError(400, 'This reset link is invalid or has expired. Ask for a new one.');
    const userId = verifyResetToken(req.body.token);
    if (!userId) throw invalid();
    const hash = await hashPassword(validPassword(req.body.password));
    db.transaction(() => {
      // Check again after the (async) hash, so two submissions of one link can't both succeed.
      if (verifyResetToken(req.body.token) !== userId) throw invalid();
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
      revokeAllForUser(userId);
    })();
    return { ok: true };
  }),
);

authRoutes.get('/me', h((req) => req.user));

// Change password: signs out every other device and returns a fresh session for this one.
authRoutes.post(
  '/me/password',
  h(async (req) => {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id) as { password_hash: string };
    const newPassword = validPassword(req.body.newPassword);
    if (!(await bcrypt.compare(String(req.body.currentPassword ?? '').slice(0, 1024), row.password_hash)))
      throw new HttpError(400, 'Your current password is incorrect');
    await setPassword(req.user.id, newPassword);
    return { ...issueSession(req.user.id, req.get('user-agent') ?? null), user: req.user } satisfies AuthSession;
  }),
);

authRoutes.patch(
  '/me',
  h((req) => {
    if (req.body.name !== undefined) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(str(req.body.name, 'Name', 100), req.user.id);
    if (req.body.color !== undefined && /^#[0-9a-f]{6}$/i.test(req.body.color))
      db.prepare('UPDATE users SET color = ? WHERE id = ?').run(req.body.color, req.user.id);
    const wss = db.prepare('SELECT workspace_id FROM workspace_members WHERE user_id = ?').all(req.user.id) as { workspace_id: string }[];
    for (const w of wss) publish({ type: 'members', workspaceId: w.workspace_id });
    return db.prepare('SELECT id, email, name, color FROM users WHERE id = ?').get(req.user.id);
  }),
);
