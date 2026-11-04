/**
 * Entitlement resolution — the single answer to "what may this org do".
 *
 * There are two sources and exactly one resolver:
 *
 *   1. A Stripe subscription in `subscriptions` → `planEntitlements(plan)`.
 *   2. A WPistic ecosystem key (`wpi_live_…`) → the platform's
 *      `EntitlementService.resolveForOrg(orgId)`, which already merges every
 *      active subscription and licence the org holds into one flat map.
 *
 * Case 2 is an ADAPTER, not a second entitlement engine. `resolveForOrg` is the
 * single-key resolver on the WPistic side and it already exists; writing a
 * parallel one here would guarantee the two drift and a customer would be told
 * two different things about what they bought.
 */

import { planEntitlements, PLANS } from "@bridgistic/types";
import type { PlanId, EntitlementValue } from "@bridgistic/types";

export type EntitlementMap = Record<string, EntitlementValue>;

export interface ResolvedEntitlements {
  source: "subscription" | "wpistic_ecosystem_key";
  plan: PlanId;
  entitlements: EntitlementMap;
  /** Seconds the caller may cache this. Effective scope is never cached longer. */
  checkAfter: number;
}

/** How long any consumer may hold a resolved entitlement map. */
export const CHECK_AFTER_SECONDS = 900;

export function fromSubscription(plan: PlanId): ResolvedEntitlements {
  return {
    source: "subscription",
    plan,
    entitlements: planEntitlements(plan),
    checkAfter: CHECK_AFTER_SECONDS,
  };
}

/**
 * Map a WPistic ecosystem entitlement map onto the plan-shaped answer the rest
 * of this Worker expects.
 *
 * Only `bridgistic.*` keys are read: the map is the WHOLE ecosystem, and
 * SEOistic's or Memberistic's keys are none of this Worker's business.
 *
 * `bridgistic.plan` is display only. The gate is always the individual
 * entitlement key — a plan NAME must never be what unlocks a capability, or a
 * renamed plan silently changes what customers can do.
 */
export function fromWpisticEntitlements(map: EntitlementMap): ResolvedEntitlements | null {
  const scoped = Object.fromEntries(Object.entries(map).filter(([k]) => k.startsWith("bridgistic.")));
  if (Object.keys(scoped).length === 0) return null;

  const declared = scoped["bridgistic.plan"];
  const plan: PlanId =
    typeof declared === "string" && declared in PLANS ? (declared as PlanId) : "free";

  return {
    source: "wpistic_ecosystem_key",
    plan,
    // The ecosystem map wins where it says anything, so adding Bridgistic to a
    // WPistic subscription lights it up on the next validate with no change
    // here. Plan defaults fill only the keys it does not carry.
    entitlements: { ...planEntitlements(plan), ...scoped },
    checkAfter: CHECK_AFTER_SECONDS,
  };
}

function numeric(map: EntitlementMap, key: string): number | null {
  const value = map[key];
  if (value === null) return null; // null encodes "unlimited"
  return typeof value === "number" ? value : 0;
}

export function scopesFrom(resolved: ResolvedEntitlements): string[] {
  const value = resolved.entitlements["bridgistic.scopes"];
  return typeof value === "string" && value !== "" ? value.split(/\s+/).sort() : [];
}

export function sitesMax(resolved: ResolvedEntitlements): number | null {
  return numeric(resolved.entitlements, "bridgistic.sites.max");
}

export function actionsPerMonth(resolved: ResolvedEntitlements): number {
  return numeric(resolved.entitlements, "bridgistic.actions.monthly") ?? Number.MAX_SAFE_INTEGER;
}

export function minIntervalSeconds(resolved: ResolvedEntitlements): number {
  return numeric(resolved.entitlements, "bridgistic.scheduler.min_interval_seconds") ?? 300;
}
