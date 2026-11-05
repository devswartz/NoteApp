-- Initial schema. Never edit a migration once merged; add a new NNN-name.sql instead.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  color TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

-- Invites for people who don't have an account yet; applied on sign-up.
CREATE TABLE workspace_invites (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL,
  invited_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, email)
);

CREATE TABLE notebooks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('shared','private')),
  created_by TEXT NOT NULL REFERENCES users(id),
  position REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sections (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  position REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  icon TEXT,
  kind TEXT NOT NULL DEFAULT 'document',
  ydoc BLOB,
  text TEXT NOT NULL DEFAULT '',
  position REAL NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id)
);

CREATE VIRTUAL TABLE pages_fts USING fts5(page_id UNINDEXED, title, text, tokenize = 'porter unicode61');

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  priority INTEGER NOT NULL DEFAULT 4,
  due_date TEXT,
  due_time TEXT,
  recurrence TEXT,
  reminder_at TEXT,
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  -- For completed occurrences of a recurring task.
  occurrence_of TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  completed_at TEXT,
  completed_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tasks_ws ON tasks(workspace_id, status);
CREATE INDEX tasks_page ON tasks(page_id);
CREATE INDEX tasks_assignee ON tasks(assignee_id, status);
