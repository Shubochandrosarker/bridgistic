import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkoutOptions, checkoutReady, offerOpen, PADDLE_PRICES, quantityReset, readConfig, remainingLabel, stripeSessionRequest, validEmail } from "../src/config.ts";

const html = readFileSync(resolve(__dirname, "../index.html"), "utf8");
const main = readFileSync(resolve(__dirname, "../src/main.ts"), "utf8");
const text = html.replace(/<[^>]+>/g, " ");

describe("pay.bridgistic.app", () => {
  it("requires a real Paddle token for the optional Paddle path", () => {
    expect(checkoutReady(readConfig({}))).toBe(false);
    expect(checkoutReady(readConfig({ VITE_PADDLE_CLIENT_TOKEN: "not-a-token" }))).toBe(false);
    expect(checkoutReady(readConfig({ VITE_PADDLE_CLIENT_TOKEN: "live_abc123" }))).toBe(true);
  });

  it("uses the live Paddle price IDs and $69 lifetime catalog", () => {
    const c = readConfig({ VITE_PADDLE_PRICE_LIFETIME: "pri_" });
    expect(c.priceId).toBe("pri_01m58k6epsqzbr3qbab84t6p90");
    expect(c.prices).toEqual(PADDLE_PRICES);
    expect(PADDLE_PRICES.monthly).toBe("pri_01m1ykar8aq033865h68a4b9hh");
    expect(PADDLE_PRICES.yearly).toBe("pri_01m1ykaqyaaeewsbah07akmpka");
  });

  it("keeps the offer open until the server closes it", () => {
    expect(offerOpen(Date.parse("2030-01-01T00:00:00Z"))).toBe(true);
    expect(offerOpen(Date.parse("2026-11-01T00:00:00Z"), { open: false })).toBe(false);
    expect(remainingLabel({ source: "none", remaining: 100 })).toBeNull();
  });

  it("uses one license per checkout and carries the buyer email", () => {
    const o = checkoutOptions(readConfig({}), "a@b.co", "yearly");
    expect(o.items).toEqual([{ priceId: PADDLE_PRICES.yearly, quantity: 1 }]);
    expect(o.customData).toMatchObject({ customer_email: "a@b.co", offer: "yearly" });
    expect(o.customer).toEqual({ email: "a@b.co" });
    expect(validEmail("nope")).toBe(false);
  });

  it("shows the current commercial terms without stale offer claims", () => {
    expect(text).toContain("$69");
    expect(text).toContain("$12");
    expect(main).toContain("$99");
    for (const term of ["Active now", "All future updates included", "1 license for 1 site", "Limited Time Offer", "7-day refund guarantee"]) expect(text).toContain(term);
    for (const stale of ["$49.99", "96 of 100", "100 licenses", "31 December 2026", "Coming soon"]) expect(text).not.toContain(stale);
  });

  it("uses the two-card billing toggle and Stripe as the default checkout", () => {
    expect(html).toContain('data-plan-choice="monthly"');
    expect(html).toContain('data-plan-choice="yearly"');
    expect(html).toContain('data-plan-choice="lifetime"');
    expect(text).toContain("Stripe is the default checkout. Paddle remains available as an optional payment method.");
    expect(text).toContain("AI agent credits are separate");
  });

  it("builds a server-resolved Stripe request with pinned return URLs", () => {
    const body = stripeSessionRequest("a@b.co", "yearly", "https://pay.bridgistic.app");
    expect(body).toEqual({
      product: "bridgistic",
      plan: "yearly",
      email: "a@b.co",
      success_url: "https://pay.bridgistic.app/?thanks=1&provider=stripe",
      cancel_url: "https://pay.bridgistic.app/",
      source: "pay.bridgistic.app",
    });
    expect(JSON.stringify(body)).not.toMatch(/price_|pri_/);
  });

  it("resets any Paddle quantity change back to one", () => {
    const ev = (q: number, extra = false) => ({ name: "checkout.items.updated", data: { items: [{ price_id: "pri_x", quantity: q }, ...(extra ? [{ price_id: "pri_y", quantity: 1 }] : [])] } });
    expect(quantityReset(ev(3), "pri_x")).toEqual([{ priceId: "pri_x", quantity: 1 }]);
    expect(quantityReset(ev(1), "pri_x")).toBeNull();
    expect(quantityReset(ev(1, true), "pri_x")).toEqual([{ priceId: "pri_x", quantity: 1 }]);
  });
});

