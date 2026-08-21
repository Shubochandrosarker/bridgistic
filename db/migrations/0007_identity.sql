-- Identity: the seven roles, sessions, key scoping, and site ownership claims.
--
-- 0001 defined four membership roles (owner/admin/member/viewer). The product
-- needs seven, and the two extra ones are not conveniences — `approver` and
-- `support_auditor` exist so that approving work and doing work can be
-- different people, and so that reading the audit trail does not require the
-- ability to add to it.
--
-- SQLite cannot alter a CHECK constraint, so `memberships` is rebuilt with the
-- standard create-copy-drop-rename. Foreign keys are suspended for the swap
-- and re-checked afterwards; `PRAGMA foreign_key_check` is run at the end so a
-- broken reference fails the migration rather than surfacing later as a row
-- nobody can explain.

PRAGMA foreign_keys = OFF;

-- ---------------------------------------------------------------------------
-- 1. memberships — four roles become seven
-- ---------------------------------------------------------------------------

CREATE TABLE memberships_new (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN (
                    'owner','admin','operator','approver','viewer','billing_manager','support_auditor'
                  )),
  created_at      INTEGER NOT NULL,
  -- Who granted this role, so a privilege escalation has a trail. Nullable
  -- only for the first owner of an organization, who by definition was not
  -- granted the role by anybody.
  granted_by      TEXT REFERENCES users(id),
  PRIMARY KEY (organization_id, user_id)
);

-- `member` was the old name for what is now `operator`: it could do the work.
-- Mapping it to `viewer` would silently strip everyone's ability to act;
-- mapping it to `admin` would silently grant scope management. `operator` is
-- the role whose permissions match what `member` actually had.
INSERT INTO memberships_new (organization_id, user_id, role, created_at, granted_by)
SELECT
  organization_id,
  user_id,
  CASE role WHEN 'member' THEN 'operator' ELSE role END,
  created_at,
  NULL
FROM memberships;

DROP TABLE memberships;
ALTER TABLE memberships_new RENAME TO memberships;

CREATE INDEX idx_memberships_user ON memberships(user_id);

-- ---------------------------------------------------------------------------
-- 2. sessions
-- ---------------------------------------------------------------------------

CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id    TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- SHA-256 of the session token. The token itself is never stored, for the
  -- same reason an API key's secret is not: a table that can hand back a live
  -- session is a table whose compromise is every account at once.
  token_hash         TEXT NOT NULL UNIQUE,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL CHECK (expires_at > created_at),
  last_seen_at       INTEGER,
  -- When step-up authentication was last completed. NULL means never.
  stepped_up_at      INTEGER,
  revoked_at         INTEGER,
  -- The user's credential generation this session was issued under. A password
  -- change or MFA reset bumps users.credential_version, and every session
  -- below it stops being valid. Without this, "sign out everywhere" is a
  -- button that does nothing.
  credential_version INTEGER NOT NULL DEFAULT 1,
  -- Coarse client fingerprint for the "your sessions" list. Deliberately NOT
  -- an IP address or a full user agent: enough to recognise a device, not
  -- enough to be a tracking record we then have to defend holding.
  client_label       TEXT
);

CREATE INDEX idx_sessions_user ON sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_expiry ON sessions(expires_at) WHERE revoked_at IS NULL;

ALTER TABLE users ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN mfa_enrolled_at INTEGER;
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','suspended','deleted'));

-- ---------------------------------------------------------------------------
-- 3. api_keys — scoping, expiry, and a role
-- ---------------------------------------------------------------------------
--
-- A key with no role acts as whoever created it, forever, at whatever their
-- role becomes later. That is a privilege escalation with a delay on it: an
-- operator mints a key, is promoted to admin, and the key silently gains
-- admin. The role is fixed at mint time.

ALTER TABLE api_keys ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer'
  CHECK (role IN ('operator','viewer','support_auditor'));
ALTER TABLE api_keys ADD COLUMN expires_at INTEGER;
ALTER TABLE api_keys ADD COLUMN environment TEXT NOT NULL DEFAULT 'live'
  CHECK (environment IN ('live','test'));
-- JSON array. A key may be narrower than its role, never wider: the effective
-- scope is still the four-way intersection, and this is a fifth narrowing.
ALTER TABLE api_keys ADD COLUMN scopes TEXT;
-- Optional single-site restriction. An agency key that only ever touches one
-- client's site should not be able to touch the other twenty-four.
ALTER TABLE api_keys ADD COLUMN site_id TEXT REFERENCES sites(id) ON DELETE CASCADE;

