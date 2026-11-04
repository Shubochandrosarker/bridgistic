-- 0004_appsumo_redemption — one-time AppSumo code inventory and redemption.
-- Raw codes are never stored. The code hash is also unique on licenses so a
-- concurrent retry cannot create two licenses for the same buyer code.
ALTER TABLE licenses ADD COLUMN appsumo_code_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_appsumo_code_hash
  ON licenses(appsumo_code_hash) WHERE appsumo_code_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS appsumo_redemption_codes (
  code_hash           TEXT PRIMARY KEY,
  plan                TEXT NOT NULL DEFAULT 'lifetime',
  site_limit          INTEGER NOT NULL DEFAULT 1,
  status              TEXT NOT NULL DEFAULT 'available',
  license_id          TEXT REFERENCES licenses(id) ON DELETE SET NULL,
  redeemed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  redeemed_at         TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_appsumo_codes_status ON appsumo_redemption_codes(status);
CREATE INDEX IF NOT EXISTS idx_appsumo_codes_license ON appsumo_redemption_codes(license_id);
