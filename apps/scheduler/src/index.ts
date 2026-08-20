/**
 * bridgistic-scheduler — dispatcher, queue consumer, and the per-job Durable
 * Objects that own the alarms.
 *
 * Division of labour, so nobody has to reconstruct it from the code:
 *
 *   Cron Trigger (every minute)
 *     → `scheduled()` selects jobs whose `next_run_at` has passed and pokes
 *       their Durable Object. It is a SAFETY NET, not the primary path: a DO's
 *       own alarm is what normally fires. The sweep exists because an alarm can
 *       be lost if a DO is deleted or a deploy replaces the class, and a
 *       scheduler that silently stops is worse than one that fires twice.
 *
 *   Durable Object per job
 *     → owns the alarm, the run lock and next_run_at. Decides overlap and
 *       catch-up. Enqueues.
 *
 *   Queue consumer
 *     → executes one run: resolve scopes AT RUN TIME, snapshot before any
 *       mutating step, pause on approval, write the run row, report back.
 *
 * Exactly-once dispatch under a Worker restart comes from three layers, and it
 * needs all three: the DO serialises the decision, the durable alarm survives
 * eviction, and `unique(job_id, scheduled_for, attempt)` on `job_runs` means a
 * duplicate that gets through the first two cannot execute twice.
 */

import type { Env, JobRunMessage } from "./env.ts";

export { JobScheduler } from "./job-scheduler.ts";

/** How far back the sweep looks. A job later than this needs a human, not a poke. */
const SWEEP_WINDOW_MS = 6 * 60 * 60 * 1_000;

export default {
  /** The every-minute safety net. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sweep(env));
  },

  async queue(batch: MessageBatch<JobRunMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await execute(message.body, env);
        message.ack();
      } catch {
        // Let the queue's own retry/dead-letter policy handle it; retrying here
        // would double the backoff and hide the failure from the DLQ.
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, JobRunMessage>;

async function sweep(env: Env): Promise<void> {
  const now = Date.now();
  const due = await env.DB.prepare(
    `SELECT id, organization_id, site_id
       FROM jobs
      WHERE enabled = 1
        AND next_run_at IS NOT NULL
        AND next_run_at <= ?
        AND next_run_at > ?
      LIMIT 500`
  )
    .bind(now, now - SWEEP_WINDOW_MS)
    .all<{ id: string; organization_id: string; site_id: string }>();

  for (const row of due.results) {
    const stub = env.JOB.get(env.JOB.idFromName(row.id));
    // A poke, not a dispatch. The DO re-reads its own state and decides; if its
    // alarm already fired, this is a no-op rather than a second run.
    await stub.fetch("https://job/state");
  }
}

/**
 * Execute one scheduled run.
 *
 * Phase 4. The order of the first three steps is the safety contract and must
 * not be rearranged:
 *
 *   1. Resolve scopes AT RUN TIME — creator ∩ plan ∩ site grant. Revoking a
 *      scope has to affect existing schedules immediately, and it only does if
 *      nothing was cached at create time.
 *   2. Snapshot before any mutating step. No snapshot id, no destructive
 *      execution — the run fails rather than proceeding unprotected.
 *   3. Never auto-approve. A destructive step records `paused_for_approval`,
 *      notifies, and expires into `skipped` after N hours.
 */
async function execute(message: JobRunMessage, _env: Env): Promise<void> {
  void message;
  throw new Error("Scheduler run execution lands in phase 4 — see docs/SCHEDULER.md.");
}
