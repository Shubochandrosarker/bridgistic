import { describe, it, expect, beforeEach } from "vitest";
import { makeD1 } from "./d1.ts";
import { billingSummary, billingApiBase, safeReturnUrl, stripePortal, type BillingEnv } from "../functions/lib/billing.ts";

const USER = { id: "u1", email: "buyer@example.com" };
const stripeAcct = {
  billing_provider: "stripe", subscription_id: "s1", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1",
  plan: "pro", plan_name: "Pro", interval: "month", amount: 1200, currency: "USD", status: "active",
  renews_at: "2026-12-04T00:00:00Z", ends_at: null, cancel_at_period_end: false,
  invoices: [{ id: "i1", amount_paid: 1200, amount_due: 1200, currency: "USD", status: "paid", pdf_url: "https://x/pdf", hosted_invoice_url: null, created_at: "2026-11-04", paid_at: "2026-11-04" }],
  manage: { type: "stripe_portal" },
};
const paddleAcct = { ...stripeAcct, billing_provider: "paddle", subscription_id: "s0", stripe_customer_id: null, stripe_subscription_id: null, status: "cancelled", manage: { type: "paddle_portal", url: null } };

function fake(accounts: unknown[], status = 200) {
  const calls: { url: string; body: any; auth: string }[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    if (url.endsWith("/portal")) return new Response(JSON.stringify({ portal_url: "https://billing.stripe.com/p/session/test" }), { status });
    return new Response(JSON.stringify({ accounts }), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("billing page backend", () => {
  let env: BillingEnv;
  beforeEach(async () => {
    env = { DB: await makeD1(), LICENSE_SERVICE_TOKEN: "svc-token", PADDLE_CUSTOMER_PORTAL_URL: "https://paddle.example/portal" };
    await env.DB.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, '', 'x')").bind(USER.id, USER.email).run();
  });

  it("derives the billing service URL from the license service URL", () => {
    expect(billingApiBase({ ...env })).toBe("https://api.wpistic.com/api/v1/service/billing");
    expect(billingApiBase({ ...env, WPISTIC_SERVICE_API: "http://127.0.0.1:8799/api/v1/service/licenses/" })).toBe("http://127.0.0.1:8799/api/v1/service/billing");
  });

  it("new accounts default to Stripe in D1", async () => {
    const row = await env.DB.prepare("SELECT billing_provider FROM users WHERE id = ?").bind(USER.id).first<{ billing_provider: string }>();
    expect(row?.billing_provider).toBe("stripe");
  });

  it("Stripe account: current subscription first, provider + stripe ids cached in D1", async () => {
    const { calls, fetchImpl } = fake([paddleAcct, stripeAcct]);
    const r = await billingSummary(env, USER, fetchImpl);
    expect(calls[0].auth).toBe("Bearer svc-token");
    expect(calls[0].body).toEqual({ product: "bridgistic", emails: [USER.email] });
    expect(r.billing_provider).toBe("stripe");
    expect(r.subscriptions[0].status).toBe("active");
    expect(r.subscriptions[0].manage).toEqual({ type: "stripe_portal" });
    const row = await env.DB.prepare("SELECT billing_provider, stripe_customer_id, stripe_subscription_id, billing_synced_at FROM users WHERE id = ?").bind(USER.id).first<any>();
    expect(row).toMatchObject({ billing_provider: "stripe", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1" });
    expect(row.billing_synced_at).toBeTruthy();
  });

  it("legacy pre-Stripe account keeps its portal link (retirement-only fallback from env)", async () => {
    const r = await billingSummary(env, USER, fake([{ ...paddleAcct, status: "active" }]).fetchImpl);
    expect(r.billing_provider).toBe("paddle");
    expect(r.subscriptions[0].manage).toEqual({ type: "paddle_portal", url: "https://paddle.example/portal" });
  });

  it("caches a directly issued license's 'license' provider (0008 widens the CHECK)", async () => {
    const { fetchImpl } = fake([{ ...stripeAcct, billing_provider: "license", subscription_id: "s2", manage: { type: "support" } }]);
    const r = await billingSummary(env, USER, fetchImpl);
    expect(r.billing_provider).toBe("license");
    const row = await env.DB.prepare("SELECT billing_provider FROM users WHERE id = ?").bind(USER.id).first<{ billing_provider: string }>();
    expect(row?.billing_provider).toBe("license");
  });

  it("upstream failure is reported, not thrown; no token = not configured", async () => {
    expect((await billingSummary(env, USER, fake([], 500).fetchImpl)).upstream_error).toBe(true);
    expect((await billingSummary({ ...env, LICENSE_SERVICE_TOKEN: undefined }, USER, fake([]).fetchImpl)).upstream_error).toBe(true);
  });

  it("Stripe portal proxies the email + a safe return URL", async () => {
    const { calls, fetchImpl } = fake([]);
    const r = await stripePortal(env, USER, safeReturnUrl("https://evil.example/x"), fetchImpl);
    expect(r).toEqual({ ok: true, url: "https://billing.stripe.com/p/session/test" });
    expect(calls[0].body).toEqual({ email: USER.email, return_url: "https://dashboard.bridgistic.app/billing" });
    expect(safeReturnUrl("https://dashboard.bridgistic.app/billing?x=1")).toBe("https://dashboard.bridgistic.app/billing?x=1");
  });
});
