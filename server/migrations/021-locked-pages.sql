-- Locked pages (server/locks.ts). A locked page is NOT encrypted: its content stays readable on the server, which
-- refuses to serve it until its owner unlocks. Only the person who locked it can ever open it; everyone else
-- (admins included) no longer sees it anywhere.
--   pages.locked_by   who locked it (the only person who can open it). Deliberately no foreign key: if that
--                     account goes, its locked pages are deleted with it (server/accounts.ts), never unlocked.
--   pages.locked_at   when
ALTER TABLE pages ADD COLUMN locked_by TEXT;
ALTER TABLE pages ADD COLUMN locked_at TEXT;
CREATE INDEX pages_locked ON pages(locked_by) WHERE locked_by IS NOT NULL;

-- One "locked notes" password per account, separate from the login password (bcrypt, like it).
ALTER TABLE users ADD COLUMN lock_password_hash TEXT;

-- Unlock grants: one per sign-in (refresh-token family, carried in access tokens as `sid`). While a row is live,
-- that sign-in may open all of the user's locked pages. Short-lived and extended by activity (keepalive);
-- deleted by "Lock now", sign-out, a password change or reset.
CREATE TABLE lock_unlocks (
  family_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX lock_unlocks_user ON lock_unlocks(user_id);

-- Device unlock secrets for Face ID / Touch ID / Android biometrics: the device keeps the secret in its keychain
-- behind biometry and presents it instead of the password. Only a SHA-256 hash is stored. Changing or resetting
-- the locked-notes password removes them all.
CREATE TABLE lock_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX lock_devices_user ON lock_devices(user_id);

-- Resetting a forgotten locked-notes password: the login password, then a 6-digit code sent by email
-- (hash stored, 15 minutes, a few tries). One pending reset per user.
CREATE TABLE lock_resets (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
