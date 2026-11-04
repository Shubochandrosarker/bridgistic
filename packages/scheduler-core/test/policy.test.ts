import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideOverlap,
  decideCatchup,
  decideRetry,
  decideApprovalExpiry,
  assertIntervalAllowed,
  IntervalTooTightError,
  defaultConcurrencyKey,
} from "../src/policy.ts";
import { missedRuns } from "../src/next-run.ts";

test("overlap defaults to skipping, never stacking", () => {
  assert.deepEqual(decideOverlap("skip", null), { action: "run" });
  assert.equal(decideOverlap("skip", "run_123").action, "skip");
  assert.equal(decideOverlap("queue", "run_123").action, "queue");
  assert.deepEqual(decideOverlap("cancel_previous", "run_123"), {
    action: "cancel_previous",
    cancelRunId: "run_123",
  });
});

test("a 5-minute job survives a 2-hour outage without firing 24 catch-up runs", () => {
  const outageStart = Date.parse("2027-01-01T00:00:00Z");
  const backUp = Date.parse("2027-01-01T02:00:00Z");
  const { ticks } = missedRuns("*/5 * * * *", "UTC", outageStart, backUp);
  assert.equal(ticks.length, 24, "24 ticks were genuinely missed");

  const skip = decideCatchup("skip_missed", ticks);
  assert.equal(skip.run.length, 0);
  assert.equal(skip.dropped.length, 24, "dropped ticks are reported, not forgotten");

  const once = decideCatchup("run_once", ticks);
  assert.deepEqual(once.run, [ticks.at(-1)]);
  assert.equal(once.dropped.length, 23);

  const all = decideCatchup("run_all", ticks);
  assert.equal(all.run.length, 24, "run_all is opt-in and does exactly what it says");
});

test("catch-up carries the truncation flag through", () => {
  assert.equal(decideCatchup("skip_missed", [1, 2, 3], true).truncated, true);
  assert.deepEqual(decideCatchup("run_once", []).run, []);
});

test("retry backs off exponentially and then dead-letters", () => {
  const rng = () => 1; // full jitter pinned to its ceiling
  assert.deepEqual(decideRetry(0, 3, 10, rng), { retry: true, attempt: 1, delaySeconds: 10, deadLetter: false });
  assert.equal(decideRetry(1, 3, 10, rng).delaySeconds, 20);
  assert.equal(decideRetry(2, 3, 10, rng).delaySeconds, 40);
  assert.deepEqual(decideRetry(3, 3, 10, rng), { retry: false, attempt: 3, delaySeconds: 0, deadLetter: true });
});

test("retry delay is capped so a long backoff cannot outlive the schedule", () => {
  assert.equal(decideRetry(20, 30, 10, () => 1).delaySeconds, 3_600);
  assert.ok(decideRetry(0, 3, 10, () => 0).delaySeconds >= 1, "jitter never yields a zero delay");
});

test("a paused approval expires into skipped instead of hanging forever", () => {
  const paused = Date.parse("2027-01-01T00:00:00Z");
  assert.equal(decideApprovalExpiry(paused, Date.parse("2027-01-01T11:59:00Z"), 12), "still_waiting");
  assert.equal(decideApprovalExpiry(paused, Date.parse("2027-01-01T12:00:00Z"), 12), "expired");
});

test("the plan's interval floor is enforced at create time", () => {
  assert.throws(() => assertIntervalAllowed(300, 900), IntervalTooTightError);
  assert.doesNotThrow(() => assertIntervalAllowed(900, 900));
  assert.doesNotThrow(() => assertIntervalAllowed(3_600, 900));
});

test("concurrency defaults to one run per site", () => {
  assert.equal(defaultConcurrencyKey("site_abc"), "site:site_abc");
});
