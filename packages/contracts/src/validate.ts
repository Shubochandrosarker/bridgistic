/**
 * The gate. Every surface — MCP, API, scheduler — calls `assertCallable`
 * before anything else, and none of them implements this check itself.
 *
 * `assertCallable` answers one question: may THIS caller invoke THIS tool with
 * THESE arguments, right now? It does not perform the call, touch a site, or
 * know how to. That separation is what lets the same answer be given to a tool
 * call from Claude, a REST request from the dashboard, and a scheduled job at
 * 3am — which is the requirement that there not be three security models.
 */

import { validate } from "./json-schema.ts";
import type { ValidationError } from "./json-schema.ts";
import { contractFor } from "./registry.ts";
import type { ToolContract, ErrorCode } from "./types.ts";
import { effectiveScopes, allowedForMachineToken } from "@bridgistic/types";
import type { PlanId } from "@bridgistic/types";

/**
 * Who is calling, resolved server-side.
 *
 * Every field here is derived from the token and the database. None is taken
 * from the request body — see `FORBIDDEN_PARAM_NAMES`. The type exists partly
 * to make that obvious at every call site: if you are constructing a
 * `CallerContext` from something a client sent, it is visible in the diff.
 */
export interface CallerContext {
  readonly organizationId: string;
  readonly actorId: string;
  /** True for an API key or service account: cannot answer a step-up challenge. */
  readonly isMachineToken: boolean;
  readonly plan: PlanId;
  /** Scopes the plan entitles. */
  readonly planScopes: readonly string[];
  /** Scopes granted to THIS site. Narrower than the plan, never wider. */
  readonly siteScopes: readonly string[];
  /** Tools the organization's policy has switched off. */
  readonly disabledTools?: readonly string[];
  /** True when the actor completed step-up authentication recently enough. */
  readonly stepUpSatisfied: boolean;
  /** Approval ids already granted to this actor for this exact request. */
  readonly grantedApprovals?: readonly string[];
  /** True when this site has opted in to code execution. */
  readonly codeExecutionOptIn?: boolean;
}

export type CallableVerdict =
  | { readonly ok: true; readonly contract: ToolContract; readonly args: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly code: ErrorCode;
      readonly message: string;
      readonly validationErrors?: readonly ValidationError[];
    };

/** Validate arguments against a tool's input schema. */
export function validateToolInput(
  name: string,
  args: unknown
): { valid: boolean; errors: readonly ValidationError[] } {
  const contract = contractFor(name);
  if (!contract) return { valid: false, errors: [{ path: "", message: `unknown tool "${name}"` }] };
  return validate(contract.inputSchema, args);
}

/**
 * The full pre-flight check.
 *
 * Order matters, and it is not the order that reads most naturally. Existence
 * and entitlement are checked before schema, so a caller probing for tools
 * they are not entitled to learns nothing from the shape of the error: an
 * unknown tool and an unentitled tool both come back the same way. Telling
 * someone "that tool exists but not on your plan" is fine; telling them "that
 * tool exists, and here is exactly which argument you got wrong" before
 * establishing they may call it at all is free reconnaissance.
 */
