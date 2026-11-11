/** Billing page data: GET /api/me/billing on the console (Stripe, or a directly issued license; "paddle" only for legacy rows). */
import { ACCOUNT_URL } from "./config.ts";

export type BillingProvider = "paddle" | "stripe" | "license";
export interface BillingInvoice { id: string; amount_paid: number; amount_due: number; currency: string; status: string; pdf_url: string | null; hosted_invoice_url: string | null; created_at: string; paid_at: string | null }
export interface BillingSubscription {
  billing_provider: BillingProvider;
  subscription_id: string;
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
export interface BillingSummary { billing_provider: BillingProvider | null; subscriptions: BillingSubscription[]; upstream_error: boolean }

type Fetch = typeof fetch;

export async function fetchBilling(fetchImpl: Fetch = fetch): Promise<BillingSummary> {
  const res = await fetchImpl(`${ACCOUNT_URL}/api/me/billing`, { credentials: "include", cache: "no-store" });
  if (!res.ok) throw new Error(res.status === 401 ? "Sign in to see billing." : "Billing is unavailable right now.");
  return (await res.json()) as BillingSummary;
}

export async function openStripePortal(returnUrl: string, fetchImpl: Fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${ACCOUNT_URL}/api/me/billing/portal`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ return_url: returnUrl }),
  });
  const body = (await res.json().catch(() => ({}))) as { url?: string; message?: string };
  if (!res.ok || !body.url) throw new Error(body.message ?? "Could not open the billing portal.");
  return body.url;
}

export function fmtMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(cents / 100);
}

export function cadence(interval: string): string {
  if (interval === "month") return "/ month";
  if (interval === "year") return "/ year";
  return "one-time";
}

/** One line under the plan name, the same for both gateways. */
export function renewalLine(s: Pick<BillingSubscription, "status" | "renews_at" | "ends_at">, fmt: (d: string) => string): string {
  if (s.status === "lifetime") return "Lifetime license, no renewal";
  if (s.status === "refunded") return "Refunded";
  if (s.status === "cancelled" || s.status === "expired") return s.ends_at ? `Ended ${fmt(s.ends_at)}` : "Ended";
  if (s.ends_at) return `Cancels ${fmt(s.ends_at)}`;
  if (s.status === "past_due") return s.renews_at ? `Payment failed. Update your card before ${fmt(s.renews_at)}` : "Payment failed. Update your card";
  return s.renews_at ? `Renews ${fmt(s.renews_at)}` : "Active";
}

export const PROVIDER_LABEL: Record<BillingProvider, string> = { paddle: "Paddle (legacy)", stripe: "Stripe", license: "Bridgistic (direct license)" };
export const SUPPORT_EMAIL = "support@bridgistic.app";
