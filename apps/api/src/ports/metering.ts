/**
 * The metering port, backed by the `UsageCounter` Durable Object.
 *
 * The object is the serialization point: one counter per organization and
 * billing period, so two concurrent calls cannot both see room under the limit
 * and both take it. That is the whole reason this is a Durable Object rather
 * than a D1 row.
 *
 * ## The plan is read here, not passed in
 *
 * `MeteringStore.reserve` takes no plan, and `UsageCounter` requires one — it
 * derives the LIMIT from it. The adapter closes that gap by reading the plan
 * from D1 under the organization's own row. That is deliberate: a plan that
 * arrived with the request is a limit the caller chose, and `SECURITY_MODEL.md`
 * §9 requires cost, limit, period, plan and entitlement to be derived
 * server-side from canonical data.
 *
 * An organization with no subscription row reads as `free`, which is the
 * smallest limit rather than an absent one. Default deny applies to quota too:
 * a missing record must not mean "unmetered".
 */

import type { MeteringStore, AdmissionOutcome } from "@bridgistic/executor";
import { counterName, periodFor } from "../usage-counter.ts";
import { PLAN_IDS } from "@bridgistic/types";
import type { PlanId } from "@bridgistic/types";
import type { SqlDatabase } from "../db/scope.ts";

/** The subset of the DO namespace this adapter needs, so a test can supply it. */
export interface CounterNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> };
}

interface ReserveReply {
  readonly admitted: boolean;
  readonly reservationId: string;
  readonly verdict?: { readonly state?: string; readonly resetAt?: number };
  readonly error?: string;
}

export interface DurableMeteringStoreOptions {
  readonly counters: CounterNamespace;
  readonly db: SqlDatabase;
  readonly now?: () => number;
}

export class DurableMeteringStore implements MeteringStore {
  readonly #counters: CounterNamespace;
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(options: DurableMeteringStoreOptions) {
    this.#counters = options.counters;
    this.#db = options.db;
    this.#now = options.now ?? (() => Date.now());
  }

  async reserve(input: {
    organizationId: string;
    cost: number;
    idempotencyKey: string;
  }): Promise<AdmissionOutcome> {
    const plan = await this.#planFor(input.organizationId);
    const period = periodFor(this.#now());

    const reply = await this.#call<ReserveReply>(counterName(input.organizationId, period), "/reserve", {
      cost: input.cost,
      plan,
      idempotencyKey: input.idempotencyKey,
    });

    // A counter that cannot be reached, or answers with something this adapter
    // does not understand, denies. The alternative is admitting an unmetered
    // call every time the object is unavailable, which turns an outage into
    // free unlimited execution.
    if (!reply || reply.admitted !== true || typeof reply.reservationId !== "string" || !reply.reservationId) {
      const retryAfterMs = resetDelay(reply?.verdict?.resetAt, this.#now());
      return {
        admitted: false,
        reason: reply?.verdict?.state === "rate_limited" ? "rate_limited" : "quota_exceeded",
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    }

    return {
      admitted: true,
      // The period is part of the private handle so a call crossing a billing
      // boundary settles/releases against the same counter that admitted it.
      // The raw DO reservation id never leaves this adapter.
      reservation: { id: `${period}.${reply.reservationId}`, cost: input.cost },
    };
  }

  async settle(input: { organizationId: string; reservationId: string; actual: number }): Promise<void> {
    const handle = parseReservationHandle(input.reservationId, this.#now());
    await this.#call(counterName(input.organizationId, handle.period), "/settle", {
      reservationId: handle.reservationId,
      actual: input.actual,
    });
  }

  async release(input: { organizationId: string; reservationId: string }): Promise<void> {
    const handle = parseReservationHandle(input.reservationId, this.#now());
    await this.#call(counterName(input.organizationId, handle.period), "/release", {
      reservationId: handle.reservationId,
    });
  }

  /**
   * The organization's plan, from its own subscription row.
   *
   * Only an `active` or `trialing` subscription carries its plan. A past-due
   * or cancelled subscription falls back to `free` rather than keeping the paid
   * limit, so an unpaid account degrades to the free tier instead of retaining
   * whatever it last paid for.
   */
  async #planFor(organizationId: string): Promise<PlanId> {
    const row = await this.#db
      .prepare(
        `SELECT plan FROM subscriptions
          WHERE organization_id = ? AND status IN ('active','trialing')
          LIMIT 1`
      )
      .bind(organizationId)
      .first<{ plan: string }>();

    return isPlanId(row?.plan) ? row.plan : "free";
  }

  async #call<T>(counter: string, path: string, body: unknown): Promise<T | undefined> {
    const stub = this.#counters.get(this.#counters.idFromName(counter));
    try {
      const response = await stub.fetch(
        new Request(`https://usage-counter.internal${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      );
      if (!response.ok) return undefined;
      return (await response.json()) as T;
    } catch {
      // Swallowed rather than propagated: `reserve` turns an absent reply into
      // a denial, and `settle`/`release` are best-effort — a reservation the
      // adapter could not settle expires on the counter's own alarm, so the
      // quota comes back either way.
      return undefined;
    }
  }
}

function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && (PLAN_IDS as readonly string[]).includes(value);
}

function resetDelay(resetAt: number | undefined, now: number): number | undefined {
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) return undefined;
  const delay = resetAt - now;
  return delay > 0 ? delay : undefined;
}

interface ReservationHandle {
  readonly period: string;
  readonly reservationId: string;
}

function parseReservationHandle(value: string, now: number): ReservationHandle {
  const separator = value.indexOf(".");
  const period = separator > 0 ? value.slice(0, separator) : "";
  const reservationId = separator > 0 ? value.slice(separator + 1) : value;
  // Unprefixed handles remain readable for a short compatibility window after
  // deploy, but new reservations always carry their period. Invalid handles
  // fail closed against the current counter rather than becoming a new route.
  return /^\d{4}-(?:0[1-9]|1[0-2])$/.test(period) && reservationId !== ""
    ? { period, reservationId }
    : { period: periodFor(now), reservationId: value };
}
