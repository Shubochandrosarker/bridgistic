export type Plan = "monthly" | "yearly";
export interface PayConfig {
  stripe: boolean;
  /** Server endpoint that creates a Stripe Checkout session without exposing a secret. */
  stripeSessionUrl: string;
}

export function readConfig(env: Record<string, string | undefined>): PayConfig {
  return {
    // Stripe is the only public checkout. The flag stays so a broken deploy
    // can disable the button without shipping a half-configured page.
    stripe: env.VITE_STRIPE_CHECKOUT !== "0",
    stripeSessionUrl: (env.VITE_STRIPE_SESSION_URL ?? "/api/stripe-checkout").trim(),
  };
}

export function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/** Body for POST /api/stripe-checkout. Stripe collects name and email. */
export function stripeSessionRequest(plan: Plan, origin: string) {
  return {
    product: "bridgistic",
    plan,
    success_url: `${origin}/?thanks=1&provider=stripe`,
    cancel_url: `${origin}/`,
    source: "pay.bridgistic.app",
  };
}
