/**
 * One Durable Object per job. It owns three things and nothing else owns them:
 *
 *   - the alarm            → when this job next fires
 *   - the run lock         → whether a run is in flight, for overlap policy
 *   - `next_run_at`        → the authoritative value; D1 holds a copy for the UI
 *
 * Why a DO and not a `SELECT … FOR UPDATE` loop over D1: exactly-once dispatch
 * needs a single serialised decision-maker per job. D1 has no row locks and no
 * transactions that span a Worker restart, so two dispatcher invocations that
 * overlap would both see the same due row and both enqueue it. A DO gives one
 * writer, and `blockConcurrencyWhile` makes the read-decide-write atomic.
 *
 * Restart safety: the alarm is durable. If this object is evicted mid-tick,
 * the alarm survives and fires again on the next instance; the run lock is in
 * durable storage too, so the replay sees the in-flight run and applies the
 * overlap policy rather than starting a second one. The queue message is
 * additionally deduplicated on (jobId, scheduledFor, attempt) by a unique index
 * in D1 — belt and braces, because a queue redelivery is not the same event as
 * an alarm replay and both can happen.
 */

import {
  nextCronRun,
  nextIntervalRun,
  nextOnceRun,
  decideOverlap,
  decideCatchup,
  decideRetry,
  missedRuns,
} from "@bridgistic/scheduler-core";
import type { OverlapPolicy, CatchupPolicy, ScheduleKind } from "@bridgistic/types";
import type { Env, JobRunMessage } from "./env.ts";

export interface JobConfig {
  jobId: string;
  organizationId: string;
  siteId: string;
  scheduleKind: ScheduleKind;
  cronExpr: string | null;
  intervalSeconds: number | null;
  runOnceAt: number | null;
  timezone: string;
  enabled: boolean;
  overlapPolicy: OverlapPolicy;
  catchupPolicy: CatchupPolicy;
  maxRetries: number;
  retryBackoffSeconds: number;
  /** Anchor for interval schedules, so the cadence does not creep. */
  createdAt: number;
}

interface Durable {
  config: JobConfig | null;
  /** Run id currently in flight, or null. */
  runningRunId: string | null;
  /** The tick the alarm was set for. */
  scheduledFor: number | null;
  /** Last tick that was successfully dispatched — the catch-up window's start. */
  lastDispatchedFor: number | null;
  attempt: number;
}

