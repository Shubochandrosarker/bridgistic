-- 0002_site_connections — Phase 1 (2026-10-26).
-- api.wpistic.com is the single license issuer. The console keeps only:
--   * one pairing row per site activation (the plugin's auto-paired dashboard key,
--     encrypted at rest), written on activate/validate, deleted on deactivate;
--   * license claims: a user proved they hold a key (Paddle email != account email).
-- The legacy single-slot licenses.site_connection column stays for rollback but is
-- no longer written; its pairings are copied below.

CREATE TABLE IF NOT EXISTS site_connections (
  id                     TEXT PRIMARY KEY,               -- api.wpistic.com activation id, or 'legacy:<activation id>'
  source                 TEXT NOT NULL DEFAULT 'wpistic', -- wpistic | legacy (console-issued BRG- keys)
  activation_token_hash  TEXT UNIQUE,                    -- SHA-256 of the plugin's activation token
  license_ref            TEXT NOT NULL DEFAULT '',       -- legacy: licenses.id; wpistic: '' (wpistic owns licenses)
  site_url               TEXT NOT NULL,
  domain                 TEXT NOT NULL DEFAULT '',
  key_id                 TEXT NOT NULL,
  secret_enc             TEXT NOT NULL,                  -- AES-GCM (SECRET_ENCRYPTION_KEY); never sent to a browser
  status                 TEXT NOT NULL DEFAULT 'active',
  last_validated_at      TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_site_connections_license ON site_connections(license_ref);

CREATE TABLE IF NOT EXISTS license_claims (
  user_id     TEXT NOT NULL,
  key_hash    TEXT NOT NULL,          -- SHA-256 of the raw key (same hash api.wpistic.com stores)
  key_mask    TEXT NOT NULL DEFAULT '',
  claimed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, key_hash)
);

-- Copy legacy single-slot pairings onto the newest active activation of each license.
INSERT OR IGNORE INTO site_connections (id, source, license_ref, site_url, domain, key_id, secret_enc, status, last_validated_at)
SELECT 'legacy:' || a.id, 'legacy', l.id,
       json_extract(l.site_connection, '$.site_url'), a.domain,
       json_extract(l.site_connection, '$.key_id'), json_extract(l.site_connection, '$.secret_enc'),
       'active', a.last_validated_at
FROM licenses l
JOIN activations a ON a.id = (SELECT id FROM activations WHERE license_id = l.id AND status = 'active' ORDER BY last_validated_at DESC LIMIT 1)
WHERE l.site_connection <> '' AND json_valid(l.site_connection)
  AND json_extract(l.site_connection, '$.secret_enc') IS NOT NULL;
