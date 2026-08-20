# Phase 0 — moving `cloud/` in without breaking anything

Two migrations happen in Phase 0 and they are independent. Do them in this
order; the second one touches live customer state.

## 1. Code: `cloud/src` → `apps/mcp` + `packages/*`

The free repo's `cloud/` carries **194 tests across 43 suites**, including a
59-test SSRF guard and a tenant-isolation suite. It is the most reviewed code in
the org. It is migrated, not rewritten.

### Moves unchanged

| From (free repo) | To (here) |
|---|---|
| `cloud/src/index.ts` | `apps/mcp/src/index.ts` |
| `cloud/src/agent.ts` | `apps/mcp/src/agent.ts` |
| `cloud/src/default-handler.ts` | `apps/mcp/src/default-handler.ts` |
| `cloud/src/pkce.ts` | `apps/mcp/src/pkce.ts` |
| `cloud/src/url-guard.ts` | `apps/mcp/src/url-guard.ts` |
| `cloud/src/crypto.ts` | `apps/mcp/src/crypto.ts` |
| `cloud/src/observability.ts` | `apps/mcp/src/observability.ts` |
| `cloud/src/wp-oauth-client.ts` | `apps/mcp/src/wp-oauth-client.ts` |
| `cloud/test/**` | `apps/mcp/test/**` |

**Do not reimplement `url-guard.ts`.** It documents its own residual DNS-rebinding
risk honestly and has 59 tests behind it. A second, weaker guard written from
memory is a real regression dressed as a refactor.

### Already extracted here

| Package | Replaces |
|---|---|
| `packages/wp-client` | `cloud/src/services/{signer,wp-client}.ts`, ported to WebCrypto so one file runs on Workers, on Node, and in a test |
| `packages/types` | scattered enums and the plan numbers that lived nowhere |
| `packages/tools` | `cloud/src/tools/**` metadata, plus the digest and metering rules |
| `packages/scheduler-core` | nothing — this is new |

### Changes in `apps/mcp`, and only these

- `tenant-registry.ts` / `tenants-db.ts` resolve through `sites` + `organizations`
  instead of the flat `tenants` table.
- Every tool call is admitted by the plan, metered on the `UsageCounter` Durable
  Object, and written to `action_log` as a digest.
- Tool definitions come from `@bridgistic/tools`.

### Gate

> The public repo builds against the shared package; the existing 194 tests
> still pass.

Run them here before deleting anything there.

## 2. Data: `tenants` → `organizations` + `sites`

`db/migrations/0001_tenancy.sql` creates the schema. The backfill is deliberately
**not** in that file — it reads a table a fresh database does not have — and
lives in `db/migrations/legacy/0001_backfill_tenants.sql`.

### The three properties the backfill must preserve

In order of how badly they break things:

1. **`sites.id = tenants.id`.** `tenants.id` doubles as the OAuth grant's
   `userId` (see `cloud/src/default-handler.ts`), so `BridgisticMcpAgent` looks
   the tenant up straight from the access token's props. Regenerate those ids
   and every live access token stops resolving.
2. **`key_secret_enc` copied verbatim.** No re-encryption during the migration.
   Re-encrypting would need `TENANT_ENC_KEY` at migration time, and getting it
   wrong locks out every connected site at once.
3. **`scopes_granted` copied verbatim.** Nobody silently gains or loses access.

`scripts/check-migrations.mjs` asserts all three against a fixture on every run.

### Ownership is left unclaimed on purpose

A migrated site lands in an orphan-safe personal org with **no member**. Its
owner claims it by signing in and proving control of the site. Guessing an owner
from a site URL would be a tenancy bug with a security blast radius, and there is
no rush: an unclaimed site keeps working, because authorisation flows from the
site's own key, not from a membership row.

### Runbook

```bash
# 0. Export first. This is the rollback.
wrangler d1 export bridgistic-cloud --remote --output backup-$(date +%F).sql

# 1. Schema.
for f in db/migrations/000*.sql; do
  wrangler d1 execute bridgistic-app --remote --file="$f"
done

# 2. Backfill (only on the deployment that has `tenants`).
wrangler d1 execute bridgistic-app --remote \
  --file=db/migrations/legacy/0001_backfill_tenants.sql

# 3. Verify — all three must return 0.
wrangler d1 execute bridgistic-app --remote --command "
  SELECT COUNT(*) FROM tenants t LEFT JOIN sites s ON s.id = t.id
   WHERE s.id IS NULL
      OR s.key_secret_enc <> t.key_secret_enc
      OR s.scopes_granted <> t.scopes;"
```

### Do not run `legacy/0002_drop_tenants.sql` yet

`tenants` is the rollback path. It drops only after every previously-connected
site has made at least one successful signed call against the new schema, and
the export in step 0 is stored outside Cloudflare. The preconditions are listed
in the file itself.

### Gate

> An existing connected site keeps working through the migration.

The only way to know is to check it on the real rows, from a real site, before
the drop.
