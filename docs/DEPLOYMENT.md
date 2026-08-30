# Deployment runbook

## Present status (2026-08-30)

Bridgistic is **not production-ready**. The repository has strong foundations
and a deployable Worker skeleton, but a deployment today would not be a fully
working product:

- `apps/mcp` only serves `/health`; the hosted MCP/OAuth engine import remains.
- Most `apps/api` product routes intentionally return `501`.
- The scheduler dispatch plumbing exists, but its queue executor intentionally
  throws. Enabling its cron in production would create retries and DLQ traffic,
  not successful scheduled actions.
- `apps/dashboard` and `apps/web` contain design notes, not runnable apps.
- BR-016 (signed responses) and BR-020 (snapshot coverage) require upstream
  plugin work or an explicit product decision.
- Licensing/visibility, security review, production billing, legal documents,
  monitoring, backup restore, load testing, and owner approval remain open.

Consequently, the release workflow is **prepared for the completed product**,
not evidence that the product is complete. Keep production GitHub environment
approval locked and do not set `RELEASE_APPROVED_COMMIT` until every Level 3
gate in `RELEASE_GATES.md` has recorded evidence.

## One-time Cloudflare and GitHub setup

1. Create isolated staging and production D1 databases, OAuth KV namespaces,
   scheduler run queues, and dead-letter queues using the names in each
   `wrangler.toml`. Never share a resource between environments.
2. Add `bridgistic.app` to Cloudflare and create the routes declared in the
   Worker configs. Create dashboard and marketing hosting only after those apps
   exist.
3. Create least-privilege Cloudflare API tokens able to deploy Workers, apply
   D1 migrations, and manage the declared bindings/routes.
4. Create protected GitHub environments named `staging` and `production`.
   Require reviewers for production and disable self-review.
5. Add these secrets independently to both environments:
   `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
   `CLOUDFLARE_D1_ID_STAGING`, `CLOUDFLARE_D1_ID_PRODUCTION`,
   `CLOUDFLARE_KV_OAUTH_STAGING`, and
   `CLOUDFLARE_KV_OAUTH_PRODUCTION`. Scope environment values so production
   credentials cannot be used by staging.
6. Provision Worker runtime secrets with `wrangler secret put --env ...` as
   documented beside each app's bindings. Use a unique `TENANT_ENC_KEY` per
   environment. Before rotating it, follow `docs/KEY-ROTATION.md`.
7. Keep `BILLING_MODE=FREE_ONLY` and
   `WPISTIC_ENTITLEMENTS_ENABLED=false` until their release gates close.

## Normal release workflow

1. Merge only after `.github/workflows/ci.yml` is green.
2. Run **Release platform** against `staging`. The workflow re-runs verification,
   validates all bundles, applies D1 migrations, deploys API → MCP → scheduler,
   then checks both public health endpoints.
3. Run the Level 2 E2E suite against disposable WordPress sites. Check queue
   health, logs, alarms, usage reservations, and tenant isolation. Never attach
   customer sites to staging.
4. Back up production D1 and restore it into a scratch database. Review every
   pending migration and its recovery path.
5. Record all 23 Level 3 checks, reviewer, exact commit SHA, and date. Put that
   SHA in the protected production environment variable
   `RELEASE_APPROVED_COMMIT`.
6. Dispatch **Release platform** for production and paste the same full SHA into
   `approved_commit`. Both values must equal `GITHUB_SHA`, preventing approval
   for one revision from releasing another.
7. Observe health, error rate, authentication failures, queues/DLQ, scheduler
   lag, reservation leaks, webhooks, and audit writes. Run one read-only canary
   against an owned site before enabling traffic.
8. Only after written commercial approval may a separate reviewed change alter
   `BILLING_MODE`; never toggle paid billing as an incidental deploy step.

The older **Deploy** workflow deploys one Worker and does not apply migrations;
reserve it for a reviewed break-glass rollback or repair. It enforces the same
commit-bound production approval and is not the normal release path.

## Failure and rollback

- Stop on a migration failure; do not deploy Workers against a partial schema.
- If API deploy fails, no dependent Worker is changed. If MCP fails, API remains
  usable and scheduler is not deployed. Scheduler is deliberately last because
  deploying it activates cron and queue consumption.
- A Worker regression is rolled back by rerunning the workflow at the last
  approved commit (production requires a new approval for that SHA).
- Do not blindly reverse D1 migrations. Restore the verified backup or apply the
  migration-specific recovery plan. The legacy tenant drop is irreversible.
- Disable scheduler triggers/consumers first during an execution incident, then
  revoke affected credentials, preserve logs and audit rows, and follow the
  incident runbook once Phase 8 supplies it.
