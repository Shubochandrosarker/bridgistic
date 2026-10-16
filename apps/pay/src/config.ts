export interface PayConfig { token: string; env: "production" | "sandbox"; priceId: string }
export function readConfig(env: Record<string, string | undefined>): PayConfig {
  return {
    token: (env.VITE_PADDLE_CLIENT_TOKEN ?? "").trim(),
    env: env.VITE_PADDLE_ENV === "sandbox" ? "sandbox" : "production",
    priceId: (env.VITE_PADDLE_PRICE_LIFETIME ?? "").trim(),
  };
}
/** Checkout is only offered when both a client token and a real price ID are configured. */
export function checkoutReady(c: PayConfig): boolean {
  return /^(live|test)_[A-Za-z0-9]+$/.test(c.token) && /^pri_[a-z0-9]{26}$/.test(c.priceId);
}
/** Mirrors pay.wpistic.com: overlay checkout; customData lets the WPistic webhook attribute the sale. */
export function checkoutOptions(c: PayConfig, email?: string) {
  return {
    items: [{ priceId: c.priceId, quantity: 1 }],
    settings: { displayMode: "overlay", theme: "light", successUrl: `${location.origin}/?thanks=1` },
    customData: { source: "pay.bridgistic.app", product: "bridgistic", offer: "lifetime", ...(email ? { customer_email: email } : {}) },
    ...(email ? { customer: { email } } : {}),
  };
}
