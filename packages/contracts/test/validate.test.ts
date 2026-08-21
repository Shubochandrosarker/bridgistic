/**
 * `assertCallable` is the single gate every surface goes through. If it is
 * wrong, it is wrong for MCP, the API and the scheduler simultaneously — so
 * these tests are mostly about what it must REFUSE.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCallable, validateToolInput, mcpToolDescriptors } from "../src/validate.ts";
import type { CallerContext } from "../src/validate.ts";
import { contractsFor, contractFor, allContracts } from "../src/registry.ts";
import { planScopes } from "@bridgistic/types";

/** An Agency caller who has been granted everything and cleared step-up. */
function caller(overrides: Partial<CallerContext> = {}): CallerContext {
  const scopes = planScopes("agency");
  return {
    organizationId: "org_1",
    actorId: "usr_1",
    isMachineToken: false,
    plan: "agency",
    planScopes: scopes,
    siteScopes: scopes,
    stepUpSatisfied: true,
    grantedApprovals: [],
    codeExecutionOptIn: true,
    ...overrides,
  };
}

const KEY = "idem-00000001";

// --------------------------------------------------------------- happy path

test("a fully entitled caller with valid arguments is admitted", () => {
  const verdict = assertCallable("bridgistic_list_posts", { site: "shop", per_page: 10 }, caller());
  assert.equal(verdict.ok, true);
});

test("a write is admitted once it carries an idempotency key", () => {
  const verdict = assertCallable(
    "bridgistic_create_post",
    { site: "shop", title: "Hello", idempotency_key: KEY },
    caller()
  );
  assert.equal(verdict.ok, true);
});

// ------------------------------------------------------------------ denials

test("an unknown tool is not_found", () => {
  const verdict = assertCallable("bridgistic_take_over_the_world", {}, caller());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.code, "not_found");
});

test("a tool off the plan is plan_required, distinctly from forbidden", () => {
  // The distinction matters to a person: one is fixable by upgrading and the
  // other is not, and showing "forbidden" for both sends someone to support
  // when they wanted a pricing page.
  const free = caller({ plan: "free", planScopes: planScopes("free"), siteScopes: planScopes("free") });
  const verdict = assertCallable("bridgistic_create_post", { site: "shop", idempotency_key: KEY }, free);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.code, "plan_required");
});

test("BR-002: a Free caller cannot read the site's files or database", () => {
  const free = caller({ plan: "free", planScopes: planScopes("free"), siteScopes: planScopes("free") });
  for (const [name, args] of [
    ["bridgistic_fs_read", { site: "shop", path: "wp-config.php" }],
    ["bridgistic_db_query", { site: "shop", sql: "SELECT user_pass FROM wp_users", idempotency_key: KEY }],
    ["bridgistic_list_users", { site: "shop" }],
    ["bridgistic_woo_list_customers", { site: "shop" }],
  ] as const) {
    const verdict = assertCallable(name, args, free);
    assert.equal(verdict.ok, false, `${name} was admitted on Free`);
  }
});

test("the site grant narrows the plan and can never widen it", () => {
  // Plan says yes, site says no.
  const noGrant = assertCallable(
    "bridgistic_create_post",
    { site: "shop", idempotency_key: KEY },
    caller({ siteScopes: ["posts:read"] })
  );
  assert.equal(noGrant.ok, false);
  assert.equal(noGrant.ok === false && noGrant.code, "scope_denied");

  // Site says yes, plan says no. The grant must not rescue it.
  const overGrant = assertCallable(
    "bridgistic_execute_php",
    { site: "shop", code: "return 1;", idempotency_key: KEY },
    caller({ plan: "free", planScopes: planScopes("free"), siteScopes: ["php:execute"] })
  );
  assert.equal(overGrant.ok, false);
});

test("BR-010: a scope the plugin's key does not carry is refused", () => {
  // Plan says yes, the organization granted it, and the key the site minted
  // does not include it. Admitting the call would send a request the plugin
  // rejects, and meter the customer for it.
  const verdict = assertCallable(
    "bridgistic_create_post",
    { site: "shop", title: "x", idempotency_key: KEY },
    caller({ keyScopes: ["posts:read"] })
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.code, "scope_denied");

  // With the key carrying it, the same call goes through.
  assert.equal(
    assertCallable(
      "bridgistic_create_post",
      { site: "shop", title: "x", idempotency_key: KEY },
      caller({ keyScopes: ["posts:read", "posts:write"] })
    ).ok,
    true
  );
});

