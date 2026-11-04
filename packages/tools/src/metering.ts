/**
 * How a tool call turns into billable actions.
 *
 * The rule is published on the pricing page, so it lives in one place and is
 * asserted by tests rather than living in a Worker's head. Two principles:
 *
 *   1. The customer is never billed for our failure or for our refusal.
 *      A denied scope, a rate limit, and a call that never reached the site
 *      cost nothing.
 *   2. Writes cost more than reads, because they cost US more — a write drags
 *      a snapshot, an approval record and an audit row behind it.
 *
 * The counter these feed is a Durable Object counter per (org, month), NOT KV.
 * `docs/CLOUD_CONNECTOR.md` in the free repo says plainly that KV
 * read-then-write is "approximate — roughly the configured limit per colo …
 * inadequate as a billing-grade counter", and it is right.
 */

import type { ActionOutcome, ScopeClass } from "@bridgistic/types";
import { operationClass, effectiveToolClass } from "./catalog.ts";

/**
 * Cost in actions, by risk class. The shape mirrors SCOPE_CLASSES exactly — a
 * class added there without a weight here is a compile error, which is the
 * point: an unpriced class would meter as `undefined` and bill as NaN.
 */
export const ACTION_WEIGHTS: Readonly<Record<ScopeClass, number>> & { readonly local: 0 } = {
  safe_read: 1,
  /**
   * A sensitive read costs more than a safe one because it is worth more to
   * the person taking it. Pricing exfiltration at the same rate as fetching a
   * post list gives an attacker a quota, not a deterrent.
   */
  sensitive_read: 2,
  content_write: 2,
  operational: 2,
  destructive: 5,
  credential: 5,
  code_execution: 5,
  /** Platform-local tools (e.g. listing sites) never touch a site. */
  local: 0,
} as const;

/**
 * A call that reached the site and failed there still consumed a request, so it
 * is charged at the read rate rather than free — otherwise a broken loop is an
 * unmetered one.
 */
export const FAILED_CALL_WEIGHT = 1;

/**
 * @param grantedScopes When supplied, the call is priced at the class the
 *   caller's OWN scopes give it — a `db:read` SELECT is a read, not a
 *   destructive write. Omit it and the tool is priced at its worst case, which
 *   over-charges rather than under-charges.
 */
export function actionsConsumed(
  tool: string,
  outcome: ActionOutcome,
  grantedScopes?: readonly string[]
): number {
  switch (outcome) {
    case "denied":
    case "rate_limited":
    case "pending_approval":
      return 0;
    case "failed":
    case "timeout":
    case "cancelled":
      return FAILED_CALL_WEIGHT;
    case "success": {
      const cls = grantedScopes ? effectiveToolClass(tool, grantedScopes) : operationClass(tool);
      return cls === null ? ACTION_WEIGHTS.local : ACTION_WEIGHTS[cls];
    }
  }
}

export type QuotaState = "ok" | "soft_limit" | "hard_limit";

export interface QuotaVerdict {
  state: QuotaState;
  used: number;
  limit: number;
  remaining: number;
  /** Set on a hard limit, for the 429's `X-Bridgistic-Quota-Reset` header. */
  resetAt: number | null;
}

/**
 * Soft-limit at 80% (email + dashboard banner), hard-limit at 100% with a clear
 * upgrade CTA and a 429 carrying `X-Bridgistic-Quota-Reset`.
 */
export function evaluateQuota(
  used: number,
  limit: number,
  periodEndMs: number,
  softRatio = 0.8
): QuotaVerdict {
  const remaining = Math.max(0, limit - used);
  if (used >= limit) {
    return { state: "hard_limit", used, limit, remaining: 0, resetAt: periodEndMs };
  }
  if (used >= limit * softRatio) {
    return { state: "soft_limit", used, limit, remaining, resetAt: null };
  }
  return { state: "ok", used, limit, remaining, resetAt: null };
}

/**
 * Whether a call may proceed given the counter BEFORE it runs. Checked
 * pre-flight so a 5-action destructive call cannot straddle the limit and land
 * the org at 100.4% of its plan.
 */
export function admitCall(
  tool: string,
  usedThisPeriod: number,
  limit: number,
  grantedScopes?: readonly string[]
): { admitted: boolean; cost: number } {
  const cost = actionsConsumed(tool, "success", grantedScopes);
  return { admitted: usedThisPeriod + cost <= limit, cost };
}
