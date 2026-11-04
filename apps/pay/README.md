# apps/pay: pay.bridgistic.app

Static page for Bridgistic pricing: **$69 lifetime for one site, $12 monthly or $99 yearly for three sites.** Vite + Tailwind, no framework. Paddle.js v2 overlay remains available alongside Stripe hosted Checkout; `customData` = `{source: "pay.bridgistic.app", product: "bridgistic", offer: "lifetime"}` for the WPistic webhook.

Config (public values, set in Cloudflare Pages env, see `.env.example`): `VITE_PADDLE_CLIENT_TOKEN`, `VITE_PADDLE_ENV`, `VITE_PADDLE_PRICE_LIFETIME`. The live Paddle lifetime price is `pri_01m6jjwzmy59ck0t0fgs87g37f`; the buy button stays disabled until the client token and a valid price id are present. Stripe remains independently disabled until its production configuration gate is approved.

`privacy.html`, `terms.html` and `refund.html` are deliberate empty shells marked "Legal text required". Do not go live without Shuvo's text.
