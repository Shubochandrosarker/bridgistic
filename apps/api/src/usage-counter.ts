/**
 * The meter: one Durable Object per (organization, billing period).
 *
 * A Durable Object gives a single serialised writer per instance, so N
 * concurrent tool calls produce exactly N counted actions. KV cannot: the free
 * repo's own docs say its KV rate limiting is "approximate — roughly the
 * configured limit per colo … inadequate as a billing-grade counter", and a
 * meter you cannot defend in a billing dispute is not a meter.
 *
 * ## BR-004 — what was wrong, and what changed
 *
 * The first version took `limit` and `periodEndMs` from the request body. That
 * is the whole billing decision arriving as an argument. Nothing between an
 * MCP client and this object was obliged to keep those honest, and a single
 * careless `...body` spread anywhere upstream would have made the quota
 * whatever the caller said it was.
 *
 * It is now impossible to express: there is no `limit` parameter. The caller
 * supplies a `plan`, and the limit is looked up from the shared plan catalogue
 * inside this object. A caller cannot invent a number that does not exist in
 * `PLANS`, and if they send a plan they are not on, the worst they can do is
 * name a *different real plan* — which the API's own entitlement check has
 * already refused before it gets here.
 *
 * It also validated nothing. A negative `cost` decremented the meter; a
 * non-finite one made every comparison against it false, so `projected > limit`
 * was never true and the quota never applied. Both are now refused.
 *
 * And a reservation had no expiry. A call that crashed between reserve and
 * settle held its quota forever — permanently, silently, and invisibly until
 * the customer complained about a number nobody could explain. Reservations now
 * expire on an alarm.
 */

import { PLANS, isUnlimited } from "@bridgistic/types";
import type { PlanId } from "@bridgistic/types";
import { evaluateQuota } from "@bridgistic/tools";
import type { QuotaVerdict } from "@bridgistic/tools";

/**
 * How long a reservation may stay pending before it is reclaimed.
 *
 * Longer than the longest tool timeout (300s) plus room for the settle to land,
 * so a slow-but-alive call is never reclaimed underneath itself. Short enough
 * that a crashed one does not hold quota into next week.
 */
export const RESERVATION_TTL_MS = 600_000;

/** Sweep cadence. Cheap: it touches one key. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Ceiling on concurrently pending reservations.
 *
 * Not a rate limit — that lives elsewhere and is a separate control. This stops
 * a runaway loop from growing the stored object until writes start failing,
 * which would take the meter down for an organization rather than merely
 * throttling it.
 */
const MAX_PENDING = 10_000;

export interface ReserveRequest {
  /** What this call will consume if it succeeds. Must be a non-negative integer. */
  readonly cost: number;
  /** The organization's plan. The LIMIT is derived from this, never supplied. */
  readonly plan: PlanId;
  /** Deduplicates a retry of the same call. */
  readonly idempotencyKey: string;
}

export interface ReserveResponse {
  readonly admitted: boolean;
  readonly verdict: QuotaVerdict;
  readonly reservationId: string;
  /** Present when the request was rejected as malformed rather than over quota. */
  readonly error?: string;
}

interface PendingReservation {
  readonly cost: number;
  readonly reservedAt: number;
}

interface CounterState {
  consumed: number;
  pending: Record<string, PendingReservation>;
  /** Reservations reclaimed by the sweeper. Surfaced so leaks are visible. */
  expiredCount: number;
}

const EMPTY: CounterState = { consumed: 0, pending: {}, expiredCount: 0 };

