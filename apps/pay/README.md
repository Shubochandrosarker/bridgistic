# apps/pay: pay.bridgistic.app

Static checkout page for Bridgistic Pro: **$69 lifetime, $12/month, or $99/year.** Vite + Tailwind, no framework. Stripe is the default gateway through the same-origin `/api/stripe-checkout` Pages Function; Paddle remains an optional fallback through Paddle.js v2. Paddle `customData` = `{source: "pay.bridgistic.app", product: "bridgistic", offer: "lifetime"}` for the WPistic webhook.

Config (public values, set in Cloudflare Pages env, see `.env.example`): `VITE_PADDLE_CLIENT_TOKEN`, `VITE_PADDLE_ENV`, `VITE_STRIPE_CHECKOUT=1`, and `VITE_STRIPE_SESSION_URL=/api/stripe-checkout`. The Pages production variable `STRIPE_CHECKOUT=1` enables the server-side proxy. Stripe price IDs are resolved and allowlisted by api.wpistic.com; no Stripe secret is present in this app.

`privacy.html`, `terms.html` and `refund.html` are deliberate empty shells marked "Legal text required". Do not go live without Shuvo's text.
