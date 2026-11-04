/**
 * Plan catalogue. INVARIANT 1: the customer never sets their own limits —
 * every number here is server-side, and `KeyStore::create( …, $tier )` in the
 * WordPress plugin stops accepting a customer-supplied tier in Phase 2.
 *
 * Entitlement keys are namespaced `bridgistic.*` so the same map can be served
 * either by this catalogue or by the WPistic ecosystem key's
 * `EntitlementService.resolveForOrg()` — see docs/WPISTIC-INTEROP.md.
 */

import { scopesInClass } from "./scopes.ts";
import type { ScopeClass } from "./scopes.ts";

export const PLAN_IDS = ["free", "starter", "agency", "scale"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export const BILLING_INTERVALS = ["monthly", "yearly"] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export interface PlanDefinition {
  readonly id: PlanId;
  readonly name: string;
  /** USD cents per month. Yearly is eleven months' price (one month free). */
  readonly monthlyPriceCents: number;
  readonly yearlyPriceCents: number;
  /** `null` = unlimited. */
  readonly sitesMax: number | null;
  readonly actionsPerMonth: number;
  readonly schedulerJobsMax: number | null;
  /** Floor on a job's interval, in seconds. */
  readonly minIntervalSeconds: number;
  readonly snapshotRetentionDays: number;
  readonly auditRetentionDays: number;
  readonly teamSeats: number | null;
  readonly scopeClasses: readonly ScopeClass[];
  readonly whiteLabel: boolean;
}

const YEAR_MONTHS_CHARGED = 11; // "Yearly = 1 month free" — concrete beats "save 17%".

function yearly(monthlyCents: number): number {
  return monthlyCents * YEAR_MONTHS_CHARGED;
}

export const PLANS: Readonly<Record<PlanId, PlanDefinition>> = {
  free: {
    id: "free",
    name: "Free",
    monthlyPriceCents: 0,
    yearlyPriceCents: 0,
    sitesMax: 1,
    actionsPerMonth: 500,
    schedulerJobsMax: 1,
    minIntervalSeconds: 86_400,
    snapshotRetentionDays: 7,
    auditRetentionDays: 30,
    teamSeats: 1,
    // BR-002: Free holds safe_read ONLY. It does not get `fs:read`
    // (wp-config.php), `db:read`, `users:read`, `options:read`, or the
    // WooCommerce order/customer reads. An unverified free signup must not be
    // able to read a connected site's credentials or its customer list.
    scopeClasses: ["safe_read"],
    whiteLabel: false,
  },
  starter: {
    id: "starter",
    name: "Starter",
    monthlyPriceCents: 2_900,
    yearlyPriceCents: yearly(2_900),
    sitesMax: 3,
    actionsPerMonth: 10_000,
    schedulerJobsMax: 10,
    minIntervalSeconds: 3_600,
    snapshotRetentionDays: 30,
    auditRetentionDays: 90,
    teamSeats: 1,
    scopeClasses: ["safe_read", "sensitive_read", "content_write", "operational"],
    whiteLabel: false,
  },
  agency: {
    id: "agency",
    name: "Agency",
    monthlyPriceCents: 7_900,
    yearlyPriceCents: yearly(7_900),
    sitesMax: 25,
    actionsPerMonth: 100_000,
    schedulerJobsMax: 100,
    minIntervalSeconds: 900,
    snapshotRetentionDays: 90,
    auditRetentionDays: 365,
    teamSeats: 5,
    // `code_execution` is on Agency because the published catalogue puts it
    // there. Moving it to Scale would be a pricing decision, not a security
    // fix, and is not one to make in a hardening pass. The control that makes
    // it safe is the per-site opt-in in SECURITY_MODEL.md §3, not the price.
    scopeClasses: [
      "safe_read",
      "sensitive_read",
      "content_write",
      "operational",
      "destructive",
      "credential",
      "code_execution",
    ],
    whiteLabel: false,
  },
  scale: {
    id: "scale",
    name: "Scale",
    monthlyPriceCents: 19_900,
    yearlyPriceCents: yearly(19_900),
    sitesMax: null,
    actionsPerMonth: 500_000,
    schedulerJobsMax: null,
    minIntervalSeconds: 300,
    snapshotRetentionDays: 365,
    auditRetentionDays: 730,
    teamSeats: null,
    scopeClasses: [
      "safe_read",
      "sensitive_read",
      "content_write",
      "operational",
      "destructive",
      "credential",
      "code_execution",
    ],
    whiteLabel: true,
  },
} as const;

/** Requires an active subscription — never sold standalone. */
export const API_ADDON = {
  id: "api",
  monthlyPriceCents: 500,
  yearlyPriceCents: 5_000,
  requiresActiveSubscription: true,
} as const;

export const TRIAL_DAYS = 7;
export const REFUND_WINDOW_DAYS = 7;
/** Soft limit: email + dashboard banner. Hard limit: 429 + upgrade CTA. */
export const SOFT_LIMIT_RATIO = 0.8;

/** The scopes a plan may hold at all, before the per-site grant narrows them. */
export function planScopes(plan: PlanId): string[] {
  return PLANS[plan].scopeClasses.flatMap((cls) => [...scopesInClass(cls)]).sort();
}

/**
 * The flat entitlement map for a plan, in the `bridgistic.*` namespace the
 * WPistic ecosystem key also resolves into. `null` encodes "unlimited"; the
 * merge rules on the WPistic side treat numbers as max-wins, so unlimited is
 * represented as `null` rather than a sentinel integer nobody can beat.
 */
export type EntitlementValue = string | number | boolean | null;

export function planEntitlements(plan: PlanId): Record<string, EntitlementValue> {
  const p = PLANS[plan];
  return {
    "bridgistic.plan": p.id,
    "bridgistic.sites.max": p.sitesMax,
    "bridgistic.actions.monthly": p.actionsPerMonth,
    "bridgistic.scheduler.jobs.max": p.schedulerJobsMax,
    "bridgistic.scheduler.min_interval_seconds": p.minIntervalSeconds,
    "bridgistic.snapshot.retention_days": p.snapshotRetentionDays,
    "bridgistic.audit.retention_days": p.auditRetentionDays,
    "bridgistic.team.seats": p.teamSeats,
    "bridgistic.scopes": planScopes(plan).join(" "),
    "bridgistic.php_execute.enabled": planScopes(plan).includes("php:execute"),
    "bridgistic.white_label.enabled": p.whiteLabel,
  };
}

export function isUnlimited(value: number | null): value is null {
  return value === null;
}

export function withinLimit(used: number, limit: number | null): boolean {
  return limit === null || used < limit;
}
