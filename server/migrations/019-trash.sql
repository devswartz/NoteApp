-- Trash. Deleting a page, section or notebook moves it to Trash (kept 60 days) instead of removing it:
--   deleted_at   when it was trashed (NULL = live)
--   deleted_by   who trashed it
--   trash_id     the id of the item that was trashed. A section's subsections and pages, or a notebook's sections and
--                pages, carry the same trash_id as the item itself, so restoring or purging acts on one batch and every
--                read only needs "deleted_at IS NULL" on its own table (no checking of ancestors). The item whose id
--                equals its trash_id is what the Trash lists. Parent and position stay in their normal columns, which is
--                how a restore puts it back.
-- Tasks on a trashed page keep page_id and are hidden while in Trash: tasks.trash_id is that batch. A restore clears it;
-- a purge removes the page (tasks become standalone, as deleting always did) and clears it.
ALTER TABLE notebooks ADD COLUMN deleted_at TEXT;
ALTER TABLE notebooks ADD COLUMN deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE notebooks ADD COLUMN trash_id TEXT;
ALTER TABLE sections ADD COLUMN deleted_at TEXT;
ALTER TABLE sections ADD COLUMN deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sections ADD COLUMN trash_id TEXT;
ALTER TABLE pages ADD COLUMN deleted_at TEXT;
ALTER TABLE pages ADD COLUMN deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE pages ADD COLUMN trash_id TEXT;
ALTER TABLE tasks ADD COLUMN trash_id TEXT;

CREATE INDEX notebooks_trash ON notebooks(workspace_id) WHERE deleted_at IS NOT NULL;
CREATE INDEX sections_trash ON sections(notebook_id) WHERE deleted_at IS NOT NULL;
CREATE INDEX pages_trash ON pages(section_id) WHERE deleted_at IS NOT NULL;
CREATE INDEX tasks_trash ON tasks(trash_id) WHERE trash_id IS NOT NULL;
