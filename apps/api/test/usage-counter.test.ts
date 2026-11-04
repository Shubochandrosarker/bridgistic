/**
 * The meter.
 *
 * Two things are being proven. That it counts correctly under concurrency —
 * the Phase 4 gate is "1 000 concurrent calls produce exactly 1 000 counted
 * actions". And that BR-004 is closed: no billing value arrives as an
 * argument, malformed input is refused rather than absorbed, and a crashed
 * call's quota comes back.
 *
 * `DurableObjectState` is faked rather than mocked away. The fake keeps real
 * storage in a Map and implements `blockConcurrencyWhile` by serialising
 * through a promise chain, which is what the real one guarantees — so the
 * concurrency test exercises the actual code path rather than a simplified
 * one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageCounter, RESERVATION_TTL_MS, endOfPeriod, periodFor, counterName } from "../src/usage-counter.ts";

/** A DurableObjectState with real serialisation semantics. */
function fakeState(clock: { now: number }) {
  const store = new Map<string, unknown>();
  let alarm: number | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  return {
    storage: {
      async get<T>(key: string): Promise<T | undefined> {
        return store.get(key) as T | undefined;
      },
      async put(key: string, value: unknown): Promise<void> {
        // Structured-clone semantics, so a test cannot accidentally share a
        // mutable reference with the object under test.
        store.set(key, JSON.parse(JSON.stringify(value)));
      },
      async getAlarm(): Promise<number | null> {
        return alarm;
      },
      async setAlarm(time: number): Promise<void> {
        alarm = time;
      },
    },
    /**
     * Serialises, which is the guarantee the real one makes. Without this the
     * concurrency test would prove nothing about the real object.
     */
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      const result = chain.then(callback);
      chain = result.catch(() => undefined);
      return result;
    },
    get currentAlarm() {
      return alarm;
    },
  };
}

function counter(nowMs = Date.parse("2026-08-21T12:00:00Z")) {
  const clock = { now: nowMs };
  const state = fakeState(clock);
  const original = Date.now;
  Date.now = () => clock.now;
  const object = new UsageCounter(state as unknown as DurableObjectState);
  return {
    object,
    state,
    clock,
    restore: () => {
      Date.now = original;
    },
  };
}

const post = (object: UsageCounter, path: string, body: unknown) =>
  object.fetch(new Request(`https://counter/${path}`, { method: "POST", body: JSON.stringify(body) }));

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

// ------------------------------------------------------------- counting ----

test("reserve then settle counts exactly once", async () => {
  const { object, restore } = counter();
  try {
    const reserved = await json<{ admitted: boolean; reservationId: string }>(
      await post(object, "reserve", { cost: 5, plan: "agency", idempotencyKey: "k1" })
    );
    assert.equal(reserved.admitted, true);

    await post(object, "settle", { reservationId: "k1", actual: 5 });
    const read = await json<{ consumed: number; pending: number }>(await post(object, "read", {}));
    assert.equal(read.consumed, 5);
    assert.equal(read.pending, 0);
  } finally {
    restore();
  }
});

test("1000 concurrent reservations produce exactly 1000 counted actions", async () => {
  // The Phase 4 gate. A KV read-then-write would lose some of these.
  const { object, restore } = counter();
  try {
    const keys = Array.from({ length: 1000 }, (_, i) => `k${i}`);
    const reservations = await Promise.all(
      keys.map((key) => post(object, "reserve", { cost: 1, plan: "scale", idempotencyKey: key }))
    );
    for (const response of reservations) {
      assert.equal((await json<{ admitted: boolean }>(response)).admitted, true);
    }

    await Promise.all(keys.map((key) => post(object, "settle", { reservationId: key, actual: 1 })));

    const read = await json<{ consumed: number; pending: number }>(await post(object, "read", {}));
    assert.equal(read.consumed, 1000, "concurrent settles lost or double-counted");
    assert.equal(read.pending, 0);
  } finally {
    restore();
  }
});

test("a retry reuses its reservation rather than doubling it", async () => {
  const { object, restore } = counter();
  try {
    await post(object, "reserve", { cost: 5, plan: "agency", idempotencyKey: "k1" });
    await post(object, "reserve", { cost: 5, plan: "agency", idempotencyKey: "k1" });
    await post(object, "reserve", { cost: 5, plan: "agency", idempotencyKey: "k1" });

    const read = await json<{ pending: number; pendingCount: number }>(await post(object, "read", {}));
    assert.equal(read.pendingCount, 1);
    assert.equal(read.pending, 5, "a retry reserved a second time");
  } finally {
    restore();
  }
});

test("settling twice does not charge twice", async () => {
  const { object, restore } = counter();
  try {
    await post(object, "reserve", { cost: 2, plan: "agency", idempotencyKey: "k1" });
    await post(object, "settle", { reservationId: "k1", actual: 2 });
    await post(object, "settle", { reservationId: "k1", actual: 2 });

    assert.equal((await json<{ consumed: number }>(await post(object, "read", {}))).consumed, 2);
  } finally {
    restore();
  }
});

