-- 0003_billing_provider — Stripe as a second gateway (2026-11-04).
-- api.wpistic.com owns billing truth (organizations.billing_provider there).
-- The console caches the account's provider so admin can show it without a
-- round-trip per row; refreshed on every /api/me/billing read.
-- Additive + idempotent-by-runner (D1 migrations run once). Rollback: the columns
-- are unused by older code; SQLite >= 3.35 can DROP COLUMN if needed.
--
-- Historical: this file shipped with DEFAULT 'paddle', when Paddle was the only
-- gateway. Paddle is retired (2026-11-11), so fresh installs default to 'stripe'
-- here; databases that already ran the old version are corrected by
-- 0006_billing_provider_stripe_default.sql.
ALTER TABLE users ADD COLUMN billing_provider TEXT NOT NULL DEFAULT 'stripe' CHECK (billing_provider IN ('paddle', 'stripe'));
ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE users ADD COLUMN billing_synced_at TEXT;
CREATE INDEX IF NOT EXISTS idx_users_billing_provider ON users(billing_provider);
