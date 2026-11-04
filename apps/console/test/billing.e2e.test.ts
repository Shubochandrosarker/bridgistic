// Cross-repo check against a local api.wpistic.com (wpistic scripts/e2e-stripe-local.mjs).
// Skipped unless E2E_API, E2E_SERVICE_TOKEN and E2E_EMAIL are set.
import { describe, it, expect } from "vitest";
import { makeD1 } from "./d1.ts";
import { billingSummary } from "../functions/lib/billing.ts";

const { E2E_API, E2E_SERVICE_TOKEN, E2E_EMAIL } = process.env;
describe.skipIf(!E2E_API || !E2E_SERVICE_TOKEN || !E2E_EMAIL)("console billing against local wpistic", () => {
  it("reads the Stripe account and caches the provider", async () => {
    const DB = await makeD1();
    await DB.prepare("INSERT INTO users (id, email, name, password_hash) VALUES ('u', ?, '', 'x')").bind(E2E_EMAIL).run();
    const r = await billingSummary({ DB, LICENSE_SERVICE_TOKEN: E2E_SERVICE_TOKEN, WPISTIC_SERVICE_API: `${E2E_API}/api/v1/service/licenses` }, { id: "u", email: E2E_EMAIL! });
    expect(r.upstream_error).toBe(false);
    expect(r.billing_provider).toBe("stripe");
    const row = await DB.prepare("SELECT billing_provider, stripe_customer_id FROM users WHERE id = 'u'").first<any>();
    expect(row.billing_provider).toBe("stripe");
    expect(row.stripe_customer_id).toMatch(/^cus_/);
    console.log(JSON.stringify(r.subscriptions.map((s) => ({ provider: s.billing_provider, status: s.status, plan: s.plan, renews_at: s.renews_at, invoices: s.invoices.length, manage: s.manage.type }))));
  });
});
