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

function seedTeams(wsId: string, teams: { name: string; color: string; members: string[]; parent?: string }[]): Record<string, string> {
  const ids: Record<string, string> = {};
  teams.forEach((x, i) => {
    ids[x.name] = newId();
    db.prepare('INSERT INTO teams (id, workspace_id, parent_id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      ids[x.name], wsId, x.parent ? ids[x.parent] : null, x.name, x.color, i + 1, now(),
    );
    for (const u of x.members) db.prepare('INSERT INTO team_members (team_id, user_id) VALUES (?, ?)').run(ids[x.name], u);
  });
  return ids;
}

function seedTags(wsId: string, by: string, tags: [string, string][]): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const [name, color] of tags) {
    ids[name] = newId();
    db.prepare('INSERT INTO tags (id, workspace_id, name, color, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(ids[name], wsId, name, color, by, now());
  }
  return ids;
}

/** Returns true if it seeded. Does nothing unless the DB has no users. */
export function seedDemoIfEmpty(): boolean {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM users WHERE id <> 'deleted-user'").get() as { n: number };
  if (n > 0) return false;
  const password = process.env.DEMO_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const hash = bcrypt.hashSync(password, 10);

  db.transaction(() => {
    const ids = DEMO_USERS.map((u) => {
      const id = newId();
      // Verified: nobody can open a demo inbox, and an unverified account would be stuck on "Check your email"
      // (and later pruned) wherever verification is required, e.g. staging with SMTP.
      const ts = now();
      db.prepare('INSERT INTO users (id, email, name, password_hash, color, created_at, email_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        id, u.email, u.name, hash, pickColor(), ts, ts,
      );
      createWorkspace(id, `${u.name.split(' ')[0]}'s Space`, true);
      return id;
    });
    const [demo, sam] = ids;

    // A shared team workspace with both users and tasks across the dashboard views.
    const team = createWorkspace(demo, 'Demo Team', false);
    db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)").run(team, sam, now());
    const t = today();
    // Teams (Elders; Staff with a Worship subteam) and tags, so filters and saved views have something to show.
    const teamIds = seedTeams(team, [
      { name: 'Elders', color: '#6366f1', members: [demo, sam] },
      { name: 'Staff', color: '#0ea5e9', members: [demo, sam] },
      { name: 'Worship', color: '#ec4899', members: [sam], parent: 'Staff' },
    ]);
    const tag = seedTags(team, demo, [
      ['Waiting', '#f59e0b'],
      ['Follow-up', '#10b981'],
      ['Budget', '#8b5cf6'],
    ]);
    createTask(demo, team, { title: 'Review the launch checklist', assigneeId: demo, dueDate: addDays(t, -1), priority: 1, teamId: teamIds.Staff });
    createTask(demo, team, { title: 'Draft release notes', assigneeId: sam, dueDate: t, priority: 2, teamId: teamIds.Staff, tagIds: [tag.Waiting] });
    createTask(demo, team, { title: 'Book the team retro', assigneeId: demo, dueDate: addDays(t, 2), dueTime: '10:00' });
    createTask(demo, team, { title: 'Weekly status update', assigneeId: demo, dueDate: addDays(t, 4), recurrence: { freq: 'week', interval: 1 } });
    createTask(sam, team, { title: 'Collect feedback from beta users', assigneeId: sam, dueDate: addDays(t, 7), tagIds: [tag['Follow-up']] });
    createTask(demo, team, { title: 'Plan the elders’ retreat', assigneeId: sam, dueDate: addDays(t, 10), teamId: teamIds.Elders, tagIds: [tag.Budget] });
    createTask(demo, team, { title: 'Visit new members', teamId: teamIds.Elders, dueDate: addDays(t, 5) });
    createTask(sam, team, { title: 'Reply to the hall booking', assigneeId: demo, teamId: teamIds.Elders, tagIds: [tag.Waiting] });
    createTask(demo, team, { title: 'Choose songs for Sunday', assigneeId: sam, dueDate: addDays(t, 3), teamId: teamIds.Worship });
    // Notebooks and pages that show off the editor, tasks, links, comments and history.
    seedDemoContent(team, demo, sam);
  })();

  console.log(`SEED_DEMO: created ${DEMO_USERS.map((u) => u.email).join(', ')}`);
  if (!process.env.DEMO_PASSWORD) console.log(`SEED_DEMO: generated password for demo accounts: ${password}`);
  return true;
}
