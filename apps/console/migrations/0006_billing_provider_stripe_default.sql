-- 0006_billing_provider_stripe_default — Paddle retired, Stripe is the only live
-- gateway (2026-11-11).
--
-- 0003 added `users.billing_provider` with DEFAULT 'paddle', from when Paddle was the
-- only gateway. New accounts must default to 'stripe' instead. 0003 is corrected for
-- fresh installs; this migration fixes databases that already ran the old version.
--
-- SQLite cannot ALTER a column default, and a table rebuild is not an option here:
-- sessions, orgs and memberships reference users(id), so the implicit DELETE that
-- DROP TABLE performs either trips their ON DELETE CASCADE or fails outright with
-- "FOREIGN KEY constraint failed" (D1 enforces foreign keys during migrations and
-- PRAGMA foreign_keys has no effect there — verified against a populated local D1).
-- Swapping the column instead keeps every row, including child rows, untouched: the
-- values are copied across and only the default changes.
--
-- Legacy 'paddle' rows keep their stored value and stay readable, which the 90-day
-- history/refund path still relies on.
DROP INDEX IF EXISTS idx_users_billing_provider;
ALTER TABLE users ADD COLUMN billing_provider_stripe TEXT NOT NULL DEFAULT 'stripe' CHECK (billing_provider_stripe IN ('paddle', 'stripe'));
UPDATE users SET billing_provider_stripe = billing_provider;
ALTER TABLE users DROP COLUMN billing_provider;
ALTER TABLE users RENAME COLUMN billing_provider_stripe TO billing_provider;
CREATE INDEX IF NOT EXISTS idx_users_billing_provider ON users(billing_provider);
