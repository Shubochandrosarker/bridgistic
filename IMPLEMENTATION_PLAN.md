# Implementation plan

Nine phases. Each is independently reviewable, independently testable, and
ends with `BUILD_STATUS.md` updated and its verification output recorded.

A phase is complete when every acceptance criterion has been **run**. Not when
the code exists.

## Migration boundary

Decided in Phase 0, from a full read of both repositories at
`bridgistic` `8ddf771` and `bridgistic-claude-marketplace` `a9cf564`.

```
bridgistic-claude-marketplace  (public, GPL-2.0-or-later, stays free)
├── wordpress-plugin/     the only execution authority on a site
├── mcp-server/           local stdio MCP server
├── mcpb/, plugins/       Claude Desktop + Claude Code packaging
└── cloud/                ──┐  imported, pinned at a9cf564
                            │
bridgistic  (hosted platform)
├── packages/contracts     ◄┘  canonical tool contracts, generated from one registry
├── packages/*             plans, scopes, tools, transport, scheduler logic
├── apps/mcp               MCP server over Streamable HTTP
├── apps/api               accounts, sites, billing, approvals
├── apps/scheduler         cron dispatch + queue consumer
├── apps/dashboard         operational control plane
└── apps/web               marketing + docs
```

Nothing proprietary moves left. No billing, account, credential or customer
data code lands in the public repository — `SECURITY_MODEL.md` §5 and
`docs/LICENSING-DECISION.md`.

`legacy/` is retained until the Phase 1 import is tested, then removed. It is
already excluded from build, test and ship.

---

## Phase 0 — Repository and release hardening ✅

**Scope.** Make the repository safe to build in before building in it.

- Audit both repositories; pin the external engine (`EXTERNAL_ENGINE.lock`).
- Fix the deploy workflow so the selected environment reaches Wrangler.
- Declare `staging` and `production` environments; remove production routes
  from the shared top level.
- Remove `REPLACE_ME` from deployable config.
- Add placeholder scanning, secret scanning, dependency audit, engine-pin check.
- Split `read` into `safe_read` / `sensitive_read`; take sensitive reads off
  the Free plan (BR-002).
- Write `BUILD_STATUS.md`, `IMPLEMENTATION_PLAN.md`, `SECURITY_MODEL.md`,
  `RELEASE_GATES.md`.

**Acceptance.** CI green including the new checks; no placeholder in a
deployable file; `wrangler --dry-run` passes per app *per environment*; Free
plan holds no sensitive scope, proven by test.

---

## Phase 1 — Canonical contracts and engine import

**Scope.** One registry, one schema, one source of tool truth.

- Create `packages/contracts`: versioned tool contracts with runtime JSON
  Schema validation. TypeScript types alone are insufficient — the MCP client
  is not compiled against our types.
- Each contract carries: `name, version, description, inputSchema,
  outputSchema, requiredScopes, riskClass, requiresApproval, requiresSnapshot,
  supportsIdempotency, timeoutMs, meterUnit, enabledPlans`.
- **Harden BR-005**: `packages/url-guard` — DoH pre-resolution, private-IP
  rejection of every resolved address, adversarial tests.
- The `cloud/src` import moves to **Phase 2**. The code left to import —
  `default-handler.ts`, `tenant-registry.ts`, `tenants-db.ts` — *is* the
  identity layer, and importing it here would mean importing a tenancy model
  Phase 2 immediately replaces, then rewriting it. BR-003 lives in the OAuth
  authorize flow, so its fix belongs with that flow rather than before it.
- Collapse the duplicate tool definitions (`cloud/src/tools` vs
  `mcp-server/src/tools`) into generated output from the contract registry.
- Cross-repository drift check in CI: tool names, scopes, plan mapping.
- MCP discovery and metadata generated from the registry, never hand-written.

**Acceptance.** Adversarial SSRF/rebinding suite green; drift check fails on
an induced drift; no tool defined in two places. (`legacy/` removal and the
194 imported tests move to Phase 2 with the import.)

---

## Phase 2 — Identity, OAuth, tenancy, site connection

**Scope.** Know who is calling and what they own.

- OAuth 2.1 + PKCE, state and nonce, MCP client authorization, consent.
- Users, organizations, memberships, roles (Owner, Admin, Operator, Approver,
  Viewer, Billing manager, Support/auditor), service accounts.
- API keys: create, hash, rotate, revoke. Never stored in the clear.
- Sessions: expiry, revocation, invalidation, step-up authentication.
- Site connection: challenge → plugin verification → signed connection →
  claim → explicit grants → health check.
