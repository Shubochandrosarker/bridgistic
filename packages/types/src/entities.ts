/**
 * The tenancy and scheduler entities. These mirror db/migrations/*.sql one for
 * one; if you change a column, change it in both places in the same commit.
 *
 * Field names are camelCase here and snake_case in SQL — the mapping happens
 * in each app's repository layer, never in a tool handler.
 */

import type { PlanId, BillingInterval } from "./plans.ts";

export type Id = string; // UUIDv4

// ---------------------------------------------------------------- tenancy ---

export const MEMBERSHIP_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export interface Organization {
  id: Id;
  name: string;
  slug: string;
  /** Set when the org authenticates with a WPistic ecosystem key instead of a Stripe plan. */
  wpisticOrgId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface User {
  id: Id;
  email: string;
  name: string | null;
  createdAt: number;
  lastSeenAt: number | null;
}

export interface Membership {
  organizationId: Id;
  userId: Id;
  role: MembershipRole;
  createdAt: number;
}

export const SITE_HEALTH = ["unknown", "healthy", "degraded", "unreachable"] as const;
export type SiteHealth = (typeof SITE_HEALTH)[number];

export interface Site {
  id: Id;
  organizationId: Id;
  /** Normalised base URL, no trailing slash. Unique per platform, not per org. */
  siteUrl: string;
  label: string | null;
  keyId: string;
  /** AES-256-GCM envelope. Never plaintext, never returned to a client. */
  keySecretEnc: string;
  /** Scopes the site itself granted when the key was minted. */
  scopesGranted: string[];
  health: SiteHealth;
  pluginVersion: string | null;
  createdAt: number;
  lastSeenAt: number | null;
}

// --------------------------------------------------------------- billing ---

export const SUBSCRIPTION_STATUS = [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "incomplete",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUS)[number];

export interface Subscription {
  id: Id;
  organizationId: Id;
  plan: PlanId;
  interval: BillingInterval;
  status: SubscriptionStatus;
  apiAddon: boolean;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  trialEndsAt: number | null;
  currentPeriodStart: number;
  currentPeriodEnd: number;
}

// --------------------------------------------------------------- metering ---

export const ACTOR_TYPES = ["user", "api_key", "mcp_session", "scheduler"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const ACTION_OUTCOMES = [
  "success",
  "failed",
  "denied",
  "pending_approval",
  "rate_limited",
] as const;
export type ActionOutcome = (typeof ACTION_OUTCOMES)[number];

/**
 * One row per tool call. INVARIANT 6: digests, not bodies — `requestDigest` is
 * sha256(canonical(args)) and the args themselves are never persisted. A
 * `db_query` or `execute_php` argument can carry customer PII.
 */
export interface ActionLogEntry {
  id: Id;
  organizationId: Id;
  siteId: Id | null;
  actorType: ActorType;
  actorId: string;
  tool: string;
  scopeUsed: string | null;
  approvalId: string | null;
  snapshotId: string | null;
  idempotencyKey: string | null;
  requestDigest: string;
  outcome: ActionOutcome;
  errorCode: string | null;
  durationMs: number;
  /** How much of the monthly quota this call consumed. See packages/tools. */
  actionsConsumed: number;
  createdAt: number;
}

// -------------------------------------------------------------- scheduler ---

export const SCHEDULE_KINDS = ["cron", "interval", "once"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

export const OVERLAP_POLICIES = ["skip", "queue", "cancel_previous"] as const;
export type OverlapPolicy = (typeof OVERLAP_POLICIES)[number];

export const CATCHUP_POLICIES = ["skip_missed", "run_once", "run_all"] as const;
export type CatchupPolicy = (typeof CATCHUP_POLICIES)[number];

export const NOTIFY_EVENTS = ["failure", "approval_required", "success"] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

export interface Job {
  id: Id;
  organizationId: Id;
  siteId: Id;
  name: string;
  playbookSlug: string;
  vars: Record<string, unknown>;
  scheduleKind: ScheduleKind;
  /** 5-field cron, evaluated in `timezone`. Null for interval/once. */
  cronExpr: string | null;
  /** Seconds. Null unless scheduleKind === "interval". */
  intervalSeconds: number | null;
  /** IANA zone, e.g. "Asia/Dhaka". NEVER a fixed UTC offset — DST would drift. */
  timezone: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: JobRunStatus | null;
  enabled: boolean;
  dryRun: boolean;
  overlapPolicy: OverlapPolicy;
  catchupPolicy: CatchupPolicy;
  maxRetries: number;
  retryBackoffSeconds: number;
  timeoutSeconds: number;
  /** Defaults to siteId — never hammer one shared host with ten parallel runs. */
  concurrencyKey: string;
  notifyOn: NotifyEvent[];
  /**
   * INVARIANT: a job cannot grant itself more than its creator had. The
   * dispatcher intersects the creator's scopes with the plan and site grant at
   * RUN time, not at create time, so a revocation takes effect immediately.
   */
  createdBy: Id;
  createdAt: number;
  updatedAt: number;
}

export const JOB_RUN_STATUS = [
  "queued",
  "running",
  "success",
  "failed",
  "paused_for_approval",
  "skipped",
  "timed_out",
  "cancelled",
] as const;
export type JobRunStatus = (typeof JOB_RUN_STATUS)[number];

export interface JobRunStep {
  index: number;
  tool: string;
  outcome: ActionOutcome;
  /** Digest only — same rule as ActionLogEntry.requestDigest. */
  requestDigest: string;
  durationMs: number;
  errorCode: string | null;
}

export interface JobRun {
  id: Id;
  jobId: Id;
  organizationId: Id;
  siteId: Id;
  /** The tick this run belongs to. Part of the idempotency key. */
  scheduledFor: number;
  startedAt: number | null;
  finishedAt: number | null;
  status: JobRunStatus;
  attempt: number;
  snapshotId: string | null;
  approvalId: string | null;
  stepsSummary: JobRunStep[];
  errorCode: string | null;
  errorMessage: string | null;
  actionsConsumed: number;
  /** unique(jobId, scheduledFor, attempt) — a queue redelivery cannot double-run. */
  idempotencyKey: string;
}

export function jobRunIdempotencyKey(jobId: Id, scheduledFor: number, attempt: number): string {
  return `${jobId}:${scheduledFor}:${attempt}`;
}
