/**
 * Overlap, catch-up, retry and interval policy — the rules that decide what a
 * scheduler does when reality does not match the schedule.
 *
 * All pure functions. The Durable Object per job owns the alarm and the lock;
 * this module owns the decisions, so both are testable without a Worker.
 */

import type { CatchupPolicy, OverlapPolicy } from "@bridgistic/types";

// ---------------------------------------------------------------- overlap ---

export type OverlapDecision =
  | { action: "run" }
  | { action: "skip"; reason: string }
  | { action: "queue" }
  | { action: "cancel_previous"; cancelRunId: string };

/**
 * Default policy is `skip`: a job still running when its next tick arrives is
 * skipped and logged, never stacked. Stacking is how a slow 5-minute job turns
 * into a self-inflicted denial of service on the customer's own host.
 */
export function decideOverlap(
  policy: OverlapPolicy,
  runningRunId: string | null
): OverlapDecision {
  if (runningRunId === null) return { action: "run" };
  switch (policy) {
    case "skip":
      return { action: "skip", reason: `previous run ${runningRunId} still in progress` };
    case "queue":
      return { action: "queue" };
    case "cancel_previous":
      return { action: "cancel_previous", cancelRunId: runningRunId };
  }
}

// --------------------------------------------------------------- catch-up ---

export interface CatchupDecision {
  /** The ticks to actually execute, oldest first. */
  run: number[];
  /** Ticks deliberately dropped. Always surfaced in the run log, never silent. */
  dropped: number[];
  /** True when the missed-run scan hit its cap before reaching `now`. */
  truncated: boolean;
}

/**
 * After an outage, `run_all` on a 5-minute job would fire hundreds of times and
 * bill the customer for an incident that was ours. Default `skip_missed`.
 */
export function decideCatchup(
  policy: CatchupPolicy,
  missedTicks: readonly number[],
  truncated = false
): CatchupDecision {
  const ticks = [...missedTicks].sort((a, b) => a - b);
  switch (policy) {
    case "skip_missed":
      return { run: [], dropped: ticks, truncated };
    case "run_once": {
      const last = ticks.at(-1);
      return last === undefined
        ? { run: [], dropped: [], truncated }
        : { run: [last], dropped: ticks.slice(0, -1), truncated };
    }
    case "run_all":
      return { run: ticks, dropped: [], truncated };
  }
}

// ------------------------------------------------------------------ retry ---

export interface RetryDecision {
  retry: boolean;
  attempt: number;
  delaySeconds: number;
  /** True when retries are exhausted and the run belongs in the dead-letter queue. */
  deadLetter: boolean;
}

/**
 * Exponential backoff with full jitter. `random` is injected so a test can pin
 * it; production passes `Math.random`.
 */
export function decideRetry(
  attempt: number,
  maxRetries: number,
  baseBackoffSeconds: number,
  random: () => number = Math.random
): RetryDecision {
  if (attempt >= maxRetries) {
    return { retry: false, attempt, delaySeconds: 0, deadLetter: true };
  }
  const ceiling = Math.min(baseBackoffSeconds * 2 ** attempt, 3_600);
  const delaySeconds = Math.max(1, Math.round(ceiling * random()));
  return { retry: true, attempt: attempt + 1, delaySeconds, deadLetter: false };
}

// --------------------------------------------------------------- approval ---

export type ApprovalOutcome = "still_waiting" | "expired";

/**
 * INVARIANT 5: an unattended run never auto-approves. It pauses, notifies, and
 * — unlike the plugin's WP-Cron version, which leaves it hanging forever —
 * expires into `skipped` so the run history cannot fill with zombies.
 */
export function decideApprovalExpiry(
  pausedAtMs: number,
  nowMs: number,
  expiryHours: number
): ApprovalOutcome {
  return nowMs - pausedAtMs >= expiryHours * 3_600_000 ? "expired" : "still_waiting";
}

// -------------------------------------------------------------- intervals ---

export class IntervalTooTightError extends Error {
  readonly requestedSeconds: number;
  readonly minSeconds: number;

  constructor(requestedSeconds: number, minSeconds: number) {
    super(
      `This schedule fires every ${requestedSeconds}s; the plan's floor is ${minSeconds}s. Upgrade or loosen the schedule.`
    );
    this.name = "IntervalTooTightError";
    this.requestedSeconds = requestedSeconds;
    this.minSeconds = minSeconds;
  }
}

/**
 * Enforced at create/update time so the customer sees an honest error instead
 * of a job that silently runs less often than the screen says it will.
 */
export function assertIntervalAllowed(requestedSeconds: number, planMinSeconds: number): void {
  if (requestedSeconds < planMinSeconds) {
    throw new IntervalTooTightError(requestedSeconds, planMinSeconds);
  }
}

// ------------------------------------------------------------ concurrency ---

/**
 * Default concurrency key is the site id: at most one run per site at a time.
 * Ten sites on one shared host is the classic way to take a customer's server
 * down with your own product, so the key is a knob, not a constant.
 */
export function defaultConcurrencyKey(siteId: string): string {
  return `site:${siteId}`;
}