export function assertCallable(name: string, args: unknown, caller: CallerContext): CallableVerdict {
  const contract = contractFor(name);
  if (!contract) {
    return { ok: false, code: "not_found", message: `No tool named "${name}".` };
  }

  if (caller.disabledTools?.includes(name)) {
    return {
      ok: false,
      code: "forbidden",
      message: `"${name}" is disabled by your organization's policy.`,
    };
  }

  if (!contract.enabledPlans.includes(caller.plan)) {
    return {
      ok: false,
      code: "plan_required",
      message: `"${name}" is not available on the ${caller.plan} plan.`,
    };
  }

  // The intersection from SECURITY_MODEL.md §2. Requested is what the tool
  // needs, not what the caller asked for — a caller does not get to nominate
  // the scopes their own call is checked against.
  if (contract.requiredScopes.length > 0) {
    const effective = effectiveScopes(contract.requiredScopes, caller.planScopes, caller.siteScopes);
    const hasFull = contract.requiredScopes.every((s) => effective.includes(s));

    const minEffective =
      contract.minScope === undefined
        ? []
        : effectiveScopes([contract.minScope], caller.planScopes, caller.siteScopes);
    const hasMin = contract.minScope !== undefined && minEffective.includes(contract.minScope);

    if (!hasFull && !hasMin) {
      return {
        ok: false,
        code: "scope_denied",
        message:
          `"${name}" requires ${contract.requiredScopes.join(", ")}` +
          (contract.minScope ? ` (or ${contract.minScope} for read-only use)` : "") +
          ` on this site.`,
      };
    }
  }

  // A machine token cannot answer a step-up challenge, so it must not hold a
  // scope whose gate depends on one. Refused on the class, not on a list of
  // tool names, so a new credential-class tool is covered the day it is added.
  if (caller.isMachineToken) {
    const humanOnly = contract.requiredScopes.filter((s) => !allowedForMachineToken(s));
    if (humanOnly.length > 0) {
      return {
        ok: false,
        code: "forbidden",
        message:
          `"${name}" cannot be called by an API key or service account: ${humanOnly.join(", ")} ` +
          `requires a person to re-authenticate.`,
      };
    }
  }

  if (contract.riskClass === "code_execution" && caller.codeExecutionOptIn !== true) {
    return {
      ok: false,
      code: "forbidden",
      message:
        `"${name}" executes code on the site. It requires an explicit per-site opt-in in addition to the plan ` +
        `and the scope grant.`,
    };
  }

  // Only now does the caller learn anything about their arguments.
  const result = validate(contract.inputSchema, args);
  if (!result.valid) {
    return {
      ok: false,
      code: "invalid_request",
      message: `Arguments for "${name}" did not match its schema.`,
      validationErrors: result.errors,
    };
  }

  const argsObject = args as Record<string, unknown>;

  if (contract.requiresStepUp && !caller.stepUpSatisfied) {
    return {
      ok: false,
      code: "step_up_required",
      message: `"${name}" requires you to re-authenticate before it can run.`,
    };
  }

  if (contract.requiresApproval) {
    const supplied = typeof argsObject.approval_id === "string" ? argsObject.approval_id : undefined;
    const granted = caller.grantedApprovals ?? [];
    if (supplied === undefined || !granted.includes(supplied)) {
      return {
        ok: false,
        code: "approval_required",
        message:
          `"${name}" needs an approver to sign off before it runs. Re-send the same arguments with the ` +
          `approval_id once it has been granted.`,
      };
    }
  }

  // A write without an idempotency key can be turned into two writes by any
  // retry — a dropped response, a queue redelivery, a user clicking twice.
  // Requiring the key is the only way the executor can tell a retry from a
  // second request, and it has to be the caller's key: we cannot generate one
  // that survives their retry.
  if (contract.supportsIdempotency && isWrite(contract) && typeof argsObject.idempotency_key !== "string") {
    return {
      ok: false,
      code: "invalid_request",
      message: `"${name}" changes the site and requires an idempotency_key so a retry cannot become a second change.`,
      validationErrors: [{ path: "/idempotency_key", message: "is required for writes" }],
    };
  }

  return { ok: true, contract, args: argsObject };
}

function isWrite(contract: ToolContract): boolean {
  return contract.riskClass !== "local" && contract.riskClass !== "safe_read" && contract.riskClass !== "sensitive_read";
}

/**
 * MCP `tools/list` descriptors, generated from the registry.
 *
 * Generated, never hand-maintained: a hand-written list is a second source of
 * truth about what a tool accepts, and the copy clients read would be the one
 * that goes stale.
 *
 * The descriptors are filtered to what this caller may actually invoke.
 * Advertising a tool that `assertCallable` will refuse wastes a model's turn
 * discovering the refusal, and teaches it to retry things that cannot work.
 */
export function mcpToolDescriptors(
  contracts: readonly ToolContract[]
): readonly {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations: Record<string, boolean>;
}[] {
  return contracts.map((contract) => ({
    name: contract.name,
    description: contract.description,
    inputSchema: contract.inputSchema,
    annotations: {
      // MCP's hints, derived from the same classification everything else uses.
      readOnlyHint: contract.riskClass === "safe_read" || contract.riskClass === "sensitive_read",
      destructiveHint: contract.requiresApproval,
      idempotentHint: contract.supportsIdempotency,
      openWorldHint: contract.route !== null,
    },
  }));
}
