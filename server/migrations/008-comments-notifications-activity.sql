-- Collaboration & Access: comment threads on text selections, in-app
-- notifications (mentions, assignments, shares, reminders) and a per-workspace
-- activity feed.

-- A thread is anchored to a text range in a page by a `comment` mark in the
-- page's Yjs document carrying the thread id; `quote` is the text when created.
CREATE TABLE comment_threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  quote TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT REFERENCES users(id)
);
CREATE INDEX comment_threads_page ON comment_threads(page_id);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  edited_at TEXT
);
CREATE INDEX comments_thread ON comments(thread_id, created_at);

-- One row per recipient. `data` is JSON for the client (ids to deep-link to).
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,
  data TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX notifications_user ON notifications(user_id, created_at);

-- Who changed what. `notebook_id` lets the feed hide entries from private
-- notebooks the reader can't see; `task_id` likewise for tasks.
CREATE TABLE activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  verb TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  notebook_id TEXT,
  task_id TEXT,
  -- 1 if the notebook was private when this happened: hidden from everyone but
  -- the actor once the notebook no longer exists (nothing left to check against).
  private INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX activity_ws ON activity(workspace_id, id);
