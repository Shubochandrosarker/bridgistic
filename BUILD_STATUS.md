# Build status

Live state of the Bridgistic production build. Updated at the end of every
phase. If a line here says "done", it means the acceptance criteria in
`RELEASE_GATES.md` for that item were run and passed — not that the code exists.

**Last updated:** 2026-08-21, end of Phase 0.
**Commercial mode:** `BILLING_MODE=FREE_ONLY`. Paid checkout, Stripe portal and
WPistic customer entitlements are disabled and must stay disabled until the
owner records approval (`RELEASE_GATES.md` § Production release gate).
**Live customer sites used:** none. No connection has been made to any site not
owned by this build.

## Phase status

| Phase | Title | State |
|---|---|---|
| 0 | Repository and release hardening | **done** |
| 1 | Canonical contracts + external engine migration | **in progress** — contracts done, import pending |
| 2 | Identity, OAuth, tenancy, site connection | **in progress** — scope model, RBAC, keys, sessions, schema, OAuth/PKCE, connection state machine. Engine import remaining |
| 3 | Shared ActionExecutor | **in progress** — pipeline + policy done; real ports (D1, DO, transport) remain |
| 4 | Metering and entitlements | not started |
| 5 | Scheduler and asynchronous execution | not started |
| 6 | Dashboard | not started |
| 7 | Marketing, documentation, integrations | not started |
| 8 | Staging and production readiness | not started |

## Verification, last run

Run with `npm run verify`.

| Suite | Result |
|---|---|
| `packages/types` | 20 pass |
| `packages/tools` | 24 pass |
| `packages/wp-client` | 13 pass |
| `packages/contracts` | 55 pass |
| `packages/identity` | 43 pass |
| `packages/crypto` | 14 pass |
| `packages/observability` | 19 pass |
| `packages/executor` | 23 pass |
| `apps/api` (isolation + auth, real SQLite) | 24 pass |
| `packages/url-guard` | 23 pass |
| `packages/scheduler-core` | 25 pass |
| `scripts/check-migrations.mjs` | 7 migrations + 2 legacy, 25 assertions |
| `scripts/check-placeholders.mjs` | pass — 0 undeclared, 4 declared and tracked |
| `scripts/check-deploy-env.mjs` | pass — 3 apps, both environments, no top-level fallback |
| `scripts/check-engine-pin.mjs` | pass — a9cf564f88ce, v1.2.0, 194 tests at pin |
| `scripts/check-tool-drift.mjs` | pass — 54 contracts vs 54 engine tools, 5 declared divergences |
| `wrangler deploy --dry-run` | pass — 6/6 (3 apps × 2 environments) |
| `gitleaks` (8.28.0) | pass — clean on working tree and on full history |
| **Total unit tests** | **285 pass, 0 fail** |

Phase 0 added 15 tests: 13 security-policy invariants in `packages/types`
(`test/security-policy.test.ts`) and 2 in `packages/tools` covering the BR-002
reclassification.

External engine (`bridgistic-claude-marketplace`, pinned commit): **194 pass,
0 fail**, run in its own checkout. Not yet run in this repository's CI — that
lands with the Phase 1 import.

## Open findings

Severity is impact if shipped as-is. "Owner" is the role that has to act, not a
person. Every finding here is either fixed, feature-gated, or has a named phase.

