import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCron, matchesDay, tightestIntervalSeconds, CronParseError } from "../src/cron.ts";

test("parses the common shapes", () => {
  assert.deepEqual([...parseCron("*/15 * * * *").minutes], [0, 15, 30, 45]);
  assert.deepEqual([...parseCron("0 9-17 * * *").hours], [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual([...parseCron("0 0 * * MON,WED").daysOfWeek], [1, 3]);
  assert.deepEqual([...parseCron("0 0 1 JAN,JUL *").months], [1, 7]);
  assert.deepEqual([...parseCron("@daily").minutes], [0]);
});

test("7 and 0 both mean Sunday", () => {
  assert.deepEqual([...parseCron("0 0 * * 7").daysOfWeek], [0]);
});

test("rejects what it cannot evaluate unambiguously", () => {
  for (const bad of ["* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "*/0 * * * *", "5-1 * * * *", "0 0 L * *", "abc * * * *"]) {
    assert.throws(() => parseCron(bad), CronParseError, `"${bad}" should not parse`);
  }
});

test("day-of-month and day-of-week OR together only when both are restricted", () => {
  const both = parseCron("0 0 13 * FRI");
  assert.ok(matchesDay(both, 13, 1), "13th of the month matches even on a Monday");
  assert.ok(matchesDay(both, 20, 5), "any Friday matches");
  assert.ok(!matchesDay(both, 20, 1));

  const domOnly = parseCron("0 0 13 * *");
  assert.ok(matchesDay(domOnly, 13, 1));
  assert.ok(!matchesDay(domOnly, 14, 5));

  const neither = parseCron("0 0 * * *");
  assert.ok(matchesDay(neither, 1, 0));
});

test("tightest interval is what the plan floor is checked against", () => {
  assert.equal(tightestIntervalSeconds(parseCron("*/5 * * * *")), 300);
  assert.equal(tightestIntervalSeconds(parseCron("*/15 * * * *")), 900);
  assert.equal(tightestIntervalSeconds(parseCron("0 * * * *")), 3_600);
  assert.equal(tightestIntervalSeconds(parseCron("0 2 * * *")), 86_400);
  // Wrap-around: 00:00 and 23:00 are one hour apart across midnight.
  assert.equal(tightestIntervalSeconds(parseCron("0 0,23 * * *")), 3_600);
});
