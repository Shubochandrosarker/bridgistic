-- legacy/0001_backfill_tenants.sql — one-time, deployment-specific.
--
-- Applied ONCE against the existing `bridgistic-cloud` D1, after 0001-0005 have
-- created the new schema. A fresh database must NOT run this file: it reads the
-- legacy `tenants` table, which only exists on the deployment being migrated.
--
--   wrangler d1 execute bridgistic-cloud --remote \
--     --file=db/migrations/legacy/0001_backfill_tenants.sql
--
-- Three properties this must preserve, in order of how badly they break things:
--   1. sites.id = tenants.id           — live OAuth tokens keep resolving.
--   2. key_secret_enc copied verbatim  — no re-encryption, no reconnect.
--   3. key_scopes copied verbatim  — nobody silently gains or loses access.
--
-- Ownership is deliberately left unclaimed: a migrated site sits in an
-- orphan-safe personal org with no member until its owner signs in and claims
-- it by proving control of the site (docs/MIGRATION-PHASE-0.md). Guessing an
-- owner from a site URL would be a tenancy bug with a security blast radius.
--
-- The Phase 1 gate is "an existing connected site keeps working through the
-- migration". The only way to know is to check it on the real rows.

INSERT INTO organizations (id, name, slug, wpistic_org_id, created_at, updated_at)
SELECT
  'org_' || t.id,
  'Personal — ' || t.site_url,
  'org-' || lower(hex(randomblob(8))),
  NULL,
  t.created_at,
  t.created_at
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = 'org_' || t.id);

INSERT INTO sites (
  id, organization_id, site_url, label, key_id, key_secret_enc,
  enc_key_version, key_scopes, health, plugin_version, created_at, last_seen_at
)
SELECT
  t.id,
  'org_' || t.id,
  t.site_url,
  NULL,
  t.key_id,
  t.key_secret_enc,
  1,
  t.scopes,
  'unknown',
  NULL,
  t.created_at,
  t.last_used_at
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM sites s WHERE s.id = t.id);

-- Backfilled orgs need the same Free subscription row that 0002 seeds for orgs
-- that already existed. Idempotent, so re-running this file is safe.
INSERT INTO subscriptions (
  id, organization_id, plan, billing_interval, status, api_addon,
  stripe_customer_id, stripe_subscription_id, trial_ends_at,
  current_period_start, current_period_end, created_at, updated_at
)
SELECT
  'sub_' || o.id, o.id, 'free', 'monthly', 'active', 0,
  NULL, NULL, NULL,
  o.created_at, o.created_at + 2592000, o.created_at, o.created_at
FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.organization_id = o.id);

-- BR-010. Every site must hold organization grants matching its key ceiling.
--
-- 0006 does this too, for sites that already exist when it runs. It has to be
-- here as well, because the two run in the other order on a real deployment:
-- schema migrations first, THEN this file imports the tenants. A site created
-- here after 0006 has already run would otherwise have a key ceiling and no
-- grants — and once the executor intersects four terms instead of three, no
-- grants means no scopes, on every migrated site simultaneously.
--
-- Both copies are INSERT OR IGNORE guarded by NOT EXISTS, so whichever runs
-- second is a no-op and running either twice changes nothing.
INSERT OR IGNORE INTO users (id, email, name, created_at)
VALUES ('usr_system_migration', 'system@bridgistic.invalid', 'System (migration)', unixepoch());

INSERT OR IGNORE INTO site_scope_grants (site_id, scope, granted_by, granted_at, last_used_at)
SELECT s.id, j.value, 'usr_system_migration', unixepoch(), NULL
FROM sites s, json_each(s.key_scopes) j
WHERE NOT EXISTS (SELECT 1 FROM site_scope_grants g WHERE g.site_id = s.id);

-- `tenants` is NOT dropped here. It stays as the rollback path until the
-- Phase 1 gate has been demonstrated on production data.
-- legacy/0002_drop_tenants.sql does that, deliberately as a separate, later,
-- irreversible step.
