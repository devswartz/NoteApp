-- User page templates: "Save page as template" stores a snapshot of a page in this workspace.
--   content     ProseMirror/TipTap JSON (doc node) as produced by the editor, with taskRef.taskId
--               replaced by a template-local key (never a real task id) and attachment URLs
--               pointing at this template's own file copies.
--   tasks       JSON array of the task snapshots those keys refer to (title, description,
--               priority, subtasks). Using a template creates brand-new tasks from these.
--   visibility  'workspace' = every member can see and use it. 'private' = creator only; used
--               when the source page lives in a private notebook, so its content can't leak.
CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT,
  visibility TEXT NOT NULL DEFAULT 'workspace' CHECK (visibility IN ('workspace', 'private')),
  content TEXT NOT NULL,
  tasks TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX templates_ws ON templates(workspace_id, created_at);
CREATE INDEX templates_creator ON templates(workspace_id, created_by);

-- Attachment copies owned by a template (deleting the template deletes these rows; the route
-- also removes the bytes from disk).
ALTER TABLE files ADD COLUMN template_id TEXT REFERENCES templates(id) ON DELETE CASCADE;
CREATE INDEX files_template ON files(template_id) WHERE template_id IS NOT NULL;
