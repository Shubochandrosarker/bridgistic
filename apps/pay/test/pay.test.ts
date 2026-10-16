import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkoutOptions, checkoutReady, readConfig } from "../src/config.ts";

const html = readFileSync(resolve(__dirname, "../index.html"), "utf8");
const text = html.replace(/<[^>]+>/g, " ");

describe("pay.bridgistic.app", () => {
  it("checkout stays disabled until a real token and price are configured", () => {
    expect(checkoutReady(readConfig({}))).toBe(false);
    expect(checkoutReady(readConfig({ VITE_PADDLE_CLIENT_TOKEN: "live_abc123", VITE_PADDLE_PRICE_LIFETIME: "pri_" }))).toBe(false);
    expect(checkoutReady(readConfig({ VITE_PADDLE_CLIENT_TOKEN: "live_abc123", VITE_PADDLE_PRICE_LIFETIME: "pri_01aaaaaaaaaaaaaaaaaaaaaaaa" }))).toBe(true);
  });
  it("tags the checkout so the WPistic webhook can attribute it", () => {
    const o = checkoutOptions(readConfig({ VITE_PADDLE_PRICE_LIFETIME: "pri_x" }));
    expect(o.items).toEqual([{ priceId: "pri_x", quantity: 1 }]);
    expect(o.customData).toMatchObject({ source: "pay.bridgistic.app", product: "bridgistic", offer: "lifetime" });
  });
  it("offers exactly one price: $29.99 one time", () => {
    expect(text.match(/\$\d+(\.\d\d)?/g)?.every((p) => p === "$29.99")).toBe(true);
    expect(text).toContain("All future updates included");
  });
  it("brand voice: no exclamation marks in visible copy", () => {
    expect(text.replace(/<!doctype[^>]*>/i, "")).not.toContain("!");
  });
  it("links privacy, terms and refund pages", () => {
    for (const p of ["/privacy.html", "/terms.html", "/refund.html"]) expect(html).toContain(p);
  });
});
