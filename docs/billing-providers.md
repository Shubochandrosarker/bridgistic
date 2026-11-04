# Billing providers: Paddle and Stripe

Bridgistic sells the same three plans through two gateways, at the same prices:

| Plan | Price | Sites |
|---|---|---|
| Pro monthly | $12 | 3 |
| Pro yearly | $99 | 3 |
| Lifetime Deal | $69 one-time | 1 |

api.wpistic.com remains the only license issuer for both gateways. The full design
is in wpistic's `wpistic-platform/docs/billing-providers.md`. It reuses the names
from Insightistic: `billing_provider` ('paddle'|'stripe'), `stripe_customer_id`,
`stripe_subscription_id`, a provider-agnostic adapter, and event-id webhook dedupe.

## This repo

| App | Change |
|---|---|
| `apps/pay` | Adds a "Pay with" choice of Paddle or Stripe (hidden unless `VITE_STRIPE_CHECKOUT=1`); Paddle stays the default. For Stripe, `functions/api/stripe-checkout.js` posts `{plan, email}` to `api.wpistic.com/api/v1/checkout/stripe/session`. The return URLs are pinned to the page's origin, and Stripe Tax is on. No Stripe key ever reaches the browser. |
| `apps/console` | D1 `0003_billing_provider.sql` adds `users.billing_provider` (default 'paddle'), `stripe_customer_id`, `stripe_subscription_id` and `billing_synced_at`. `GET /api/me/billing` and `POST /api/me/billing/portal` proxy wpistic `/api/v1/service/billing/{summary,portal}` with `LICENSE_SERVICE_TOKEN`. Admin → Users gets a Billing column (Paddle/Stripe). |
| `apps/dashboard` | A Billing page at `/billing` with one UI for both gateways (plan, status, renewal, invoices). Manage opens the Paddle portal link or a Stripe billing_portal session. |

Paddle accounts keep working unchanged. An account becomes `stripe` only after a
paid Stripe checkout.

## Env

| Where | Variables |
|---|---|
| pay (Pages) | `STRIPE_CHECKOUT=1` (function), `VITE_STRIPE_CHECKOUT=1` (build), and optionally `WPISTIC_API_URL` |
| console (Pages) | Existing `LICENSE_SERVICE_TOKEN` and `WPISTIC_SERVICE_API`; optionally `WPISTIC_BILLING_API` and `PADDLE_CUSTOMER_PORTAL_URL` |

## Reuse for Insightistic

Use the same contract: the summary/portal service routes, the `billing_provider`
column, and the dashboard component.
