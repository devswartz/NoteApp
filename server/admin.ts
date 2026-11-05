// Instance administrators (not workspace roles): whoever runs the server.
// ADMIN_EMAILS="a@x.com,b@y.com"; if unset, the first account ever created.
import { db } from './db.ts';
import type { User } from '../shared/types.ts';

export function isInstanceAdmin(user: User): boolean {
  const list = (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length) return list.includes(user.email.toLowerCase());
  const first = db.prepare('SELECT id FROM users ORDER BY created_at, rowid LIMIT 1').get() as { id: string } | undefined;
  return first?.id === user.id;
}
