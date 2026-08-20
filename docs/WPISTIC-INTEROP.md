# WPistic ecosystem-key interop

Bridgistic is a WPistic product. A customer holding the ecosystem key
(`wpi_live_…`) must be able to paste it and have Bridgistic light up — no second
key, no second account, no second invoice.

## The rule

**Build the adapter, not a second entitlement engine.**

`EntitlementService.resolveForOrg(orgId)` on the WPistic platform already merges
plan entitlements from every active subscription and every licence an org holds
into one flat map, with documented merge rules (numbers → max, booleans → true,
strings → newest). Called without a `productSlug` it returns the whole ecosystem
map. That function *is* the single-key resolver.

Writing a parallel resolver here would guarantee the two drift, and the failure
mode is a customer being told two different things about what they bought.

## The keys Bridgistic reads

Only the `bridgistic.*` slice. The map is the whole ecosystem; SEOistic's and
Memberistic's keys are none of this Worker's business.

| Key | Meaning |
|---|---|
| `bridgistic.plan` | **Display only.** Never the gate. |
| `bridgistic.sites.max` | Connected sites. `null` = unlimited. |
| `bridgistic.actions.monthly` | Quota. |
| `bridgistic.scheduler.jobs.max` | Scheduler jobs. |
| `bridgistic.scheduler.min_interval_seconds` | Interval floor. |
| `bridgistic.snapshot.retention_days` | Snapshot retention. |
| `bridgistic.audit.retention_days` | Audit retention. |
| `bridgistic.team.seats` | Team seats. |
| `bridgistic.scopes` | Space-separated scope list. |
| `bridgistic.php_execute.enabled` | Whether `php:execute` is entitled at all. |
| `bridgistic.white_label.enabled` | White-label. |

`bridgistic.plan` being display-only matters: a plan **name** must never be what
unlocks a capability, or renaming a plan silently changes what customers can do.
The gate is always the individual entitlement key. This is the same rule the
licensing brief states as its invariant 2.

Adding Bridgistic to an existing WPistic subscription changes the resolved map on
the next validate and lights it up here with no change on this side. That is the
entire "no new key" promise, and the adapter is what makes it land.

## Where it lives

`apps/api/src/entitlements.ts`. Two entry points, one output shape:

- `fromSubscription(plan)` — a Stripe subscription in this platform's own
  `subscriptions` table.
- `fromWpisticEntitlements(map)` — the ecosystem map, filtered to
  `bridgistic.*`, layered over the plan's defaults so keys the map does not
  carry still have an answer.

Everything downstream — scope resolution, seat checks, quota — reads the
resolved shape and does not know or care which source produced it.

## Prerequisite from the licensing side

The licensing brief's Phase A is a hard prerequisite for trusting an ecosystem
key here at all: asymmetric response signing, every client verifying, and every
`__return_true` filter bypass deleted. Until that lands, an ecosystem key is a
claim, not a credential, and this adapter must not be the only thing standing
between a forged response and an Agency-tier entitlement.

Concretely: do not enable the `wpi_live_…` path in production before
`PLAT-17` (the symmetric `verification_key` a licensee can use to forge signed
responses) is settled.