test("organization policy can disable a tool the plan and grant both allow", () => {
  const verdict = assertCallable(
    "bridgistic_execute_php",
    { site: "shop", code: "return 1;", idempotency_key: KEY },
    caller({ disabledTools: ["bridgistic_execute_php"] })
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.code, "forbidden");
});

// -------------------------------------------------------------------- gates

test("a destructive call without an approval is refused, and says how to proceed", () => {
  const verdict = assertCallable(
    "bridgistic_toggle_plugin",
    { site: "shop", plugin: "woocommerce/woocommerce.php", state: "deactivate", idempotency_key: KEY },
    caller()
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.code, "approval_required");
  assert.match(verdict.ok === false ? verdict.message : "", /approval_id/);
});

test("an approval_id the caller was not granted does not satisfy the gate", () => {
  // Otherwise the gate is "produce a plausible string", which a model is
  // extremely good at.
  const verdict = assertCallable(
    "bridgistic_toggle_plugin",
    {
      site: "shop",
      plugin: "w/w.php",
      state: "activate",
      approval_id: "approval-i-made-up",
      idempotency_key: KEY,
    },
    caller({ grantedApprovals: ["approval-a-real-one"] })
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.code, "approval_required");
});

test("a granted approval admits the call", () => {
  const verdict = assertCallable(
    "bridgistic_toggle_plugin",
    { site: "shop", plugin: "w/w.php", state: "activate", approval_id: "approval-real-1", idempotency_key: KEY },
    caller({ grantedApprovals: ["approval-real-1"] })
  );
  assert.equal(verdict.ok, true);
});

test("step-up is required even when the approval is in hand", () => {
  const verdict = assertCallable(
    "bridgistic_toggle_plugin",
    { site: "shop", plugin: "w/w.php", state: "activate", approval_id: "approval-stepup-1", idempotency_key: KEY },
    caller({ stepUpSatisfied: false, grantedApprovals: ["approval-stepup-1"] })
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.code, "step_up_required");
});

test("BR-013: there is no argument that turns a gate off", () => {
  // The pinned engine accepted `force: true` to skip the snapshot abort. If
  // anything like it comes back, the schema rejects it before policy runs.
  const verdict = assertCallable(
    "bridgistic_toggle_plugin",
    { site: "shop", plugin: "w/w.php", state: "activate", force: true, idempotency_key: KEY },
    caller()
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.code, "invalid_request");
});

test("a machine token cannot create or change a WordPress user", () => {
  const bot = caller({ isMachineToken: true });
  for (const [name, args] of [
    ["bridgistic_create_user", { site: "shop", login: "x", email: "x@y.co", idempotency_key: KEY }],
    ["bridgistic_update_user", { site: "shop", id: 1, role: "administrator", idempotency_key: KEY }],
  ] as const) {
    const verdict = assertCallable(name, args, bot);
    assert.equal(verdict.ok, false, `${name} admitted for a machine token`);
    assert.equal(verdict.ok === false && verdict.code, "forbidden");
  }

  // The same token may still do ordinary work — this is a targeted refusal,
  // not a blanket one, or nobody would use service accounts.
  assert.equal(assertCallable("bridgistic_list_posts", { site: "shop" }, bot).ok, true);
});

test("code execution needs a per-site opt-in on top of plan and grant", () => {
  const verdict = assertCallable(
    "bridgistic_execute_php",
    { site: "shop", code: "return 1;", approval_id: "approval-stepup-1", idempotency_key: KEY },
    caller({ codeExecutionOptIn: false, grantedApprovals: ["approval-stepup-1"] })
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.code, "forbidden");
});

test("a write without an idempotency key is refused", () => {
  const verdict = assertCallable("bridgistic_create_post", { site: "shop", title: "x" }, caller());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.code, "invalid_request");
  assert.equal(verdict.ok === false && verdict.validationErrors?.[0]?.path, "/idempotency_key");
});

test("reads do not require an idempotency key", () => {
  assert.equal(assertCallable("bridgistic_list_posts", { site: "shop" }, caller()).ok, true);
  assert.equal(assertCallable("bridgistic_list_sites", {}, caller()).ok, true);
});

