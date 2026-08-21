# The cloud scheduler

The headline feature and the reason to leave WP-Cron behind.
`class-scheduler.php` says it in its own docblock:

> WP-Cron only fires on traffic. For true unattended operation, disable WP-Cron
> and hit wp-cron.php from a real system cron.

You cannot sell "managed schedules" on something that only runs when a visitor
happens to arrive.

## Who owns what

| Component | Owns |
|---|---|
| **Cron Trigger** (every minute) | A *sweep*, not the primary path. Finds jobs whose `next_run_at` has passed and pokes their Durable Object. |
| **Durable Object per job** | The alarm, the run lock, and `next_run_at`. Decides overlap and catch-up. Enqueues. |
| **Queue** | Fan-out and dead-lettering. |
| **Queue consumer** | Executes one run: resolve scopes, snapshot, pause on approval, write the run row, report back. |

The DO is the primary trigger; the Cron sweep exists because a durable alarm can
still be lost — a DO deleted, a class replaced by a deploy. A scheduler that
silently stops is worse than one that occasionally fires twice, and the third
layer below makes "twice" harmless anyway.

## Exactly-once dispatch under a Worker restart

Three layers, and it needs all three:

1. **The DO serialises the decision.** `blockConcurrencyWhile` makes
   read-decide-write atomic per job, so two overlapping dispatcher invocations
   cannot both enqueue the same tick. D1 has no row locks and no transaction
   that spans a Worker restart, so a `SELECT … FOR UPDATE` loop over D1 cannot
   give you this.
2. **The alarm is durable.** If the object is evicted mid-tick the alarm
   survives and fires on the next instance. The run lock is in durable storage
   too, so the replay sees the in-flight run and applies the overlap policy
   rather than starting a second one.
3. **`unique(job_id, scheduled_for, attempt)` on `job_runs`.** A queue
   redelivery is a different event from an alarm replay and both can happen; the
   unique index means a duplicate that survives layers 1 and 2 still cannot
   execute twice.

## Timezones

Jobs store an **IANA zone name** (`Asia/Dhaka`), never a UTC offset. An offset
cannot express DST, so "daily at 2am" would drift by an hour twice a year for
anyone in a DST zone — including their clients, whose countries the agency does
not control.

`packages/scheduler-core` walks local wall-clock fields and converts to UTC only
once a candidate matches. The two DST policies, applied in one place so every
caller gets the same answer:

- **Spring forward** — a wall-clock time that does not exist is *skipped*. A
  02:30 job simply does not run on the day 02:30 never happens. It does not
  quietly slide to 03:30.
- **Fall back** — an ambiguous wall-clock time takes its **first** occurrence. A
  01:30 job runs once on the day 01:30 happens twice.

Non-hour offsets (`Asia/Kathmandu` +05:45, `Australia/Adelaide` +09:30/+10:30)
are read from the zone, never rounded. All of this is asserted in
`packages/scheduler-core/test/next-run.test.ts`, including a 365-iteration walk
that fails if a daily job drifts off its local hour even once.

## Policies

| Policy | Default | Why |
|---|---|---|
| `overlap_policy` | `skip` | A job still running when the next tick arrives is skipped and logged, never stacked. Stacking is how a slow 5-minute job becomes a self-inflicted outage on the customer's host. |
| `catchup_policy` | `skip_missed` | After a two-hour outage, `run_all` on a 5-minute job fires 24 times and bills the customer for our incident. `run_once` is offered; `run_all` is opt-in. |
| `concurrency_key` | `site:<site_id>` | At most one run per site. Ten sites on one shared host is the classic way to take a customer's server down with your own product. |
| `max_retries` / `retry_backoff_seconds` | 3 / 60 | Exponential backoff with full jitter, capped at one hour, then dead-letter and notify. |
| `timeout_seconds` | 300 | A timed-out run is `timed_out`, not `failed` — different alerting, because one means "slow site" and the other means "broken playbook". |

The missed-run scan is capped and reports `truncated`. A silent truncation reads
as "we caught everything up", which is the wrong thing for a customer to believe
after an outage.

## Safety

- **Snapshot before any mutating step.** The snapshot id goes on the run row. No
  snapshot id, no destructive execution — the run fails rather than proceeding
  unprotected.
- **Unattended runs never auto-approve.** The plugin already does this correctly:
  `class-scheduler.php` records `paused_for_approval` and stops. That behaviour
  is preserved exactly, and extended: notify the org, expire the approval after
  N hours, and mark the run `skipped` rather than leaving it hanging forever.
- **Scopes resolve at run time, not create time.** Revoking a scope must
  immediately affect existing schedules. The plugin does this; so does this.
- **A job cannot grant itself more than its creator had.** `jobs.created_by` is
  stored and intersected at run time.
- **Dry-run mode** executes the full plan and reports the diff without writing.

## Phase 4 gate

> A 5-minute job survives a 2-hour outage without firing 24 catch-up runs; a
> destructive step pauses for approval and expires cleanly; DST transitions do
> not drift.

The first and third are already covered by tests in `packages/scheduler-core`.
The second needs the queue consumer, which is the remaining Phase 4 work.
