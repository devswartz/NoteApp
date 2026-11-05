-- Subtasks (one level): a task may belong to a parent task. Deleting the
-- parent deletes its subtasks. Subtasks take the parent's page_id so they
-- inherit its visibility; the server keeps that in sync.
ALTER TABLE tasks ADD COLUMN parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE;
CREATE INDEX tasks_parent ON tasks(parent_id);
-- Completed view pages by completed_at within a workspace.
CREATE INDEX tasks_ws_completed ON tasks(workspace_id, status, completed_at);
