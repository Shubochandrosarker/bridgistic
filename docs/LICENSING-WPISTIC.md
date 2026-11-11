# Bridgistic licensing via the existing WPistic license server

> **Status (2026-11-11):** Stripe is the only live gateway. Paddle is retired and is
> kept only as read-only history — anything below that describes a Paddle checkout is
> the pre-switch flow and is no longer how a licence is sold.

Found in: `Shubochandrosarker/wpistic` → `wpistic-platform/docs/API_SPECIFICATION.md`, `apps/api/src/modules/billing/paddle-service.ts`, `database/migrations/20260908000019_paddle_catalog.sql`; the removed 1.3.x client is in `Wordpressistic/bridgistic@ffe2f92:wordpress-plugin/bridgistic/includes/sdk/` (`LicenseManager.php`, `Api/WpisticApi.php`, `Security/HmacVerifier.php`). Live check 2026-10-16: `POST https://api.wpistic.com/api/v1/licenses/validate` answers with a zod validation error (server up); `GET /health` 200.

## API (base `https://api.wpistic.com/api/v1`)
| Call | Body | Returns |
|---|---|---|
| `POST /licenses/activate` | `key, domain, installation_uuid, site_url?, home_url?, environment, product_version?, wp_version?, php_version?`; header `X-Idempotency-Key` | `valid, status, grace_period_ends_at, product, plan, expires_at, activation{id,domain,environment}, entitlements{}, updates{}, check_after, grace_period_days, signature, activation_token (RS256 JWT), verification_key (hex)` |
| `POST /licenses/validate` | `activation_token, domain, environment, installation_uuid, plugin_version?` | same minus token/key; 403 on domain/env/uuid mismatch |
| `POST /licenses/refresh` | `activation_token` | rotates token + key |
| `POST /licenses/deactivate` | `activation_token, installation_uuid` | `{deactivated:true}` |
| Dashboard (JWT): `GET /organizations/:orgId/licenses`, `…/:id`, `POST …/:id/rotate`, `DELETE …/:id/activations/:activationId` | | org-level license management (app.wpistic.com) |

Status values: `active | suspended | expired | revoked | cancelled | grace_period | activation_suspended`. Errors: 400 `invalid_key`/`invalid_domain`, 403, 409 `activation_limit_reached`, 429.
Signature: `signature = HMAC-SHA256(verification_key, canonical_json(payload minus signature, activation_token, verification_key))`, hex, sorted keys, no whitespace.

## How Bridgistic uses it
Activation is bound to a site's domain + installation id, so the **site** activates, not the browser:
dashboard License screen → signed `POST bridgistic/v1/license/activate` (plugin PR Wordpressistic/bridgistic#8, scope `license:manage`) → plugin calls `/licenses/activate`, verifies the signature, stores token + verification key in a non-autoloaded option, returns a masked status. Validate and deactivate work the same way.

## Purchase → license
`apps/pay` posts `{product, plan, success_url, cancel_url, source}` to `api.wpistic.com/api/v1/checkout/stripe/session` (no email in the body — Stripe Checkout collects it together with the payment); the WPistic Stripe webhook (`/v1/webhooks/stripe`, idempotent by event id) resolves the org, maps the Stripe price to a `plans`/`prices` row and issues the licence. Pro bills monthly or yearly; no price is treated as lifetime any more.

### Legacy Paddle flow (retired 2026-11-11, history only)
Before the switch pay.wpistic.com opened a Paddle overlay (`Paddle.Checkout.open`, `customData.source`). The WPistic webhook (`transaction.completed`) resolved the org (customData `organization_id`, else customer email, else creates one), mapped each line item's Paddle price via the `prices` table (`paddle_price_id`), and issued the license. **A one-time price was treated as lifetime when its `prices.interval` is NULL** (`isLifetime = price.interval === null`), and an unmapped Paddle price failed the webhook with `unknown_paddle_price`. This stays documented because the 90-day tail — receipts, invoices and refunds — still refers to it.

## Obsolete: the one-time Lifetime Deal setup
This section used to describe creating a Paddle one-time price for the Lifetime Deal. Paddle and the Lifetime Deal both retired on 2026-11-11, so there is nothing left to create and no `VITE_PADDLE_*` build variable to set. Pro is sold as a Stripe subscription at $12/month or $99/year (see `apps/pay`).

## Still missing
- Scheduled re-validation and `/licenses/refresh` token rotation in the plugin (1.3.x had it).
- Plan entitlements: Pro is defined by the Stripe price upstream; the old "lifetime" slug no longer applies. The plugin gates nothing on a license today (free-only policy kept).
- Org-level license views in dashboard.bridgistic.app need the hosted API (BR-007) or a WPistic dashboard token.
- PLAT-17 (symmetric `verification_key`) is still open per WPISTIC-INTEROP.md; the hosted API must not trust ecosystem keys before it is settled.
