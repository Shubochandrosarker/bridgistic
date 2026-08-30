# Phases

Each phase has one gate. A phase is not done when the code merges; it is done
when its gate is demonstrated.

| Phase | Work | Gate | State |
|---|---|---|---|
| **0** | Scaffold `bridgistic-app`. Move `cloud/` in; extract `packages/tools`, `packages/wp-client`, `packages/types`; wire the public local server to consume `packages/tools` so drift is impossible. | Public repo builds against the shared package; existing 194 tests still pass. | **Scaffold + packages landed.** `cloud/src` move outstanding. |
| **1** | Tenancy: org / user / membership / site. Migrate `tenants` without forcing any site to reconnect. Write the `TENANT_ENC_KEY` rotation migration before you need it. | An existing connected site keeps working through the migration. | Schema + backfill + verified rotation design landed; not yet run against production D1. |
| **2** | Plans, entitlements, scope tiering, per-site grants. WPistic ecosystem-key adapter. Remove `$tier` from `KeyStore::create`. | A Free-tier key cannot call `db:write`. A site grant can narrow below the plan. | Catalogue, tiering and adapter landed and tested; eleven authenticated read handlers landed, action handlers outstanding. |
| **3** | Server-side metering on a Durable Object counter. `action_log` with digests. Soft/hard limits. Stripe subscriptions + metered overage + idempotent webhooks. | 1 000 concurrent calls produce exactly 1 000 counted actions. | Counter DO + digest + rules landed; Stripe outstanding. |
| **4** | The cloud scheduler — jobs, runs, DO alarms, Queues, timezone cron, overlap/catch-up/retry/timeout/concurrency, snapshot-before-mutate, approval pause + expiry, notifications, re-run. | A 5-minute job survives a 2-hour outage without firing 24 catch-up runs; a destructive step pauses for approval and expires cleanly; DST transitions do not drift. | `scheduler-core` + job DO landed and tested. Queue consumer outstanding. |
| **5** | `app.bridgistic.app` dashboard. | An agency can onboard 25 sites and see every run in one place. | Not started. |
| **6** | `bridgistic.app` marketing site, pricing, FAQ, 10 free tools, 6+ comparison pages, docs, affiliate. | Every free tool ranks its own query and the MCP Config Generator converts. | Not started. |
| **7** | Claude connector directory submission, `mcpb sign`, Cursor/Windsurf/ChatGPT/Codex/Gemini configs, Product Hunt. | One-click install from the Claude directory works end to end. | Not started. |
| **8** | Security review, load/abuse testing, live E2E recorded in the docs. | All four hard gates green. **Then, and only then, take money.** | Not started. Book the review now — see [HARD-GATES.md](HARD-GATES.md). |

## What "landed" means in this repo today

Real, tested code:

- `packages/types` — plans, scope tiering, entities. 7 tests.
- `packages/tools` — 54-tool catalogue, digests, metering rules. 22 tests.
- `packages/wp-client` — WebCrypto HMAC signing, signed transport, URL
  normalisation. 13 tests.
- `packages/scheduler-core` — cron, IANA timezone maths, DST policy, overlap /
  catch-up / retry / approval-expiry. 25 tests.
- `db/migrations` — five schema migrations plus the legacy backfill and drop,
  applied against real SQLite by `scripts/check-migrations.mjs` with 16 assertions
  including the three properties the `tenants` backfill must preserve.
- `apps/api` — the `UsageCounter` Durable Object with reserve/settle, the
  entitlement adapter, the full route surface declared, and eleven authenticated
  read handlers backed by `OrgScope`.
- `apps/scheduler` — the per-job `JobScheduler` Durable Object with alarm, lock,
  overlap and catch-up.

Declared but not implemented, and honest about it: remaining API action handlers
return 501 with the phase that will implement them; the scheduler's queue
consumer throws with a pointer to `docs/SCHEDULER.md`; `apps/mcp` serves
`/health` and nothing else until `cloud/src` moves in.
