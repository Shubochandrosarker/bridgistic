-- Email ownership proof. Licenses, billing and paired sites are matched by
-- email, so an account only receives them after its email is verified.
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
-- Accounts that exist at launch are grandfathered (10 accounts, all staff,
-- testers or OAuth); every new password signup must verify.
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;

CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL,            -- verify | reset
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens(user_id, purpose, created_at);
