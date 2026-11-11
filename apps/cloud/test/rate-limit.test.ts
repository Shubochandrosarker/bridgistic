/**
 * Tests for src/rate-limit.ts - the KV-backed fixed-window limiter used to
 * blunt abuse of /mcp and the OAuth handshake routes.
 *
 * Run: npx tsx --test test/rate-limit.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkRateLimits, isRateLimited, secondsUntilWindowReset, LIMITS, type RateLimitRule } from "../src/rate-limit.js";

/** Minimal in-memory stand-in for the two KVNamespace methods this module uses. */
class FakeKv {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string, _opts?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
  }
}

describe("rate-limit: isRateLimited", () => {
  test("allows requests under the limit", async () => {
    const kv = new FakeKv() as unknown as KVNamespace;
    for (let i = 0; i < 5; i++) {
      assert.equal(await isRateLimited(kv, "1.2.3.4:mcp", 5), false);
    }
  });

  test("blocks once the limit is reached within the window", async () => {
    const kv = new FakeKv() as unknown as KVNamespace;
    for (let i = 0; i < 5; i++) {
      await isRateLimited(kv, "1.2.3.4:mcp", 5);
    }
    assert.equal(await isRateLimited(kv, "1.2.3.4:mcp", 5), true);
  });

  test("tracks separate keys independently", async () => {
    const kv = new FakeKv() as unknown as KVNamespace;
    for (let i = 0; i < 5; i++) {
      await isRateLimited(kv, "1.2.3.4:mcp", 5);
    }
    // A different IP (or a different route bucket for the same IP) has its
    // own counter and isn't affected by the first key's exhaustion.
    assert.equal(await isRateLimited(kv, "5.6.7.8:mcp", 5), false);
    assert.equal(await isRateLimited(kv, "1.2.3.4:auth", 5), false);
  });

  test("a limit of 0 blocks immediately", async () => {
    const kv = new FakeKv() as unknown as KVNamespace;
    assert.equal(await isRateLimited(kv, "1.2.3.4:mcp", 0), true);
  });
});

/**
 * Layered limiting. The point of the layers is that a miss on one dimension
 * is not a free pass: an attacker rotating source IPs still meets the tenant
 * and global ceilings, and a single tenant looping still meets its own.
 */