- Site transfer, claim, reconnection, credential rotation and versioning,
  revocation, suspension, deletion.
- **BR-010, done**: the two models were not duplicates. `sites.key_scopes` is
  the ceiling the plugin enforces; `site_scope_grants` is the organization's
  policy. Both are needed, and `effectiveScopes` intersects four terms.
- Import `cloud/src`, preserving its 194 tests, onto the new tenancy model.
- **Fix BR-003 on import**: escape upstream error text in HTML responses.
- Remove `legacy/` once the import is tested.
- Legacy `tenants` migration preserving `sites.id = tenants.id` (the OAuth
  grant's `userId`) and the encrypted credential verbatim, with a formal claim
  process for a migrated site that has no user.

**Acceptance.** Tenant isolation tests including negative cross-org cases;
OAuth/PKCE end-to-end; rotation invalidates prior grants; no route trusts a
client-supplied identifier, proven by test.

---

## Phase 3 — Shared ActionExecutor

**Scope.** One pipeline. There is no second security implementation.

The 23-step pipeline in `SECURITY_MODEL.md`, from authenticate through to
structured result, with correct failure handling at every step: usage released
or settled, failure recorded without credentials or site content, retry
behaviour explicit, unsafe mutations never auto-retried.

- Runtime input **and output** validation against the contract.
- Durable claim-before-call idempotency.
- Approvals, snapshots (with `create`/`restore`/`delete` split), concurrency
  locks, audit with digests.
- MCP, API and scheduler all call it. Handlers become thin adapters.

**Acceptance.** A test proves each of MCP, API and scheduler refuses a
destructive call without approval; duplicate-mutation test under concurrent
retry; a killed executor releases its reservation.

---

## Phase 4 — Metering and entitlements

- Harden `UsageCounter` (BR-004): server-derived limits, input validation,
  reservation expiry via alarm, crash recovery, idempotent settlement,
  negative and overflow rejection, bounded pending map.
- Per-tool, per-org, per-site metering; monthly period; overage policy; export;
  audited support adjustment.
- Rate and concurrency limits, separate from quota.
- `BILLING_MODE=FREE_ONLY` safe by construction.
- Stripe adapter behind a disabled flag; webhook signature verification,
  replay protection and reconciliation against `action_log`, all tested while
  disabled.

**Acceptance.** 1 000 concurrent calls produce exactly 1 000 counted actions;
a leaked reservation expires and is recovered; no client-supplied value reaches
a billing decision, proven by test.

---

## Phase 5 — Scheduler and asynchronous execution

Queue producer and consumer; overlap/skip/queue/cancel-previous policies;
concurrency keys per site, org and tool; generation/fencing tokens so a
disarmed job's in-flight message cannot execute; retries with backoff and
jitter; dead-letter handling; approval pause and resume; snapshot before risky
runs; run history; manual run; notifications with retry.

Queue messages carry ids and bounded metadata only — never credentials.
The consumer calls `ActionExecutor`.

**Acceptance.** Disarm-then-deliver test proves fencing; DST and catch-up
tests; dead-letter path exercised.

---

## Phase 6 — Dashboard

Every screen in the brief, with every state: loading, empty, error, permission
denied, suspended site, expired connection, pending approval, usage limit
reached, offline, mobile, long-running action, destructive confirmation.

Typed API client generated from the contract package. No business logic in the
client that can disagree with the server.

**Acceptance.** Integration tests against the API; a permission-denied path
renders as denial, not as a crash.

---

## Phase 7 — Marketing, documentation, integrations

Positioning, security model, pricing, free-vs-hosted distinction, install and
connection docs, tool catalogue generated from contracts, API and scheduler
reference, disclosure policy, privacy, terms, status link.

WPistic adapters — identity, catalogue, entitlements, licensing, billing,
Brain, AI Gateway — as versioned interfaces. One entitlement engine, not two.
The Gateway and Brain never receive credentials and never bypass the pipeline.

No unsupported security or compliance claim.

---

## Phase 8 — Staging and production readiness

Isolated staging; disposable WordPress sites only; end-to-end, load and
security tests; migration and rollback validation; independent security
review; Level 3 gates; billing stays disabled until owner approval.

---

## Working rules

Inspect before changing. State scope. Small changes. Tests with the change.
Run the verification. Re-read the diff for tenant-isolation and secret-leak
issues. Update docs. Update `BUILD_STATUS.md`. Report what was run and what
it printed. Never call a phase complete on an unverified criterion.
