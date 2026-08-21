/**
 * The invariants in SECURITY_MODEL.md, asserted rather than described.
 *
 * These are properties, not examples. A test that lists today's sensitive
 * scopes passes forever after somebody adds tomorrow's — so where it can, this
 * file asserts the rule and lets the data be whatever it is.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCOPES,
  SCOPE_CLASSES,
  ALL_SCOPES,
  scopeClass,
  atLeastAsRisky,
  requiresApproval,
  requiresSnapshot,
  requiresStepUp,
  allowedForMachineToken,
  snapshotOperationClass,
  effectiveScopes,
  isKnownScope,
  rollbackMechanism,
  isMutating,
} from "../src/scopes.ts";
import { PLANS, PLAN_IDS, planScopes } from "../src/plans.ts";

// --------------------------------------------------------------- default deny

test("effective scope is an intersection and can never widen", () => {
  const requested = ["posts:read", "php:execute", "db:write"];
  const plan = ["posts:read", "php:execute"];
  const site = ["posts:read"];

  assert.deepEqual(
    effectiveScopes(requested, plan, site),
    ["posts:read"],
    "the narrowest term wins; asking for more must not produce more"
  );

  // Each term alone is enough to deny.
  assert.deepEqual(effectiveScopes(requested, [], site), []);
  assert.deepEqual(effectiveScopes(requested, plan, []), []);
  assert.deepEqual(effectiveScopes([], plan, site), []);
});

test("an unknown scope is dropped, never forwarded", () => {
  // If an invented name could survive the intersection, a client could start
  // naming scopes a future plugin version might honour.
  const invented = "posts:superuser";
  assert.ok(!isKnownScope(invented));
  assert.deepEqual(effectiveScopes([invented], [invented], [invented]), []);
});

test("no plan grants a scope the vocabulary does not define", () => {
  for (const plan of PLAN_IDS) {
    for (const scope of planScopes(plan)) {
      assert.ok(isKnownScope(scope), `plan ${plan} grants unknown scope ${scope}`);
    }
  }
});

// ------------------------------------------------------------------- BR-002

test("the Free plan holds no scope above safe_read", () => {
  const free = planScopes("free");
  assert.ok(free.length > 0, "Free is not empty — it is limited, not useless");
  for (const scope of free) {
    assert.equal(
      scopeClass(scope),
      "safe_read",
      `Free must hold safe_read only; ${scope} is ${scopeClass(scope)}`
    );
  }
});

test("the specific scopes that made BR-002 critical are off the Free plan", () => {
  // Named explicitly as well as by property, because these are the six that
  // made the finding critical and a future refactor should have to argue with
  // each of them individually.
  const free = new Set(planScopes("free"));
  const forbidden = {
    "fs:read": "reads inside ABSPATH, where wp-config.php holds the DB credentials and auth salts",
    "db:read": "unbounded SELECT over every table",
    "users:read": "user PII",
    "options:read": "wp_options can hold third-party API keys",
    "woo:orders:read": "customer PII",
    "woo:customers:read": "customer PII",
  };
  for (const [scope, why] of Object.entries(forbidden)) {
    assert.ok(!free.has(scope), `Free must not hold ${scope}: ${why}`);
  }
});

test("plans are monotonic — a plan holding a class holds every safer class", () => {
  for (const plan of PLAN_IDS) {
    const held = PLANS[plan].scopeClasses;
    const riskiest = held.reduce((a, b) => (atLeastAsRisky(a, b) ? a : b), held[0]!);
    for (const cls of SCOPE_CLASSES) {
      if (atLeastAsRisky(riskiest, cls)) {
        assert.ok(
          held.includes(cls),
          `plan ${plan} holds ${riskiest} but not the safer ${cls} — a gap in the ladder ` +
            `means a customer can do something dangerous but not the safe version of it`
        );
      }
    }
  }
});

// ------------------------------------------------------------------- gating

test("every scope has exactly one class, and every class is reachable", () => {
  for (const scope of ALL_SCOPES) {
    assert.ok(scopeClass(scope) !== undefined, `${scope} has no class`);
  }
  for (const cls of SCOPE_CLASSES) {
    assert.ok(
      SCOPES.some((s) => s.class === cls),
      `class ${cls} has no scopes — a class nothing uses is a gate nothing passes through`
    );
  }
});

test("destructive, credential and code_execution are approval + snapshot + step-up gated", () => {
  for (const { scope, class: cls } of SCOPES) {
    const gated = cls === "destructive" || cls === "credential" || cls === "code_execution";
    assert.equal(requiresApproval(scope), gated, `${scope} approval gate`);
    assert.equal(requiresStepUp(scope), gated, `${scope} step-up gate`);
    if (gated) {
      assert.ok(requiresSnapshot(scope), `${scope} must snapshot before it runs`);
    }
  }
});

test("no read scope is ever approval-gated", () => {
  for (const { scope, class: cls } of SCOPES) {
    if (cls !== "safe_read" && cls !== "sensitive_read") continue;
    assert.ok(requiresApproval(scope) === false, `${scope} is a read; gating it trains people to click through`);
    assert.ok(requiresSnapshot(scope) === false, `${scope} is a read; there is nothing to roll back`);
    assert.equal(rollbackMechanism(scope), "none_needed");
    assert.ok(!isMutating(scope));
  }
});

test("every mutating scope has a rollback path, and it is proportionate", () => {
  // The rule is "a way back", not "a snapshot". Requiring a full snapshot
  // before every post edit would make ordinary content work unusable, and a
  // safety control people switch off protects nobody.
  for (const { scope, class: cls } of SCOPES) {
    if (cls === "safe_read" || cls === "sensitive_read") continue;

    const mechanism = rollbackMechanism(scope);
    assert.notEqual(mechanism, undefined, `${scope} has no rollback mechanism`);
    assert.notEqual(
      mechanism,
      "none_needed",
      `${scope} mutates the site — a change with no way back should not be reachable through an API`
    );
    assert.ok(isMutating(scope));

    if (cls === "content_write") {
      assert.equal(mechanism, "object_revision", `${scope} is reversible per object, not per site`);
      assert.ok(!requiresSnapshot(scope), `${scope} must not force a full snapshot`);
    } else {
      assert.equal(mechanism, "snapshot", `${scope} can change more than one object; only a snapshot covers it`);
      assert.ok(requiresSnapshot(scope));
    }
  }
});

test("a machine token cannot hold a scope whose gate needs a human", () => {
  for (const { scope, class: cls } of SCOPES) {
    if (cls === "credential") {
      assert.ok(
        !allowedForMachineToken(scope),
        `${scope} is a persistence primitive; an unattended key holding it is a backdoor`
      );
    } else {
      assert.ok(allowedForMachineToken(scope), `${scope} should be usable by a service account`);
    }
  }
});

test("snapshot restore and delete are destructive; only create is operational", () => {
  assert.equal(snapshotOperationClass("create"), "operational");
  assert.equal(
    snapshotOperationClass("restore"),
    "destructive",
    "a restore silently discards every change since the snapshot"
  );
  assert.equal(
    snapshotOperationClass("delete"),
    "destructive",
    "deleting a snapshot removes the rollback path other gates depend on"
  );
});

test("no plan can turn a gate off", () => {
  // INVARIANT 3. There is no tier, and no combination of entitlements, under
  // which a destructive call skips approval — including on the plan that pays
  // the most, which is exactly where the pressure to make an exception comes
  // from.
  for (const plan of PLAN_IDS) {
    for (const scope of planScopes(plan)) {
      const cls = scopeClass(scope);
      if (cls === "destructive" || cls === "credential" || cls === "code_execution") {
        assert.ok(requiresApproval(scope), `${plan} + ${scope} skipped approval`);
        assert.ok(requiresStepUp(scope), `${plan} + ${scope} skipped step-up`);
      }
    }
  }
});
