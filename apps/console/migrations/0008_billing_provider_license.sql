-- 0008_billing_provider_license — accept the third provider value the code already
-- produces (2026-11-11).
--
-- 0003/0006 constrained `users.billing_provider` to ('paddle', 'stripe'), but the
-- BillingAccount contract in functions/lib/billing.ts types the value as
-- "paddle" | "stripe" | "license", and the local fallback in functions/api/[[path]].ts
-- reports 'license' for directly issued licenses (manual issue, AppSumo, keys migrated
-- from the retired gateway). billingSummary() writes whatever provider the billing
-- service returns into this column, so a 'license' account hit
-- "CHECK constraint failed: billing_provider IN ('paddle', 'stripe')" and the billing
-- page failed with a 500. Verified against a populated local D1 before this migration.
--
-- SQLite cannot widen a CHECK in place, and a users table rebuild is not available
-- (sessions/orgs/memberships reference users(id); see 0006). Same column-swap as 0006:
-- add the replacement with the wider CHECK, copy, drop, rename, restore the index.
DROP INDEX IF EXISTS idx_users_billing_provider;
ALTER TABLE users ADD COLUMN billing_provider_license TEXT NOT NULL DEFAULT 'stripe' CHECK (billing_provider_license IN ('paddle', 'stripe', 'license'));
UPDATE users SET billing_provider_license = billing_provider;
ALTER TABLE users DROP COLUMN billing_provider;
ALTER TABLE users RENAME COLUMN billing_provider_license TO billing_provider;
CREATE INDEX IF NOT EXISTS idx_users_billing_provider ON users(billing_provider);
