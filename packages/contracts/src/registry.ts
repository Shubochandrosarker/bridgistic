/**
 * The contract registry: one `ToolContract` per tool, assembled once at module
 * load and frozen.
 *
 * Every policy field is *derived* — from the tool's scope, from the scope's
 * class, from the plan catalogue. None is hand-written per tool. That is the
 * whole point: `requiresApproval` cannot disagree with the scope model,
 * because nobody types it. Reclassify a scope and every contract that uses it
 * moves with it, including the ones whoever made the change forgot about.
 *
 * The output schema is shared. A tool result is the plugin's envelope; the
 * per-tool payload inside it is not something the platform should claim to
 * know the shape of, because the plugin owns that and ships on its own cycle.
 * Declaring a precise output schema we cannot enforce would be a lie told in
 * a machine-readable format.
 */

import { TOOLS } from "@bridgistic/tools";
import type { ToolDefinition } from "@bridgistic/tools";
import type { ScopeClass } from "@bridgistic/types";
import {
  scopeClass,
  requiresApproval,
  requiresApprovalForClass,
  requiresSnapshotForClass,
  requiresStepUpForClass,
  snapshotOperationClass,
  maxClass,
  requiresSnapshot,
  requiresStepUp,
  PLAN_IDS,
  planScopes,
} from "@bridgistic/types";
import type { PlanId } from "@bridgistic/types";
import { compileSchema } from "./json-schema.ts";
import type { JsonSchema } from "./json-schema.ts";
import { SCHEMAS } from "./schemas.ts";
import { FORBIDDEN_PARAM_NAMES, assertUrlParamsGuarded } from "./params.ts";
import type { ToolContract } from "./types.ts";

/** Contract version for the whole surface. Bumped by the compatibility check. */
export const CONTRACT_VERSION = "1.0";

/**
 * Default timeout by risk class.
 *
 * A read that has not answered in ten seconds is not going to; holding the
 * connection open past that spends a Worker's time and a customer's patience
 * on a result nobody is still waiting for.
 */
const DEFAULT_TIMEOUT_MS: Record<string, number> = {
  local: 5_000,
  safe_read: 10_000,
  sensitive_read: 15_000,
  content_write: 30_000,
  operational: 60_000,
  destructive: 120_000,
  credential: 30_000,
  code_execution: 60_000,
};

/**
 * The envelope every tool returns.
 *
 * `ok: false` carries the error envelope; `ok: true` carries a `data` payload
 * whose shape belongs to the plugin. Validated for *envelope* correctness, not
 * for payload shape — see the file docblock.
 */
export const TOOL_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean", description: "Whether the operation completed." },
    data: { description: "Tool-specific payload. Present when ok is true." },
    error: { type: "string", maxLength: 64, description: "Error code. Present when ok is false." },
    message: { type: "string", maxLength: 2_000, description: "Human-readable summary, safe to display." },
    requestId: { type: "string", maxLength: 64, description: "Correlates this call with one log line." },
    dryRun: { type: "boolean", description: "True when nothing was changed because dry_run was set." },
    approvalId: { type: "string", maxLength: 128, description: "Present when the call needs an approval." },
    snapshotId: { type: "string", maxLength: 128, description: "Snapshot taken before the change, if any." },
    actionsConsumed: { type: "integer", minimum: 0, maximum: 1_000_000 },
  },
  required: ["ok", "requestId"],
  additionalProperties: false,
};

