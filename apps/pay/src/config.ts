export type Plan = "lifetime" | "monthly" | "yearly";
export interface PayConfig {
  token: string;
  env: "production" | "sandbox";
  /** Lifetime Deal ($49.99 one time), the welcome offer. */
  priceId: string;
  /** Regular plans that apply after the welcome offer ends. */
  prices: Record<Plan, string>;
  statusUrl: string;
}

/** Real Paddle prices on product "Bridgistic Pro" (pro_01m1ykaqjsgcgt6xvwsy4jpn83), read 2026-10-19. */
export const PADDLE_PRICES: Record<Plan, string> = {
  lifetime: "pri_01m58k6epsqzbr3qbab84t6p90", // $49.99 USD one time
  monthly: "pri_01m1ykar8aq033865h68a4b9hh", // $12.00 USD per month
  yearly: "pri_01m1ykaqyaaeewsbah07akmpka", // $99.00 USD per year
};

/** Offer terms set by Shuvo. End time assumes Asia/Dhaka (UTC+6). */
export const OFFER = { endsAt: "2026-12-31T23:59:59+06:00", cap: 100 } as const;

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

/** Only a number that came from the server-side Paddle count is ever shown. */
export function remainingLabel(status?: { source?: unknown; remaining?: unknown } | null): string | null {
  if (!status || status.source !== "paddle") return null;
  const n = status.remaining;
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n <= OFFER.cap ? `${n} of ${OFFER.cap} licenses left` : null;
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
