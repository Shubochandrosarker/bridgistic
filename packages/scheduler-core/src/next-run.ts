/**
 * Turning a schedule into the next UTC instant to fire.
 *
 * The search walks LOCAL wall-clock fields and only converts to UTC once a
 * candidate matches, which is what keeps a "daily at 02:00" job pinned to 02:00
 * local across a DST transition instead of drifting by an hour.
 */

import { parseCron, matchesDay } from "./cron.ts";
import type { CronFields } from "./cron.ts";
import {
  assertValidTimeZone,
  floorToMinute,
  addMinutes,
  startOfNextDay,
  startOfNextHour,
  startOfNextMonth,
  fromWallClock,
  wallClockDayOfWeek,
} from "./timezone.ts";
import type { WallClock } from "./timezone.ts";

/** Refuse to search forever if an expression somehow matches nothing real. */
const MAX_STEPS = 200_000;
/** No cron expression can be more than ~4 years from any instant. */
const HORIZON_YEARS = 5;

export class NoNextRunError extends Error {
  constructor(expression: string, timeZone: string) {
    super(`Cron "${expression}" has no next run in ${timeZone} within ${HORIZON_YEARS} years.`);
    this.name = "NoNextRunError";
  }
}

/**
 * The first instant strictly after `afterMs` at which `expression` fires in
 * `timeZone`.
 *
 * DST policy, applied here so every caller gets the same answer:
 *   - spring forward — a wall-clock time that does not exist is skipped, so a
 *     02:30 job simply does not run on the day 02:30 never happens.
 *   - fall back — an ambiguous wall-clock time takes its FIRST occurrence, so a
 *     01:30 job runs once on the day 01:30 happens twice, not twice.
 */
export function nextCronRun(expression: string, timeZone: string, afterMs: number): number {
  assertValidTimeZone(timeZone);
  const fields = parseCron(expression);
  return search(fields, timeZone, afterMs);
}

/** Pre-parsed variant, for the dispatcher's hot loop over many jobs. */
export function nextCronRunParsed(fields: CronFields, timeZone: string, afterMs: number): number {
  return search(fields, timeZone, afterMs);
}

function search(fields: CronFields, timeZone: string, afterMs: number): number {
  const horizonMs = afterMs + HORIZON_YEARS * 366 * 86_400_000;
  let wc: WallClock = addMinutes(floorToMinute(afterMs, timeZone), 1);

  for (let step = 0; step < MAX_STEPS; step++) {
    if (!fields.months.has(wc.month)) {
      wc = startOfNextMonth(wc);
      continue;
    }
    if (!matchesDay(fields, wc.day, wallClockDayOfWeek(wc))) {
      wc = startOfNextDay(wc);
      continue;
    }
    if (!fields.hours.has(wc.hour)) {
      wc = startOfNextHour(wc);
      continue;
    }
    if (!fields.minutes.has(wc.minute)) {
      wc = addMinutes(wc, 1);
      continue;
    }

    const instants = fromWallClock(wc, timeZone);
    // Empty = this local time was skipped by a spring-forward transition.
    const firstAfter = instants.find((t) => t > afterMs);
    if (firstAfter !== undefined) {
      if (firstAfter > horizonMs) throw new NoNextRunError(fields.expression, timeZone);
      return firstAfter;
    }
    wc = addMinutes(wc, 1);
  }

  throw new NoNextRunError(fields.expression, timeZone);
}

/**
 * Fixed-interval schedules stay anchored to their creation instant so the run
 * time does not creep forward by the execution latency of every previous run.
 */
export function nextIntervalRun(intervalSeconds: number, anchorMs: number, afterMs: number): number {
  if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0) {
    throw new RangeError("intervalSeconds must be a positive integer.");
  }
  const periodMs = intervalSeconds * 1_000;
  if (afterMs < anchorMs) return anchorMs;
  const elapsed = afterMs - anchorMs;
  return anchorMs + (Math.floor(elapsed / periodMs) + 1) * periodMs;
}

/** A `once` job fires at its scheduled instant and never again. */
export function nextOnceRun(runAtMs: number, afterMs: number): number | null {
  return runAtMs > afterMs ? runAtMs : null;
}

/**
 * Every tick between `fromMs` (exclusive) and `toMs` (inclusive) — the runs an
 * outage swallowed. Bounded by `cap`; the caller must LOG when the cap trims
 * the list, because a silent truncation reads as "we caught everything up".
 */
export function missedRuns(
  expression: string,
  timeZone: string,
  fromMs: number,
  toMs: number,
  cap = 1_000
): { ticks: number[]; truncated: boolean } {
  assertValidTimeZone(timeZone);
  const fields = parseCron(expression);
  const ticks: number[] = [];
  let cursor = fromMs;

  while (ticks.length < cap) {
    let next: number;
    try {
      next = search(fields, timeZone, cursor);
    } catch {
      break;
    }
    if (next > toMs) break;
    ticks.push(next);
    cursor = next;
  }

  const truncated = ticks.length === cap && (() => {
    try {
      return search(fields, timeZone, cursor) <= toMs;
    } catch {
      return false;
    }
  })();

  return { ticks, truncated };
}
