-- Durable claim-before-call idempotency, and two CHECK constraints that
-- would have rejected rows the executor writes.
--
-- ## Why a separate table
--
-- 0003 put a unique index on `action_log(organization_id, idempotency_key)`.
-- That prevents a duplicate ROW. It does not prevent a duplicate external
-- MUTATION, because the row is written after the call returns, and the call is
-- the thing that must not happen twice:
--
--     reserve → CALL WORDPRESS → write action_log   ← index checked here
--                     ▲
--                     └─ a concurrent retry gets this far too
--
-- The claim has to exist before the side effect. `idempotency_claims` is
-- written first, with the key as the primary key, so a second attempt collides
-- at the moment it tries to start rather than at the moment it tries to record
-- having finished.
--
-- ## The two CHECK fixes
--
-- Wiring the executor to this schema surfaced two vocabularies that had drifted
-- apart. `action_log.outcome` did not permit `timeout` or `cancelled`, and
-- `actor_type` did not permit `service_account` or `system` — so a timed-out
-- call, or one made by a service account, would have failed to write its audit
-- row. Losing the audit entry for exactly the calls most worth auditing is the
-- wrong failure, and it would have appeared as a constraint error in
-- production rather than as anything a test caught.
--
-- Reversible: the rebuild maps the new values back to `failed` and `api_key`,
-- which loses detail but not rows.

-- ---------------------------------------------------------------------------
-- 1. idempotency_claims
-- ---------------------------------------------------------------------------

CREATE TABLE idempotency_claims (
  -- The caller's key. Primary key, so `INSERT … ON CONFLICT DO NOTHING`
  -- followed by a read is an atomic claim-or-observe in one round trip.
  key             TEXT PRIMARY KEY,

  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id         TEXT REFERENCES sites(id) ON DELETE SET NULL,
  actor_id        TEXT NOT NULL,
  tool            TEXT NOT NULL,

  -- sha256(canonical(args)). The key is bound to the REQUEST, not only to the
  -- caller: re-using a key with different arguments is a conflict, never a
  -- replay, because returning the first call's result for the second call's
  -- arguments is worse than either outcome the caller expected.
  request_hash    TEXT NOT NULL,

  state           TEXT NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending','succeeded','failed','expired')),

  -- The stored result, for replaying a completed call. Only ever written for
  -- `succeeded`, and subject to the same redaction rules as everything else:
  -- what goes here is the tool's response envelope, not the site's raw body.
  result_json     TEXT,

  created_at      INTEGER NOT NULL,
  settled_at      INTEGER,

  -- A claim left `pending` by a crashed handler must not block its own retry
  -- forever. The sweeper expires past this, and an expired claim can be
  -- re-claimed.
  expires_at      INTEGER NOT NULL CHECK (expires_at > created_at)
);

-- The sweeper's query: pending claims past their expiry.
CREATE INDEX idx_idempotency_expiry
  ON idempotency_claims(expires_at) WHERE state = 'pending';

-- "What did this actor do" during an incident, without scanning the table.
CREATE INDEX idx_idempotency_org ON idempotency_claims(organization_id, created_at);

-- ---------------------------------------------------------------------------
-- 2. action_log — reconcile the outcome and actor vocabularies
-- ---------------------------------------------------------------------------

PRAGMA foreign_keys = OFF;

CREATE TABLE action_log_new (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id          TEXT REFERENCES sites(id) ON DELETE SET NULL,
  -- `service_account` and `system` added. A migration or a sweeper acting on
  -- its own behalf is `system`, and it must be able to record that it did.
  actor_type       TEXT NOT NULL
                   CHECK (actor_type IN ('user','api_key','mcp_session','service_account','scheduler','system')),
  actor_id         TEXT NOT NULL,
  tool             TEXT NOT NULL,
  scope_used       TEXT,
  approval_id      TEXT,
  snapshot_id      TEXT,
  idempotency_key  TEXT,
  -- INVARIANT 6: sha256(canonical(args)). NEVER the args. A db_query or
  -- execute_php argument can carry customer PII; a digest cannot.
  request_digest   TEXT NOT NULL,
  -- `timeout` and `cancelled` added. A timed-out call is not the same event as
  -- a failed one — one reached the site and may have changed something, the
  -- other is a definite outcome — and an incident review needs to tell them
  -- apart.
  outcome          TEXT NOT NULL
                   CHECK (outcome IN ('success','failed','denied','pending_approval','rate_limited','timeout','cancelled')),
  error_code       TEXT,
  duration_ms      INTEGER NOT NULL CHECK (duration_ms >= 0),
  actions_consumed INTEGER NOT NULL DEFAULT 0 CHECK (actions_consumed >= 0),
  request_id       TEXT,
  created_at       INTEGER NOT NULL
);

INSERT INTO action_log_new (
  id, organization_id, site_id, actor_type, actor_id, tool, scope_used,
  approval_id, snapshot_id, idempotency_key, request_digest, outcome,
  error_code, duration_ms, actions_consumed, request_id, created_at
)
SELECT
  id, organization_id, site_id, actor_type, actor_id, tool, scope_used,
  approval_id, snapshot_id, idempotency_key, request_digest, outcome,
  error_code, duration_ms, actions_consumed, request_id, created_at
FROM action_log;

DROP TABLE action_log;
ALTER TABLE action_log_new RENAME TO action_log;

-- Recreate the indexes the old table carried.
CREATE INDEX idx_action_log_org_time ON action_log(organization_id, created_at DESC);
CREATE INDEX idx_action_log_site_time ON action_log(site_id, created_at DESC);
CREATE UNIQUE INDEX idx_action_log_idempotency
  ON action_log(organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

PRAGMA foreign_keys = ON;
PRAGMA foreign_key_check;

-- ---------------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------------
--
--   DROP TABLE idempotency_claims;
--   then rebuild action_log with the original CHECKs, mapping
--     outcome    'timeout' | 'cancelled'          -> 'failed'
--     actor_type 'service_account' | 'system'     -> 'api_key'
--   which loses detail but no rows. Do it before anything starts writing the
--   new values, or the rebuild will silently flatten real distinctions.
