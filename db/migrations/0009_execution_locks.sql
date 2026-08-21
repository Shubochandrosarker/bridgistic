-- Per-site execution locks for the ActionExecutor.
--
-- ## What this stops
--
-- Two calls mutating the same site at the same time. The executor takes a lock
-- on `site:{id}` before it calls WordPress, so a scheduled playbook and a
-- dashboard click cannot both be halfway through editing the same install —
-- and, more to the point, so a destructive call cannot start while the
-- snapshot for another one is still being taken.
--
-- ## Why a table rather than a Durable Object
--
-- A Durable Object is the stronger primitive: single-threaded by construction,
-- no expiry to get wrong. This is a table because the lock has to be visible to
-- the same transaction boundary as the idempotency claim, and because a lock
-- whose holder crashes must become available again on its own — which is a TTL
-- either way, in the object or in a column.
--
-- The acquire is `INSERT … ON CONFLICT DO UPDATE … WHERE expires_at <= now`,
-- and ownership is decided by rows-changed rather than by reading the row back.
-- Reading first is the race the lock exists to prevent: two callers both see it
-- free, both write, both believe they hold it. SQLite applies the conditional
-- update atomically, so exactly one INSERT changes a row.
--
-- ## The holder column is a fencing token
--
-- A lock that expires can be taken by someone else while the first holder is
-- still running. When that first holder finally finishes and releases, it must
-- not delete the new holder's lock — so release is conditional on the holder,
-- not just the key. Without it, a slow call silently unlocks a site that
-- another call is actively mutating, which is the exact state this table
-- exists to make impossible.
--
-- Reversible: DROP TABLE. Nothing references it; a lost lock table costs
-- concurrency safety until it is recreated, not data.

CREATE TABLE execution_locks (
  -- Namespaced by the caller, e.g. `site:site_abc123`. Primary key, so the
  -- conditional insert is an atomic acquire-or-fail in one round trip.
  lock_key    TEXT PRIMARY KEY,

  -- Who holds it. Compared on release so an expired holder cannot unlock the
  -- site for whoever took it next.
  holder      TEXT NOT NULL,

  acquired_at INTEGER NOT NULL,

  -- When it becomes available regardless of whether it was released. Set from
  -- the tool's own timeout plus a margin, so a lock outlives the call it
  -- guards but not by much.
  expires_at  INTEGER NOT NULL CHECK (expires_at > acquired_at)
);

-- The sweep is by expiry, so an abandoned lock can be found without a scan.
CREATE INDEX idx_execution_locks_expiry ON execution_locks(expires_at);
