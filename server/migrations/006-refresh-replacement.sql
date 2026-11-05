-- The token that replaced a rotated refresh token, encrypted with a key derived
-- from the rotated token itself (so only its holder can read it). Lets a replay
-- inside the grace window receive the same replacement instead of a new chain.
ALTER TABLE refresh_tokens ADD COLUMN replacement_enc TEXT;
