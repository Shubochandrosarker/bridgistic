# Metering

## The problem being fixed

`KeyStore::create( …, string $tier = 'custom', int $monthly_quota = 0 )` takes
the billing tier as a **parameter**, and `class-usage.php` — which its own
docblock calls "the monetization layer" — runs inside the customer's WordPress.
Anyone can mint themselves an `unlimited` key. Client-side metering is not
metering.

Phase 2 removes `$tier` from `KeyStore::create`. `class-usage.php` stays, demoted
from "the monetization layer" to a local safety valve: it still protects the
customer's own server from a runaway loop, which is a genuinely useful thing for
it to do. It just stops being the thing we bill from.

## The counter

A **Durable Object per (organization, billing period)**. Not KV. The free repo's
own `docs/CLOUD_CONNECTOR.md` says its KV rate limiting is

> approximate — roughly the configured limit per colo … inadequate as a
> billing-grade counter

and it is right: KV read-then-write races across colos. A Durable Object gives a
single serialised writer per instance, which is exactly what a counter is.

### Reserve / settle

Counting after the fact lets a 5-action destructive call straddle the limit, and
then nobody can say which call crossed it. So:

1. **Reserve** before the call, with the cost and the idempotency key. The DO
   admits or refuses against `consumed + pending + cost`.
2. **Settle** with the actual cost when it finishes — a failure costs 1, not the
   reserved 5.
3. **Release** if the call never happened (denied, rate-limited): costs 0.

A retry carrying the same idempotency key reuses its reservation rather than
doubling it.

### Gate

> 1 000 concurrent calls produce exactly 1 000 counted actions.

## The ledger

Every tool call writes one `action_log` row:

```
organization_id, site_id, actor_type, actor_id, tool, scope_used,
approval_id, snapshot_id, idempotency_key, request_digest,
outcome, error_code, duration_ms, actions_consumed, request_id, created_at
```

`request_digest` is `sha256(canonical(args))` and the args themselves are
**never stored**. A `bridgistic_db_query` or `bridgistic_execute_php` argument
can contain customer PII, credentials, or an entire table; a digest cannot. The
canonical form sorts object keys recursively so `{a:1,b:2}` and `{b:2,a:1}`
produce one digest — otherwise an idempotency key derived from a digest would
depend on the client's JSON key order.

`usage_counters` is a per-(org, month) roll-up written as the DO advances. It is
read by the dashboard and by Stripe reporting, and is **never** used to
authorise a call — the DO is the live counter.

## Stripe

Subscriptions plus a metered overage price. Webhooks are idempotent by event id
(`stripe_events.id` is the primary key, so a redelivery is a no-op) and they
reconcile **against** `action_log`, never the other way round. The meter is the
source of truth for what happened; Stripe is the source of truth for what was
paid. Letting a webhook rewrite the meter would mean a billing dispute has no
independent record to appeal to.
