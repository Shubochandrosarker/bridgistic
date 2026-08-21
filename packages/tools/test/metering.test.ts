import { test } from "node:test";
import assert from "node:assert/strict";
import { actionsConsumed, evaluateQuota, admitCall, ACTION_WEIGHTS } from "../src/metering.ts";
import { canonicalJson, requestDigest, defaultIdempotencyKey } from "../src/digest.ts";
import { planScopes } from "@bridgistic/types";

test("the customer is never billed for our refusal or our failure to start", () => {
  for (const outcome of ["denied", "rate_limited", "pending_approval"] as const) {
    assert.equal(actionsConsumed("bridgistic_execute_php", outcome), 0, outcome);
  }
});

test("a call that reached the site and failed still costs the read rate", () => {
  assert.equal(actionsConsumed("bridgistic_execute_php", "failed"), 1);
});

test("writes cost more than reads because they cost us more", () => {
  assert.equal(actionsConsumed("bridgistic_list_posts", "success"), ACTION_WEIGHTS.safe_read);
  assert.equal(actionsConsumed("bridgistic_create_post", "success"), ACTION_WEIGHTS.content_write);
  assert.equal(actionsConsumed("bridgistic_update_option", "success"), ACTION_WEIGHTS.operational);
  assert.equal(actionsConsumed("bridgistic_execute_php", "success"), ACTION_WEIGHTS.destructive);
});

test("a platform-local tool is free", () => {
  assert.equal(actionsConsumed("bridgistic_list_sites", "success"), 0);
});

test("a SELECT on a read-only key is priced as a read, not as a destructive write", () => {
  // Starter is the cheapest plan that holds `db:read` at all — BR-002 took the
  // sensitive reads off Free — so it is the plan that exercises this path.
  assert.equal(
    actionsConsumed("bridgistic_db_query", "success", ["db:read"]),
    ACTION_WEIGHTS.sensitive_read
  );
  assert.equal(actionsConsumed("bridgistic_db_query", "success", planScopes("agency")), ACTION_WEIGHTS.destructive);
  assert.equal(actionsConsumed("bridgistic_db_query", "success"), ACTION_WEIGHTS.destructive, "worst case when unknown");
});

test("a sensitive read costs more than a safe one", () => {
  assert.ok(
    ACTION_WEIGHTS.sensitive_read > ACTION_WEIGHTS.safe_read,
    "pricing exfiltration at the safe-read rate hands an attacker a quota rather than a deterrent"
  );
});

test("quota soft-limits at 80% and hard-limits at 100%", () => {
  const periodEnd = Date.parse("2027-02-01T00:00:00Z");
  assert.equal(evaluateQuota(0, 10_000, periodEnd).state, "ok");
  assert.equal(evaluateQuota(7_999, 10_000, periodEnd).state, "ok");
  assert.equal(evaluateQuota(8_000, 10_000, periodEnd).state, "soft_limit");
  const hard = evaluateQuota(10_000, 10_000, periodEnd);
  assert.equal(hard.state, "hard_limit");
  assert.equal(hard.remaining, 0);
  assert.equal(hard.resetAt, periodEnd, "the 429 needs X-Bridgistic-Quota-Reset");
});

test("a multi-action call cannot straddle the limit", () => {
  assert.deepEqual(admitCall("bridgistic_execute_php", 9_996, 10_000), { admitted: false, cost: 5 });
  assert.deepEqual(admitCall("bridgistic_execute_php", 9_995, 10_000), { admitted: true, cost: 5 });
  assert.deepEqual(admitCall("bridgistic_list_posts", 9_999, 10_000), { admitted: true, cost: 1 });
});

test("canonical JSON is key-order independent so a digest is stable", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.equal(canonicalJson({ a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4}}');
  assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]", "array order is meaningful and preserved");
});

test("canonicalisation refuses values JSON would silently mangle", () => {
  assert.throws(() => canonicalJson({ n: NaN }), TypeError);
  assert.throws(() => canonicalJson({ n: Infinity }), TypeError);
  assert.throws(() => canonicalJson({ f: () => 1 }), TypeError);
});

test("the log stores a digest, never the arguments", async () => {
  const secretish = { sql: "SELECT email FROM wp_users WHERE id = 1" };
  const digest = await requestDigest("bridgistic_db_query", secretish);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.ok(!digest.includes("email"));
  assert.equal(digest, await requestDigest("bridgistic_db_query", { sql: secretish.sql }));
  assert.notEqual(digest, await requestDigest("bridgistic_db_query", { sql: "SELECT 1" }));
  assert.notEqual(digest, await requestDigest("bridgistic_execute_php", secretish), "the tool is part of the digest");
});

test("the same call from the same org retries idempotently; a different org does not collide", async () => {
  const a = await defaultIdempotencyKey("org_1", "site_1", "bridgistic_create_post", { title: "Hi" });
  const b = await defaultIdempotencyKey("org_1", "site_1", "bridgistic_create_post", { title: "Hi" });
  const c = await defaultIdempotencyKey("org_2", "site_1", "bridgistic_create_post", { title: "Hi" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});