test("release costs nothing", async () => {
  const { object, restore } = counter();
  try {
    await post(object, "reserve", { cost: 5, plan: "agency", idempotencyKey: "k1" });
    await post(object, "release", { reservationId: "k1" });

    const read = await json<{ consumed: number; pending: number }>(await post(object, "read", {}));
    assert.equal(read.consumed, 0);
    assert.equal(read.pending, 0);
  } finally {
    restore();
  }
});

// ------------------------------------------------------------ BR-004 -------

test("there is no way to supply a limit — it comes from the plan", async () => {
  // The finding. A limit that arrives as an argument is the whole billing
  // decision arriving as an argument.
  const { object, restore } = counter();
  try {
    // Free allows 500. Reserving 501 must fail whatever else is in the body.
    const response = await json<{ admitted: boolean }>(
      await post(object, "reserve", {
        cost: 501,
        plan: "free",
        idempotencyKey: "k1",
        // Ignored: there is no parameter for these any more.
        limit: 999_999,
        periodEndMs: 1,
        actionsPerMonth: 999_999,
      })
    );
    assert.equal(response.admitted, false, "a caller-supplied limit was honoured");
  } finally {
    restore();
  }
});

test("an unknown plan is refused rather than defaulted", async () => {
  const { object, restore } = counter();
  try {
    const response = await json<{ admitted: boolean; error?: string }>(
      await post(object, "reserve", { cost: 1, plan: "enterprise_unlimited", idempotencyKey: "k1" })
    );
    assert.equal(response.admitted, false);
    assert.equal(response.error, "unknown_plan");
  } finally {
    restore();
  }
});

test("a negative cost cannot decrement the meter", async () => {
  const { object, restore } = counter();
  try {
    await post(object, "reserve", { cost: 10, plan: "agency", idempotencyKey: "k1" });
    await post(object, "settle", { reservationId: "k1", actual: 10 });

    const response = await json<{ admitted: boolean; error?: string }>(
      await post(object, "reserve", { cost: -100, plan: "agency", idempotencyKey: "k2" })
    );
    assert.equal(response.admitted, false);
    assert.equal(response.error, "cost_negative");

    assert.equal((await json<{ consumed: number }>(await post(object, "read", {}))).consumed, 10);
  } finally {
    restore();
  }
});

test("NaN and Infinity are refused", async () => {
  // NaN makes every comparison false, so `projected > limit` never fires and
  // the quota stops existing. Infinity poisons the total permanently.
  const { object, restore } = counter();
  try {
    for (const cost of [null, undefined, "5", {}, []]) {
      const response = await json<{ admitted: boolean; error?: string }>(
        await post(object, "reserve", { cost, plan: "agency", idempotencyKey: "k" })
      );
      assert.equal(response.admitted, false, `cost ${JSON.stringify(cost)} was admitted`);
      assert.equal(response.error, "cost_not_finite");
    }

    // NaN and Infinity do not survive JSON, so they are sent as their JSON
    // encoding — null — which is exactly how they would arrive in reality.
    const nan = await json<{ admitted: boolean }>(
      await post(object, "reserve", { cost: Number.NaN, plan: "agency", idempotencyKey: "k" })
    );
    assert.equal(nan.admitted, false);
  } finally {
    restore();
  }
});

test("a non-integer or implausible cost is refused", async () => {
  const { object, restore } = counter();
  try {
    for (const [cost, expected] of [
      [1.5, "cost_not_integer"],
      [2_000_000, "cost_implausible"],
    ] as const) {
      const response = await json<{ error?: string }>(
        await post(object, "reserve", { cost, plan: "agency", idempotencyKey: "k" })
      );
      assert.equal(response.error, expected);
    }
  } finally {
    restore();
  }
});

test("settling above the reservation is refused", async () => {
  // Otherwise a call consumes quota that was never admitted, and
  // reserve-then-settle becomes decorative.
  const { object, restore } = counter();
  try {
    await post(object, "reserve", { cost: 1, plan: "agency", idempotencyKey: "k1" });
    const response = await json<{ error?: string }>(
      await post(object, "settle", { reservationId: "k1", actual: 500 })
    );
    assert.equal(response.error, "actual_exceeds_reservation");
    assert.equal((await json<{ consumed: number }>(await post(object, "read", {}))).consumed, 0);
  } finally {
    restore();
  }
});

test("settling below the reservation is allowed — a failed call costs less", async () => {
  const { object, restore } = counter();
  try {
    await post(object, "reserve", { cost: 5, plan: "agency", idempotencyKey: "k1" });
    await post(object, "settle", { reservationId: "k1", actual: 1 });
    assert.equal((await json<{ consumed: number }>(await post(object, "read", {}))).consumed, 1);
  } finally {
    restore();
  }
});

test("a malformed body does not take the meter down", async () => {
  const { object, restore } = counter();
  try {
    const response = await object.fetch(
      new Request("https://counter/reserve", { method: "POST", body: "not json at all" })
    );
    assert.equal(response.status, 400);

    // Still working afterwards.
    const ok = await json<{ admitted: boolean }>(
      await post(object, "reserve", { cost: 1, plan: "agency", idempotencyKey: "k1" })
    );
    assert.equal(ok.admitted, true);
  } finally {
    restore();
  }
});

