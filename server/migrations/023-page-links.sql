-- "Anyone with the link can view" (server/routes/pageLinks.ts, server/publicPage.ts): at most one live link per page.
-- Turning the link off deletes the row; turning it on again makes a new token, so an old link never comes back.
CREATE TABLE page_links (
  token TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX page_links_page ON page_links(page_id);
