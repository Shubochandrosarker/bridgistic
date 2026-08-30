-- Keep audit history append-only while retaining a database guard against
-- duplicate successful records for one organization/key.
--
-- The idempotency_claims primary key is the pre-side-effect replay guard. The
-- action log is an audit trail and must be allowed to record repeated denied,
-- pending, rate-limited, failed, timed-out, or cancelled attempts using the
-- same caller key. The old all-outcome unique index made that legitimate audit
-- record fail with a constraint error.

DROP INDEX IF EXISTS idx_action_log_idempotency;

CREATE UNIQUE INDEX idx_action_log_idempotency
  ON action_log(organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND outcome = 'success';