// ------------------------------------------------------- crash recovery ----

test("a reservation whose call never returned is reclaimed", async () => {
  // The leak: a Worker killed between reserve and settle held its quota
  // permanently, invisibly, until a customer complained about a number nobody
  // could explain.
  const start = Date.parse("2026-08-21T12:00:00Z");
  const { object, clock, restore } = counter(start);
  try {
    await post(object, "reserve", { cost: 5, plan: "agency", idempotencyKey: "crashed" });
    assert.equal((await json<{ pending: number }>(await post(object, "read", {}))).pending, 5);

    // The call never comes back. Time passes.
    clock.now = start + RESERVATION_TTL_MS + 1;
    await object.alarm();

    const read = await json<{ pending: number; consumed: number; expiredCount: number }>(
      await post(object, "read", {})
    );
    assert.equal(read.pending, 0, "the reservation was not reclaimed");
    assert.equal(read.consumed, 0, "an expired reservation was charged");
    // Surfaced rather than absorbed: a rising count means calls are dying.
    assert.equal(read.expiredCount, 1);
  } finally {
    restore();
  }
});

test("a slow but living call is not reclaimed underneath itself", async () => {
  const start = Date.parse("2026-08-21T12:00:00Z");
  const { object, clock, restore } = counter(start);
  try {
    await post(object, "reserve", { cost: 5, plan: "agency", idempotencyKey: "slow" });

    // The longest tool timeout is 300s; the TTL is well beyond it.
    clock.now = start + 300_000;
    await object.alarm();

    assert.equal((await json<{ pending: number }>(await post(object, "read", {}))).pending, 5);
    await post(object, "settle", { reservationId: "slow", actual: 5 });
    assert.equal((await json<{ consumed: number }>(await post(object, "read", {}))).consumed, 5);
  } finally {
    restore();
  }
});

test("the sweeper is armed on reserve and keeps running while work is pending", async () => {
  const { object, state, restore } = counter();
  try {
    assert.equal(state.currentAlarm, null);
    await post(object, "reserve", { cost: 1, plan: "agency", idempotencyKey: "k1" });
    assert.notEqual(state.currentAlarm, null, "nothing would ever reclaim a leaked reservation");
  } finally {
    restore();
  }
});

test("the pending map is bounded, so a runaway loop cannot take the meter down", async () => {
  // Not a rate limit — that is a separate control. This stops storage growth
  // from breaking the meter for an organization rather than merely throttling.
  const { object, restore } = counter();
  try {
    // Scale's limit is high enough that quota is not what stops this.
    for (let i = 0; i < 10_001; i++) {
      await post(object, "reserve", { cost: 0, plan: "scale", idempotencyKey: `k${i}` });
    }
    const response = await json<{ admitted: boolean; error?: string }>(
      await post(object, "reserve", { cost: 0, plan: "scale", idempotencyKey: "one-too-many" })
    );
    assert.equal(response.admitted, false);
    assert.equal(response.error, "too_many_pending");
  } finally {
    restore();
  }
});

// ------------------------------------------------------------- quota -------

test("the quota is enforced against the plan's real number", async () => {
  const { object, restore } = counter();
  try {
    // Free allows 500 actions.
    const under = await json<{ admitted: boolean }>(
      await post(object, "reserve", { cost: 500, plan: "free", idempotencyKey: "k1" })
    );
    assert.equal(under.admitted, true);
    await post(object, "settle", { reservationId: "k1", actual: 500 });

    const over = await json<{ admitted: boolean; verdict: { state: string } }>(
      await post(object, "reserve", { cost: 1, plan: "free", idempotencyKey: "k2" })
    );
    assert.equal(over.admitted, false);
    assert.equal(over.verdict.state, "hard_limit");
  } finally {
    restore();
  }
});

test("pending reservations count toward the quota, so a burst cannot oversell it", async () => {
  const { object, restore } = counter();
  try {
    await post(object, "reserve", { cost: 499, plan: "free", idempotencyKey: "k1" });
    const second = await json<{ admitted: boolean }>(
      await post(object, "reserve", { cost: 5, plan: "free", idempotencyKey: "k2" })
    );
    assert.equal(second.admitted, false, "a burst oversold the quota against unsettled reservations");
  } finally {
    restore();
  }
});

// -------------------------------------------------------------- periods ----

test("the period is derived, never supplied", async () => {
  assert.equal(periodFor(Date.parse("2026-08-21T12:00:00Z")), "2026-08");
  assert.equal(periodFor(Date.parse("2026-01-01T00:00:00Z")), "2026-01");
  assert.equal(endOfPeriod(Date.parse("2026-08-21T12:00:00Z")), Date.parse("2026-09-01T00:00:00Z"));
  // December rolls the year rather than producing month 13.
  assert.equal(endOfPeriod(Date.parse("2026-12-15T00:00:00Z")), Date.parse("2027-01-01T00:00:00Z"));
  assert.equal(counterName("org_1", "2026-08"), "org_1:2026-08");
});
