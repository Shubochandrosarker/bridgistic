import { test } from "node:test";
import assert from "node:assert/strict";
import { allContracts, contractFor, contractsFor, CONTRACT_VERSION } from "../src/registry.ts";
import { FORBIDDEN_PARAM_NAMES } from "../src/params.ts";
import { compileSchema } from "../src/json-schema.ts";
import { TOOLS } from "@bridgistic/tools";
import {
  PLAN_IDS,
  planScopes,
  scopeClass,
  requiresApproval,
  requiresSnapshot,
  requiresStepUp,
  requiresApprovalForClass,
  requiresStepUpForClass,
  snapshotOperationClass,
  atLeastAsRisky,
} from "@bridgistic/types";
import type { ScopeClass } from "@bridgistic/types";

test("every catalogued tool has a contract, and nothing extra does", () => {
  const contracts = allContracts();
  assert.equal(contracts.length, TOOLS.length, "one contract per tool, no more, no fewer");
  assert.equal(contracts.length, 54, "the surface is 54 tools");
  for (const tool of TOOLS) {
    assert.ok(contractFor(tool.name), `${tool.name} has no contract`);
  }
});

test("every input schema compiles under the validator that will enforce it", () => {
  // The registry compiles at module load, so reaching this line already proves
  // it. Asserting again makes the failure legible when it happens.
  for (const contract of allContracts()) {
    assert.doesNotThrow(() => compileSchema(contract.inputSchema, contract.name));
  }
});

test("no contract declares a server-derived or bypass argument", () => {
  for (const contract of allContracts()) {
    for (const name of Object.keys(contract.inputSchema.properties ?? {})) {
      assert.ok(
        !(name in FORBIDDEN_PARAM_NAMES),
        `${contract.name} declares "${name}": ${FORBIDDEN_PARAM_NAMES[name]}`
      );
    }
  }
});

test("BR-013: no tool accepts a caller-settable safety bypass", () => {
  // The pinned engine's guardParams carried `force`, documented as "Bypass the
  // snapshot-required abort (irreversible)". On the hosted platform the thing
  // filling in that argument is a language model working from a prompt that
  // may have come from a web page. A gate an argument can switch off is not a
  // gate.
  for (const contract of allContracts()) {
    const props = Object.keys(contract.inputSchema.properties ?? {});
    assert.ok(!props.includes("force"), `${contract.name} still accepts force`);
    assert.ok(!props.includes("skip_snapshot"), `${contract.name} accepts skip_snapshot`);
  }
});

test("every object schema refuses unknown properties", () => {
  // An argument we silently drop makes a call look like it did what was asked.
  for (const contract of allContracts()) {
    assert.equal(
      contract.inputSchema.additionalProperties,
      false,
      `${contract.name} would accept and discard unknown arguments`
    );
  }
});