describe("rate-limit: checkRateLimits layering", () => {
  const rules = (ip: string, tenant: string): RateLimitRule[] => [
    { scope: "ip", id: `${ip}:mcp`, limit: 3 },
    { scope: "tenant", id: tenant, limit: 5 },
    { scope: "global", id: "mcp", limit: 100 },
  ];

  test("passes while every layer is under its limit", async () => {
    const kv = new FakeKv() as unknown as KVNamespace;
    const decision = await checkRateLimits(kv, rules("1.2.3.4", "tenant-a"));
    assert.equal(decision.limited, false);
    assert.equal(decision.scope, undefined);
  });

  test("reports which layer tripped", async () => {
    const kv = new FakeKv() as unknown as KVNamespace;
    for (let i = 0; i < 3; i++) await checkRateLimits(kv, rules("1.2.3.4", "tenant-a"));
    const decision = await checkRateLimits(kv, rules("1.2.3.4", "tenant-a"));
    assert.equal(decision.limited, true);
    assert.equal(decision.scope, "ip");
  });

  test("separate IPs get separate budgets", async () => {
    const kv = new FakeKv() as unknown as KVNamespace;
    for (let i = 0; i < 3; i++) await checkRateLimits(kv, rules("1.2.3.4", "tenant-a"));
    assert.equal((await checkRateLimits(kv, rules("1.2.3.4", "tenant-a"))).limited, true);
    assert.equal((await checkRateLimits(kv, rules("5.6.7.8", "tenant-b"))).limited, false);
  });

  test("a tenant rotating source IPs still meets its own ceiling", async () => {
    const kv = new FakeKv() as unknown as KVNamespace;
    // Five distinct IPs, all under the per-IP limit of 3, all one tenant.
    for (let i = 0; i < 5; i++) {
      const decision = await checkRateLimits(kv, rules(`10.0.0.${i}`, "tenant-a"));
      assert.equal(decision.limited, false, `request ${i} should be admitted`);
    }
    const sixth = await checkRateLimits(kv, rules("10.0.0.99", "tenant-a"));
    assert.equal(sixth.limited, true);
    assert.equal(sixth.scope, "tenant", "the tenant layer is what should catch a rotating source");
  });

  test("separate tenants do not share a budget", async () => {
    const kv = new FakeKv() as unknown as KVNamespace;
    for (let i = 0; i < 5; i++) await checkRateLimits(kv, rules(`10.0.0.${i}`, "tenant-a"));
    assert.equal((await checkRateLimits(kv, rules("10.0.1.1", "tenant-b"))).limited, false);
  });

  test("the global ceiling catches a distributed flood that clears every other layer", async () => {
    const kv = new FakeKv() as unknown as KVNamespace;
    const spread = (i: number): RateLimitRule[] => [
      { scope: "ip", id: `10.1.${i}.1:mcp`, limit: 3 },
      { scope: "tenant", id: `tenant-${i}`, limit: 5 },
      { scope: "global", id: "mcp", limit: 4 },
    ];
    for (let i = 0; i < 4; i++) {
      assert.equal((await checkRateLimits(kv, spread(i))).limited, false);
    }
    const overflow = await checkRateLimits(kv, spread(99));
    assert.equal(overflow.limited, true);
    assert.equal(overflow.scope, "global");
  });

  test("a request already refused by the IP layer does not consume tenant or global budget", async () => {
    const kv = new FakeKv() as unknown as KVNamespace;
    for (let i = 0; i < 3; i++) await checkRateLimits(kv, rules("1.2.3.4", "shared"));
    // Ten refusals from the blocked IP.
    for (let i = 0; i < 10; i++) await checkRateLimits(kv, rules("1.2.3.4", "shared"));
    // A different IP on the same tenant still has its full tenant budget minus
    // the 3 that were genuinely admitted.
    for (let i = 0; i < 2; i++) {
      assert.equal((await checkRateLimits(kv, rules("9.9.9.9", "shared"))).limited, false);
    }
  });

  test("different route classes are limited independently", async () => {
    const kv = new FakeKv() as unknown as KVNamespace;
    const mcp: RateLimitRule[] = [{ scope: "ip", id: "1.2.3.4:mcp", limit: 2 }];
    const auth: RateLimitRule[] = [{ scope: "ip", id: "1.2.3.4:auth", limit: 2 }];
    for (let i = 0; i < 2; i++) await checkRateLimits(kv, mcp);
    assert.equal((await checkRateLimits(kv, mcp)).limited, true);
    assert.equal((await checkRateLimits(kv, auth)).limited, false);
  });

  test("a refusal carries a usable Retry-After", async () => {
    const kv = new FakeKv() as unknown as KVNamespace;
    const one: RateLimitRule[] = [{ scope: "ip", id: "1.2.3.4:mcp", limit: 1 }];
    await checkRateLimits(kv, one);
    const decision = await checkRateLimits(kv, one);
    assert.equal(decision.limited, true);
    assert.ok(decision.retryAfterSeconds > 0 && decision.retryAfterSeconds <= 60);
  });
});

describe("rate-limit: window reset", () => {
  test("secondsUntilWindowReset stays inside the window", () => {
    const seconds = secondsUntilWindowReset();
    assert.ok(seconds > 0 && seconds <= 60, `got ${seconds}`);
  });

  test("a new window starts a fresh count", async () => {
    const kv = new FakeKv() as unknown as KVNamespace;
    // A 1-second window makes the rollover observable without a long sleep;
    // the bucket key is derived from Date.now(), so advancing real time is
    // what actually rolls it.
    for (let i = 0; i < 2; i++) assert.equal(await isRateLimited(kv, "roll", 2, 1), false);
    assert.equal(await isRateLimited(kv, "roll", 2, 1), true);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(await isRateLimited(kv, "roll", 2, 1), false, "the next window must admit again");
  });
});

describe("rate-limit: production limits", () => {
  test("MCP traffic is allowed far more headroom than the OAuth handshake", () => {
    // A person walks the OAuth flow once per site; an MCP client calls tools
    // in bursts while a model works. Inverting these would break normal use.
    assert.ok(LIMITS.mcpPerIp > LIMITS.authPerIp);
  });

  test("per-tenant headroom exceeds per-IP, so one site behind one NAT is not the tightest bound", () => {
    assert.ok(LIMITS.mcpPerTenant >= LIMITS.mcpPerIp);
  });

  test("global ceilings sit above the per-source limits", () => {
    assert.ok(LIMITS.mcpGlobal > LIMITS.mcpPerTenant);
    assert.ok(LIMITS.authGlobal > LIMITS.authPerIp);
  });
});
