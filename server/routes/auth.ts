// Sign-up, sign-in and the current user. Owner: Foundation.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, newId, now, pickColor } from '../db.ts';
import { signToken } from '../auth.ts';
import { publish } from '../events.ts';
import { createWorkspace } from '../workspaces.ts';
import { HttpError, h, str } from '../http.ts';
import type { Role } from '../../shared/types.ts';

/** Routes that work without a token. */
export const publicAuthRoutes = Router();
/** Routes for the signed-in user. */
export const authRoutes = Router();

publicAuthRoutes.post(
  '/auth/register',
  h((req) => {
    const email = str(req.body.email, 'Email', 200).toLowerCase();
    const name = str(req.body.name, 'Name', 100);
    const password = req.body.password;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address');
    if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'An account with that email already exists');
    const id = newId();
    const ts = now();
    const color = pickColor();
    db.transaction(() => {
      db.prepare('INSERT INTO users (id, email, name, password_hash, color, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        id, email, name, bcrypt.hashSync(password, 10), color, ts,
      );
      // Accept any pending invitations for this email.
      const invites = db.prepare('SELECT workspace_id, role FROM workspace_invites WHERE email = ?').all(email) as {
        workspace_id: string;
        role: Role;
      }[];
      for (const inv of invites) {
        db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(
          inv.workspace_id, id, inv.role, ts,
        );
        publish({ type: 'members', workspaceId: inv.workspace_id });
      }
      db.prepare('DELETE FROM workspace_invites WHERE email = ?').run(email);
      createWorkspace(id, `${name.split(' ')[0]}'s Space`, true);
    })();
    return { token: signToken(id), user: { id, email, name, color } };
  }),
);

publicAuthRoutes.post(
  '/auth/login',
  h((req) => {
    const email = String(req.body.email ?? '').trim();
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as
      | { id: string; email: string; name: string; color: string; password_hash: string }
      | undefined;
    if (!row || !bcrypt.compareSync(String(req.body.password ?? ''), row.password_hash))
      throw new HttpError(401, 'Incorrect email or password');
    return { token: signToken(row.id), user: { id: row.id, email: row.email, name: row.name, color: row.color } };
  }),
);

authRoutes.get('/me', h((req) => req.user));

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
