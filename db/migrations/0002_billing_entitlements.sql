-- 0002_billing_entitlements.sql — plans, subscriptions, per-site scope grants.
--
-- INVARIANT 1: the customer never sets their own limits. Every number a plan
-- implies is resolved from here (or from the WPistic ecosystem key adapter),
-- never from anything the client sends. This is the table that replaces
-- `KeyStore::create( …, string $tier = 'custom' )`.

PRAGMA foreign_keys = ON;

CREATE TABLE subscriptions (
  id                     TEXT PRIMARY KEY,
  organization_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan                   TEXT NOT NULL CHECK (plan IN ('free','starter','agency','scale')),
  billing_interval       TEXT NOT NULL CHECK (billing_interval IN ('monthly','yearly')),
  status                 TEXT NOT NULL
                         CHECK (status IN ('trialing','active','past_due','canceled','incomplete')),
  -- $5/mo · $50/yr, and only sold alongside an active subscription.
  api_addon              INTEGER NOT NULL DEFAULT 0 CHECK (api_addon IN (0,1)),
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT UNIQUE,
  trial_ends_at          INTEGER,
  current_period_start   INTEGER NOT NULL,
  current_period_end     INTEGER NOT NULL,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

-- One active subscription per org. A second row for the same org is a billing
-- bug, and it is cheaper to make it impossible than to reconcile it later.
CREATE UNIQUE INDEX idx_subscriptions_active_org
  ON subscriptions(organization_id)
  WHERE status IN ('trialing','active','past_due');

CREATE INDEX idx_subscriptions_period ON subscriptions(current_period_end);

-- Stripe webhook deliveries. Idempotent by construction: the event id is the
-- primary key, so a redelivery is a no-op rather than a double-credit.
--
-- Reconciliation direction is fixed and one-way: webhooks reconcile AGAINST
-- action_log, never the other way round. The meter is the source of truth for
-- what happened; Stripe is the source of truth for what was paid.
CREATE TABLE stripe_events (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  received_at   INTEGER NOT NULL,
  processed_at  INTEGER,
  outcome       TEXT CHECK (outcome IN ('applied','ignored','failed')),
  error_message TEXT
);

CREATE INDEX idx_stripe_events_unprocessed ON stripe_events(processed_at) WHERE processed_at IS NULL;

-- A per-site narrowing of the plan's scopes.
--
-- The grant can only ever REDUCE what the plan allows — an Agency org can hold
-- php:execute and still forbid it on one client's site. It can never widen:
-- effective = requested ∩ plan ∩ grant, and a row here that names a scope the
-- plan does not include simply has no effect.
CREATE TABLE site_scope_grants (
  site_id      TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  scope        TEXT NOT NULL,
  granted_by   TEXT NOT NULL REFERENCES users(id),
  granted_at   INTEGER NOT NULL,
  -- Shown in the dashboard next to the one-click revoke, so an org can see
  -- which grants are load-bearing and which are just old.
  last_used_at INTEGER,
  PRIMARY KEY (site_id, scope)
);

CREATE INDEX idx_site_scope_grants_scope ON site_scope_grants(scope);

-- Revocation is authoritative HERE, not in a cache (INVARIANT 9). A revoked
-- row is deleted and the deletion is logged; nothing reads a cached scope set
-- for longer than the plan's check_after.
CREATE TABLE scope_revocations (
  id           TEXT PRIMARY KEY,
  site_id      TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  scope        TEXT NOT NULL,
  revoked_by   TEXT NOT NULL REFERENCES users(id),
  revoked_at   INTEGER NOT NULL,
  reason       TEXT
);

CREATE INDEX idx_scope_revocations_site ON scope_revocations(site_id, revoked_at);

-- API keys for headless callers: `brg_live_<32 hex>`.
-- Prefix-bucketed so rate limiting can key on the prefix without unhashing.
-- Only the SHA-256 hash is stored; the raw key is shown exactly once.
CREATE TABLE api_keys (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- e.g. 'brg_live_a1b2c3d4' — enough to identify, useless to authenticate.
  prefix          TEXT NOT NULL UNIQUE,
  key_hash        TEXT NOT NULL UNIQUE,
  label           TEXT NOT NULL,
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER,
  revoked_at      INTEGER
);

CREATE INDEX idx_api_keys_org ON api_keys(organization_id) WHERE revoked_at IS NULL;

-- Every org gets a Free subscription so entitlement resolution never has to
-- special-case "no row" — an absent subscription and a Free one would otherwise
-- be two code paths, and only one of them would get tested.
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
