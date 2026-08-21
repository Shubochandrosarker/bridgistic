/**
 * The canonical tool contract.
 *
 * One definition, shared by the MCP server, the API, the scheduler, the
 * dashboard client and the WordPress plugin. Everything downstream is
 * generated from it: MCP `tools/list` output, the typed API client, the
 * documented tool catalogue, the drift check against the free repository.
 *
 * The point of putting policy metadata *in the contract* rather than deriving
 * it at each call site is that there is then nowhere to derive it differently.
 * A tool that needs approval needs approval whether it arrives over MCP, over
 * the REST API, or from a scheduled job.
 */

import type { JsonSchema } from "./json-schema.ts";
import type { ScopeClass, PlanId } from "@bridgistic/types";

/** How a tool's result is metered. See packages/tools/src/metering.ts. */
export type MeterUnit = "action" | "none";

export interface ToolContract {
  /** Wire name. Stable forever once published. */
  readonly name: string;

  /**
   * Contract version, `major.minor`.
   *
   * Major changes when an argument is removed, a type narrows, a new required
   * argument appears, or the output loses a field — anything that can break a
   * caller who was correct yesterday. Minor covers additions that a correct
   * caller can ignore. `scripts/check-contract-compat.mjs` enforces this
   * against the previous release, because "we'll remember to bump it" is not
   * a compatibility policy.
   */
  readonly version: string;

  /** Shown to the model. This is the prompt; vagueness here costs real calls. */
  readonly description: string;

  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;

  /**
   * Scopes the caller must hold. ALL of them — this is a conjunction, not a
   * menu. A tool needing two scopes must not run for a caller holding one.
   */
  readonly requiredScopes: readonly string[];

  /**
   * A lesser scope that also authorises the call, at reduced capability.
   * `bridgistic_db_query` needs `db:write` in the worst case but a caller
   * holding only `db:read` may run a SELECT — and is metered as a read.
   */
  readonly minScope?: string;

  /** Worst-case class. Drives approval, snapshot, step-up and price. */
  readonly riskClass: ScopeClass | "local";

  readonly requiresApproval: boolean;
  readonly requiresSnapshot: boolean;
  readonly requiresStepUp: boolean;

  /**
   * Whether re-sending the same idempotency key returns the first result
   * instead of acting again. False means the tool must never be retried
   * automatically — see `SECURITY_MODEL.md` §8.
   */
  readonly supportsIdempotency: boolean;

  /** Wall-clock ceiling for the WordPress leg. */
  readonly timeoutMs: number;

  readonly meterUnit: MeterUnit;

  /** Plans on which the tool is offered at all. Derived, never hand-written. */
  readonly enabledPlans: readonly PlanId[];

  /** HTTP verb and route on the WordPress plugin. `null` for platform-local tools. */
  readonly route: string | null;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | null;

  /** Grouping for docs and the dashboard. */
  readonly group: "core" | "content" | "admin" | "intel" | "safety" | "schedule" | "woo";

  /**
   * Set when the tool is superseded. A deprecated tool keeps working for two
   * minor versions, still appears in `tools/list` marked deprecated, and only
   * then goes away — a client pinned to it should get a warning, not a
   * mystery failure the day we ship.
   */
  readonly deprecated?: {
    readonly since: string;
    readonly replacedBy?: string;
    readonly removeAfter: string;
  };
}

/**
 * The error envelope every layer returns. One shape for MCP, the API and the
 * scheduler, so a client learns it once.
 *
 * It carries no site content and no argument values — see the redaction rules
 * in `SECURITY_MODEL.md` §5. `requestId` is how a customer's report is joined
 * to a log line without either of them containing the data.
 */
export interface ErrorEnvelope {
  readonly error: ErrorCode;
  /** Safe to show a person. Never contains argument values or site content. */
  readonly message: string;
  readonly requestId: string;
  /** Present when the failure is a schema rejection. Paths, never values. */
  readonly validationErrors?: readonly { readonly path: string; readonly message: string }[];
  /** Present when the caller may usefully try again, and when. */
  readonly retryAfterMs?: number;
  /** Present when an approval must be granted before this call can proceed. */
  readonly approvalId?: string;
}

export const ERROR_CODES = [
  "unauthenticated",
  "forbidden",
  /**
   * Distinct from `forbidden` so a client can tell "you may not" from "not on
   * this plan" and show the right thing. Both deny; only one is fixable by
   * upgrading.
   */
  "plan_required",
  "scope_denied",
  "approval_required",
  "step_up_required",
  "snapshot_required",
  "invalid_request",
  "not_found",
  "conflict",
  "idempotency_conflict",
  "quota_exceeded",
  "rate_limited",
  "site_unreachable",
  "site_error",
  "timeout",
  "response_too_large",
  "internal",
  "not_implemented",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Codes that must never distinguish "exists but you may not see it" from
 * "does not exist". Returning `not_found` for another organization's site id
 * and `forbidden` for your own turns the API into an existence oracle.
 */
export const OPAQUE_DENIAL_CODES: readonly ErrorCode[] = ["not_found"];