-- The role CHECK above deliberately excludes owner, admin, approver and
-- billing_manager. A key cannot answer a step-up challenge, so it must not
-- hold a role whose permissions depend on one — and a key that could approve
-- its own work would make approval a formality.

-- ---------------------------------------------------------------------------
-- 4. Site connection: challenge → verify → claim
-- ---------------------------------------------------------------------------

CREATE TABLE site_connections (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Normalised origin, checked by @bridgistic/url-guard before this row exists.
  site_url        TEXT NOT NULL,
  -- SHA-256 of the challenge nonce. The plugin proves it holds the nonce by
  -- signing it; we never need the nonce itself again, so we do not keep it.
  challenge_hash  TEXT NOT NULL UNIQUE,
  state           TEXT NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending','verified','claimed','expired','abandoned')),
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      INTEGER NOT NULL,
  -- Short. A pending connection is an unauthenticated write path into the
  -- organization, and it should not stay open while somebody goes to lunch.
  expires_at      INTEGER NOT NULL CHECK (expires_at > created_at),
  verified_at     INTEGER,
  claimed_at      INTEGER,
  site_id         TEXT REFERENCES sites(id) ON DELETE SET NULL,
  -- The addresses the hostname resolved to at connection time, for the audit
  -- trail. A later rebind is visible as a difference from this.
  resolved_addresses TEXT
);

CREATE INDEX idx_site_connections_org ON site_connections(organization_id, state);
CREATE INDEX idx_site_connections_expiry ON site_connections(expires_at) WHERE state = 'pending';

-- A site migrated from `tenants` has no user attached to it: the legacy table
-- had no concept of one. It cannot simply be handed to whoever asks, so it
-- enters a claim flow instead — the claimant proves control of the site the
-- same way a new connection does.
CREATE TABLE site_ownership_claims (
  id             TEXT PRIMARY KEY,
  site_id        TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  claimed_by     TEXT NOT NULL REFERENCES users(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  challenge_hash TEXT NOT NULL UNIQUE,
  state          TEXT NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending','verified','rejected','expired')),
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL CHECK (expires_at > created_at),
  decided_at     INTEGER,
  decided_by     TEXT REFERENCES users(id)
);

CREATE INDEX idx_site_claims_site ON site_ownership_claims(site_id, state);

-- ---------------------------------------------------------------------------
-- 5. Credential versions — immutable, never updated in place
-- ---------------------------------------------------------------------------
--
-- Rotation writes a new row. It does not mutate an old one, so a signature
-- made under a previous version can still be identified after the fact, and a
-- half-finished rotation is distinguishable from a corrupt one.

CREATE TABLE site_credentials (
  site_id         TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  key_id          TEXT NOT NULL,
  key_secret_enc  TEXT NOT NULL,
  enc_key_version INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  -- Set when superseded. A NULL means this is the live one; the partial unique
  -- index below makes "exactly one live credential per site" a database rule
  -- rather than something application code has to remember.
  retired_at      INTEGER,
  PRIMARY KEY (site_id, version)
);

CREATE UNIQUE INDEX idx_site_credentials_live
  ON site_credentials(site_id) WHERE retired_at IS NULL;

-- Carry the credential currently on `sites` into the versioned table as
-- version 1, so there is no window where a site has no live credential.
INSERT OR IGNORE INTO site_credentials (site_id, version, key_id, key_secret_enc, enc_key_version, created_at, retired_at)
SELECT id, 1, key_id, key_secret_enc, enc_key_version, created_at, NULL FROM sites;

-- `sites.key_id` / `key_secret_enc` are deliberately NOT dropped here. Doing
-- both in one migration means a rollback has to restore data as well as
-- schema. They become read-only in Phase 2 code and are dropped in a later,
-- separate migration once nothing reads them.

PRAGMA foreign_keys = ON;

-- A broken reference must fail the migration, not surface weeks later as a row
-- nobody can account for.
PRAGMA foreign_key_check;

-- ---------------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------------
--
-- Reversible, in this order:
--   DROP TABLE site_credentials, site_ownership_claims, site_connections, sessions;
--   ALTER TABLE api_keys DROP COLUMN site_id;      -- and scopes, environment,
--   ALTER TABLE users    DROP COLUMN status;       -- expires_at, role,
--                                                  -- mfa_enrolled_at, credential_version
--   then rebuild memberships with the original four-role CHECK, mapping
--   'operator' back to 'member' and every other new role to 'viewer' — which
--   loses information, so a rollback past this point is a decision, not a
--   routine step. It is recorded here so that decision is made with the cost
--   visible.
