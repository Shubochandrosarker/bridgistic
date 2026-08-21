/**
 * The ActionExecutor.
 *
 * One pipeline. MCP, the REST API, the scheduler and the dashboard all call
 * this, and none of them implements any part of it. That is not a tidiness
 * preference — three implementations of an approval gate is three chances to
 * get it wrong, and the one that is wrong will be the one nobody tested
 * because it was "the same as the others".
 *
 * The order in `execute` is the order in `SECURITY_MODEL.md`, and it matters
 * in both directions:
 *
 *   Cheap denials first.  Authorisation before schema, schema before
 *                         reservation, reservation before the site is touched.
 *                         A denied call must cost nothing and reveal nothing.
 *
 *   Effects last, and     Claim the idempotency key, reserve the quota, take
 *   in an order that      the lock, take the snapshot — THEN call. Every one
 *   can be unwound.       of those is releasable; the site call is not.
 *
 * ## The part that is easy to get wrong
 *
 * Failure handling. Each acquired resource has exactly one owner responsible
 * for releasing it, and the release runs whether the call succeeded, failed,
 * or threw. A reservation leaked because a handler returned early is quota a
 * customer paid for and never got back — and it is invisible until the month
 * ends.
 */

import { assertCallable, contractFor } from "@bridgistic/contracts";
import type { CallerContext, ToolContract, ErrorCode } from "@bridgistic/contracts";
import { requestDigest, actionsConsumed, FAILED_CALL_WEIGHT } from "@bridgistic/tools";
import { snapshotOperationClass } from "@bridgistic/types";
import { can, permissionForRiskClass } from "@bridgistic/identity";
import type { Role } from "@bridgistic/identity";
import type { Logger } from "@bridgistic/observability";
import type { ExecutorPorts, Reservation } from "./ports.ts";

export interface ExecuteRequest {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly caller: CallerContext & {
    readonly role: Role;
    readonly actorType: "user" | "api_key" | "service_account" | "scheduler" | "system";
  };
  readonly siteId: string | null;
  readonly requestId: string;
}

export type ExecuteResult =
  | {
      readonly ok: true;
      readonly data: unknown;
      readonly requestId: string;
      readonly actionsConsumed: number;
      readonly snapshotId?: string;
      readonly dryRun?: boolean;
      readonly replayed?: boolean;
    }
  | {
      readonly ok: false;
      readonly error: ErrorCode;
      readonly message: string;
      readonly requestId: string;
      readonly actionsConsumed: number;
      readonly approvalId?: string;
      readonly retryAfterMs?: number;
      readonly validationErrors?: readonly { readonly path: string; readonly message: string }[];
    };

export class ActionExecutor {
  readonly #ports: ExecutorPorts;
  readonly #log: Logger;

  constructor(ports: ExecutorPorts, log: Logger) {
    this.#ports = ports;
    this.#log = log;
  }