// ----------------------------------------------------------- ordering ------

test("entitlement is decided before arguments are described", () => {
  // A caller probing for tools they cannot reach should not receive a schema
  // critique — that is a free description of an interface they were denied.
  const free = caller({ plan: "free", planScopes: planScopes("free"), siteScopes: planScopes("free") });
  const verdict = assertCallable("bridgistic_execute_php", { nonsense: true }, free);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.code, "plan_required");
  assert.equal(
    verdict.ok === false && verdict.validationErrors,
    undefined,
    "no schema detail leaks to a caller who was refused on entitlement"
  );
});

test("no denial message repeats an argument value back", () => {
  // Messages are logged and shown in a dashboard. Echoing arguments puts SQL,
  // PHP and file paths into places the redaction rules keep them out of.
  const secret = "SELECT user_pass FROM wp_users WHERE ID=1";
  const verdict = assertCallable(
    "bridgistic_db_query",
    { site: "shop", sql: secret, idempotency_key: KEY },
    caller({ plan: "free", planScopes: planScopes("free"), siteScopes: planScopes("free") })
  );
  assert.equal(verdict.ok, false);
  assert.ok(verdict.ok === false && !verdict.message.includes(secret));
  assert.ok(verdict.ok === false && !verdict.message.includes("user_pass"));
});

test("validation errors carry paths, never values", () => {
  const result = validateToolInput("bridgistic_create_post", {
    site: "shop",
    title: 12345,
    idempotency_key: KEY,
  });
  assert.equal(result.valid, false);
  for (const error of result.errors) {
    assert.ok(!error.message.includes("12345"), `error echoed the value: ${error.message}`);
  }
});

// ----------------------------------------------------------- discovery -----

test("tools/list advertises exactly what the caller may invoke", () => {
  // Advertising a tool that the gate refuses wastes a model's turn and teaches
  // it to retry things that cannot work.
  const free = caller({ plan: "free", planScopes: planScopes("free"), siteScopes: planScopes("free") });
  const offered = contractsFor(free.plan, free.siteScopes);
  const descriptors = mcpToolDescriptors(offered);

  assert.ok(descriptors.length > 0);
  for (const descriptor of descriptors) {
    const verdict = assertCallable(descriptor.name, minimalArgs(descriptor.name), free);
    // Admitted, or refused for a reason that is about this request rather than
    // about entitlement. Never plan_required or scope_denied.
    if (!verdict.ok) {
      assert.ok(
        verdict.code !== "plan_required" && verdict.code !== "scope_denied" && verdict.code !== "forbidden",
        `${descriptor.name} was advertised to a Free caller but refused with ${verdict.code}`
      );
    }
  }
});

test("MCP annotations are derived from the same classification as the gates", () => {
  for (const descriptor of mcpToolDescriptors(allContracts())) {
    const contract = contractFor(descriptor.name)!;
    assert.equal(descriptor.annotations.destructiveHint, contract.requiresApproval);
    assert.equal(descriptor.annotations.idempotentHint, contract.supportsIdempotency);
    assert.equal(
      descriptor.annotations.readOnlyHint,
      contract.riskClass === "safe_read" || contract.riskClass === "sensitive_read"
    );
    assert.equal(descriptor.inputSchema, contract.inputSchema, "the advertised schema IS the enforced one");
  }
});

/** Minimal plausible arguments, to exercise the gate rather than the schema. */
function minimalArgs(name: string): Record<string, unknown> {
  const contract = contractFor(name)!;
  const args: Record<string, unknown> = {};
  for (const key of contract.inputSchema.required ?? []) {
    const prop = contract.inputSchema.properties?.[key];
    args[key] =
      prop?.type === "integer" || prop?.type === "number"
        ? 1
        : prop?.type === "boolean"
          ? true
          : prop?.type === "array"
            ? [{ tool: "bridgistic_list_posts" }]
            : prop?.type === "object"
              ? {}
              : prop?.enum
                ? prop.enum[0]
                : "x";
  }
  if (contract.inputSchema.properties?.site) args.site = "shop";
  if (contract.inputSchema.properties?.idempotency_key) args.idempotency_key = KEY;
  return args;
}
