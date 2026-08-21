import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOOLS,
  toolDefinition,
  toolClass,
  isDestructive,
  requiresApprovalFor,
  operationClass,
  requiresSnapshotBefore,
  referencedScopes,
  toolsForScopes,
  effectiveToolClass,
} from "../src/catalog.ts";
import { ALL_SCOPES, isKnownScope, planScopes, scopeClass } from "@bridgistic/types";

test("the catalogue covers all 54 tools the free server registers", () => {
  assert.equal(TOOLS.length, 54);
  assert.equal(new Set(TOOLS.map((t) => t.name)).size, 54, "no duplicate tool names");
});

test("every scope a tool references exists in the plugin's vocabulary", () => {
  for (const tool of TOOLS) {
    if (tool.scope === null) continue;
    assert.ok(isKnownScope(tool.scope), `${tool.name} references unknown scope ${tool.scope}`);
  }
});

test("every tool name is namespaced and snake_case", () => {
  for (const tool of TOOLS) {
    assert.match(tool.name, /^bridgistic_[a-z0-9_]+$/, tool.name);
  }
});

test("a site-touching tool always declares a route and a method", () => {
  for (const tool of TOOLS) {
    if (tool.scope === null) {
      assert.equal(tool.route, null, `${tool.name} is local but declares a route`);
      continue;
    }
    assert.ok(tool.route, `${tool.name} has a scope but no route`);
    assert.ok(tool.method, `${tool.name} has a scope but no method`);
  }
});

test("every dangerous tool is approval-gated, whatever class it sits in", () => {
  // Asserted through `requiresApprovalFor` rather than `isDestructive`: after
  // the BR-002 split, php/fs tools are `code_execution` and user management is
  // `credential`. Both are gated exactly as hard as `destructive`, and a test
  // written against the class name would have gone green while silently
  // covering three fewer tools than it used to.
  const gated = TOOLS.filter((t) => requiresApprovalFor(t.name)).map((t) => t.name).sort();
  assert.deepEqual(gated, [
    "bridgistic_create_user",
    "bridgistic_db_query",
    "bridgistic_execute_php",
    "bridgistic_fs_delete",
    "bridgistic_fs_write",
    "bridgistic_toggle_plugin",
    "bridgistic_update_user",
  ]);
  assert.deepEqual(
    TOOLS.filter((t) => isDestructive(t.name)).map((t) => t.name).sort(),
    ["bridgistic_db_query", "bridgistic_list_plugins", "bridgistic_toggle_plugin"],
    "the `destructive` class itself is now narrower than the set of gated tools"
  );
});

test("BR-015: a read route behind a writing scope keeps the scope and drops the gate", () => {
  // The plugin enforces Scopes::PLUGINS_MANAGE on GET /plugins, which lists
  // plugin names and versions. The caller must genuinely hold that scope — we
  // would otherwise admit calls the site rejects — but asking a human to
  // approve, and taking a snapshot before, reading a list is not a safety
  // control, it is a reason to stop using the product.
  assert.equal(toolDefinition("bridgistic_list_plugins")?.scope, "plugins:manage");
  assert.equal(toolClass("bridgistic_list_plugins"), "destructive", "the SCOPE is destructive");
  assert.equal(operationClass("bridgistic_list_plugins"), "sensitive_read", "the OPERATION is a read");
  assert.ok(!requiresApprovalFor("bridgistic_list_plugins"), "no approval to read a list");
  assert.ok(!requiresSnapshotBefore("bridgistic_list_plugins"), "nothing to roll back");

  // The relaxation must never reach a tool that actually writes.
  assert.ok(requiresApprovalFor("bridgistic_toggle_plugin"));
  assert.ok(requiresSnapshotBefore("bridgistic_toggle_plugin"));

  // And it must never be settable on a non-GET route.
  for (const tool of TOOLS) {
    if (tool.readOnlyOperation) {
      assert.equal(tool.method, "GET", `${tool.name} marks a ${tool.method} route as read-only`);
    }
  }
});

test("db_query is catalogued at its higher scope so a write cannot arrive as a read", () => {
  assert.equal(toolDefinition("bridgistic_db_query")?.scope, "db:write");
  assert.equal(toolClass("bridgistic_db_query"), "destructive");
});

test("a db:read-only caller may run db_query, and it counts as a read", () => {
  assert.ok(toolsForScopes(["db:read"]).includes("bridgistic_db_query"));
  assert.equal(effectiveToolClass("bridgistic_db_query", ["db:read"]), "sensitive_read");
  assert.equal(effectiveToolClass("bridgistic_db_query", ["db:read", "db:write"]), "destructive");
  assert.equal(effectiveToolClass("bridgistic_db_query", []), null, "no scope, no call");
});

test("operational and destructive tools snapshot first", () => {
  assert.ok(requiresSnapshotBefore("bridgistic_db_query"));
  assert.ok(requiresSnapshotBefore("bridgistic_update_option"));
  assert.ok(!requiresSnapshotBefore("bridgistic_list_posts"));
});

test("a Free-tier scope set cannot reach a destructive tool", () => {
  const free = toolsForScopes(planScopes("free"));
  assert.ok(free.includes("bridgistic_get_site_info"));
  assert.ok(free.includes("bridgistic_list_posts"));
  assert.ok(!planScopes("free").includes("db:write"), "Free must never hold db:write");
  assert.ok(!free.includes("bridgistic_execute_php"));
  assert.ok(!free.includes("bridgistic_create_post"), "posts:write is Starter+");
});

// BR-002. This is the regression test for the finding, so it asserts the
// property rather than the current list: any scope that ever gets classified
// `sensitive_read` is out of Free from that moment, without anyone having to
// remember to update a hard-coded set here.
test("the Free plan holds no sensitive read", () => {
  const free = planScopes("free");
  const sensitive = free.filter((s) => scopeClass(s) === "sensitive_read");
  assert.deepEqual(
    sensitive,
    [],
    `Free must not hold sensitive reads. wp-config.php lives inside ABSPATH, ` +
      `so fs:read is a credential read. Found: ${sensitive.join(", ")}`
  );
  for (const scope of ["fs:read", "db:read", "users:read", "options:read", "woo:orders:read", "woo:customers:read"]) {
    assert.ok(!free.includes(scope), `Free must not hold ${scope}`);
  }
  assert.equal(
    effectiveToolClass("bridgistic_db_query", free),
    null,
    "with no db scope at all, a Free caller cannot reach db_query by any path"
  );
});

test("an Agency scope set reaches every tool", () => {
  assert.equal(toolsForScopes(planScopes("agency")).length, TOOLS.length);
});

test("no scope in the plugin is orphaned without a tool that uses it", () => {
  const used = new Set(referencedScopes());
  const orphans = ALL_SCOPES.filter((s) => !used.has(s));
  assert.deepEqual(
    orphans,
    [],
    `these scopes can be granted but no tool consumes them: ${orphans.join(", ")}`
  );
});