test("policy fields are derived from the scope model, never hand-written", () => {
  for (const contract of allContracts()) {
    const scope = contract.requiredScopes[0];
    if (scope === undefined) {
      // Platform-local: touches no site, so nothing to gate or meter.
      assert.equal(contract.riskClass, "local");
      assert.equal(contract.requiresApproval, false);
      assert.equal(contract.requiresSnapshot, false);
      assert.equal(contract.meterUnit, "none");
      continue;
    }
    const tool = TOOLS.find((t) => t.name === contract.name)!;
    if (tool.readOnlyOperation) {
      // BR-015: the scope stays, the gate goes. Asserted explicitly so the
      // exception cannot spread quietly to a tool that writes.
      assert.equal(tool.method, "GET", `${contract.name} relaxes the gate on a ${tool.method} route`);
      assert.equal(contract.requiresApproval, false);
      assert.equal(contract.requiresSnapshot, false);
      assert.equal(contract.requiresStepUp, false);
      assert.deepEqual(contract.requiredScopes, [scope], "authorisation still demands the plugin's scope");
    } else if (tool.snapshotOperation !== undefined) {
      // SECURITY_MODEL §4: one scope name, three risks. The gate comes from
      // the OPERATION's class, and that class still comes from the scope model
      // via snapshotOperationClass — so this is a different derivation, not a
      // hand-written exception. Asserted against the same function the registry
      // uses, and separately asserted to only ever tighten.
      const operationClass = snapshotOperationClass(
        tool.snapshotOperation === "list" ? "create" : tool.snapshotOperation
      );
      const expected = atLeastAsRisky(operationClass, scopeClass(scope)!) ? operationClass : scopeClass(scope)!;

      assert.equal(contract.riskClass, expected, `${contract.name} class`);
      assert.equal(contract.requiresApproval, requiresApprovalForClass(expected), `${contract.name} approval`);
      assert.equal(contract.requiresStepUp, requiresStepUpForClass(expected), `${contract.name} step-up`);
      assert.ok(
        atLeastAsRisky(expected, scopeClass(scope)!),
        `${contract.name} lowered the class its scope carries`
      );
      // Only a restore snapshots first; see the dedicated test for why.
      assert.equal(contract.requiresSnapshot, tool.snapshotOperation === "restore", `${contract.name} snapshot`);
    } else {
      assert.equal(contract.riskClass, scopeClass(scope), `${contract.name} class`);
      assert.equal(contract.requiresApproval, requiresApproval(scope), `${contract.name} approval`);
      assert.equal(contract.requiresSnapshot, requiresSnapshot(scope), `${contract.name} snapshot`);
      assert.equal(contract.requiresStepUp, requiresStepUp(scope), `${contract.name} step-up`);
    }
    assert.equal(contract.meterUnit, "action");
  }
});

test("enabledPlans matches what the plan actually entitles", () => {
  for (const contract of allContracts()) {
    for (const plan of PLAN_IDS) {
      const held = new Set(planScopes(plan));
      const entitled =
        contract.requiredScopes.length === 0 ||
        contract.requiredScopes.every((s) => held.has(s)) ||
        (contract.minScope !== undefined && held.has(contract.minScope));
      assert.equal(
        contract.enabledPlans.includes(plan),
        entitled,
        `${contract.name} on ${plan}: enabledPlans disagrees with the plan catalogue`
      );
    }
  }
});

test("BR-002 holds at the contract layer too", () => {
  // Same property as the scope test, asserted where a client actually reads
  // it. A tool being off the plan is what stops it appearing in tools/list.
  const free = allContracts().filter((c) => c.enabledPlans.includes("free"));
  for (const contract of free) {
    assert.notEqual(
      contract.riskClass,
      "sensitive_read",
      `${contract.name} is offered on Free and reads sensitive data`
    );
    assert.ok(!contract.requiresApproval, `${contract.name} is on Free and is approval-gated`);
  }
  for (const name of ["bridgistic_fs_read", "bridgistic_db_query", "bridgistic_list_users", "bridgistic_woo_get_order"]) {
    assert.ok(
      !contractFor(name)!.enabledPlans.includes("free"),
      `${name} must not be offered on Free`
    );
  }
});

test("every timeout is bounded and proportionate to the risk", () => {
  for (const contract of allContracts()) {
    assert.ok(contract.timeoutMs > 0, `${contract.name} has no timeout`);
    assert.ok(
      contract.timeoutMs <= 300_000,
      `${contract.name} would hold a connection for ${contract.timeoutMs}ms`
    );
    if (contract.riskClass === "safe_read") {
      assert.ok(contract.timeoutMs <= 15_000, `${contract.name} is a read and waits ${contract.timeoutMs}ms`);
    }
  }
});

test("tools with unbounded side effects are never auto-retried", () => {
  // Replaying arbitrary PHP, a raw SQL statement or a snapshot restore is not
  // idempotent and cannot be made so from outside.
  for (const name of [
    "bridgistic_execute_php",
    "bridgistic_db_query",
    "bridgistic_fs_write",
    "bridgistic_snapshot_restore",
    "bridgistic_playbook_run",
  ]) {
    assert.equal(
      contractFor(name)!.supportsIdempotency,
      false,
      `${name} must not be replayable — the executor would repeat its side effects`
    );
  }
});

