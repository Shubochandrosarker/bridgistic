import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextCronRun,
  nextIntervalRun,
  nextOnceRun,
  missedRuns,
} from "../src/next-run.ts";
import { isValidTimeZone, fromWallClock, zoneOffsetMs } from "../src/timezone.ts";

const at = (iso: string): number => Date.parse(iso);
const shows = (ms: number): string => new Date(ms).toISOString();

test("a daily job stays pinned to its local hour, not to a UTC offset", () => {
  // Asia/Dhaka is +06:00 year round: 02:00 local is 20:00Z the day before.
  assert.equal(
    shows(nextCronRun("0 2 * * *", "Asia/Dhaka", at("2027-01-01T00:00:00Z"))),
    "2027-01-01T20:00:00.000Z"
  );
});

test("a zone with a non-hour offset is handled exactly", () => {
  // Asia/Kathmandu is +05:45. Getting this wrong by rounding to the hour is a
  // 15-minute drift nobody notices until a customer reports it.
  assert.equal(
    shows(nextCronRun("0 2 * * *", "Asia/Kathmandu", at("2027-01-01T00:00:00Z"))),
    "2027-01-01T20:15:00.000Z"
  );
});

test("spring forward: a local time that never happens is skipped, not shifted", () => {
  // America/New_York jumps 02:00 -> 03:00 on 2027-03-14, so 02:30 does not
  // exist that day. The job must skip to the 15th at 02:30 EDT (= 06:30Z),
  // NOT silently fire at 03:30 local.
  assert.deepEqual(
    fromWallClock({ year: 2027, month: 3, day: 14, hour: 2, minute: 30, second: 0 }, "America/New_York"),
    [],
    "02:30 on 2027-03-14 should not exist"
  );
  assert.equal(
    shows(nextCronRun("30 2 * * *", "America/New_York", at("2027-03-13T12:00:00Z"))),
    "2027-03-15T06:30:00.000Z"
  );
});

test("fall back: an hour that happens twice fires the job once", () => {
  // 2027-11-07 01:30 occurs at 05:30Z (EDT) and again at 06:30Z (EST).
  const both = fromWallClock(
    { year: 2027, month: 11, day: 7, hour: 1, minute: 30, second: 0 },
    "America/New_York"
  );
  assert.equal(both.length, 2, "01:30 should be ambiguous on fall-back day");

  const first = nextCronRun("30 1 * * *", "America/New_York", at("2027-11-06T12:00:00Z"));
  assert.equal(shows(first), "2027-11-07T05:30:00.000Z", "takes the earlier occurrence");

  const afterFirst = nextCronRun("30 1 * * *", "America/New_York", first);
  assert.equal(shows(afterFirst), "2027-11-08T06:30:00.000Z", "does not fire again the same day");
});

test("southern-hemisphere DST is handled the same way", () => {
  // Australia/Adelaide (+09:30 / +10:30) springs forward 02:00 -> 03:00 on
  // 2027-10-03, so 02:30 is skipped and the next run is the 4th at +10:30.
  assert.equal(
    shows(nextCronRun("30 2 * * *", "Australia/Adelaide", at("2027-10-02T00:00:00Z"))),
    "2027-10-03T16:00:00.000Z"
  );
});

test("a year of daily runs never drifts off the local hour", () => {
  let cursor = at("2027-01-01T00:00:00Z");
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  });
  for (let i = 0; i < 365; i++) {
    cursor = nextCronRun("0 9 * * *", "America/New_York", cursor);
    assert.equal(fmt.format(cursor), "09:00", `drifted on iteration ${i} (${shows(cursor)})`);
  }
});

test("interval schedules stay anchored instead of creeping", () => {
  const anchor = at("2027-01-01T00:00:00Z");
  assert.equal(shows(nextIntervalRun(300, anchor, at("2027-01-01T00:07:30Z"))), "2027-01-01T00:10:00.000Z");
  // Exactly on a boundary returns the NEXT tick, never the current one.
  assert.equal(shows(nextIntervalRun(300, anchor, at("2027-01-01T00:10:00Z"))), "2027-01-01T00:15:00.000Z");
  assert.equal(shows(nextIntervalRun(300, anchor, at("2026-12-31T00:00:00Z"))), "2027-01-01T00:00:00.000Z");
});

test("a once job fires once", () => {
  const t = at("2027-05-01T10:00:00Z");
  assert.equal(nextOnceRun(t, at("2027-05-01T09:00:00Z")), t);
  assert.equal(nextOnceRun(t, t), null);
});

test("missed runs are enumerated exclusive of the start, inclusive of the end", () => {
  const { ticks, truncated } = missedRuns(
    "*/5 * * * *",
    "UTC",
    at("2027-01-01T00:00:00Z"),
    at("2027-01-01T02:00:00Z")
  );
  assert.equal(ticks.length, 24);
  assert.equal(shows(ticks[0]!), "2027-01-01T00:05:00.000Z");
  assert.equal(shows(ticks.at(-1)!), "2027-01-01T02:00:00.000Z");
  assert.equal(truncated, false);
});

test("the missed-run scan reports when it hit its cap", () => {
  const { ticks, truncated } = missedRuns(
    "*/5 * * * *",
    "UTC",
    at("2027-01-01T00:00:00Z"),
    at("2027-01-02T00:00:00Z"),
    10
  );
  assert.equal(ticks.length, 10);
  assert.equal(truncated, true, "silent truncation reads as 'we caught everything up'");
});

test("an unknown time zone is rejected up front", () => {
  assert.ok(!isValidTimeZone("Mars/Olympus_Mons"));
  assert.ok(!isValidTimeZone("UTC+06:00"), "a fixed offset is not a zone and would drift");
  assert.ok(isValidTimeZone("Asia/Dhaka"));
  assert.throws(() => nextCronRun("0 2 * * *", "Mars/Olympus_Mons", Date.now()), RangeError);
});

test("offsets are read from the zone, never assumed to be whole hours", () => {
  assert.equal(zoneOffsetMs(at("2027-01-01T00:00:00Z"), "Asia/Kathmandu"), 5.75 * 3_600_000);
  assert.equal(zoneOffsetMs(at("2027-01-01T00:00:00Z"), "Australia/Adelaide"), 10.5 * 3_600_000);
});
