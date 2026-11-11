-- Tags, teams (one level of subteams), "assigned by" and server-side saved task views.
-- Owner: Tasks (track 1 of docs/PLAN_FEEDBACK_1.md). Additive only: older clients ignore the new task fields.

-- Tags are shared across a workspace. Names are unique per workspace, ignoring case.
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  color TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE TABLE task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
);
CREATE INDEX task_tags_tag ON task_tags(tag_id);

-- Teams: parent_id makes a subteam (one level deep, enforced by the API).
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  position REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX teams_workspace ON teams(workspace_id, position);

CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user ON team_members(user_id);

-- A task's team is independent of its assignee's teams.
ALTER TABLE tasks ADD COLUMN team_id TEXT REFERENCES teams(id) ON DELETE SET NULL;
-- Who last set the assignee (null while unassigned). Set by the server, never by the client.
ALTER TABLE tasks ADD COLUMN assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX tasks_team ON tasks(team_id);

-- Backfill: the latest "assigned" entry in the activity feed, else the task's creator.
UPDATE tasks SET assigned_by = COALESCE(
  (SELECT a.actor_id FROM activity a
     WHERE a.target_type = 'task' AND a.target_id = tasks.id AND a.verb = 'assigned' AND a.actor_id IS NOT NULL
     ORDER BY a.id DESC LIMIT 1),
  created_by)
WHERE assignee_id IS NOT NULL;

-- Saved views for All Tasks, moved from the device to the server.
-- Personal (only the owner sees it) unless shared = 1 (every member sees it; owners/admins only).
CREATE TABLE task_views (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shared INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  position REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX task_views_workspace ON task_views(workspace_id, owner_id);
