/**
 * The meter: one Durable Object per (organization, billing period).
 *
 * A Durable Object gives a single serialised writer per instance, so N
 * concurrent tool calls produce exactly N counted actions. KV cannot: the free
 * repo's own `docs/CLOUD_CONNECTOR.md` says its KV rate limiting is
 * "approximate — roughly the configured limit per colo … inadequate as a
 * billing-grade counter", and a meter you cannot defend in a billing dispute is
 * not a meter.
 *
 * Phase 3 gate: 1 000 concurrent calls produce exactly 1 000 counted actions.
 */

import { evaluateQuota } from "@bridgistic/tools";
import type { QuotaVerdict } from "@bridgistic/tools";

export interface ReserveRequest {
  /** How much this call will consume if it succeeds. */
  cost: number;
  limit: number;
  periodEndMs: number;
  /** Deduplicates a retry of the same call. */
  idempotencyKey: string;
}

export interface ReserveResponse {
  admitted: boolean;
  verdict: QuotaVerdict;
  /** Echoed back so the caller can settle or release this exact reservation. */
  reservationId: string;
}

interface CounterState {
  consumed: number;
  /** Reserved but not yet settled, so a burst cannot oversell the quota. */
  pending: Record<string, number>;
}

const EMPTY: CounterState = { consumed: 0, pending: {} };

export class UsageCounter implements DurableObject {
  readonly #state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.#state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
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
  }

  #json(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
    });
  }

  async #load(): Promise<CounterState> {
    return (await this.#state.storage.get<CounterState>("counter")) ?? { ...EMPTY, pending: {} };
  }

  /**
   * Reserve BEFORE the call runs. A destructive call costs 5; letting it run
   * and counting afterwards is how an org ends up at 100.4% of its plan and
   * nobody can say which call crossed the line.
   */
  async #reserve(req: ReserveRequest): Promise<ReserveResponse> {
    return this.#state.blockConcurrencyWhile(async () => {
      const state = await this.#load();

      // A retry of the same call reuses its reservation rather than doubling it.
      const existing = state.pending[req.idempotencyKey];
      if (existing !== undefined) {
        const verdict = evaluateQuota(this.#total(state), req.limit, req.periodEndMs);
        return { admitted: true, verdict, reservationId: req.idempotencyKey };
      }

      const projected = this.#total(state) + req.cost;
      const verdict = evaluateQuota(projected, req.limit, req.periodEndMs);
      if (projected > req.limit) {
        return { admitted: false, verdict, reservationId: req.idempotencyKey };
      }

      state.pending[req.idempotencyKey] = req.cost;
      await this.#state.storage.put("counter", state);
      return { admitted: true, verdict, reservationId: req.idempotencyKey };
    });
  }

  /** The call finished. `actual` may be lower than the reservation (a failure costs 1). */
  async #settle(req: { reservationId: string; actual: number }): Promise<{ consumed: number }> {
    return this.#state.blockConcurrencyWhile(async () => {
      const state = await this.#load();
      if (state.pending[req.reservationId] !== undefined) {
        delete state.pending[req.reservationId];
        state.consumed += req.actual;
        await this.#state.storage.put("counter", state);
      }
      return { consumed: state.consumed };
    });
  }

  /** The call never happened (denied, rate-limited). Costs nothing. */
  async #release(req: { reservationId: string }): Promise<{ consumed: number }> {
    return this.#settle({ reservationId: req.reservationId, actual: 0 });
  }

  async #read(): Promise<{ consumed: number; pending: number }> {
    const state = await this.#load();
    return { consumed: state.consumed, pending: this.#total(state) - state.consumed };
  }

  #total(state: CounterState): number {
    return state.consumed + Object.values(state.pending).reduce((a, b) => a + b, 0);
  }
}

/** The instance name. One counter per org per billing period, never per site. */
export function counterName(organizationId: string, period: string): string {
  return `${organizationId}:${period}`;
}
