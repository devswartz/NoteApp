-- Sharing a single page (issue #98). Owner: Collaboration & Access.
--
-- page_shares: a grant on one page, independent of its notebook. The grantee sees and (with
-- can_edit) co-edits that page only, never its notebook, sibling pages or sub-pages. The grantee
-- need not be a workspace member: someone outside the workspace gets that page (view, or edit
-- with can_edit) and nothing else in the workspace. A member's rights are capped by their role
-- (a viewer only views). Tasks on the page stay member-only. Moving the page keeps its shares
-- (keyed by page id); deleting the page or the grantee's account removes them.
-- (Outsider shares and invites used to be forced to can_edit = 0; rows from then stay view-only
-- until changed. Comment updated without a schema change.)
CREATE TABLE page_shares (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_edit INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (page_id, user_id)
);
CREATE INDEX page_shares_user ON page_shares(user_id);

-- Invites to a single page for people without a (verified) account: applied when the invited
-- address is confirmed, or accepted through the link, as a page share with this can_edit.
-- Only the SHA-256 of the token is stored.
CREATE TABLE page_invites (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  can_edit INTEGER NOT NULL DEFAULT 0,
  invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (page_id, email)
);
CREATE INDEX page_invites_email ON page_invites(email);