export class JobScheduler implements DurableObject {
  readonly #state: DurableObjectState;
  readonly #env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.#state = state;
    this.#env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/arm":
        return this.#json(await this.#arm(await request.json<JobConfig>()));
      case "/disarm":
        return this.#json(await this.#disarm());
      case "/finish":
        return this.#json(await this.#finish(await request.json<{ runId: string; ok: boolean }>()));
      case "/state":
        return this.#json(await this.#load());
      default:
        return new Response("Not found", { status: 404 });
    }
  }

  #json(body: unknown): Response {
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  }

  async #load(): Promise<Durable> {
    return (
      (await this.#state.storage.get<Durable>("job")) ?? {
        config: null,
        runningRunId: null,
        scheduledFor: null,
        lastDispatchedFor: null,
        attempt: 0,
      }
    );
  }

  /** Create or update the schedule and set the next alarm. Idempotent. */
  async #arm(config: JobConfig): Promise<{ nextRunAt: number | null }> {
    return this.#state.blockConcurrencyWhile(async () => {
      const state = await this.#load();
      state.config = config;
      state.attempt = 0;

      if (!config.enabled) {
        await this.#state.storage.deleteAlarm();
        state.scheduledFor = null;
        await this.#state.storage.put("job", state);
        return { nextRunAt: null };
      }

      const next = this.#computeNext(config, Date.now());
      state.scheduledFor = next;
      await this.#state.storage.put("job", state);
      if (next !== null) await this.#state.storage.setAlarm(next);
      return { nextRunAt: next };
    });
  }

  async #disarm(): Promise<{ ok: true }> {
    return this.#state.blockConcurrencyWhile(async () => {
      await this.#state.storage.deleteAlarm();
      await this.#state.storage.deleteAll();
      return { ok: true } as const;
    });
  }

  /**
   * The alarm fired. Decide, enqueue, re-arm — in that order, and all of it
   * inside one serialised block so a concurrent `/arm` cannot interleave.
   */
  async alarm(): Promise<void> {
    await this.#state.blockConcurrencyWhile(async () => {
      const state = await this.#load();
      const config = state.config;
      if (!config || !config.enabled) return;

      const now = Date.now();
      const tick = state.scheduledFor ?? now;

      // Catch-up: if we were down, decide what to do with the ticks we missed
      // BEFORE dispatching the current one, so `run_once` picks the latest.
      const ticks = this.#ticksToRun(config, state.lastDispatchedFor, tick);

      const overlap = decideOverlap(config.overlapPolicy, state.runningRunId);
      if (overlap.action === "skip") {
        // Logged as `skipped`, not stacked. The write to job_runs happens in the
        // consumer; here we only record that we chose not to dispatch.
        await this.#recordSkip(config, tick, overlap.reason);
      } else {
        for (const scheduledFor of ticks) {
          const message: JobRunMessage = {
            jobId: config.jobId,
            organizationId: config.organizationId,
            siteId: config.siteId,
            scheduledFor,
            attempt: state.attempt,
            idempotencyKey: `${config.jobId}:${scheduledFor}:${state.attempt}`,
          };
          await this.#env.RUN_QUEUE.send(message);
        }
        if (ticks.length > 0) {
          state.runningRunId = `${config.jobId}:${ticks.at(-1)}:${state.attempt}`;
          state.lastDispatchedFor = ticks.at(-1) ?? state.lastDispatchedFor;
        }
      }

      const next = this.#computeNext(config, now);
      state.scheduledFor = next;
      await this.#state.storage.put("job", state);
      if (next !== null) await this.#state.storage.setAlarm(next);
    });
  }

  /** The consumer reports the outcome. Releases the lock or schedules a retry. */
  async #finish(result: { runId: string; ok: boolean }): Promise<{ retryAt: number | null }> {
    return this.#state.blockConcurrencyWhile(async () => {
      const state = await this.#load();
      const config = state.config;
      if (!config) return { retryAt: null };

      if (state.runningRunId === result.runId) state.runningRunId = null;

      if (result.ok) {
        state.attempt = 0;
        await this.#state.storage.put("job", state);
        return { retryAt: null };
      }

      const retry = decideRetry(state.attempt, config.maxRetries, config.retryBackoffSeconds);
      if (!retry.retry) {
        // Dead-lettered by the queue; the notification is the consumer's job.
        state.attempt = 0;
        await this.#state.storage.put("job", state);
        return { retryAt: null };
      }

      state.attempt = retry.attempt;
      const retryAt = Date.now() + retry.delaySeconds * 1_000;
      // A retry alarm must never push the next scheduled tick later than it
      // would otherwise be — whichever comes first wins.
      const scheduled = state.scheduledFor;
      const alarmAt = scheduled === null ? retryAt : Math.min(retryAt, scheduled);
      await this.#state.storage.put("job", state);
      await this.#state.storage.setAlarm(alarmAt);
      return { retryAt };
    });
  }

  #computeNext(config: JobConfig, afterMs: number): number | null {
    switch (config.scheduleKind) {
      case "cron":
        return config.cronExpr === null ? null : nextCronRun(config.cronExpr, config.timezone, afterMs);
      case "interval":
        return config.intervalSeconds === null
          ? null
          : nextIntervalRun(config.intervalSeconds, config.createdAt, afterMs);
      case "once":
        return config.runOnceAt === null ? null : nextOnceRun(config.runOnceAt, afterMs);
    }
  }

  #ticksToRun(config: JobConfig, lastDispatchedFor: number | null, tick: number): number[] {
    if (config.scheduleKind !== "cron" || config.cronExpr === null || lastDispatchedFor === null) {
      return [tick];
    }
    const { ticks, truncated } = missedRuns(config.cronExpr, config.timezone, lastDispatchedFor, tick);
    const decision = decideCatchup(config.catchupPolicy, ticks, truncated);
    // Whatever the policy, the CURRENT tick always runs; catch-up only decides
    // what to do about the gap behind it.
    return [...new Set([...decision.run, tick])].sort((a, b) => a - b);
  }

  async #recordSkip(config: JobConfig, scheduledFor: number, reason: string): Promise<void> {
    await this.#env.DB.prepare(
      `INSERT OR IGNORE INTO job_runs
         (id, job_id, organization_id, site_id, scheduled_for, status, attempt,
          steps_summary_json, error_code, error_message, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, 'skipped', 0, '[]', 'overlap_skip', ?, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        config.jobId,
        config.organizationId,
        config.siteId,
        scheduledFor,
        reason,
        `${config.jobId}:${scheduledFor}:0`,
        Date.now()
      )
      .run();
  }
}
