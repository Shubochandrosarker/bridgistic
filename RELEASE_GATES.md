# Release gates

A gate is a check that must be **run and observed to pass**, not a check that
exists. "The test file is there" is not a gate.

Three levels: every merge, every staging deploy, and the one production
release gate that only the owner can open.

## Level 1 — every merge to `main`

Enforced by `.github/workflows/ci.yml`. No job may carry `continue-on-error`;
a check allowed to fail is not a check.

| # | Gate | Enforced by |
|---|---|---|
| 1 | Typecheck passes across every workspace | `npm run typecheck` |
| 2 | Unit tests pass | `npm test` |
| 3 | Migrations apply to real SQLite, fresh and with legacy data | `npm run lint:sql` |
| 4 | No unsafe placeholder reaches a deployable file | `npm run check:placeholders` |
| 5 | External engine pin is intact and well-formed | `npm run check:engine-pin` |
| 6 | Wrangler config builds and resolves bindings, per app, per environment | `wrangler deploy --dry-run --env <env>` |
| 7 | No secret is committed | `gitleaks` |
| 8 | No known-vulnerable dependency at high or critical | `npm audit --audit-level=high` |

Added as the phases that make them meaningful land:

| # | Gate | Phase |
|---|---|---|
| 9 | Contract compatibility — no undeclared breaking change to a tool schema | 1 |
| 10 | Tool/scope/plan drift between this repo and the pinned engine | 1 |
| 11 | Security test suite (SSRF, rebinding, replay, redaction, isolation) | 1–3 |
| 12 | Dashboard API integration tests | 6 |

## Level 2 — every staging deploy

Staging is a real deployment to real Cloudflare infrastructure. It is isolated
from production at every layer: separate D1, KV, queues, Durable Object
namespaces, OAuth clients, Stripe mode, secrets, and domain.

1. Level 1 gates green on the exact commit being deployed.
2. `wrangler deploy --dry-run --env staging` resolves every binding.
3. The environment named in the workflow input is the environment passed to
   Wrangler. Verified by `scripts/check-deploy-env.mjs`, which fails the build
   if the two can diverge. (This gate exists because they did — BR-001.)
4. Every secret the app reads is set in that environment. Missing secret fails
   the deploy rather than surfacing at runtime as a 500.
5. Migrations for the deploy have been applied to the **staging** D1 and the
   migration test passed against a copy of staging's current schema.
6. Only disposable WordPress test sites are connected. Connecting a real
   customer site to staging is prohibited.
7. Smoke test passes after deploy: health, MCP discovery, one read tool call
   end-to-end against a disposable site.

## Level 3 — production release gate

**Every item is required. The owner records approval in writing. Until then
`BILLING_MODE=FREE_ONLY` and no customer entitlement is activated.**

### Correctness and safety

1. Level 1 and Level 2 gates green on the release commit.
2. No production API route returns `501` unintentionally. Any remaining `501`
   is listed in `BUILD_STATUS.md` with an owner and a date.
3. No `TODO`, `REPLACE_ME`, or intentional throw reachable on a production
   code path.
4. Every execution path — MCP, API, scheduler, dashboard — goes through the
   shared `ActionExecutor`. Verified by test, not by inspection.
5. Tenant isolation tests pass, including the negative cases: another org's
   site id, another org's job id, another org's approval id.
6. Idempotency prevents a duplicate external mutation under concurrent retry.
7. Usage accounting is crash-safe: a killed call releases or settles, and a
   leaked reservation expires.
8. Destructive tools refuse without approval + snapshot + step-up, on every
   plan, proven by test.
9. SSRF and DNS-rebinding adversarial tests pass.
10. Secret redaction test passes over logs, audit rows, notifications, queue
    payloads and error envelopes.

### Operational

11. Staging has run the full end-to-end suite against disposable sites.
12. Load test at target concurrency across multiple tenants, with no
    cross-tenant leakage and no reservation leak.
13. A D1 backup exists, and a restore has been performed into a scratch
    database and verified — a backup that has never been restored is a
    hypothesis.
14. Migration plan reviewed, with a written rollback or recovery path per
    migration. Irreversible migrations are called out as irreversible.
15. Monitoring is live: error rate, auth failures, queue depth and age,
    scheduler lag, approval backlog, reservation leaks, webhook failures.
16. `docs/INCIDENT-RESPONSE.md` runbooks exist and name a responder.
17. Rollback procedure documented and rehearsed once.

### Commercial

18. Independent security review completed, findings triaged, criticals closed.
19. Production Stripe credentials exist and are set as environment secrets.
20. Stripe webhook signature verification enabled and replay protection tested.
21. Billing reconciliation against `action_log` implemented and tested.
22. Terms, privacy policy and security disclosure published.
23. **Owner approval recorded**, naming the commit, the date, and the gates
    reviewed.

Only after 23 may `BILLING_MODE` change.

## What opening a gate does not mean

Passing Level 3 authorizes a production deploy of the platform. It does not
authorize connecting a customer's live site during development, relaxing a
destructive-action gate for a customer who asks, or enabling the WPistic
entitlement path while its open finding stands.
