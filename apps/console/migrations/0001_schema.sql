-- Bridgistic console schema (D1 / SQLite).
-- Applied in order by scripts/seed-db.mjs. Idempotent: CREATE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',   -- owner | admin | member
  status        TEXT NOT NULL DEFAULT 'active',   -- active | disabled
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS orgs (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'free',     -- free | monthly | yearly | lifetime
  status        TEXT NOT NULL DEFAULT 'active',   -- active | suspended
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memberships (
  org_id    TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'owner',        -- owner | operator | approver | viewer
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS sites (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  wp_version    TEXT NOT NULL DEFAULT '',
  php_version   TEXT NOT NULL DEFAULT '',
  key_id        TEXT NOT NULL DEFAULT '',
  key_mask      TEXT NOT NULL DEFAULT '',
  secret_enc    TEXT NOT NULL DEFAULT '',         -- AES-GCM(ciphertext_b64.iv_b64)
  scopes        TEXT NOT NULL DEFAULT '[]',       -- JSON array from site-info
  status        TEXT NOT NULL DEFAULT 'connected',
  last_seen     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (org_id, url)
);

CREATE TABLE IF NOT EXISTS licenses (
  id           TEXT PRIMARY KEY,
  key          TEXT NOT NULL UNIQUE,
  product      TEXT NOT NULL DEFAULT 'bridgistic',
  plan         TEXT NOT NULL DEFAULT 'lifetime',  -- lifetime | monthly | yearly
  status       TEXT NOT NULL DEFAULT 'active',    -- active | suspended | revoked
  site_limit   INTEGER NOT NULL DEFAULT 1,
  owner_email  TEXT NOT NULL DEFAULT '',
  org_id       TEXT REFERENCES orgs(id) ON DELETE SET NULL,
  notes        TEXT NOT NULL DEFAULT '',
  issued_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_licenses_email ON licenses(owner_email);

CREATE TABLE IF NOT EXISTS activations (
  id                TEXT PRIMARY KEY,
  license_id        TEXT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  activation_token  TEXT NOT NULL UNIQUE,
  verification_key  TEXT NOT NULL,
  domain            TEXT NOT NULL DEFAULT '',
  environment       TEXT NOT NULL DEFAULT 'production',
  installation_uuid TEXT NOT NULL DEFAULT '',
  site_url          TEXT NOT NULL DEFAULT '',
  wp_version        TEXT NOT NULL DEFAULT '',
  php_version       TEXT NOT NULL DEFAULT '',
  product_version   TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'active',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  last_validated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_activations_license ON activations(license_id);

CREATE TABLE IF NOT EXISTS sync_log (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  action      TEXT NOT NULL,                       -- activate | validate | deactivate | issue | suspend | revoke
  key_mask    TEXT NOT NULL DEFAULT '',
  domain      TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS audit (
  id     TEXT PRIMARY KEY,
  at     TEXT NOT NULL DEFAULT (datetime('now')),
  actor  TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  slug           TEXT PRIMARY KEY,                -- free | monthly | yearly | lifetime
  name           TEXT NOT NULL,
  price_monthly  REAL NOT NULL DEFAULT 0,
  price_yearly   REAL NOT NULL DEFAULT 0,
  price_onetime  REAL NOT NULL DEFAULT 0,
  sites_max      INTEGER NOT NULL DEFAULT 1,
  seats          INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'active'   -- active | coming_soon
);

CREATE TABLE IF NOT EXISTS skills (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT '',
  author      TEXT NOT NULL DEFAULT '',
  handle      TEXT NOT NULL DEFAULT '',
  tier        TEXT NOT NULL DEFAULT 'free',       -- free | paid
  version     TEXT NOT NULL DEFAULT '1.0.0',
  installs    INTEGER NOT NULL DEFAULT 0,
  updated     TEXT NOT NULL DEFAULT '',
  files       TEXT NOT NULL DEFAULT '[]'          -- JSON [{path,size,text}]
);

CREATE INDEX IF NOT EXISTS idx_skills_tier ON skills(tier);

CREATE TABLE IF NOT EXISTS oauth_states (
  state      TEXT PRIMARY KEY,
  provider   TEXT NOT NULL DEFAULT '',
  next_url   TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL
);
