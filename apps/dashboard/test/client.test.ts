import { describe, expect, it } from "vitest";
import { BridgeClient } from "../src/lib/api/bridge.ts";
import { classify } from "../src/lib/api/errors.ts";
import { firstArray } from "../src/lib/api/client.ts";

const conn = { id: "1", alias: "t", siteUrl: "https://example.com", keyId: "bk_test", secret: "s3cret" };

describe("BridgeClient", () => {
  it("signs requests against bridgistic/v1 and unwraps the {ok,data} envelope", async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string> };
      return new Response(JSON.stringify({ ok: true, data: { snapshots: [{ snapshot_id: "a" }] } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const rows = await new BridgeClient(conn, fake).snapshots();
    expect(rows).toEqual([{ snapshot_id: "a" }]);
    expect(seen!.url).toBe("https://example.com/wp-json/bridgistic/v1/snapshot");
    expect(seen!.headers["X-Bridgistic-Key"]).toBe("bk_test");
    expect(seen!.headers["X-Bridgistic-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(seen!.headers)).not.toContain("s3cret");
  });

  it("maps a missing route to needs_plugin_update", async () => {
    const fake = (async () => new Response(JSON.stringify({ code: "rest_no_route", message: "No route" }), { status: 404 })) as unknown as typeof fetch;
    await expect(new BridgeClient(conn, fake).audit()).rejects.toMatchObject({ kind: "needs_plugin_update" });
  });
});

describe("helpers", () => {
  it("classify", () => {
    expect(classify(0)).toBe("network");
    expect(classify(401)).toBe("auth");
    expect(classify(403, "bridgistic_scope")).toBe("scope");
    expect(classify(429)).toBe("rate_limited");
  });
  it("firstArray", () => {
    expect(firstArray({ posts: [1] })).toEqual([1]);
    expect(firstArray([2])).toEqual([2]);
    expect(firstArray({})).toEqual([]);
  });
});
