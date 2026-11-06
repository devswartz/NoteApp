// SEED_DEMO=1 (staging): fill an empty database with demo accounts and content.
// Passwords come from DEMO_PASSWORD, or are generated and printed once to the log.
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { db, newId, now, pickColor } from './db.ts';
import { createWorkspace } from './workspaces.ts';
import { createTask } from './tasks.ts';
import { addDays, today } from '../shared/dates.ts';
import { seedDemoContent } from './demoContent.ts';

export const DEMO_USERS = [
  { name: 'Demo User', email: 'demo@example.com' },
  { name: 'Sam Teammate', email: 'sam@example.com' },
];

/** Returns true if it seeded. Does nothing unless the DB has no users. */
export function seedDemoIfEmpty(): boolean {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM users WHERE id <> 'deleted-user'").get() as { n: number };
  if (n > 0) return false;
  const password = process.env.DEMO_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const hash = bcrypt.hashSync(password, 10);

  db.transaction(() => {
    const ids = DEMO_USERS.map((u) => {
      const id = newId();
      db.prepare('INSERT INTO users (id, email, name, password_hash, color, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        id, u.email, u.name, hash, pickColor(), now(),
      );
      createWorkspace(id, `${u.name.split(' ')[0]}'s Space`, true);
      return id;
    });
    const [demo, sam] = ids;

    // A shared team workspace with both users and tasks across the dashboard views.
    const team = createWorkspace(demo, 'Demo Team', false);
    db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)").run(team, sam, now());
    const t = today();
    createTask(demo, team, { title: 'Review the launch checklist', assigneeId: demo, dueDate: addDays(t, -1), priority: 1 });
    createTask(demo, team, { title: 'Draft release notes', assigneeId: sam, dueDate: t, priority: 2 });
    createTask(demo, team, { title: 'Book the team retro', assigneeId: demo, dueDate: addDays(t, 2), dueTime: '10:00' });
    createTask(demo, team, { title: 'Weekly status update', assigneeId: demo, dueDate: addDays(t, 4), recurrence: { freq: 'week', interval: 1 } });
    createTask(sam, team, { title: 'Collect feedback from beta users', assigneeId: sam, dueDate: addDays(t, 7) });
    // Notebooks and pages that show off the editor, tasks, links, comments and history.
    seedDemoContent(team, demo, sam);
  })();

  console.log(`SEED_DEMO: created ${DEMO_USERS.map((u) => u.email).join(', ')}`);
  if (!process.env.DEMO_PASSWORD) console.log(`SEED_DEMO: generated password for demo accounts: ${password}`);
  return true;
}
