-- Rotating refresh tokens. Only a SHA-256 hash of each token is stored.
-- Tokens issued from one sign-in share a family_id; presenting a token that was
-- already rotated (outside a short grace window) revokes the whole family.
CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  -- Set when this token is exchanged for a new one (rotated) or revoked.
  used_at TEXT,
  revoked_at TEXT,
  user_agent TEXT
);
CREATE INDEX refresh_tokens_family ON refresh_tokens(family_id);
CREATE INDEX refresh_tokens_user ON refresh_tokens(user_id);
