-- Collaboration & Access: invite links and sharing private notebooks.

-- Invite links: the email carries a random token; only its SHA-256 is stored.
ALTER TABLE workspace_invites ADD COLUMN token_hash TEXT;
ALTER TABLE workspace_invites ADD COLUMN expires_at TEXT;
CREATE UNIQUE INDEX workspace_invites_token ON workspace_invites(token_hash);

-- A private notebook is visible to its creator plus the people listed here.
CREATE TABLE notebook_shares (
  notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (notebook_id, user_id)
);
CREATE INDEX notebook_shares_user ON notebook_shares(user_id);
