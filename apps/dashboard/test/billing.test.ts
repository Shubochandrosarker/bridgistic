import { describe, it, expect } from "vitest";
import { cadence, fetchBilling, fmtMoney, openStripePortal, renewalLine } from "../src/lib/billing.ts";

const fmt = (d: string) => d.slice(0, 10);

describe("billing page helpers", () => {
  it("renders the same renewal line for either gateway", () => {
    expect(renewalLine({ status: "active", renews_at: "2026-12-04T00:00:00Z", ends_at: null }, fmt)).toBe("Renews 2026-12-04");
    expect(renewalLine({ status: "active", renews_at: null, ends_at: "2026-12-04T00:00:00Z" }, fmt)).toBe("Cancels 2026-12-04");
    expect(renewalLine({ status: "lifetime", renews_at: null, ends_at: null }, fmt)).toMatch(/Lifetime/);
    expect(renewalLine({ status: "past_due", renews_at: "2026-12-04", ends_at: null }, fmt)).toMatch(/Payment failed/);
    expect(renewalLine({ status: "refunded", renews_at: null, ends_at: null }, fmt)).toBe("Refunded");
  });
  it("formats prices", () => {
    expect(fmtMoney(1200, "USD")).toBe("$12.00");
    expect(fmtMoney(6900, "USD")).toBe("$69.00");
    expect(cadence("year")).toBe("/ year");
    expect(cadence("lifetime")).toBe("one-time");
  });
  it("calls the console with the session cookie", async () => {
    const seen: any[] = [];
    const f = (async (url: string, init: any) => { seen.push({ url, init }); return new Response(JSON.stringify(url.endsWith("/portal") ? { url: "https://billing.stripe.com/p/x" } : { billing_provider: "stripe", subscriptions: [], upstream_error: false }), { status: 200 }); }) as unknown as typeof fetch;
    expect((await fetchBilling(f)).billing_provider).toBe("stripe");
    expect(seen[0].url).toBe("https://admin.bridgistic.app/api/me/billing");
    expect(seen[0].init.credentials).toBe("include");
    expect(await openStripePortal("https://dashboard.bridgistic.app/billing", f)).toBe("https://billing.stripe.com/p/x");
    expect(JSON.parse(seen[1].init.body)).toEqual({ return_url: "https://dashboard.bridgistic.app/billing" });
  });
  it("surfaces portal errors", async () => {
    const f = (async () => new Response(JSON.stringify({ message: "Stripe customer not found" }), { status: 404 })) as unknown as typeof fetch;
    await expect(openStripePortal("x", f)).rejects.toThrow("Stripe customer not found");
  });
});
