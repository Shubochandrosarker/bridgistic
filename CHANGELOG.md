# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed — repository purpose

This repository now holds **`bridgistic.app`, the hosted platform**. It used to
hold an early copy of the Bridgistic WordPress plugin and local MCP server, both
superseded by
[`bridgistic-claude-marketplace`](https://github.com/Shubochandrosarker/bridgistic-claude-marketplace)
at `v1.2.0`. That code moved to `legacy/` unchanged and is no longer built,
tested or shipped from here.

The free public repo stays free: no billing code, no account system, no nag walls
land there, and security fixes land there first.

### Added — platform scaffold (phase 0)

- **`packages/types`** — plan catalogue, scope tiering (read / content write /
  operational / destructive), and the entity shapes the migrations mirror.
- **`packages/tools`** — the 54-tool catalogue with the scope each tool needs,
  canonical request digests, and the published metering rule.
- **`packages/wp-client`** — HMAC-SHA256 request signing ported to WebCrypto so
  one implementation runs on Cloudflare Workers, on Node, and in tests; the
  signed transport; and site-URL normalisation.
- **`packages/scheduler-core`** — a 5-field cron parser, IANA-zone next-run
  computation with explicit DST policy, and the overlap / catch-up / retry /
  approval-expiry decisions.
- **`db/migrations`** — five schema migrations (tenancy, billing and
  entitlements, metering, scheduler, health) plus `legacy/` for the one-time
  `tenants` backfill and its separate, later, irreversible drop.
- **`apps/api`** — the `UsageCounter` Durable Object with a reserve/settle
  protocol, the WPistic ecosystem-key entitlement adapter, and the full route
  surface declared.
- **`apps/scheduler`** — the per-job `JobScheduler` Durable Object owning a
  durable alarm, a run lock, and `next_run_at`; plus the dispatcher and queue
  wiring.
- **`apps/mcp`** — Worker skeleton and the migration plan for `cloud/src`.
- **`scripts/check-migrations.mjs`** — applies every migration to a real SQLite
  database and asserts the three properties the `tenants` backfill must preserve.
- **Docs** — architecture, scheduler, phase-0 migration runbook, key rotation,
  pricing, metering, hard gates, WPistic interop, phases, and the open licensing
  decision.
- **CI** — typecheck and tests across every workspace, the migration check, and
  `wrangler --dry-run` validation per Worker. Deploys are manual until the four
  hard gates are green.

### Notes

- 67 unit tests and 16 migration assertions pass. No test asserts current buggy
  behaviour.
- API handlers return `501` naming the phase that will implement them, rather
  than `404` — a `404` reads as "wrong URL".
- `LICENSE` is still GPL-2.0-or-later and this repository is still public. Both
  need a decision before phase 1 — see `docs/LICENSING-DECISION.md`.

---

## Superseded history

Releases of the plugin and local MCP server that used to live here are recorded
in `bridgistic-claude-marketplace`. The 1.0.0 code is preserved in `legacy/`.
