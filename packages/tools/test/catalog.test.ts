import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOOLS,
  toolDefinition,
  toolClass,
  isDestructive,
  requiresSnapshotBefore,
  referencedScopes,
  toolsForScopes,
  effectiveToolClass,
} from "../src/catalog.ts";
import { ALL_SCOPES, isKnownScope, planScopes } from "@bridgistic/types";

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

test("only the four destructive scopes produce destructive tools", () => {
  const destructive = TOOLS.filter((t) => isDestructive(t.name)).map((t) => t.name).sort();
  assert.deepEqual(destructive, [
    "bridgistic_db_query",
    "bridgistic_execute_php",
    "bridgistic_fs_delete",
    "bridgistic_fs_write",
    "bridgistic_toggle_plugin",
  ]);
});

test("db_query is catalogued at its higher scope so a write cannot arrive as a read", () => {
  assert.equal(toolDefinition("bridgistic_db_query")?.scope, "db:write");
  assert.equal(toolClass("bridgistic_db_query"), "destructive");
});

test("a db:read-only caller may run db_query, and it counts as a read", () => {
  assert.ok(toolsForScopes(["db:read"]).includes("bridgistic_db_query"));
  assert.equal(effectiveToolClass("bridgistic_db_query", ["db:read"]), "read");
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
  assert.equal(
    effectiveToolClass("bridgistic_db_query", planScopes("free")),
    "read",
    "Free holds db:read, so a SELECT is a read — but never db:write"
  );
  assert.ok(!planScopes("free").includes("db:write"), "Free must never hold db:write");
  assert.ok(!free.includes("bridgistic_execute_php"));
  assert.ok(!free.includes("bridgistic_create_post"), "posts:write is Starter+");
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
