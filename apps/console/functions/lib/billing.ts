/**
 * Billing page backend: one shape for Stripe-billed accounts and legacy rows.
 * api.wpistic.com is the source of truth (it issues every license) and the console
 * proxies with the server-to-server LICENSE_SERVICE_TOKEN, caching the account's
 * provider in D1 (users.billing_provider) for the admin list.
 *
 * Retirement note: Paddle is gone from the product surface (2026-11-11). The
 * 'paddle' provider value and its portal link below are kept read-only so pre-Stripe
 * accounts can still see history and open refunds during the 90-day tail; new
 * accounts never take that path. Delete both once the tail has run out.
 */
import { DEFAULT_WPISTIC_SERVICE_API } from "./sites.ts";

type Fetch = typeof fetch;

export interface BillingEnv {
  DB: D1Database;
  WPISTIC_SERVICE_API?: string;
  /** Override for the billing service base; defaults to WPISTIC_SERVICE_API's sibling /service/billing. */
  WPISTIC_BILLING_API?: string;
  LICENSE_SERVICE_TOKEN?: string;
  /** Retirement-only: portal link for legacy pre-Stripe rows when api.wpistic.com sends none. */
  PADDLE_CUSTOMER_PORTAL_URL?: string;
}

export interface BillingInvoice {
  id: string;
  amount_paid: number;
  amount_due: number;
  currency: string;
  status: string;
  pdf_url: string | null;
  hosted_invoice_url: string | null;
  created_at: string;
  paid_at: string | null;
}

export interface BillingAccount {
  billing_provider: "paddle" | "stripe" | "license";
  subscription_id: string;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  plan: string;
  plan_name: string;
  interval: string;
  amount: number;
  currency: string;
  status: string;
  renews_at: string | null;
  ends_at: string | null;
  cancel_at_period_end: boolean;
  invoices: BillingInvoice[];
  manage: { type: "paddle_portal"; url: string | null } | { type: "stripe_portal" } | { type: "support" };
}

export interface BillingSummary {
  billing_provider: "paddle" | "stripe" | "license" | null;
  subscriptions: BillingAccount[];
  upstream_error: boolean;
}

export function billingApiBase(env: BillingEnv): string {
  if (env.WPISTIC_BILLING_API) return env.WPISTIC_BILLING_API.replace(/\/$/, "");
  return (env.WPISTIC_SERVICE_API || DEFAULT_WPISTIC_SERVICE_API).replace(/\/$/, "").replace(/\/licenses$/, "/billing");
}

const RANK: Record<string, number> = { active: 0, trialing: 0, lifetime: 1, past_due: 2, paused: 3, cancelled: 4, refunded: 5, expired: 6 };

export async function billingSummary(env: BillingEnv, user: { id: string; email: string }, fetchImpl: Fetch = fetch): Promise<BillingSummary> {
  if (!env.LICENSE_SERVICE_TOKEN) return { billing_provider: null, subscriptions: [], upstream_error: true };
  let accounts: BillingAccount[] = [];
  try {
    const res = await fetchImpl(`${billingApiBase(env)}/summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.LICENSE_SERVICE_TOKEN}` },
      body: JSON.stringify({ product: "bridgistic", emails: [user.email] }),
    });
    if (!res.ok) throw new Error(`billing summary ${res.status}`);
    accounts = ((await res.json()) as { accounts?: BillingAccount[] }).accounts ?? [];
  } catch {
    return { billing_provider: null, subscriptions: [], upstream_error: true };
  }
  const subscriptions = accounts
    .map((a) => ({
      ...a,
      manage: a.manage?.type === "paddle_portal" ? { type: "paddle_portal" as const, url: a.manage.url ?? env.PADDLE_CUSTOMER_PORTAL_URL ?? null } : a.manage,
    }))
    .sort((x, y) => (RANK[x.status] ?? 9) - (RANK[y.status] ?? 9));
  // The account's provider is the one billing its best (current) subscription.
  const top = subscriptions[0];
  const provider = top?.billing_provider ?? null;
  if (top && provider) {
    await env.DB.prepare(
      "UPDATE users SET billing_provider = ?, stripe_customer_id = ?, stripe_subscription_id = ?, billing_synced_at = datetime('now') WHERE id = ?"
    ).bind(provider, top.stripe_customer_id ?? null, top.stripe_subscription_id ?? null, user.id).run();
  }
  return { billing_provider: provider, subscriptions, upstream_error: false };
}

export async function stripePortal(env: BillingEnv, user: { email: string }, returnUrl: string, fetchImpl: Fetch = fetch): Promise<{ ok: true; url: string } | { ok: false; status: number; error: string; message: string }> {
  if (!env.LICENSE_SERVICE_TOKEN) return { ok: false, status: 503, error: "not_configured", message: "Billing is not configured on this deployment." };
  const res = await fetchImpl(`${billingApiBase(env)}/portal`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.LICENSE_SERVICE_TOKEN}` },
    body: JSON.stringify({ email: user.email, return_url: returnUrl }),
  });
  const body = (await res.json().catch(() => ({}))) as { portal_url?: string; url?: string; error?: { code?: string; message?: string } };
  const url = body.portal_url ?? body.url;
  if (!res.ok || !url) {
    return { ok: false, status: res.status === 404 ? 404 : 502, error: body.error?.code ?? "portal_failed", message: body.error?.message ?? "Could not open the Stripe billing portal." };
  }
  return { ok: true, url };
}

const RETURN_HOSTS = new Set(["dashboard.bridgistic.app", "app.bridgistic.app", "admin.bridgistic.app"]);
export const DEFAULT_BILLING_RETURN = "https://dashboard.bridgistic.app/billing";

/** Only send the buyer back to our own dashboards from the Stripe portal. */
export function safeReturnUrl(candidate: string): string {
  try {
    const u = new URL(candidate);
    if (u.protocol === "https:" && RETURN_HOSTS.has(u.hostname)) return u.toString();
  } catch {
    /* fall through */
  }
  return DEFAULT_BILLING_RETURN;
}
