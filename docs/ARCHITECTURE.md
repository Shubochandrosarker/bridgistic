# Architecture

`bridgistic.app` is a hosted, multi-tenant WordPress MCP platform with a managed
scheduler. Customers let an AI hold root-equivalent access on their production
websites. Every design decision below follows from that one fact.

## Where the code comes from

This repository is **not** a greenfield rewrite. The engine is
[`bridgistic-claude-marketplace`](https://github.com/Shubochandrosarker/bridgistic-claude-marketplace)
at `v1.2.0`: a WordPress plugin with HMAC-signed requests, 25 scopes, approvals,
snapshots and an audit log; a 54-tool MCP server; and a Cloudflare Worker relay
with OAuth 2.1 + PKCE, an SSRF guard and a versioned AES-256-GCM credential
envelope, carrying 194 tests across 43 suites.

What was missing was entirely commercial — accounts, orgs, plans, billing,
server-side metering, and a scheduler that does not depend on a visitor
arriving. That is what lives here.

**The free public repo stays free.** No billing code, no account system, no nag
walls in `bridgistic-claude-marketplace`. Security fixes land there first. That
promise is written into `docs/FREE_VS_PAID.md` over there and it is a marketing
asset, not an obstacle.

## Shape

```
apps/
  mcp/         Worker  bridgistic.app/mcp      remote MCP endpoint (migrated from cloud/src)
  api/         Worker  api.bridgistic.app      accounts, plans, billing, entitlements, meter
  scheduler/   Worker + Durable Objects + Queues
  web/         bridgistic.app                  marketing + free tools (static)
  dashboard/   app.bridgistic.app              sites, jobs, runs, approvals, team, billing

packages/
  types/           plans, scopes, entities — the single source of truth for enums
  tools/           the tool catalogue, request digests, metering rules
  wp-client/       signed WordPress transport (WebCrypto, runs on Workers and Node)
  scheduler-core/  cron parsing, IANA timezone maths, overlap/catch-up/retry policy

db/migrations/     D1 schema, plus a legacy/ folder for the one-time backfill
```

### Why `packages/tools` exists

The free repo ships `scripts/check-cloud-tools-drift.js`, which compares two
copies of the tool definitions and tells you when they diverge. Drift detection
is a workaround for having two copies. `packages/tools` is published from here
and consumed by the public local server, so there is only one copy and the
script becomes unnecessary.

## Tenancy

```
organization ──< membership >── user
     │
     ├──< site           (domain, key_id, key_secret_enc, scopes_granted, health)
     ├──< job            (scheduled playbook)
     ├──< subscription   (plan, Stripe)
     └──< action_log     (the meter, and the audit trail — one table)
```

- One org = one billing relationship = one team.
- A site belongs to exactly one org. Moving it is an explicit, audited transfer.
- `sites.id` is the same value the old `tenants.id` was, because it doubles as
  the OAuth grant's `userId`. Regenerating those ids would invalidate every live
  access token. See [MIGRATION-PHASE-0.md](MIGRATION-PHASE-0.md).

## Authentication

| Surface | Mechanism |
|---|---|
| Dashboard + hosted MCP | OAuth 2.1 + PKCE against `bridgistic.app` |
| API / headless | `brg_live_…` keys, prefix-bucketed for rate limiting |
| Platform → site | The site's HMAC key, held encrypted by the Worker and used to sign on the site's behalf. It is never sent to a client. |
| WPistic ecosystem key | `wpi_live_…` resolves through `EntitlementService.resolveForOrg()` via an adapter — see [WPISTIC-INTEROP.md](WPISTIC-INTEROP.md) |

## Authorisation

Effective scope on every call is **requested ∩ plan entitlement ∩ site grant**,
computed server-side, never cached longer than the plan's `check_after`. A site
grant can narrow below the plan; nothing can widen above it. Revocation is
authoritative in the database, not in a cache.

Scopes are tiered in `packages/types/src/scopes.ts`:

| Class | Rule |
|---|---|
| Read | Free. No approval. |
| Content write | Starter+. Logged. |
| Operational | Starter+. Logged. Snapshot first. |
| **Destructive** (`db:write`, `fs:write`, `plugins:manage`, `php:execute`) | Agency+. **Approval + snapshot + step-up auth, every time.** No plan turns this off. |

One deliberate subtlety: `bridgistic_db_query` is catalogued at `db:write` so it
can never be under-classified, but it carries a `minScope` of `db:read` — a
caller holding only `db:read` may run it, and that call is authorised, gated and
metered as a read. Without that, `db:read` would be a scope customers can be
granted that no tool would ever accept.

## Metering

`class-usage.php` inside the customer's WordPress calls itself "the monetization
layer". Client-side metering is not metering — anyone can mint themselves an
`unlimited` key, because `KeyStore::create()` takes `$tier` as a parameter. It
stays, demoted to a local safety valve. The real meter is a **Durable Object
counter per (org, month)** with a reserve/settle protocol, backed by
`action_log`. See [METERING.md](METERING.md).

## Invariants

1. The customer never sets their own limits. Plan, scopes, quotas and retention are server-side.
2. Effective scope = requested ∩ plan ∩ site grant, computed server-side on every call.
3. Destructive verbs require approval + snapshot + step-up auth, always. No exceptions, no plan tier that turns it off.
4. Snapshot before mutate. No snapshot id, no destructive execution.
5. Unattended runs never auto-approve.
6. Digests, not bodies. No request arguments, no PII, no secrets in any log or table.
7. Idempotency on every mutating call and every scheduled run.
8. Fail closed. When the site cannot verify its token and the cached verdict has expired, it refuses.
9. Revocation is authoritative in the database, not in a cache.
10. Every scope grant is visible in the dashboard per site, with a last-used time and one-click revoke.
11. The free public repo stays free.
12. Never edit a client site directly. Client sites receive released, tagged builds.
