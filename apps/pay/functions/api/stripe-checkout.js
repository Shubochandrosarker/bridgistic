// Cloudflare Pages Function: POST /api/stripe-checkout
//
// Stripe as a second gateway next to Paddle. The page posts {plan, email, ...};
// this function forwards to api.wpistic.com, which resolves the Stripe price from
// its own plan table (same plans, same prices as Paddle), creates the Checkout
// Session with Stripe Tax, and later issues the license from the webhook. No Stripe
// key ever reaches pay.bridgistic.app.
//
// Env (Pages project settings):
//   WPISTIC_API_URL   optional  default https://api.wpistic.com
//   STRIPE_CHECKOUT   "1" turns this on (off by default)

const PLANS = new Set(["monthly", "yearly", "lifetime"]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function sessionBody(input, origin) {
  const plan = String(input?.plan ?? "");
  const email = String(input?.email ?? "").trim().toLowerCase();
  if (!PLANS.has(plan)) return { error: "Choose monthly, yearly or the Lifetime Deal." };
  if (!EMAIL.test(email) || email.length > 255) return { error: "Enter a valid email for your license key." };
  // Return URLs are always this site, never taken from the client.
  return {
    body: {
      product: "bridgistic",
      plan,
      email,
      success_url: `${origin}/?thanks=1&provider=stripe`,
      cancel_url: `${origin}/`,
      source: "pay.bridgistic.app",
    },
  };
}

export async function onRequestPost({ request, env }) {
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  if (env.STRIPE_CHECKOUT !== "1") return json({ message: "Stripe checkout is not enabled." }, 409);
  const origin = new URL(request.url).origin;
  const parsed = sessionBody(await request.json().catch(() => null), origin);
  if (parsed.error) return json({ message: parsed.error }, 400);
  const api = (env.WPISTIC_API_URL || "https://api.wpistic.com").replace(/\/$/, "");
  let res;
  try {
    res = await fetch(`${api}/api/v1/checkout/stripe/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(parsed.body) });
  } catch {
    return json({ message: "Stripe checkout is not available right now." }, 502);
  }
  const data = await res.json().catch(() => null);
  const checkoutUrl = data?.checkout_url ?? data?.url;
  if (!res.ok || !checkoutUrl || !/^https:\/\/checkout\.stripe\.com\//.test(checkoutUrl)) {
    return json({ message: data?.error?.message ?? "Stripe checkout is not available right now." }, res.ok ? 502 : res.status === 409 ? 409 : 502);
  }
  return json({ url: checkoutUrl });
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: { "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" } });
}
