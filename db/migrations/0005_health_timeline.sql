-- 0005_health_timeline.sql — per-site health over time.
--
-- "Is this site reachable, what plugin version is it on, when did it last run
-- clean, and what kind of errors is it throwing" is the question an agency
-- running 25 client sites asks first every morning. Answering it from
-- action_log alone means a full scan; this is the roll-up.

PRAGMA foreign_keys = ON;

CREATE TABLE site_health_events (
  id             TEXT PRIMARY KEY,
  site_id        TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  observed_at    INTEGER NOT NULL,
  health         TEXT NOT NULL CHECK (health IN ('unknown','healthy','degraded','unreachable')),
  plugin_version TEXT,
  -- A category, not a message: 'timeout', 'signature', 'scope_denied',
  -- 'http_5xx', 'bad_response'. Free-text error bodies can carry PII.
  error_category TEXT,
  latency_ms     INTEGER
);

CREATE INDEX idx_site_health_timeline ON site_health_events(site_id, observed_at DESC);

-- Retention sweeps run against these two, driven by the plan's retention days.
-- A sweep that deletes is cheaper to reason about than a partition scheme, and
-- D1 is not large enough for the difference to matter yet.
CREATE TABLE retention_sweeps (
  id           TEXT PRIMARY KEY,
  table_name   TEXT NOT NULL,
  swept_at     INTEGER NOT NULL,
  rows_deleted INTEGER NOT NULL,
  oldest_kept  INTEGER
);

CREATE INDEX idx_retention_sweeps_table ON retention_sweeps(table_name, swept_at DESC);
