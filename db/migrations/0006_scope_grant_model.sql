-- BR-010 — resolve the two competing site-scope models.
--
-- 0001 created `sites.scopes_granted`; 0002 created `site_scope_grants`. They
-- looked like duplicates of each other, which is how the finding was written
-- up. Reading both carefully, they are not duplicates — they are two DIFFERENT
-- things wearing names that suggest they are the same one, which is worse,
-- because it invites code to read either and believe it has the answer.
--
--   sites.scopes_granted   what the WordPress plugin baked into the signed key
--                          when it was minted. The plugin enforces this. The
--                          platform cannot raise it without the site re-minting
--                          the key; it can only observe it.
--
--   site_scope_grants      what the ORGANIZATION has granted on this site, with
--                          who granted it, when, and when it was last used —
--                          and a revocation trail. This is policy, ours, and
--                          changeable from the dashboard.
--
-- Deleting either would be wrong. Dropping the key's scopes loses the ceiling
-- the plugin actually enforces, so the platform would authorise calls the site
-- rejects — the same class of bug as BR-015. Dropping the grants table loses
-- revocation, attribution and last-used.
--
-- So: keep both, rename the ambiguous one to say what it is, and make the
-- relationship explicit. The effective scope on any call is
--
--     requested ∩ plan entitlement ∩ key ceiling ∩ organization grant
--
-- and `site_scope_grants` is authoritative for the last term.
--
-- Reversible. See the rollback at the bottom.

-- ---------------------------------------------------------------------------
-- 1. Rename, so the column cannot be mistaken for the grant.
-- ---------------------------------------------------------------------------

ALTER TABLE sites RENAME COLUMN scopes_granted TO key_scopes;

-- ---------------------------------------------------------------------------
-- 2. Backfill the grants table from the key ceiling for any site that has no
--    grants yet.
--
--    A site migrated from the legacy `tenants` table has a key ceiling and no
--    grant rows, because grants did not exist when it was connected. Leaving
--    it empty would silently revoke every scope on every migrated site the
--    moment the executor starts intersecting four terms instead of three —
--    a platform-wide outage disguised as a security improvement.
--
--    Granting exactly the key's scopes preserves current behaviour precisely:
--    the intersection is unchanged, because grant == ceiling.
--
--    Attributed to the system, not to a person. Inventing a `granted_by` user
--    would put a name against a decision that person never made.
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO users (id, email, name, created_at)
VALUES ('usr_system_migration', 'system@bridgistic.invalid', 'System (migration)', unixepoch());

INSERT OR IGNORE INTO site_scope_grants (site_id, scope, granted_by, granted_at, last_used_at)
SELECT
  s.id,
  -- json_each over the stored JSON array gives one row per scope.
  j.value,
  'usr_system_migration',
  unixepoch(),
  NULL
FROM sites s, json_each(s.key_scopes) j
WHERE NOT EXISTS (SELECT 1 FROM site_scope_grants g WHERE g.site_id = s.id);

-- ---------------------------------------------------------------------------
-- 3. Record which model is authoritative for what, in the database itself.
--
--    A comment in a migration is read once. This view is read every time
--    somebody goes looking for "the scopes for a site", and it gives them the
--    intersection rather than one half of it.
-- ---------------------------------------------------------------------------

CREATE VIEW site_effective_scopes AS
SELECT
  g.site_id,
  g.scope,
  g.granted_at,
  g.last_used_at
FROM site_scope_grants g
JOIN sites s ON s.id = g.site_id
-- The grant only counts where the key also carries the scope. A grant naming
-- a scope the key does not have is not an error — it is a grant made ahead of
-- a key rotation — but it does not authorise anything today.
WHERE EXISTS (
  SELECT 1 FROM json_each(s.key_scopes) j WHERE j.value = g.scope
);

-- ---------------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------------
--
--   DROP VIEW IF EXISTS site_effective_scopes;
--   DELETE FROM site_scope_grants WHERE granted_by = 'usr_system_migration';
--   DELETE FROM users WHERE id = 'usr_system_migration';
--   ALTER TABLE sites RENAME COLUMN key_scopes TO scopes_granted;
--
-- Safe to run: the backfill is identified by its granted_by, so a rollback
-- removes exactly what this migration added and leaves any grant a human made
-- afterwards alone.
