# Billing providers: Stripe (Paddle retired)

Bridgistic sells Pro through Stripe only. Paddle was retired on 2026-11-11: it is
closed to new checkout across the product and survives only as read-only history for
accounts that bought before the switch (invoices, receipts and refunds, 90-day tail).

| Plan | Price | Covers |
|---|---|---|
| Free | $0 | the default plan |
| Pro monthly | $12 / month | one license across 3 sites |
| Pro yearly | $99 / year | the same, billed annually |

The $69 Lifetime Deal (and the earlier $29.99 one-time price) went with Paddle.
`apps/pay` sells the two Pro tiers only, and the plan rows the console serves are
seeded from `apps/console/scripts/seed-registry.mjs`.

api.wpistic.com remains the only license issuer. The wpistic design note
(`wpistic-platform/docs/billing-providers.md`) still documents the two-gateway
adapter; this repo now runs the Stripe half of it and keeps `billing_provider` as the
column that records which gateway an account's history came from.

## This repo

| App | Role |
|---|---|
| `apps/pay` | Static checkout page for the two Pro tiers. `functions/api/stripe-checkout.js` posts `{plan, email}` to `api.wpistic.com/api/v1/checkout/stripe/session`; return URLs are pinned to the page's origin, Stripe Tax is on, and no Stripe key ever reaches the browser. Paddle is gone from the page, its copy and its tests. |
| `apps/console` | D1 `0003_billing_provider.sql` adds `users.billing_provider` (DEFAULT `'stripe'`) plus `stripe_customer_id`, `stripe_subscription_id` and `billing_synced_at`; `0006_billing_provider_stripe_default.sql` moves databases that ran the original `'paddle'` default onto `'stripe'` without touching rows. `GET /api/me/billing` and `POST /api/me/billing/portal` proxy wpistic `/api/v1/service/billing/{summary,portal}` with `LICENSE_SERVICE_TOKEN`. Admin → Users shows Billing as Stripe or Legacy. |
| `apps/dashboard` | A Billing page at `/billing` for Stripe subscriptions (plan, status, renewal, invoices). Manage opens a Stripe billing_portal session; pre-switch rows keep their receipt link or fall back to the portal URL the billing service sends. |

## Env

| Where | Variables |
|---|---|
| pay (Pages) | `STRIPE_CHECKOUT=1` (function), `VITE_STRIPE_CHECKOUT=1` (build), `VITE_STRIPE_SESSION_URL=/api/stripe-checkout`, and optionally `WPISTIC_API_URL` |
| console (Pages) | Existing `LICENSE_SERVICE_TOKEN` and `WPISTIC_SERVICE_API`; optionally `WPISTIC_BILLING_API`, and `PADDLE_CUSTOMER_PORTAL_URL` for the retirement-only portal fallback |

## Retirement rules

- `billing_provider` still accepts `'paddle'`: accounts that bought before the switch
  keep the value, and the billing summary keeps resolving their portal link so they
  can see history and open a refund.
- That path is read-only. Nothing new may write `'paddle'`; new accounts are created
  with `'stripe'`.
- Drop the `'paddle'` value, the `PADDLE_CUSTOMER_PORTAL_URL` fallback and the legacy
  branch in `apps/console/functions/lib/billing.ts` once the 90-day tail has run out.

## Reuse for Insightistic

Use the same contract: the summary/portal service routes, the `billing_provider`
column, and the dashboard component.
