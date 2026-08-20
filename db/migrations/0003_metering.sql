-- 0003_metering.sql — the meter and the audit trail, which are one table.
--
-- `class-usage.php` in the WordPress plugin calls itself "the monetization
-- layer" while running inside the customer's own WordPress. Client-side
-- metering is not metering. It stays, demoted to a local safety valve; THIS is
-- the meter.
--
-- The authoritative counter is a Durable Object per (org, month) — a serialised
-- single writer. KV read-then-write is per-colo approximate and the free repo's
-- own docs call it "inadequate as a billing-grade counter". This table is the
-- durable ledger the DO counter is reconciled against, not the counter itself.

PRAGMA foreign_keys = ON;

CREATE TABLE action_log (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id          TEXT REFERENCES sites(id) ON DELETE SET NULL,
  actor_type       TEXT NOT NULL CHECK (actor_type IN ('user','api_key','mcp_session','scheduler')),
  actor_id         TEXT NOT NULL,
  tool             TEXT NOT NULL,
  scope_used       TEXT,
  approval_id      TEXT,
  snapshot_id      TEXT,
  idempotency_key  TEXT,
  -- INVARIANT 6: sha256(canonical(args)). NEVER the args. A db_query or
  -- execute_php argument can carry customer PII; a digest cannot.
  request_digest   TEXT NOT NULL,
  outcome          TEXT NOT NULL
                   CHECK (outcome IN ('success','failed','denied','pending_approval','rate_limited')),
  error_code       TEXT,
  duration_ms      INTEGER NOT NULL,
  actions_consumed INTEGER NOT NULL DEFAULT 0,
  request_id       TEXT,
  created_at       INTEGER NOT NULL
);

-- The billing query: everything an org consumed in a period.
CREATE INDEX idx_action_log_org_period ON action_log(organization_id, created_at);
-- The audit query: everything that happened to one site.
CREATE INDEX idx_action_log_site ON action_log(site_id, created_at);
-- The support query: one customer report → one log line.
CREATE INDEX idx_action_log_request_id ON action_log(request_id);

-- INVARIANT 7: a retried mutating call must not execute twice. The unique
-- index is what enforces it; the application's "have I seen this key" check is
-- an optimisation on top, not the guarantee.
CREATE UNIQUE INDEX idx_action_log_idempotency
  ON action_log(organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- A materialised per-(org, month) roll-up. Written by the Durable Object
-- counter as it advances, read by the dashboard and by Stripe reporting.
-- Never used to AUTHORISE a call — the DO is the live counter — only to report.
CREATE TABLE usage_counters (
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- 'YYYY-MM' in UTC. The billing period boundary is the subscription's, not
  -- the calendar's; this bucket exists for reporting, so UTC months are fine.
  period           TEXT NOT NULL,
  actions_consumed INTEGER NOT NULL DEFAULT 0,
  -- Cheap enough to keep, and it is what makes "why is my bill high" answerable.
  reads            INTEGER NOT NULL DEFAULT 0,
  writes           INTEGER NOT NULL DEFAULT 0,
  destructive      INTEGER NOT NULL DEFAULT 0,
  failures         INTEGER NOT NULL DEFAULT 0,
  soft_limit_notified_at INTEGER,
  hard_limit_hit_at      INTEGER,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (organization_id, period)
);

-- Approvals raised by the platform (as opposed to the ones the plugin raises
-- in-site). A scheduled run that hits a destructive step lands here.
CREATE TABLE approvals (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id         TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  tool            TEXT NOT NULL,
  scope_requested TEXT NOT NULL,
  request_digest  TEXT NOT NULL,
  -- Human-readable summary of what will happen. Derived server-side from the
  -- tool and the dry-run result — never free text supplied by the caller, or
  -- the approval screen becomes a place to lie to the person clicking it.
  summary         TEXT NOT NULL,
  requested_by_type TEXT NOT NULL CHECK (requested_by_type IN ('user','api_key','mcp_session','scheduler')),
  requested_by_id TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','expired')),
  -- INVARIANT 3: destructive verbs need step-up auth as well as approval.
  step_up_verified_at INTEGER,
  decided_by      TEXT REFERENCES users(id),
  decided_at      INTEGER,
  -- An approval that nobody answers expires; the run it blocks becomes
  -- `skipped`, not a zombie that sits in the history forever.
  expires_at      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX idx_approvals_pending ON approvals(organization_id, status, expires_at);

-- Snapshot bookkeeping. The snapshot itself lives in the site (the plugin owns
-- it); this row is what lets the platform refuse to run a destructive step when
-- no snapshot id came back (INVARIANT 4).
CREATE TABLE snapshots (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id         TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  -- The id the PLUGIN returned. Restoring goes back through the plugin.
  remote_id       TEXT NOT NULL,
  reason          TEXT NOT NULL,
  size_bytes      INTEGER,
  created_at      INTEGER NOT NULL,
  -- Retention is the plan's, enforced by a scheduled sweep, not by the site.
  expires_at      INTEGER NOT NULL,
  restored_at     INTEGER
);

CREATE INDEX idx_snapshots_site ON snapshots(site_id, created_at);
CREATE INDEX idx_snapshots_expiry ON snapshots(expires_at) WHERE restored_at IS NULL;