function build(tool: ToolDefinition): ToolContract {
  const entry = SCHEMAS[tool.name];
  if (!entry) {
    throw new Error(
      `${tool.name} is in the catalogue but has no schema. A tool that can be called and cannot be ` +
        `validated is a tool whose arguments reach WordPress unchecked.`
    );
  }

  // A contract that declares a forbidden argument would let a caller supply
  // something the server must derive. Checked at load, so it cannot ship.
  for (const name of Object.keys(entry.inputSchema.properties ?? {})) {
    const reason = FORBIDDEN_PARAM_NAMES[name];
    if (reason) throw new Error(`${tool.name}: argument "${name}" is not permitted — ${reason}.`);
  }

  assertUrlParamsGuarded(tool.name, entry.inputSchema.properties ?? {});

  compileSchema(entry.inputSchema, tool.name);

  const cls = tool.scope === null ? "local" : scopeClass(tool.scope);
  if (cls === undefined) {
    throw new Error(`${tool.name}: scope "${tool.scope}" has no class in the scope vocabulary.`);
  }

  const scopes = tool.scope === null ? [] : [tool.scope];

  // BR-015. A GET route the plugin gates behind a writing scope is still a
  // read: the caller must hold that scope, but nothing is going to change, so
  // there is nothing to approve, snapshot or re-authenticate for. Guarded so
  // the flag can only ever relax, and only on a GET.
  if (tool.readOnlyOperation && tool.method !== "GET") {
    throw new Error(
      `${tool.name}: readOnlyOperation is set on a ${tool.method} route. It may only mark a GET, or it becomes ` +
        `a way to switch a gate off — which is exactly what BR-013 removed.`
    );
  }
  const readOnly = tool.readOnlyOperation === true;

  // SECURITY_MODEL §4. `snapshot:manage` is classed `operational`, which is
  // right for creating and listing and wrong for the two operations that
  // destroy something. `restore` discards every change since the snapshot was
  // taken; `delete` removes the rollback path the destructive and
  // code_execution gates rely on. Without this the gate for both is "hold the
  // scope", with no approval and no step-up.
  //
  // Guarded so it can only ever tighten: a snapshot operation may raise the
  // class the scope carries, never lower it.
  // `null` for platform-local tools, which have no scope and therefore no gate.
  const scopedClass: ScopeClass | null = tool.scope === null || cls === "local" ? null : cls;
  const operationClass: ScopeClass | null =
    scopedClass === null || tool.snapshotOperation === undefined
      ? scopedClass
      : maxClass(
          scopedClass,
          snapshotOperationClass(tool.snapshotOperation === "list" ? "create" : tool.snapshotOperation)
        );

  return Object.freeze({
    name: tool.name,
    version: CONTRACT_VERSION,
    description: entry.description,
    inputSchema: entry.inputSchema,
    outputSchema: TOOL_OUTPUT_SCHEMA,
    requiredScopes: Object.freeze(scopes),
    ...(tool.minScope !== undefined ? { minScope: tool.minScope } : {}),
    // The class the OPERATION carries, which is what pricing and the MCP
    // read-only hint should reflect. Authorisation still uses `requiredScopes`.
    riskClass: readOnly ? "sensitive_read" : (operationClass ?? "local"),
    // Derived, every one of them. Nothing here is a per-tool judgement call:
    // the gates come from the class, and the class comes from the scope model.
    requiresApproval: !readOnly && operationClass !== null && requiresApprovalForClass(operationClass),
    // Of the snapshot operations only `restore` takes one first, and §4 says
    // why: it discards every change since the snapshot, so the current state
    // has to be recoverable or a mistaken restore is unrecoverable. Snapshotting
    // before `create` would snapshot the site in order to snapshot the site;
    // before `delete` it would preserve the site, which is not the thing being
    // destroyed. Both are cost with no rollback value.
    requiresSnapshot:
      tool.snapshotOperation !== undefined
        ? tool.snapshotOperation === "restore"
        : !readOnly && operationClass !== null && requiresSnapshotForClass(operationClass),
    requiresStepUp: !readOnly && operationClass !== null && requiresStepUpForClass(operationClass),
    supportsIdempotency: entry.supportsIdempotency ?? true,
    timeoutMs: entry.timeoutMs ?? DEFAULT_TIMEOUT_MS[readOnly ? "sensitive_read" : cls] ?? 30_000,
    meterUnit: tool.scope === null ? "none" : "action",
    enabledPlans: Object.freeze(plansFor(tool)),
    route: tool.route,
    method: tool.method,
    group: tool.group,
  });
}

/**
 * Plans on which the tool is offered.
 *
 * A tool with a `minScope` is offered to any plan holding *either* scope: a
 * Starter customer with `db:read` can run a SELECT through `db_query` even
 * though the plan does not carry `db:write`.
 */
function plansFor(tool: ToolDefinition): PlanId[] {
  if (tool.scope === null) return [...PLAN_IDS]; // platform-local: every plan
  return PLAN_IDS.filter((plan) => {
    const held = new Set(planScopes(plan));
    return held.has(tool.scope!) || (tool.minScope !== undefined && held.has(tool.minScope));
  });
}

const CONTRACTS: readonly ToolContract[] = Object.freeze(TOOLS.map(build));
const INDEX = new Map<string, ToolContract>(CONTRACTS.map((c) => [c.name, c]));

export function allContracts(): readonly ToolContract[] {
  return CONTRACTS;
}

export function contractFor(name: string): ToolContract | undefined {
  return INDEX.get(name);
}

/**
 * Contracts a caller on `plan` holding `grantedScopes` may see.
 *
 * Both terms, because they answer different questions: the plan says what the
 * customer bought, the grant says what they pointed at this site. A tool
 * missing from this list is not merely hidden — `assertCallable` refuses it
 * too, so a client that calls a tool it was never offered is denied rather
 * than served.
 */
export function contractsFor(plan: PlanId, grantedScopes: readonly string[]): readonly ToolContract[] {
  const granted = new Set(grantedScopes);
  return CONTRACTS.filter((contract) => {
    if (!contract.enabledPlans.includes(plan)) return false;
    if (contract.requiredScopes.length === 0) return true; // platform-local
    const hasFull = contract.requiredScopes.every((s) => granted.has(s));
    const hasMin = contract.minScope !== undefined && granted.has(contract.minScope);
    return hasFull || hasMin;
  });
}
