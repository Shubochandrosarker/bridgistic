-- AppSumo / marketplace redemption codes.
-- Raw codes are never stored: only a SHA-256 hash and a 4-character hint.

CREATE TABLE IF NOT EXISTS marketplace_codes (
  id           TEXT PRIMARY KEY,
  marketplace  TEXT NOT NULL DEFAULT 'appsumo',
  code_hash    TEXT NOT NULL UNIQUE,
  code_hint    TEXT NOT NULL DEFAULT '',
  tier         INTEGER NOT NULL DEFAULT 1,
  site_limit   INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | redeemed | refunded | revoked
  owner_email  TEXT NOT NULL DEFAULT '',
  license_id   TEXT,
  external_id  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  redeemed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_marketplace_codes_status ON marketplace_codes(status);
CREATE INDEX IF NOT EXISTS idx_marketplace_codes_email ON marketplace_codes(owner_email);
