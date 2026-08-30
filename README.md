<div align="center">

# Bridgistic.app

**Run every WordPress site you manage from your AI.**

*Signed requests. Scoped keys. Approval before anything destructive. A snapshot before every change. A full audit log.*

[![CI](https://github.com/Shubochandrosarker/bridgistic/actions/workflows/ci.yml/badge.svg)](https://github.com/Shubochandrosarker/bridgistic/actions/workflows/ci.yml)

**Part of the [WordPressistic](https://wordpressistic.com) galaxy**

[Architecture](docs/ARCHITECTURE.md) · [Scheduler](docs/SCHEDULER.md) · [Pricing](docs/PRICING.md) · [Metering](docs/METERING.md) · [Phases](docs/PHASES.md) · [Hard gates](docs/HARD-GATES.md)

[Deployment status and runbook](docs/DEPLOYMENT.md)

</div>

---

> **This repository has changed purpose.** It used to hold an early copy of the
> Bridgistic WordPress plugin and local MCP server, both superseded by
> [`bridgistic-claude-marketplace`](https://github.com/Shubochandrosarker/bridgistic-claude-marketplace).
> That code now lives in [`legacy/`](legacy/). This repository is the **hosted
> platform**: `bridgistic.app`, `api.bridgistic.app`, `app.bridgistic.app`, and
> the managed cloud scheduler.

## What this is

A hosted, multi-tenant WordPress MCP platform with a managed scheduler, sold as a
subscription to agencies and site owners.

The engine already exists and is good: `bridgistic-claude-marketplace` at `v1.2.0`
ships a WordPress plugin with HMAC-signed requests, 25 scopes, approvals,
snapshots and an audit log; a 54-tool MCP server; and a Cloudflare Worker relay
with OAuth 2.1 + PKCE, an SSRF guard and a versioned AES-256-GCM credential
envelope — 194 tests across 43 suites.

What was missing was entirely commercial: accounts, orgs, teams, plans, billing,
server-side metering, and a scheduler that does not depend on a visitor arriving
at the site. That is what this repository builds.

**The free public repo stays free.** No billing code, no account system, no nag
walls there. Security fixes land there first.

## Layout

```
apps/
  mcp/         Worker  bridgistic.app/mcp     remote MCP endpoint
  api/         Worker  api.bridgistic.app     accounts, plans, billing, entitlements, meter
  scheduler/   Worker + Durable Objects + Queues — the managed scheduler
  web/         bridgistic.app                 marketing site + free tools
  dashboard/   app.bridgistic.app             sites, jobs, runs, approvals, team, billing

packages/
  types/           plans, scopes, entities — single source of truth for every enum
  tools/           the 54-tool catalogue, request digests, metering rules
  wp-client/       signed WordPress transport (WebCrypto: Workers and Node)
  scheduler-core/  cron, IANA timezone maths, overlap / catch-up / retry policy

db/migrations/     D1 schema, plus legacy/ for the one-time tenants backfill
scripts/           migration checker
legacy/            the superseded 1.0.0 plugin and MCP server
```

## Getting started

```bash
npm install          # Node 22+
npm run verify       # migrations + typecheck + tests
```

`npm run verify` runs three things:

| Command | What it proves |
|---|---|
| `npm run lint:sql` | Every migration applies to a real SQLite database, the `tenants` backfill preserves site ids, encrypted secrets and granted scopes, and the CHECK constraints actually bite. |
| `npm run typecheck` | Every workspace typechecks under `strict` + `noUncheckedIndexedAccess`. |
| `npm test` | 67 unit tests across the four packages. |

The packages are dependency-free and their tests run on Node's own type
stripping, so `node --test packages/scheduler-core/test/next-run.test.ts` works
with no build step.

## What is real here today

Real, tested code:

- **`packages/scheduler-core`** — a 5-field cron parser and IANA-zone next-run
  computation. A wall-clock time that a spring-forward skipped is skipped, not
  shifted; a fall-back hour that happens twice fires once; `Asia/Kathmandu`
  (+05:45) and `Australia/Adelaide` (+09:30/+10:30) are exact. A 365-iteration
  test fails if a daily job drifts off its local hour even once.
- **`packages/tools`** — the 54-tool catalogue with the scope each one needs,
  the risk class that scope carries, and the metering rule. A test asserts a
  Free-tier scope set cannot reach `db:write`, and another asserts no scope in
  the plugin's vocabulary is left orphaned.
- **`packages/wp-client`** — HMAC-SHA256 request signing on WebCrypto so one
  implementation runs on Workers, on Node and in a test, checked byte for byte
  against an independent `node:crypto` implementation of the plugin's algorithm.
- **`packages/types`** — the plan catalogue, the scope tiering, and the entity
  shapes the migrations mirror.
- **`db/migrations`** — five schema migrations plus the legacy backfill and its
  separate, later, irreversible drop.
- **`apps/api`** — the `UsageCounter` Durable Object with a reserve/settle
  protocol, and the WPistic ecosystem-key adapter.
- **`apps/scheduler`** — the per-job `JobScheduler` Durable Object with a durable
  alarm, a run lock, overlap and catch-up.

Declared and honest about not being implemented: API handlers return `501` naming
the phase that will implement them; the scheduler's queue consumer throws with a
pointer to the doc; `apps/mcp` serves `/health` until `cloud/src` moves in.

See [docs/PHASES.md](docs/PHASES.md) for the full state.

## Before taking money

Four hard gates, all four green, no exceptions —
[docs/HARD-GATES.md](docs/HARD-GATES.md):

1. An **independent security review** of the OAuth relay and the tenant store,
   published. The Worker holds a live root-equivalent credential for every
   connected site.
2. **Metering is server-side and billing-grade** — a Durable Object counter, and
   `KeyStore::create` no longer accepts a customer-supplied `$tier`.
3. **A real end-to-end test on a live site**, recorded in the docs.
4. **Load and abuse testing**, including the DNS-rebinding gap the SSRF guard
   documents as unmitigated.

## Invariants

1. The customer never sets their own limits.
2. Effective scope = requested ∩ plan ∩ site grant, computed server-side on every call.
3. Destructive verbs require approval + snapshot + step-up auth, always.
4. Snapshot before mutate. No snapshot id, no destructive execution.
5. Unattended runs never auto-approve.
6. Digests, not bodies.
7. Idempotency on every mutating call and every scheduled run.
8. Fail closed.
9. Revocation is authoritative in the database, not in a cache.
10. Every scope grant is visible per site, with a last-used time and one-click revoke.
11. The free public repo stays free.
12. Never edit a client site directly.

## Licence — open decision

[`LICENSE`](LICENSE) is still **GPL-2.0-or-later**, inherited from when this repo
held the plugin, and the code in [`legacy/`](legacy/) is genuinely GPL and stays
that way. The hosted platform is a different thing and the brief calls for it to
live in a private repository, which implies a proprietary licence.

**That change has not been made here.** Relicensing a repository is a decision
for its owner, not for a scaffolding commit, and it interacts with the promise in
`docs/FREE_VS_PAID.md` on the public side. See
[docs/LICENSING-DECISION.md](docs/LICENSING-DECISION.md) for what has to be
settled and in what order.

The free WordPress plugin and local MCP server remain GPL-2.0-or-later in
[`bridgistic-claude-marketplace`](https://github.com/Shubochandrosarker/bridgistic-claude-marketplace)
and that does not change under any option.
