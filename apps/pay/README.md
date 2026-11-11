# apps/pay: pay.bridgistic.app

Static checkout page for Bridgistic Pro: **$12/month or $99/year.** Vite + Tailwind, no framework. Stripe is the only gateway, through the same-origin `/api/stripe-checkout` Pages Function. Paddle and the Lifetime Deal are retired (2026-11-11).

Config (public values, set in Cloudflare Pages env, see `.env.example`): `VITE_STRIPE_CHECKOUT=1`, and `VITE_STRIPE_SESSION_URL=/api/stripe-checkout`. The Pages production variable `STRIPE_CHECKOUT=1` enables the server-side proxy. Stripe price IDs are resolved and allowlisted by api.wpistic.com; no Stripe secret is present in this app.

`privacy.html`, `terms.html` and `refund.html` are deliberate empty shells marked "Legal text required". Do not go live without Shuvo's text.
