// Instance administrators (not workspace roles): whoever runs the server.
// ADMIN_EMAILS="a@x.com,b@y.com"; if unset, the first account ever created.
import { db } from './db.ts';
import type { User } from '../shared/types.ts';

/** ADMIN_EMAILS as a lower-cased list (empty when unset). */
export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isInstanceAdmin(user: User): boolean {
  const list = adminEmails();
  if (list.length) return list.includes(user.email.toLowerCase());
  const first = db.prepare('SELECT id FROM users ORDER BY created_at, rowid LIMIT 1').get() as { id: string } | undefined;
  return first?.id === user.id;
}
