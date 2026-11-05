-- Editor & Notes: full-text search over tasks, and metadata for uploaded files.

-- Task titles and descriptions, indexed for search. Kept in sync by triggers,
-- keyed by task id (not rowid: tasks has a TEXT primary key, so its rowid may
-- change on VACUUM).
CREATE VIRTUAL TABLE tasks_fts USING fts5(task_id UNINDEXED, title, description, tokenize = 'porter unicode61');
INSERT INTO tasks_fts (task_id, title, description) SELECT id, title, description FROM tasks;

CREATE TRIGGER tasks_fts_insert AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts (task_id, title, description) VALUES (new.id, new.title, new.description);
END;
CREATE TRIGGER tasks_fts_delete AFTER DELETE ON tasks BEGIN
  DELETE FROM tasks_fts WHERE task_id = old.id;
END;
CREATE TRIGGER tasks_fts_update AFTER UPDATE OF title, description ON tasks BEGIN
  DELETE FROM tasks_fts WHERE task_id = old.id;
  INSERT INTO tasks_fts (task_id, title, description) VALUES (new.id, new.title, new.description);
END;

-- Uploaded images and attachments. The bytes live on disk at $DATA_DIR/files/<id><ext>.
-- id is 32 random hex characters, so links can be embedded in notes (an <img> can't send
-- a bearer token) without being guessable.
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  ext TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX files_workspace ON files(workspace_id);
