-- 0004_scheduler.sql — the managed cloud scheduler.
--
-- This is the reason to leave WP-Cron behind. `class-scheduler.php` says so in
-- its own docblock: "WP-Cron only fires on traffic. For true unattended
-- operation, disable WP-Cron and hit wp-cron.php from a real system cron."
-- You cannot sell "managed schedules" on something that only runs when a
-- visitor happens to arrive.
--
-- Ownership of state, so it is written down once:
--   Cron Trigger (1/min) → dispatcher selects due jobs and enqueues.
--   Queue               → fan-out + dead-letter.
--   Durable Object/job  → owns the alarm, the lock, and next_run_at.
-- The DO is authoritative for dispatch; these rows are the durable record and
-- the thing the dashboard reads. See docs/SCHEDULER.md.

PRAGMA foreign_keys = ON;

CREATE TABLE jobs (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id         TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  playbook_slug   TEXT NOT NULL,
  vars_json       TEXT NOT NULL DEFAULT '{}',

  schedule_kind   TEXT NOT NULL CHECK (schedule_kind IN ('cron','interval','once')),
  -- 5-field, evaluated in `timezone`. NULL for interval/once.
  cron_expr       TEXT,
  interval_seconds INTEGER,
  run_once_at     INTEGER,
  -- IANA zone name, e.g. 'Asia/Dhaka'. NOT a UTC offset: an offset cannot
  -- express DST, and "daily at 2am" would drift by an hour twice a year.
  timezone        TEXT NOT NULL DEFAULT 'UTC',

  next_run_at     INTEGER,
  last_run_at     INTEGER,
  last_status     TEXT,

  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  dry_run         INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0,1)),

  -- Default 'skip': a job still running when the next tick arrives is skipped
  -- and logged, never stacked.
  overlap_policy  TEXT NOT NULL DEFAULT 'skip'
                  CHECK (overlap_policy IN ('skip','queue','cancel_previous')),
  -- Default 'skip_missed': after a two-hour outage, run_all on a 5-minute job
  -- would fire 24 times and bill the customer for our incident.
  catchup_policy  TEXT NOT NULL DEFAULT 'skip_missed'
                  CHECK (catchup_policy IN ('skip_missed','run_once','run_all')),

  max_retries          INTEGER NOT NULL DEFAULT 3,
  retry_backoff_seconds INTEGER NOT NULL DEFAULT 60,
  timeout_seconds      INTEGER NOT NULL DEFAULT 300,

  -- Defaults to 'site:<site_id>'. Ten sites on one shared host is the classic
  -- way to take a customer's server down with your own product.
  concurrency_key TEXT NOT NULL,
  -- JSON array. Defaults to failure + approval_required; NOT success, or people
  -- mute the notifications and then miss the failures.
  notify_on       TEXT NOT NULL DEFAULT '["failure","approval_required"]',

  -- A job cannot grant itself more than its creator had. Scopes are intersected
  -- at RUN time against this actor, the plan, and the site grant — so revoking
  -- a scope immediately affects existing schedules.
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,

  CHECK (
    (schedule_kind = 'cron'     AND cron_expr IS NOT NULL) OR
    (schedule_kind = 'interval' AND interval_seconds IS NOT NULL AND interval_seconds > 0) OR
    (schedule_kind = 'once'     AND run_once_at IS NOT NULL)
  )
);

-- The dispatcher's only hot query: due, enabled jobs.
CREATE INDEX idx_jobs_due ON jobs(next_run_at) WHERE enabled = 1;
CREATE INDEX idx_jobs_org ON jobs(organization_id);
CREATE INDEX idx_jobs_site ON jobs(site_id);

CREATE TABLE job_runs (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id         TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,

  -- The tick this run belongs to, not the moment it started. Two different
  -- things, and conflating them is what makes catch-up logic wrong.
  scheduled_for   INTEGER NOT NULL,
  started_at      INTEGER,
  finished_at     INTEGER,

  status          TEXT NOT NULL
                  CHECK (status IN ('queued','running','success','failed',
                                    'paused_for_approval','skipped','timed_out','cancelled')),
  attempt         INTEGER NOT NULL DEFAULT 0,

  snapshot_id     TEXT REFERENCES snapshots(id),
  approval_id     TEXT REFERENCES approvals(id),

  -- Per-step outcome, digests only — same rule as action_log.request_digest.
  steps_summary_json TEXT NOT NULL DEFAULT '[]',
  error_code      TEXT,
  error_message   TEXT,
  actions_consumed INTEGER NOT NULL DEFAULT 0,

  idempotency_key TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

-- The guarantee that a queue redelivery cannot double-execute a run.
CREATE UNIQUE INDEX idx_job_runs_idempotency ON job_runs(job_id, scheduled_for, attempt);
CREATE INDEX idx_job_runs_history ON job_runs(job_id, scheduled_for DESC);
CREATE INDEX idx_job_runs_org_status ON job_runs(organization_id, status, created_at);
-- At most one run in flight per concurrency key is enforced by the DO lock;
-- this index is what makes the "is anything running here" check cheap.
CREATE INDEX idx_job_runs_active ON job_runs(site_id, status) WHERE status IN ('queued','running');

-- Where notifications go. Email, Slack, or a generic webhook.
CREATE TABLE notification_channels (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('email','slack','webhook')),
  -- For webhook/slack: the URL. Passed through the same SSRF guard as a site
  -- URL — a notification target is another server-side fetch from a stranger.
  target          TEXT NOT NULL,
  -- HMAC secret for the generic webhook, so a receiver can verify us.
  secret_enc      TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at      INTEGER NOT NULL,
  last_delivery_at INTEGER,
  last_error      TEXT
);

CREATE INDEX idx_notification_channels_org ON notification_channels(organization_id) WHERE enabled = 1;
