# apps/pay: pay.bridgistic.app

Static page for one offer: **Lifetime Deal, $49.99 one time, lifetime use, all future updates included.** Vite + Tailwind, no framework. Paddle.js v2 overlay, same pattern as pay.wpistic.com; `customData` = `{source: "pay.bridgistic.app", product: "bridgistic", offer: "lifetime"}` for the WPistic webhook.

Config (public values, set in Cloudflare Pages env, see `.env.example`): `VITE_PADDLE_CLIENT_TOKEN`, `VITE_PADDLE_ENV`, `VITE_PADDLE_PRICE_LIFETIME`. The buy button stays disabled until a valid token and `pri_…` id are set. No price exists yet; see `docs/LICENSING-WPISTIC.md`.

`privacy.html`, `terms.html` and `refund.html` are deliberate empty shells marked "Legal text required". Do not go live without Shuvo's text.
