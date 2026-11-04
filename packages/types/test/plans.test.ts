import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PLANS,
  PLAN_IDS,
  planScopes,
  planEntitlements,
  effectiveScopes,
  requiresApproval,
  SCOPES,
  ALL_SCOPES,
  isKnownScope,
} from "../src/index.ts";

test("every scope has a class and no duplicates", () => {
  assert.equal(new Set(ALL_SCOPES).size, ALL_SCOPES.length);
  for (const s of SCOPES) assert.ok(s.class, `${s.scope} has no class`);
});

test("yearly price is eleven months — one month free", () => {
  for (const id of PLAN_IDS) {
    const p = PLANS[id];
    assert.equal(p.yearlyPriceCents, p.monthlyPriceCents * 11, `${id} yearly price`);
  }
});

test("a Free-tier plan cannot hold db:write", () => {
  assert.ok(!planScopes("free").includes("db:write"));
  assert.ok(!planScopes("starter").includes("db:write"));
  assert.ok(planScopes("agency").includes("db:write"));
  assert.ok(planScopes("scale").includes("db:write"));
});

test("destructive scopes always require approval, on every plan", () => {
  for (const scope of ["db:write", "fs:write", "plugins:manage", "php:execute"]) {
    assert.ok(requiresApproval(scope), `${scope} must be approval-gated`);
  }
  assert.ok(!requiresApproval("posts:read"));
});

test("effective scope = requested ∩ plan ∩ site grant", () => {
  const requested = ["posts:write", "db:write", "site:read"];
  const plan = planScopes("agency");
  const siteGrant = ["posts:write", "site:read"]; // site narrows below the plan
  assert.deepEqual(effectiveScopes({ requested: requested, planEntitled: plan, siteGranted: siteGrant }), ["posts:write", "site:read"]);
});

test("an unknown scope is dropped, not passed through", () => {
  assert.ok(!isKnownScope("root:everything"));
  assert.deepEqual(
    effectiveScopes({ requested: ["root:everything"], planEntitled: ["root:everything"], siteGranted: ["root:everything"] }),
    []
  );
});

test("plan entitlements use the bridgistic.* namespace the WPistic key resolves into", () => {
  const e = planEntitlements("agency");
  assert.equal(e["bridgistic.sites.max"], 25);
  assert.equal(e["bridgistic.actions.monthly"], 100_000);
  assert.equal(e["bridgistic.php_execute.enabled"], true);
  assert.equal(planEntitlements("starter")["bridgistic.php_execute.enabled"], false);
  assert.equal(planEntitlements("scale")["bridgistic.sites.max"], null, "unlimited is null");
  for (const key of Object.keys(e)) {
    assert.ok(key.startsWith("bridgistic."), `${key} is not namespaced`);
  }
});
