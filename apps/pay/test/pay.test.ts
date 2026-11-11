import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readConfig, stripeSessionRequest, validEmail } from "../src/config.ts";

const html = readFileSync(resolve(__dirname, "../index.html"), "utf8");
const main = readFileSync(resolve(__dirname, "../src/main.ts"), "utf8");
const text = html.replace(/<[^>]+>/g, " ");

describe("pay.bridgistic.app", () => {
  it("is Stripe-only and does not ask for an email before checkout", () => {
    expect(html).not.toContain("buyer-email");
    expect(html).not.toContain("Email for your license key");
    expect(text).toContain("You will enter your name, email and payment details on the secure Stripe checkout page");
    expect(html.toLowerCase()).not.toContain("paddle");
    expect(main.toLowerCase()).not.toContain("paddle");
    expect(html).not.toContain("data-plan-choice=\"lifetime\"");
    expect(text).not.toContain("$69");
    expect(text).not.toContain("Limited Time Offer");
    expect(text).not.toContain("Coming soon");
  });

  it("lists monthly and yearly Pro plans", () => {
    expect(html).toContain('data-plan-choice="monthly"');
    expect(html).toContain('data-plan-choice="yearly"');
    expect(text).toContain("$12");
    expect(main).toContain("$99");
    expect(text).toContain("7-day refund guarantee");
  });

  it("builds a server-resolved Stripe request without a pre-filled email", () => {
    const body = stripeSessionRequest("yearly", "https://pay.bridgistic.app");
    expect(body).toEqual({
      product: "bridgistic",
      plan: "yearly",
      success_url: "https://pay.bridgistic.app/?thanks=1&provider=stripe",
      cancel_url: "https://pay.bridgistic.app/",
      source: "pay.bridgistic.app",
    });
    expect(JSON.stringify(body)).not.toMatch(/price_|pri_|email/);
  });

  it("uses the same-origin Stripe proxy by default", () => {
    expect(readConfig({}).stripeSessionUrl).toBe("/api/stripe-checkout");
    expect(readConfig({ VITE_STRIPE_CHECKOUT: "0" }).stripe).toBe(false);
    expect(main).toContain('fetch(cfg.stripeSessionUrl || "/api/stripe-checkout"');
  });

  it("accepts the API's checkout_url response shape and monthly or yearly only", () => {
    const fn = readFileSync(resolve(__dirname, "../functions/api/stripe-checkout.js"), "utf8");
    expect(fn).toContain("data?.checkout_url ?? data?.url");
    expect(fn).toContain("return json({ url: checkoutUrl });");
    expect(fn).toContain('const PLANS = new Set(["monthly", "yearly"])');
    expect(fn).not.toContain("Enter a valid email");
  });

  it("keeps a basic email helper for tests and future account mail", () => {
    expect(validEmail("a@b.co")).toBe(true);
    expect(validEmail("nope")).toBe(false);
  });
});
