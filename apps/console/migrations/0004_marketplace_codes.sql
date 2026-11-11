-- AppSumo redemption codes.
-- The production database already has `appsumo_redemption_codes` (SHA-256 hashed
-- codes, status available|redeemed). Keep that table as the source of truth.
-- `marketplace_codes` is the newer generic shape used for webhook bookkeeping.

CREATE TABLE IF NOT EXISTS appsumo_redemption_codes (
  code_hash            TEXT PRIMARY KEY,
  plan                 TEXT NOT NULL DEFAULT 'lifetime',
  site_limit           INTEGER NOT NULL DEFAULT 1,
  status               TEXT NOT NULL DEFAULT 'available', -- available | redeemed | refunded | revoked
  license_id           TEXT,
  redeemed_by_user_id  TEXT,
  redeemed_at          TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS marketplace_codes (
  id           TEXT PRIMARY KEY,
  marketplace  TEXT NOT NULL DEFAULT 'appsumo',
  code_hash    TEXT NOT NULL UNIQUE,
  code_hint    TEXT NOT NULL DEFAULT '',
  tier         INTEGER NOT NULL DEFAULT 1,
  site_limit   INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'pending',
  owner_email  TEXT NOT NULL DEFAULT '',
  license_id   TEXT,
  external_id  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  redeemed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_marketplace_codes_status ON marketplace_codes(status);
CREATE INDEX IF NOT EXISTS idx_marketplace_codes_email ON marketplace_codes(owner_email);