test("contractsFor narrows by plan AND by site grant", () => {
  const starterScopes = planScopes("starter");

  // Holding the plan but granting nothing on this site yields only the
  // platform-local tools.
  const noGrants = contractsFor("starter", []);
  assert.ok(noGrants.every((c) => c.requiredScopes.length === 0), "a site with no grants exposes no site tools");
  assert.ok(noGrants.some((c) => c.name === "bridgistic_list_sites"));

  // Granting on the site but on a plan that does not carry the scope is also
  // a denial — the grant cannot widen the plan.
  const overGranted = contractsFor("free", starterScopes);
  assert.ok(
    overGranted.every((c) => c.enabledPlans.includes("free")),
    "a site grant must not reach past the plan"
  );
  assert.ok(!overGranted.some((c) => c.name === "bridgistic_create_post"));

  const full = contractsFor("starter", starterScopes);
  assert.ok(full.some((c) => c.name === "bridgistic_create_post"));
  assert.ok(full.length > noGrants.length);
});

test("every contract carries a version and a description a model can act on", () => {
  for (const contract of allContracts()) {
    assert.equal(contract.version, CONTRACT_VERSION);
    assert.ok(
      contract.description.length >= 40,
      `${contract.name} description is too thin to be a useful prompt: "${contract.description}"`
    );
    // The description is what the model reads to decide whether to call the
    // tool. A gated tool that does not say so gets called and refused, which
    // costs a turn and teaches the model nothing.
    if (contract.requiresApproval) {
      assert.ok(
        /approval|approver/i.test(contract.description),
        `${contract.name} needs approval but its description does not say so`
      );
    }
  }
});

// ------------------------------------------------- snapshot operations ------

test("the three snapshot operations are gated separately, per SECURITY_MODEL §4", () => {
  // `snapshot:manage` is classed `operational`, and for two of the operations
  // that is wrong. Restoring silently discards every change made since the
  // snapshot was taken; deleting removes the rollback path the destructive and
  // code_execution gates depend on being there. Gating both as `operational`
  // leaves them behind nothing but holding the scope.
  const restore = contractFor("bridgistic_snapshot_restore")!;
  const remove = contractFor("bridgistic_snapshot_delete")!;

  for (const contract of [restore, remove]) {
    assert.equal(contract.riskClass, "destructive", `${contract.name} is not destructive`);
    assert.equal(contract.requiresApproval, true, `${contract.name} runs without approval`);
    assert.equal(contract.requiresStepUp, true, `${contract.name} runs without step-up`);
  }

  // Restore takes a snapshot of the CURRENT state first, so a mistaken restore
  // is itself reversible. §4 requires exactly this.
  assert.equal(restore.requiresSnapshot, true, "a restore is not itself reversible");
});

test("creating and listing snapshots do not snapshot first", () => {
  // Snapshotting before `create` would snapshot the site in order to snapshot
  // the site. Before `delete` it would preserve the site, which is not the
  // thing being destroyed. Both are storage cost with no rollback value.
  assert.equal(contractFor("bridgistic_snapshot_create")!.requiresSnapshot, false);
  assert.equal(contractFor("bridgistic_snapshot_delete")!.requiresSnapshot, false);

  // Listing is a GET behind a writing scope — the BR-015 shape. The caller
  // must hold the scope, but nothing changes, so there is nothing to approve,
  // snapshot or re-authenticate for.
  const list = contractFor("bridgistic_snapshot_list")!;
  assert.equal(list.requiresApproval, false);
  assert.equal(list.requiresSnapshot, false);
  assert.equal(list.requiresStepUp, false);
});

test("a snapshot operation can only raise the class its scope carries", () => {
  // The override exists to tighten a gate that the scope name under-states. If
  // it could lower one, it would be the per-tool judgement call BR-013 removed
  // — a field that turns a gate off for one tool.
  const create = contractFor("bridgistic_snapshot_create")!;
  assert.ok(
    atLeastAsRisky(create.riskClass as ScopeClass, scopeClass("snapshot:manage")!),
    "the create operation lowered its scope's class"
  );
});
