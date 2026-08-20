-- 0001_tenancy.sql — organizations, users, memberships, sites.
--
-- Replaces the site-only `tenants` table from the free repo's cloud Worker
-- (cloud/migrations/0001_init.sql) with a real hierarchy:
--
--   organization ──< membership >── user
--        ├──< site
--        ├──< job
--        ├──< subscription
--        └──< action_log
--
-- The backfill at the bottom is the load-bearing part: an already-connected
-- site must keep working through this migration. See docs/MIGRATION-PHASE-0.md.

PRAGMA foreign_keys = ON;

CREATE TABLE organizations (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  -- Set when this org authenticates with a WPistic ecosystem key (wpi_live_…)
  -- instead of a Stripe subscription. Entitlements then resolve through the
  -- adapter in apps/api, never through a second entitlement engine.
  wpistic_org_id TEXT UNIQUE,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  name         TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE memberships (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX idx_memberships_user ON memberships(user_id);

-- One row per connected WordPress site.
--
-- `id` is ALSO the OAuth grant's userId, exactly as `tenants.id` was, so an
-- access token minted before this migration still resolves to its site
-- afterwards. Do not regenerate these ids.
CREATE TABLE sites (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Normalised by packages/wp-client → `https://host[:port]`, no trailing
  -- slash. Globally unique: one WordPress install belongs to exactly one org,
  -- and moving it is an explicit, audited transfer, never an implicit re-claim.
  site_url        TEXT NOT NULL UNIQUE,
  label           TEXT,
  key_id          TEXT NOT NULL,
  -- AES-256-GCM envelope from cloud/src/crypto.ts, carried across UNCHANGED by
  -- the backfill. Re-encrypting here would need TENANT_ENC_KEY at migration
  -- time and would lock out every site if it were wrong.
  key_secret_enc  TEXT NOT NULL,
  -- Which TENANT_ENC_KEY generation `key_secret_enc` is sealed under. Rotation
  -- walks rows from N to N+1 and can resume; without this column a half-
  -- finished rotation is indistinguishable from a corrupt table.
  enc_key_version INTEGER NOT NULL DEFAULT 1,
  -- JSON array of scope strings the SITE granted when the key was minted. The
  -- effective scope on any call is requested ∩ plan ∩ this.
  scopes_granted  TEXT NOT NULL,
  health          TEXT NOT NULL DEFAULT 'unknown'
                  CHECK (health IN ('unknown','healthy','degraded','unreachable')),
  plugin_version  TEXT,
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER
);

CREATE INDEX idx_sites_org ON sites(organization_id);
CREATE INDEX idx_sites_health ON sites(health, last_seen_at);
CREATE INDEX idx_sites_enc_version ON sites(enc_key_version);

-- An audited record of a site changing hands between orgs.
CREATE TABLE site_transfers (
  id            TEXT PRIMARY KEY,
  site_id       TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  from_org_id   TEXT NOT NULL REFERENCES organizations(id),
  to_org_id     TEXT NOT NULL REFERENCES organizations(id),
  requested_by  TEXT NOT NULL REFERENCES users(id),
  approved_by   TEXT REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  completed_at  INTEGER
);

CREATE INDEX idx_site_transfers_site ON site_transfers(site_id);

-- The backfill of the legacy `tenants` table is NOT here: it is a one-time,
-- deployment-specific step against the existing `bridgistic-cloud` D1 and it
-- references a table a fresh database does not have. See
-- db/migrations/legacy/0001_backfill_tenants.sql.
