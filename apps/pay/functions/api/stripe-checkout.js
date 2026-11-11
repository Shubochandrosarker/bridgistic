// Cloudflare Pages Function: POST /api/stripe-checkout
//
// Stripe is the only public checkout. The page posts {plan}; this function
// forwards to api.wpistic.com, which creates the Checkout Session. Stripe
// collects the customer's name and email. The webhook then creates the
// Bridgistic account and sends setup instructions. No Stripe key ever
// reaches pay.bridgistic.app.
//
// Env (Pages project settings):
//   WPISTIC_API_URL   optional  default https://api.wpistic.com
//   STRIPE_CHECKOUT   "1" turns this on (off by default)

const PLANS = new Set(["monthly", "yearly"]);

export function sessionBody(input, origin) {
  const plan = String(input?.plan ?? "");
  if (!PLANS.has(plan)) return { error: "Choose monthly or yearly." };
  return {
    body: {
      product: "bridgistic",
      plan,
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
