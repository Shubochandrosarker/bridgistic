import { describe, expect, it } from "vitest";
import { BridgeClient } from "../src/lib/api/bridge.ts";
import { classify } from "../src/lib/api/errors.ts";
import { RELAY_URL } from "../src/lib/config.ts";

const conn = { id: "1", alias: "t", siteUrl: "https://example.com", keyId: "bk_test", secret: "s3cret" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Records direct calls and answers from a route → response map (plugin 1.5.3
 * shapes). The console relay is treated as unreachable so these tests pin the
 * signed direct contract; the relay path is covered in client.test.ts.
 */
function fakeSite(routes: Record<string, (init: RequestInit, url: string) => Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    if (url === RELAY_URL) throw new TypeError("relay unreachable");
    calls.push({ url, init });
    const path = url.replace("https://example.com/wp-json/bridgistic/v1/", "");
    const key = Object.keys(routes).find((k) => path === k || path.startsWith(`${k}?`));
    return key ? routes[key]!(init, url) : json(404, { code: "rest_no_route", message: "No route" });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("live-mode contract with plugin 1.5.3", () => {
  it("sends the snapshot target as an object", async () => {
    const s = fakeSite({ snapshot: () => json(200, { ok: true, data: { snapshot_id: "snap_1" } }) });
    const c = new BridgeClient(conn, s.f);
    await c.createSnapshot({ type: "option", target: " blogname ", label: "x" });
    await c.createSnapshot({ type: "post", target: "12" });
    expect(JSON.parse(String(s.calls[0]!.init.body))).toEqual({ type: "option", target: { name: "blogname" }, label: "x" });
    expect(JSON.parse(String(s.calls[1]!.init.body)).target).toEqual({ id: 12 });
  });

  it("looks an approval up in the own-approvals list, never via the unsigned query string", async () => {
    const s = fakeSite({ approvals: () => json(200, { ok: true, data: { approvals: [{ approval_id: "apr_1", status: "pending" }] } }) });
    const a = await new BridgeClient(conn, s.f).approvalStatus("apr_1");
    expect(a.status).toBe("pending");
    expect(s.calls.every((c) => !c.url.includes("approval_id="))).toBe(true);
  });

  it("falls back to approvals/status on plugins without the list route", async () => {
    const s = fakeSite({ "approvals/status": () => json(200, { ok: true, data: { approval_id: "apr_1", status: "approved" } }) });
    expect((await new BridgeClient(conn, s.f).approvalStatus("apr_1")).status).toBe("approved");
  });

  it("reads allow-listed options by name and skips denied ones", async () => {
    const s = fakeSite({
      options: (_i, url) => {
        const name = new URL(url).searchParams.get("name");
        return name === "blogname" ? json(200, { ok: true, data: { name, value: "Site", exists: true } }) : json(403, { code: "bridgistic_option_denied", message: "no" });
      },
    });
    const rows = await new BridgeClient(conn, s.f).list("options");
    expect(rows).toEqual([{ option: "blogname", value: "Site" }]);
    expect(s.calls.every((c) => /options\?name=/.test(c.url))).toBe(true);
  });

  it("flattens woo inventory and normalises the sales summary", async () => {
    const s = fakeSite({
      "woo/inventory": () => json(200, { ok: true, data: { low_stock_threshold: 2, counts: {}, out_of_stock: [{ id: 1 }], low_stock: [{ id: 2 }] } }),
      "woo/sales-summary": () => json(200, { ok: true, data: { period_days: 30, since: "x", currency: "USD", order_count: 3, gross_revenue: 24, average_order_value: 8 } }),
    });
    const c = new BridgeClient(conn, s.f);
    expect(await c.list("woo/inventory")).toEqual([{ id: 1, stock_state: "out of stock" }, { id: 2, stock_state: "low stock" }]);
    expect(await c.wooSalesSummary()).toEqual({ period: "Last 30 days", orders: 3, gross_revenue: "24.00 USD", average_order_value: "8.00 USD" });
  });

  it("does not call a policy 403 an auth failure", () => {
    expect(classify(403, "bridgistic_option_denied")).toBe("server");
    expect(classify(403, "bridgistic_auth_ip")).toBe("auth");
    expect(classify(403, "bridgistic_scope_denied")).toBe("scope");
  });
});