export class UsageCounter implements DurableObject {
  readonly #state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.#state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/reserve":
          return this.#json(await this.#reserve(await request.json<ReserveRequest>()));
        case "/settle":
          return this.#json(await this.#settle(await request.json<{ reservationId: string; actual: number }>()));
        case "/release":
          return this.#json(await this.#release(await request.json<{ reservationId: string }>()));
        case "/read":
          return this.#json(await this.#read());
        default:
          return new Response("Not found", { status: 404 });
      }
    } catch (error) {
      // A malformed body must not take the meter down for the organization.
      // The message is generic: this object's errors are internal, and it has
      // no business shaping a customer-visible string.
      return this.#json({ error: "bad_request" }, 400);
    }
  }

  /**
   * Expire reservations whose calls never came back.
   *
   * The alarm is the crash-recovery path. Without it a killed Worker holds its
   * reservation forever, and the organization loses that quota permanently.
   */
  async alarm(): Promise<void> {
    await this.#state.blockConcurrencyWhile(async () => {
      const state = await this.#load();
      const cutoff = Date.now() - RESERVATION_TTL_MS;
      let expired = 0;

      for (const [key, reservation] of Object.entries(state.pending)) {
        if (reservation.reservedAt <= cutoff) {
          delete state.pending[key];
          expired++;
        }
      }

      if (expired > 0) {
        state.expiredCount += expired;
        await this.#state.storage.put("counter", state);
      }

      // Keep sweeping while anything is pending; stop when idle, so an inactive
      // counter costs nothing.
      if (Object.keys(state.pending).length > 0) {
        await this.#state.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
      }
    });
  }

  #json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  async #load(): Promise<CounterState> {
    const stored = await this.#state.storage.get<CounterState>("counter");
    return stored ? { ...stored, pending: { ...stored.pending } } : { ...EMPTY, pending: {} };
  }

  /**
   * Reserve BEFORE the call runs.
   *
   * A destructive call costs 5; letting it run and counting afterwards is how
   * an organization ends up at 100.4% of its plan and nobody can say which call
   * crossed the line.
   */
  async #reserve(req: ReserveRequest): Promise<ReserveResponse> {
    const invalid = validateCost(req?.cost) ?? validateKey(req?.idempotencyKey) ?? validatePlan(req?.plan);
    if (invalid) {
      return {
        admitted: false,
        // A malformed request is not "over quota" — but the response shape is
        // the same either way, so it carries a well-formed verdict rather than
        // a half-filled one a caller might read fields off.
        verdict: { state: "hard_limit", used: 0, limit: 0, remaining: 0, resetAt: endOfPeriod(Date.now()) },
        reservationId: "",
        error: invalid,
      };
    }

    // The limit comes from the catalogue, keyed by plan. There is no parameter
    // a caller could use to name a number of their own.
    const limit = PLANS[req.plan].actionsPerMonth;
    const periodEndMs = endOfPeriod(Date.now());

    return this.#state.blockConcurrencyWhile(async () => {
      const state = await this.#load();

      // A retry of the same call reuses its reservation rather than doubling
      // it. The reservation's own cost is kept — re-pricing a retry at a
      // different cost would let a caller lower a charge by retrying.
      const existing = state.pending[req.idempotencyKey];
      if (existing !== undefined) {
        return {
          admitted: true,
          verdict: evaluateQuota(this.#total(state), limit, periodEndMs),
          reservationId: req.idempotencyKey,
        };
      }

      if (Object.keys(state.pending).length >= MAX_PENDING) {
        return {
          admitted: false,
          verdict: evaluateQuota(this.#total(state), limit, periodEndMs),
          reservationId: "",
          error: "too_many_pending",
        };
      }

      const projected = this.#total(state) + req.cost;
      const verdict = evaluateQuota(projected, limit, periodEndMs);

      // `isUnlimited` rather than a sentinel: the Scale plan's limit is a real
      // number, but a plan whose limit is null must admit everything without
      // the comparison silently coercing null to 0.
      if (!isUnlimited(limit as number | null) && projected > limit) {
        return { admitted: false, verdict, reservationId: "" };
      }

      state.pending[req.idempotencyKey] = { cost: req.cost, reservedAt: Date.now() };
      await this.#state.storage.put("counter", state);

      // Arm the sweeper if it is not already running. Idempotent: setting an
      // alarm that already exists just moves it, and the sweep is cheap.
      const existingAlarm = await this.#state.storage.getAlarm();
      if (existingAlarm === null) {
        await this.#state.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
      }

      return { admitted: true, verdict, reservationId: req.idempotencyKey };
    });
  }

  /**
   * The call finished. `actual` may be lower than the reservation — a failed
   * call costs 1 rather than the 5 a destructive call reserved.
   *
   * It may never be HIGHER. Settling above the reservation would let a call
   * consume quota that was never admitted, which is the check that makes
   * reserve-then-settle meaningful rather than decorative.
   */
  async #settle(req: { reservationId: string; actual: number }): Promise<{ consumed: number; error?: string }> {
    const invalid = validateCost(req?.actual) ?? validateKey(req?.reservationId);
    if (invalid) return { consumed: -1, error: invalid };

    return this.#state.blockConcurrencyWhile(async () => {
      const state = await this.#load();
      const reservation = state.pending[req.reservationId];

      // Settling twice is a no-op rather than a double charge. A retried settle
      // after a dropped response must not bill again.
      if (reservation === undefined) return { consumed: state.consumed };

      if (req.actual > reservation.cost) {
        return { consumed: state.consumed, error: "actual_exceeds_reservation" };
      }

      delete state.pending[req.reservationId];
      state.consumed += req.actual;
      await this.#state.storage.put("counter", state);
      return { consumed: state.consumed };
    });
  }

  /** The call never happened. Costs nothing. */
  async #release(req: { reservationId: string }): Promise<{ consumed: number; error?: string }> {
    return this.#settle({ reservationId: req.reservationId, actual: 0 });
  }

  async #read(): Promise<{ consumed: number; pending: number; pendingCount: number; expiredCount: number }> {
    const state = await this.#load();
    return {
      consumed: state.consumed,
      pending: this.#total(state) - state.consumed,
      pendingCount: Object.keys(state.pending).length,
      // Surfaced so a leak is observable rather than merely absorbed. A rising
      // expiredCount means calls are dying between reserve and settle.
      expiredCount: state.expiredCount,
    };
  }

  #total(state: CounterState): number {
    return state.consumed + Object.values(state.pending).reduce((sum, r) => sum + r.cost, 0);
  }
}