  async execute(request: ExecuteRequest): Promise<ExecuteResult> {
    const startedAt = this.#ports.now();
    const log = this.#log.child({
      requestId: request.requestId,
      organizationId: request.caller.organizationId,
      siteId: request.siteId ?? undefined,
      actorId: request.caller.actorId,
      actorType: request.caller.actorType,
      tool: request.tool,
    });

    // --- 1. Authorisation ---------------------------------------------------
    // Before anything is claimed, reserved or locked. A denied call must cost
    // nothing: no quota, no lock, no row.
    const verdict = assertCallable(request.tool, request.args, request.caller);
    if (!verdict.ok) {
      // An approval-required denial is not a failure — it is the gate doing its
      // job — so it creates the approval rather than telling the caller to go
      // and find one.
      if (verdict.code === "approval_required") {
        return this.#requestApproval(request, startedAt, log);
      }
      return this.#deny(request, verdict.code, verdict.message, startedAt, log, verdict.validationErrors);
    }

    const contract = verdict.contract;

    // --- 2. Role -------------------------------------------------------------
    // Scope says the SITE allows this category of work. Role says this PERSON
    // may do it. Both, always — a Viewer on a site granted posts:write still
    // may not write, and the scope check above cannot see that.
    const permission = permissionForRiskClass(contract.riskClass);
    if (permission === null || !can(request.caller.role, permission)) {
      return this.#deny(
        request,
        "forbidden",
        `The ${request.caller.role} role cannot run ${request.tool}.`,
        startedAt,
        log
      );
    }

    // A site-touching tool needs a site. Reaching here without one is a bug in
    // the calling surface, not a customer error, but it must still not proceed.
    if (contract.route !== null && request.siteId === null) {
      return this.#deny(request, "invalid_request", "No site was selected for this call.", startedAt, log);
    }

    const digest = await requestDigest(request.tool, request.args);
    const dryRun = request.args.dry_run === true;

    // --- 3. Idempotency ------------------------------------------------------
    // Claimed BEFORE the side effect. A unique index prevents a duplicate row,
    // not a duplicate mutation: the row is written after the call, and the call
    // is what must not happen twice.
    const idempotencyKey = typeof request.args.idempotency_key === "string" ? request.args.idempotency_key : null;
    if (idempotencyKey !== null) {
      const outcome = await this.#ports.idempotency.claim({
        key: idempotencyKey,
        requestHash: digest,
        organizationId: request.caller.organizationId,
        siteId: request.siteId,
        actorId: request.caller.actorId,
        tool: request.tool,
        createdAt: this.#ports.now(),
      });

      if (outcome.kind === "replay") {
        log.info("replayed a completed call", { outcome: "success" });
        return {
          ok: true,
          data: outcome.result,
          requestId: request.requestId,
          actionsConsumed: 0,
          replayed: true,
        };
      }
      if (outcome.kind === "in_flight") {
        return this.#deny(
          request,
          "conflict",
          "An identical call is already running. Wait for it rather than sending it again.",
          startedAt,
          log
        );
      }
      if (outcome.kind === "conflict") {
        // Reusing a key for a different request is not a retry. Treating it as
        // one would return the first call's result for the second call's
        // arguments, which is worse than either outcome the caller expected.
        return this.#deny(
          request,
          "idempotency_conflict",
          "That idempotency key was already used for a different request. Use a new key.",
          startedAt,
          log
        );
      }
    }

    // Everything below here may need unwinding. Tracked so that exactly one
    // owner releases each, exactly once, on every path out.
    let reservation: Reservation | null = null;
    let releaseLock: (() => Promise<void>) | null = null;
    let snapshotId: string | undefined;
    let settled = false;

    const cost = actionsConsumed(request.tool, "success", request.caller.siteScopes);

    try {
      // --- 4. Meter --------------------------------------------------------
      // Reserved before the call, not counted after. Counting after is how an
      // organization ends up at 100.4% of its plan with nobody able to say
      // which call crossed the line. A dry run changes nothing and is free.
      if (!dryRun && contract.meterUnit === "action") {
        const admission = await this.#ports.metering.reserve({
          organizationId: request.caller.organizationId,
          cost,
          idempotencyKey: idempotencyKey ?? `${request.requestId}:${digest}`,
        });
        if (!admission.admitted) {
          await this.#settleClaim(idempotencyKey, "failed");
          return this.#deny(
            request,
            admission.reason,
            admission.reason === "quota_exceeded"
              ? "This organization has used its actions for the period."
              : "Too many requests. Slow down.",
            startedAt,
            log,
            undefined,
            admission.retryAfterMs
          );
        }
        reservation = admission.reservation;
      }

      // --- 5. Concurrency ---------------------------------------------------
      // Per site by default: two destructive calls against one WordPress
      // install at once is how a half-applied change happens.
      if (request.siteId !== null && !dryRun) {
        releaseLock = await this.#ports.locks.acquire(`site:${request.siteId}`, contract.timeoutMs + 5_000);
        if (releaseLock === null) {
          await this.#release(request.caller.organizationId, reservation);
          reservation = null;
          await this.#settleClaim(idempotencyKey, "failed");
          return this.#deny(
            request,
            "conflict",
            "Another call is running against this site. Try again shortly.",
            startedAt,
            log,
            undefined,
            1_000
          );
        }
      }

      // --- 6. Snapshot ------------------------------------------------------
      // Before the change, never after. A snapshot taken afterwards records
      // the damage rather than preventing it.
      if (contract.requiresSnapshot && request.siteId !== null && !dryRun) {
        const operationClass =
          request.tool === "bridgistic_snapshot_restore" || request.tool === "bridgistic_snapshot_delete"
            ? snapshotOperationClass(request.tool.endsWith("restore") ? "restore" : "delete")
            : contract.riskClass;

        const snapshot = await this.#ports.snapshots.create({
          organizationId: request.caller.organizationId,
          siteId: request.siteId,
          tool: request.tool,
          args: request.args,
          reason: `${operationClass} operation`,
        });

        if (!snapshot.ok) {
          // The tool's class requires a way back and there is none. Running
          // anyway would be the gate reporting a rollback path that does not
          // exist — to the approver who cleared the call on that basis. Refused,
          // and everything taken so far is released by the normal path.
          await this.#settleClaim(idempotencyKey, "failed");
          await this.#release(request.caller.organizationId, reservation);
          reservation = null;
          return this.#deny(request, "snapshot_required", snapshot.reason, startedAt, log);
        }

        snapshotId = snapshot.id;
      }

      // --- 7. Call ----------------------------------------------------------
      const result = await this.#ports.transport.call({
        organizationId: request.caller.organizationId,
        siteId: request.siteId ?? "",
        contract,
        args: request.args,
        requestId: request.requestId,
        timeoutMs: contract.timeoutMs,
        ...(snapshotId ? { snapshotId } : {}),
      });

      const durationMs = this.#ports.now() - startedAt;

      if (result.ok) {
        // --- 8. Settle ------------------------------------------------------
        if (reservation) await this.#ports.metering.settle({
            organizationId: request.caller.organizationId,
            reservationId: reservation.id,
            actual: reservation.cost,
          });
        settled = true;
        await this.#settleClaim(idempotencyKey, "succeeded", result.data);

        await this.#ports.audit.record({
          id: this.#ports.newId(),
          organizationId: request.caller.organizationId,
          siteId: request.siteId,
          actorId: request.caller.actorId,
          actorType: request.caller.actorType,
          tool: request.tool,
          requestDigest: digest,
          outcome: "success",
          durationMs,
          actionsConsumed: reservation?.cost ?? 0,
          ...(snapshotId ? { snapshotId } : {}),
          createdAt: this.#ports.now(),
        });

        log.info("call completed", { outcome: "success", durationMs, requestDigest: digest });
        return {
          ok: true,
          data: result.data,
          requestId: request.requestId,
          actionsConsumed: reservation?.cost ?? 0,
          ...(snapshotId ? { snapshotId } : {}),
          ...(dryRun ? { dryRun: true } : {}),
        };
      }

      // --- 9. Failure -------------------------------------------------------
      // A call that never reached the site costs nothing. One that reached it
      // and failed there consumed a request, so it is charged at the read rate
      // — otherwise a broken loop is an unmetered one.
      const reachedSite = result.kind !== "unreachable";
      const charged = reachedSite ? FAILED_CALL_WEIGHT : 0;

      if (reservation) {
        if (charged > 0) {
          await this.#ports.metering.settle({
            organizationId: request.caller.organizationId,
            reservationId: reservation.id,
            actual: charged,
          });
        } else {
          await this.#ports.metering.release({
            organizationId: request.caller.organizationId,
            reservationId: reservation.id,
          });
        }
      }
      settled = true;
      await this.#settleClaim(idempotencyKey, "failed");

      const outcome = result.kind === "timeout" ? "timeout" : "failed";
      await this.#ports.audit.record({
        id: this.#ports.newId(),
        organizationId: request.caller.organizationId,
        siteId: request.siteId,
        actorId: request.caller.actorId,
        actorType: request.caller.actorType,
        tool: request.tool,
        requestDigest: digest,
        outcome,
        durationMs,
        actionsConsumed: charged,
        ...(snapshotId ? { snapshotId } : {}),
        errorClass: result.kind,
        createdAt: this.#ports.now(),
      });

      log.warn("call failed", { outcome, durationMs, errorClass: result.kind });
      return {
        ok: false,
        error: transportErrorCode(result.kind),
        // The transport's own message, which is written to be safe to show.
        // Site content and credentials never reach it — the transport is
        // responsible for that, and the redaction in the logger is the backstop.
        message: result.message,
        requestId: request.requestId,
        actionsConsumed: charged,
      };
    } catch (error) {
      // --- 10. Something threw ----------------------------------------------
      // The reservation is released rather than settled: we do not know
      // whether the site was reached, and charging for a call we cannot
      // account for is the wrong side to err on.
      if (reservation && !settled) await this.#release(request.caller.organizationId, reservation);
      await this.#settleClaim(idempotencyKey, "failed");

      log.error("executor threw", error, { outcome: "failed" });
      return {
        ok: false,
        error: "internal",
        message: "The call could not be completed.",
        requestId: request.requestId,
        actionsConsumed: 0,
      };
    } finally {
      // The lock is released on every path, including the throw. A lock held
      // by a crashed handler blocks a site until its TTL expires.
      if (releaseLock) await releaseLock().catch(() => undefined);
    }
  }

  // ------------------------------------------------------------- helpers ----

  async #requestApproval(request: ExecuteRequest, startedAt: number, log: Logger): Promise<ExecuteResult> {
    const digest = await requestDigest(request.tool, request.args);
    const approvalId = await this.#ports.approvals.request({
      organizationId: request.caller.organizationId,
      siteId: request.siteId,
      actorId: request.caller.actorId,
      actorType: request.caller.actorType,
      tool: request.tool,
      // The conjunction, recorded as it was asked for. An approver reading
      // "db:write" needs to see every scope the call will use, not the first.
      scopeRequested: (contractFor(request.tool)?.requiredScopes ?? []).join(" "),
      requestHash: digest,
      // What is about to happen, not the arguments. An approver needs to know
      // "run SQL against this site"; the statement itself would put customer
      // data in an inbox.
      summary: `${request.tool}${request.siteId ? ` on site ${request.siteId}` : ""}`,
    });

    await this.#ports.audit.record({
      id: this.#ports.newId(),
      organizationId: request.caller.organizationId,
      siteId: request.siteId,
      actorId: request.caller.actorId,
      actorType: request.caller.actorType,
      tool: request.tool,
      requestDigest: digest,
      outcome: "denied",
      durationMs: this.#ports.now() - startedAt,
      actionsConsumed: 0,
      approvalId,
      createdAt: this.#ports.now(),
    });

    log.info("approval requested", { outcome: "denied", actionId: approvalId });
    return {
      ok: false,
      error: "approval_required",
      message: "This call needs an approver to sign off. Re-send it with the approval_id once granted.",
      requestId: request.requestId,
      actionsConsumed: 0,
      approvalId,
    };
  }

  async #deny(
    request: ExecuteRequest,
    code: ErrorCode,
    message: string,
    startedAt: number,
    log: Logger,
    validationErrors?: readonly { readonly path: string; readonly message: string }[],
    retryAfterMs?: number
  ): Promise<ExecuteResult> {
    // A denial is audited. "Somebody tried to run php:execute and was refused"
    // is exactly what an incident review needs, and it is invisible if only
    // successes are recorded.
    await this.#ports.audit.record({
      id: this.#ports.newId(),
      organizationId: request.caller.organizationId,
      siteId: request.siteId,
      actorId: request.caller.actorId,
      actorType: request.caller.actorType,
      tool: request.tool,
      requestDigest: await requestDigest(request.tool, request.args),
      outcome: "denied",
      durationMs: this.#ports.now() - startedAt,
      actionsConsumed: 0,
      errorClass: code,
      createdAt: this.#ports.now(),
    });

    log.info("call denied", { outcome: "denied", errorClass: code });
    return {
      ok: false,
      error: code,
      message,
      requestId: request.requestId,
      actionsConsumed: 0,
      ...(validationErrors ? { validationErrors } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }

  async #release(organizationId: string, reservation: Reservation | null): Promise<void> {
    if (reservation) {
      await this.#ports.metering
        .release({ organizationId, reservationId: reservation.id })
        .catch(() => undefined);
    }
  }

  async #settleClaim(key: string | null, state: "succeeded" | "failed", result?: unknown): Promise<void> {
    if (key === null) return;
    await this.#ports.idempotency.settle(key, state, result).catch(() => undefined);
  }
}

function transportErrorCode(kind: string): ErrorCode {
  switch (kind) {
    case "unreachable":
      return "site_unreachable";
    case "timeout":
      return "timeout";
    case "too_large":
      return "response_too_large";
    // A signature failure means the response did not come from the credential
    // we hold for that site. Reported as a site error rather than as a
    // generic failure, because it is the signal a DNS rebind would produce.
    case "bad_signature":
      return "site_error";
    default:
      return "site_error";
  }
}

/** Re-exported so a caller can name the type without depending on ports.ts. */
export type { ExecutorPorts } from "./ports.ts";
