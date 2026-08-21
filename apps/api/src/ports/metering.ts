/**
 * The metering port, backed by the `UsageCounter` Durable Object.
 *
 * The object is the serialization point: one counter per organization, so two
 * concurrent calls cannot both see room under the limit and both take it. That
 * is the whole reason this is a Durable Object rather than a D1 row.
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

    const reply = await this.#call<ReserveReply>(input.organizationId, "/reserve", {
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

    return { admitted: true, reservation: { id: reply.reservationId, cost: input.cost } };
  }

  async settle(input: { organizationId: string; reservationId: string; actual: number }): Promise<void> {
    await this.#call(input.organizationId, "/settle", {
      reservationId: input.reservationId,
      actual: input.actual,
    });
  }

  async release(input: { organizationId: string; reservationId: string }): Promise<void> {
    await this.#call(input.organizationId, "/release", { reservationId: input.reservationId });
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

  async #call<T>(organizationId: string, path: string, body: unknown): Promise<T | undefined> {
    const stub = this.#counters.get(this.#counters.idFromName(organizationId));
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

const PLAN_IDS = new Set(["free", "starter", "pro", "agency", "scale"]);

function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && PLAN_IDS.has(value);
}

function resetDelay(resetAt: number | undefined, now: number): number | undefined {
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) return undefined;
  const delay = resetAt - now;
  return delay > 0 ? delay : undefined;
}
