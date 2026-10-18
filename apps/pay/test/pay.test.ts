import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkoutOptions, checkoutReady, offerOpen, PADDLE_PRICES, readConfig, remainingLabel, validEmail } from "../src/config.ts";

const html = readFileSync(resolve(__dirname, "../index.html"), "utf8");
const text = html.replace(/<[^>]+>/g, " ");

describe("pay.bridgistic.app", () => {
  it("checkout stays disabled until a real token and price are configured", () => {
    expect(checkoutReady(readConfig({}))).toBe(false);
    expect(checkoutReady(readConfig({ VITE_PADDLE_CLIENT_TOKEN: "not-a-token" }))).toBe(false);
    expect(checkoutReady(readConfig({ VITE_PADDLE_CLIENT_TOKEN: "live_abc123" }))).toBe(true);
  });
  it("defaults to the real Paddle prices; LTD is the checkout price", () => {
    const c = readConfig({ VITE_PADDLE_PRICE_LIFETIME: "pri_" });
    expect(c.priceId).toBe("pri_01m58k6epsqzbr3qbab84t6p90");
    expect(c.prices).toEqual(PADDLE_PRICES);
    expect(PADDLE_PRICES.monthly).toBe("pri_01m1ykar8aq033865h68a4b9hh");
    expect(PADDLE_PRICES.yearly).toBe("pri_01m1ykaqyaaeewsbah07akmpka");
  });
  it("offer closes after 31 Dec 2026 23:59:59 Asia/Dhaka or when the server says so", () => {
    expect(offerOpen(Date.parse("2026-12-31T17:59:58Z"))).toBe(true);
    expect(offerOpen(Date.parse("2026-12-31T18:00:00Z"))).toBe(false);
    expect(offerOpen(Date.parse("2026-11-01T00:00:00Z"), { open: false })).toBe(false);
  });
  it("never shows an invented remaining count", () => {
    expect(remainingLabel(null)).toBeNull();
    expect(remainingLabel({ source: "none", remaining: 100 })).toBeNull();
    expect(remainingLabel({ source: "paddle", remaining: 37 })).toBe("37 of 100 licenses left");
  });
  it("requires an email and passes it for license issuance", () => {
    expect(validEmail("nope")).toBe(false);
    const o = checkoutOptions(readConfig({}), "a@b.co", "yearly");
    expect(o.items[0]!.priceId).toBe("pri_01m1ykaqyaaeewsbah07akmpka");
    expect(o.customData).toMatchObject({ customer_email: "a@b.co", offer: "yearly" });
    expect(o.customer).toEqual({ email: "a@b.co" });
  });
  it("tags the checkout so the WPistic webhook can attribute it", () => {
    const o = checkoutOptions(readConfig({}));
    expect(o.items).toEqual([{ priceId: "pri_01m58k6epsqzbr3qbab84t6p90", quantity: 1 }]);
    expect(o.customData).toMatchObject({ source: "pay.bridgistic.app", product: "bridgistic", offer: "welcome-lifetime" });
  });
  it("shows only the real Paddle amounts and the offer terms", () => {
    expect(text.match(/\$\d+(\.\d\d)?/g)?.every((p) => ["$29.99", "$12", "$99"].includes(p))).toBe(true);
    for (const t of ["31 December 2026", "100 licenses only"]) expect(text).toContain(t);
    expect(text).toContain("All future updates included");
  });
  it("brand voice: no exclamation marks in visible copy", () => {
    expect(text.replace(/<!doctype[^>]*>/i, "")).not.toContain("!");
  });
  it("links privacy, terms and refund pages", () => {
    for (const p of ["/privacy.html", "/terms.html", "/refund.html"]) expect(html).toContain(p);
  });
});
