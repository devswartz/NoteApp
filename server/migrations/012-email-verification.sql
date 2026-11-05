-- Email verification for sign-up (docs/DEPLOY_CONTRACT.md: SIGNUP_MODE=open needs SMTP).
-- email_verified_at is NULL until the owner of the mailbox proves it.
ALTER TABLE users ADD COLUMN email_verified_at TEXT;

-- Everyone who already has an account is treated as verified, so nobody is locked out by this upgrade.
UPDATE users SET email_verified_at = created_at;

-- At most one live token per user (a new request replaces the old one). Only the SHA-256 of the token is stored.
CREATE TABLE email_verifications (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