/**
 * A cost must be a non-negative, finite, safe integer.
 *
 * Each clause is a real failure. Negative decrements the meter. NaN makes every
 * comparison false, so `projected > limit` never fires and the quota stops
 * existing. Infinity poisons the total permanently — one such reservation and
 * the organization can never make another call. A non-integer accumulates
 * float drift into a number that appears on an invoice.
 */
function validateCost(cost: unknown): string | undefined {
  if (typeof cost !== "number" || !Number.isFinite(cost)) return "cost_not_finite";
  if (!Number.isSafeInteger(cost)) return "cost_not_integer";
  if (cost < 0) return "cost_negative";
  if (cost > 1_000_000) return "cost_implausible";
  return undefined;
}

function validateKey(key: unknown): string | undefined {
  if (typeof key !== "string" || key.length === 0) return "key_missing";
  if (key.length > 256) return "key_too_long";
  return undefined;
}

function validatePlan(plan: unknown): string | undefined {
  if (typeof plan !== "string" || !(plan in PLANS)) return "unknown_plan";
  return undefined;
}

/**
 * End of the current UTC calendar month.
 *
 * Derived here rather than accepted as a parameter (BR-004). A caller-supplied
 * period end is a caller-supplied reset time, and a quota that resets whenever
 * the caller says is not a quota.
 */
export function endOfPeriod(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0);
}

/** The instance name. One counter per org per billing period, never per site. */
export function counterName(organizationId: string, period: string): string {
  return `${organizationId}:${period}`;
}

/** The period key for an instant, as `YYYY-MM`. */
export function periodFor(nowMs: number): string {
  const now = new Date(nowMs);
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