| ID | Sev | Finding | State | Next action |
|---|---|---|---|---|
| BR-001 | Critical | Deploy workflow never passed `--env` to Wrangler, and no `wrangler.toml` declared environments, so a "staging" deploy would have published to the production routes. | **fixed** (Phase 0) | — |
| BR-002 | Critical | The Free plan's `read` class included `db:read`, `fs:read`, `users:read`, `options:read`, `woo:orders:read`, `woo:customers:read`. `fs:read` covers `ABSPATH`, which contains `wp-config.php` (DB credentials + auth salts). A free account could exfiltrate site credentials and customer PII. | **fixed** (Phase 0) | Enforcement lands with the executor in Phase 3 |
| BR-003 | High | `cloud/src/default-handler.ts:203` interpolates an upstream error into an HTML response without escaping. The upstream is a host the visitor chose, so its error text is attacker-controlled: reflected XSS on the connector origin. | open (external repo) | Fix on import, Phase 1 |
| BR-004 | High | `UsageCounter` takes `limit` and `periodEndMs` from the request body, does not validate `cost`/`actual` (a negative cost decrements the meter), and has no reservation expiry, so a crash between reserve and settle burns quota permanently. | open | Phase 4 |
| BR-005 | High | `checkSiteUrl` cannot see DNS. A hostname that passes validation and then resolves to a private address at fetch time is not caught. | **mitigated** (Phase 1) | `packages/url-guard` pre-resolves over DoH and refuses unless EVERY A/AAAA record is globally reachable, failing closed. The TOCTOU race is not winnable from a Worker; the control that closes it is response-signature binding, Phase 3 |
| BR-006 | High | `database_id` / KV `id` were `REPLACE_ME` in all three `wrangler.toml`. | **fixed** (Phase 0) | Real ids are set per environment as CI/deploy variables |
| BR-007 | Medium | 27 API routes return `501`. | open, declared | Phases 2–5 by route; `docs/PHASES.md` maps each |
| BR-008 | Medium | Scheduler queue consumer throws by design. | open, declared | Phase 5 |
| BR-009 | Medium | `apps/dashboard` and `apps/web` are README-only. | open, declared | Phases 6–7 |
| BR-010 | Medium | Two competing models for site scope grants: `sites.scopes_granted` (0001) and `site_scope_grants` (0002). Not duplicates — the key's ceiling and the org's grant, wearing names that suggest they are the same thing. | **fixed** (Phase 2) | Renamed to `sites.key_scopes`; `site_scope_grants` authoritative for policy; `effectiveScopes` now intersects four terms; migration 0006 + backfill on both paths |
| BR-011 | Medium | CI had no secret scanning, no placeholder check, no dependency audit. | **fixed** (Phase 0) | — |
| BR-012 | Medium | Repository is public under GPL-2.0-or-later while being prepared to hold customer data and hosted-service code. | **decision recorded** (Phase 0) | Owner must action `docs/LICENSING-DECISION.md` before Phase 2 |
| BR-013 | High | The pinned engine's `guardParams` includes a client-settable `force`, documented as "Bypass the snapshot-required abort (irreversible)". A tool argument that switches off a safety gate — filled in, on the hosted product, by a language model. | **fixed** (Phase 1) | No hosted contract accepts it; bypass is an approval with a reason, made by a person |
| BR-014 | Medium | `bridgistic_create_user` accepted a `password` argument, so a credential would travel through the model's context window, the MCP transport and client-side logging. | **fixed** (Phase 1) | Removed; WordPress generates and emails the password directly |
| BR-015 | Medium | The plugin enforces `Scopes::PLUGINS_MANAGE` — a destructive scope — on `GET /plugins`, which only lists names and versions. The catalogue said `site:read`, so the platform would have authorised calls the site rejects and advertised the tool on Free, where it always fails. | **fixed here** (Phase 1) | Platform now authorises on `plugins:manage` and gates on the operation. The real fix is a read-only scope for that route in the **plugin**; raise upstream |

## Owner decisions required

These block later phases and cannot be made in code.

1. **Repository visibility and licensing** (blocks Phase 2). See
   `docs/LICENSING-DECISION.md`. Phase 2 introduces user accounts and
   credential storage; that code should not land in a public GPL repository.
2. **Independent security review** (blocks Phase 8). Not booked.
3. **WPistic ecosystem-key path** (blocks the Phase 4 adapter going live). The
   licensing brief records an unresolved finding in the shared validation
   response signing. Until it is closed, the adapter stays behind
   `WPISTIC_ENTITLEMENTS_ENABLED=false`.
4. **Production release gate** (blocks any paid billing). `RELEASE_GATES.md`.

## Migration boundary

What comes from where, decided in Phase 0 and unchanged since:

- **Imported** from `bridgistic-claude-marketplace` @ `a9cf564` (see
  `EXTERNAL_ENGINE.lock`): OAuth/PKCE, tenant session and registry, URL guard,
  observability, rate limiting, HMAC signer, WP client, the 54 tool handlers.
- **Stays free and public** in that repository: the WordPress plugin, the local
  MCP server, the Claude Code marketplace manifest, the desktop package.
- **Never leaves this repository**: billing, accounts, entitlements, customer
  data, metering, the hosted scheduler, dashboard.
- **`legacy/`** is retained until the import is complete and tested. It is not
  built, tested or shipped. Deletion is a Phase 1 exit criterion, not before.
