export type Plan = "lifetime" | "monthly" | "yearly";
export interface PayConfig {
  token: string;
  env: "production" | "sandbox";
  /** Lifetime Deal ($69 one time, all future updates, active now). */
  priceId: string;
  /** Subscription plans offered alongside the Lifetime Deal. */
  prices: Record<Plan, string>;
  statusUrl: string;
  /** Stripe as a second gateway: on when VITE_STRIPE_CHECKOUT=1. Same plans, same prices. */
  stripe: boolean;
  /** Server endpoint that creates a Stripe Checkout session without exposing a secret. */
  stripeSessionUrl: string;
}

export type Provider = "paddle" | "stripe";

/** Real Paddle prices on product "Bridgistic Pro" (pro_01m1ykaqjsgcgt6xvwsy4jpn83). */
export const PADDLE_PRICES: Record<Plan, string> = {
  lifetime: "pri_01m58k6epsqzbr3qbab84t6p90", // $69 USD one time
  monthly: "pri_01m1ykar8aq033865h68a4b9hh", // $12.00 USD per month
  yearly: "pri_01m1ykaqyaaeewsbah07akmpka", // $99.00 USD per year
};

/** The offer is active now; availability is controlled server-side if the offer is ever closed. */
export const OFFER = { endsAt: "9999-12-31T23:59:59Z" } as const;

const PRICE_RE = /^pri_[a-z0-9]{26}$/;
const pick = (v: string | undefined, fallback: string) => (PRICE_RE.test((v ?? "").trim()) ? (v ?? "").trim() : fallback);

export function readConfig(env: Record<string, string | undefined>): PayConfig {
  const prices: Record<Plan, string> = {
    lifetime: pick(env.VITE_PADDLE_PRICE_LIFETIME, PADDLE_PRICES.lifetime),
    monthly: pick(env.VITE_PADDLE_PRICE_MONTHLY, PADDLE_PRICES.monthly),
    yearly: pick(env.VITE_PADDLE_PRICE_YEARLY, PADDLE_PRICES.yearly),
  };
  return {
    token: (env.VITE_PADDLE_CLIENT_TOKEN ?? "").trim(),
    env: env.VITE_PADDLE_ENV === "sandbox" ? "sandbox" : "production",
    priceId: prices.lifetime,
    prices,
    statusUrl: (env.VITE_OFFER_STATUS_URL ?? "/api/offer-status").trim(),
    stripe: env.VITE_STRIPE_CHECKOUT === "1",
    stripeSessionUrl: (env.VITE_STRIPE_SESSION_URL ?? "https://api.wpistic.com/api/v1/checkout/stripe/session").trim(),
  };
}

/** Checkout is only offered when a client token is configured (price IDs are real by default). */
export function checkoutReady(c: PayConfig, plan: Plan = "lifetime"): boolean {
  return /^(live|test)_[A-Za-z0-9]+$/.test(c.token) && PRICE_RE.test(c.prices[plan]);
}

export function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/** The offer is open before the end date unless the server says it is closed (sold out or ended). */
export function offerOpen(now: number, status?: { open?: unknown } | null): boolean {
  if (now >= Date.parse(OFFER.endsAt)) return false;
  return !(status && status.open === false);
}

/** No license count is shown: the Lifetime Deal has no cap (2026-10-28). */
export function remainingLabel(_status?: { source?: unknown; remaining?: unknown } | null): string | null {
  return null;
}

/**
 * Mirrors pay.wpistic.com: overlay checkout with the buyer email in customer and
 * customData.customer_email, which api.wpistic.com needs to issue the license.
 */
export function checkoutOptions(c: PayConfig, email?: string, plan: Plan = "lifetime") {
  return {
    items: [{ priceId: c.prices[plan], quantity: 1 }],
    settings: { displayMode: "overlay", theme: "light", successUrl: `${location.origin}/?thanks=1` },
    customData: { source: "pay.bridgistic.app", product: "bridgistic", offer: plan === "lifetime" ? "welcome-lifetime" : plan, ...(email ? { customer_email: email } : {}) },
    ...(email ? { customer: { email } } : {}),
  };
}

type PaddleItem = { quantity?: number; price_id?: string; price?: { id?: string } };
/**
 * One purchase = one license. Paddle Billing has no allowQuantity setting, so a
 * changed quantity or item list is reset to 1 x the plan. Returns the items to
 * restore, or null when the checkout is already correct.
 */
export function quantityReset(ev: { name?: string; data?: { items?: PaddleItem[] } } | undefined, priceId: string | null) {
  if (!ev || !priceId || !ev.data?.items) return null;
  if (!["checkout.items.updated", "checkout.updated", "checkout.loaded"].includes(ev.name ?? "")) return null;
  const items = ev.data.items;
  const ok = items.length === 1 && items[0]!.quantity === 1 && (items[0]!.price_id ?? items[0]!.price?.id) === priceId;
  return ok ? null : [{ priceId, quantity: 1 }];
}

/** Which gateways the page can offer right now. Stripe is the default; Paddle remains optional. */
export function availableProviders(c: PayConfig, plan: Plan = "lifetime"): Provider[] {
  const out: Provider[] = [];
  if (c.stripe) out.push("stripe");
  if (checkoutReady(c, plan)) out.push("paddle");
  return out;
}

/** Body for POST /api/stripe-checkout (proxied to api.wpistic.com). Prices are resolved server-side. */
export function stripeSessionRequest(email: string, plan: Plan, origin: string) {
  return {
    product: "bridgistic",
    plan,
    email,
    success_url: `${origin}/?thanks=1&provider=stripe`,
    cancel_url: `${origin}/`,
    source: "pay.bridgistic.app",
  };
}
