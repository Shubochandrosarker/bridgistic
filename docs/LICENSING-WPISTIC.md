# Bridgistic licensing via the existing WPistic license server

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

## Purchase → license (existing flow)
pay.wpistic.com opens a Paddle overlay (`Paddle.Checkout.open`, `customData.source`). The WPistic webhook (`transaction.completed`) resolves the org (customData `organization_id`, else customer email, else creates one), maps each line item's Paddle price via the `prices` table (`paddle_price_id`), and issues the license. **A one-time price is treated as lifetime when its `prices.interval` is NULL** (`isLifetime = price.interval === null`). An unmapped Paddle price fails the webhook with `unknown_paddle_price`.

## What Shuvo must create for the $29.99 Lifetime Deal (nothing was created)
1. Paddle (live), on the existing product "Bridgistic Pro" or a new "Bridgistic" product: **one-time price, USD 29.99, no billing cycle, no trial**, name "Lifetime Deal". Copy its `pri_…` id.
2. WPistic DB: a `plans` row for product `bridgistic`, e.g. slug `lifetime` with the entitlements it should carry, and a `prices` row `(plan_id, paddle_price_id = <pri_…>, amount 2999, currency USD, interval NULL, trial_days 0, status active)`. A migration in the wpistic repo, like `20260908000019_paddle_catalog.sql`, is the clean way.
3. Cloudflare Pages env for pay.bridgistic.app: `VITE_PADDLE_CLIENT_TOKEN` (same public client token as pay.wpistic.com), `VITE_PADDLE_ENV=production`, `VITE_PADDLE_PRICE_LIFETIME=<pri_…>`. Until set, the buy button stays disabled.
4. Paddle approved-domain list: add pay.bridgistic.app to the checkout's approved domains (Paddle → Checkout settings). That is a Paddle setting; Shuvo does it.

## Still missing
- Scheduled re-validation and `/licenses/refresh` token rotation in the plugin (1.3.x had it).
- Plan entitlements for "lifetime" are undefined. The plugin gates nothing on a license today (free-only policy kept).
- Org-level license views in app.bridgistic.app need the hosted API (BR-007) or a WPistic dashboard token.
- PLAT-17 (symmetric `verification_key`) is still open per WPISTIC-INTEROP.md; the hosted API must not trust ecosystem keys before it is settled.
