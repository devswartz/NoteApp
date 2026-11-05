-- Editor & Notes: page version history. Each row is a full Yjs state of the page
-- at that moment (Y.encodeStateAsUpdate), taken at most every few minutes while a
-- page is being edited, and before a restore. Pruned per page by the server.
CREATE TABLE page_versions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  ydoc BLOB NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  -- Who edited the page last before this snapshot (pages.updated_by), and why it was taken.
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT 'auto' CHECK (reason IN ('auto', 'restore', 'manual')),
  -- pages.updated_at at the time of the snapshot (the content's own timestamp).
  page_updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX page_versions_page ON page_versions(page_id, created_at);
