/**
 * The ports the executor needs, as interfaces.
 *
 * The executor is the one piece that must behave identically whether the call
 * arrived over MCP, over the REST API, or from a scheduled job at 3am. That
 * only holds if the executor itself is testable without any of them — so
 * everything it touches is an interface, and the tests drive it with fakes
 * that can be made to fail in ways a real database is hard to arrange:
 * crashing between reserve and settle, returning a duplicate claim, timing out
 * mid-call.
 *
 * These are ports, not abstractions-for-their-own-sake. Each one exists
 * because the executor must be able to fail it deliberately in a test.
 */

import type { ToolContract } from "@bridgistic/contracts";
import type { ActionOutcome } from "@bridgistic/types";

// ------------------------------------------------------------ idempotency --

export type ClaimState = "pending" | "succeeded" | "failed" | "expired";

export interface IdempotencyClaim {
  readonly key: string;
  readonly state: ClaimState;
  /** sha256 of the canonical request. A different hash under the same key is a conflict. */
  readonly requestHash: string;
  readonly organizationId: string;
  readonly siteId: string | null;
  readonly actorId: string;
  readonly tool: string;
  readonly createdAt: number;
  /** The stored result, for replaying a completed call. */
  readonly result?: unknown;
}

export type ClaimOutcome =
  /** This caller owns the claim and must perform the call. */
  | { readonly kind: "claimed" }
  /** The same request already completed. Return this instead of acting again. */
  | { readonly kind: "replay"; readonly result: unknown }
  /** Another attempt at the same key is in flight. */
  | { readonly kind: "in_flight" }
  /** The key was used for a DIFFERENT request. Never a replay. */
  | { readonly kind: "conflict" };

export interface IdempotencyStore {
  /**
   * Claim the key BEFORE the side effect, atomically.
   *
   * A unique index alone prevents a duplicate row, not a duplicate external
   * mutation — the row is written after the call, and the call is the thing
   * that must not happen twice. The claim has to exist first.
   */
  claim(claim: Omit<IdempotencyClaim, "state">): Promise<ClaimOutcome>;
  settle(key: string, state: "succeeded" | "failed", result?: unknown): Promise<void>;
}

// ---------------------------------------------------------------- metering --

export interface Reservation {
  readonly id: string;
  readonly cost: number;
}

export type AdmissionOutcome =
  | { readonly admitted: true; readonly reservation: Reservation }
  | { readonly admitted: false; readonly reason: "quota_exceeded" | "rate_limited"; readonly retryAfterMs?: number };

export interface MeteringStore {
  /** Reserve before the call. Never after — see the note in UsageCounter. */
  reserve(input: {
    organizationId: string;
    cost: number;
    idempotencyKey: string;
  }): Promise<AdmissionOutcome>;
  /**
   * The call finished. `actual` may be lower than reserved.
   *
   * The organization is passed rather than recovered from the reservation id.
   * A store may shard per organization — the Durable Object one does — and an
   * adapter that had to remember which shard issued which id would be holding
   * state between two calls that can be separated by a crash. Explicit here
   * costs one field; implicit costs a leaked reservation.
   */
  settle(input: { organizationId: string; reservationId: string; actual: number }): Promise<void>;
  /** The call never happened. Costs nothing. */
  release(input: { organizationId: string; reservationId: string }): Promise<void>;
}

// --------------------------------------------------------------- approvals --

export interface ApprovalStore {
  /**
   * Create a pending approval and return its id.
   *
   * The summary is redacted before it is stored: an approver needs to know
   * what is about to happen, not to receive the arguments. "Run SQL against
   * shop.example" is the useful part; the statement itself is not, and putting
   * it in a notification puts it in an inbox.
   */
  request(input: {
    organizationId: string;
    /**
     * Approval-gated classes are destructive and code_execution, and both act
     * on a site. A null site here is a caller that reached the gate by a path
     * that should not exist, and the store refuses it rather than recording an
     * approval nobody can act on.
     */
    siteId: string | null;
    actorId: string;
    actorType: "user" | "api_key" | "mcp_session" | "service_account" | "scheduler" | "system";
    tool: string;
    /** The scope being asked for, so the approval screen can name it. */
    scopeRequested: string;
    requestHash: string;
    summary: string;
  }): Promise<string>;
}

// --------------------------------------------------------------- snapshots --

export interface SnapshotStore {
  /**
   * Take a snapshot before a gated change.
   *
   * `args` is passed because the snapshot has to name what it captures, and
   * only the call's own arguments say which post, user, option or file that is.
   * The plugin captures exactly five things and there is no whole-site capture,
   * so for some tools no target can be constructed at all — those come back
   * `ok: false`, and the executor must refuse the call rather than run it
   * unprotected. A gate that reports "rollback available" over a snapshot of
   * nothing is worse than no gate, because it is the thing an approver checks.
   */
  create(input: {
    organizationId: string;
    siteId: string;
    tool: string;
    args: Record<string, unknown>;
    reason: string;
  }): Promise<{ readonly ok: true; readonly id: string } | { readonly ok: false; readonly reason: string }>;
}

// ------------------------------------------------------------- concurrency --

export interface ConcurrencyLock {
  /** Returns a release function, or null when the lock is held. */
  acquire(key: string, ttlMs: number): Promise<(() => Promise<void>) | null>;
}

// ---------------------------------------------------------------- transport --

export interface TransportRequest {
  /**
   * Carried so the transport can scope its own credential lookup rather than
   * trusting that `siteId` was authorised upstream. A transport holds a
   * root-equivalent credential for every connected site, so one missed check on
   * one caller path would be cross-tenant code execution — the one failure the
   * threat model opens with. Cheap to pass; not cheap to omit.
   */
  readonly organizationId: string;
  readonly siteId: string;
  readonly contract: ToolContract;
  readonly args: Record<string, unknown>;
  readonly requestId: string;
  readonly timeoutMs: number;
  readonly snapshotId?: string;
}

export type TransportResult =
  | { readonly ok: true; readonly data: unknown }
  | {
      readonly ok: false;
      /** Distinguishes "we never reached the site" from "the site said no". */
      readonly kind: "unreachable" | "site_error" | "timeout" | "too_large" | "bad_signature";
      readonly message: string;
      readonly status?: number;
    };

export interface Transport {
  call(request: TransportRequest): Promise<TransportResult>;
}

// -------------------------------------------------------------------- audit --

export interface AuditEntry {
  readonly id: string;
  readonly organizationId: string;
  readonly siteId: string | null;
  readonly actorId: string;
  readonly actorType: "user" | "api_key" | "mcp_session" | "service_account" | "scheduler" | "system";
  readonly tool: string;
  /** The effective scope used, or null when the call was denied before scope resolution. */
  readonly scopeUsed: string | null;
  /** sha256(canonical(args)). Never the arguments. */
  readonly requestDigest: string;
  readonly idempotencyKey: string | null;
  readonly requestId: string;
  readonly outcome: ActionOutcome;
  readonly durationMs: number;
  readonly actionsConsumed: number;
  readonly approvalId?: string;
  readonly snapshotId?: string;
  readonly errorClass?: string;
  readonly createdAt: number;
}

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
}

export interface ExecutorPorts {
  readonly idempotency: IdempotencyStore;
  readonly metering: MeteringStore;
  readonly approvals: ApprovalStore;
  readonly snapshots: SnapshotStore;
  readonly locks: ConcurrencyLock;
  readonly transport: Transport;
  readonly audit: AuditLog;
  /** Injected so tests are deterministic. */
  readonly now: () => number;
  readonly newId: () => string;
}
