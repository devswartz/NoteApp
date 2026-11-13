-- OAuth 2.1 authorization server for AI connectors (server/oauth/, docs in server/oauth/routes.ts).
-- Only SHA-256 hashes of codes and tokens are stored.

-- Apps that may ask for access: registered dynamically (RFC 7591, kind 'dcr', random id) or identified by
-- the https URL of their Client ID Metadata Document (kind 'cimd', id = that URL, row = cached copy).
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('dcr', 'cimd')),
  -- Self-reported by the app; never trusted for anything but display.
  name TEXT NOT NULL,
  client_uri TEXT,
  redirect_uris TEXT NOT NULL, -- JSON array of exact strings
  created_at TEXT NOT NULL,
  -- cimd only: when the cached document must be fetched again.
  expires_at TEXT
);

-- An authorization request between /oauth/authorize and the token exchange. After the user allows it, it
-- holds the (hashed) one-time code. Single use: used_at is set when the code is exchanged.
CREATE TABLE oauth_requests (
  id TEXT PRIMARY KEY, -- random, in the consent page URL
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  scopes TEXT NOT NULL, -- space separated, as requested
  state TEXT,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT UNIQUE,
  code_expires_at TEXT,
  grant_id TEXT,
  used_at TEXT
);

-- One "connection": a user allowed a client. Every token issued from it (through refresh rotation) belongs to it,
-- so revoking it ends them all. Settings → Connected apps lists these.
CREATE TABLE oauth_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  scopes TEXT NOT NULL, -- what the user allowed
  resource TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX oauth_grants_user ON oauth_grants(user_id);
CREATE INDEX oauth_grants_client ON oauth_grants(client_id);

CREATE TABLE oauth_tokens (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT, -- refresh: rotated
  revoked_at TEXT
);
CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id);
