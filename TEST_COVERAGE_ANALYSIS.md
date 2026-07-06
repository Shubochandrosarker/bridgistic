# Test Coverage Analysis

This document analyzes current test coverage across this repo's two components — the
WordPress plugin (`bridgistic/`) and the MCP server (`bridgistic-mcp-server/`) — and
proposes concrete areas to improve. It's a survey, not a change to behavior; no
production code is modified here.

## Current state

| Component | Test infra | What it actually runs |
|---|---|---|
| `bridgistic/` (PHP plugin) | One raw PHP script, no PHPUnit | `tests/hmac-roundtrip.test.php`, invoked directly in CI (`.github/workflows/ci.yml`, job `plugin`) |
| `bridgistic-mcp-server/` (Node/TS) | `evals/contract.test.mjs` + `evals/integration.test.mjs`, no unit test framework | CI job `mcp-server` runs `npm test` (both eval scripts) after `npm run build` |

Both components rely on hand-rolled scripts rather than a test framework, which is a
reasonable low-overhead choice for their current size — but it means coverage is
whatever the one script happens to exercise, with no framework nudging toward
completeness (no coverage reports, no easy way to add a case without boilerplate).

## `bridgistic/` — WordPress plugin (~30 files under `includes/`)

`tests/hmac-roundtrip.test.php` covers HMAC mint/sign/verify, tamper detection,
unknown-key rejection, replay, and stale-timestamp rejection — a solid foundation for
the crypto/auth round trip. Everything downstream of authentication is untested:

- **`security/class-hmac-verifier.php`** — no test for a disabled key being rejected,
  or for IP-allowlist enforcement (including malformed CIDR entries and IPv6, where
  `ip2long` silently fails).
- **`security/class-crypto.php`** — no test of the OpenSSL-GCM fallback path (CI's
  environment likely has libsodium, so that branch never runs); no test that tampered
  ciphertext fails closed rather than returning garbage plaintext; no test that
  rotating the encryption key invalidates old ciphertext as expected.
- **`security/class-key-store.php`** — no test for key rotation/revocation actually
  invalidating previously-signed requests; no test of the `rate_limit` clamp
  boundaries in `create()`.
- **`rest/class-controller.php`** — the `__internal_token` bypass (short-circuits real
  HMAC auth for internal playbook runs) has zero coverage. Nothing proves a forged or
  replayed internal token is rejected, or that the token is properly scoped to a single
  in-flight playbook run.
- **`class-approvals.php`** — no test of `request_hash` mismatch (payload tampered
  between enqueue and execute) or of the `EXECUTED`/`REJECTED`/pending status
  transitions.
- **`class-guard.php`** — no test of the dry-run → snapshot → approval pipeline
  ordering, or of the `force=true` override when a snapshot fails.
- **`class-usage.php`** — no test of rate-limit/quota boundaries or per-minute counter
  resets.
- **`rest/class-fs-controller.php`** — no test of path traversal, symlink escape, or
  that writes to `.htaccess`/`.user.ini`/PHP files outside the sandbox are blocked.
- **`rest/class-execute-controller.php`** — no test that `INTO OUTFILE`/`LOAD_FILE`/
  `LOAD DATA` are blocked regardless of `db:write` scope.
- **`rest/class-options-controller.php`** — no test of wildcard allowlist matching or
  that non-allowlisted options (e.g. `siteurl`) are denied.
- **`class-playbooks.php`** — no test that route prefixes outside `ALLOWED_PREFIXES`
  are rejected.

**Why this matters**: CI today would catch a regression in the crypto/HMAC round trip,
but would catch *nothing* in Guard, Approvals, Usage, the filesystem sandbox, the
options allowlist, or the internal-token trust boundary — which is most of the plugin's
actual attack surface, since this plugin's whole purpose is giving an external agent
scoped control of a WordPress site.

### Proposed test additions (priority order)

1. HMAC verifier: disabled-key rejection, IP allowlist accept/deny (incl. malformed
   CIDR/IPv6).
2. Filesystem sandbox (`class-fs-controller.php`): path traversal / symlink escape
   attempts confined; sandbox-boundary writes to `.htaccess`/`.user.ini`/PHP blocked.
3. Options allowlist: wildcard + exact matching, denial of non-listed options.
4. Approvals: payload-hash mismatch after tamper, executed/rejected reuse rejected.
5. Internal-token bypass: forged/guessed token rejected; token only valid while a
   playbook run is active.
6. Usage guard: rate-limit and monthly-quota boundaries return the correct error/status.
7. Execute controller: `INTO OUTFILE`/`LOAD_FILE` blocked even with write scope.
8. Crypto: tampered ciphertext fails closed; explicit test of the GCM fallback branch;
   key-rotation invalidates old ciphertext.
9. Key store: `rate_limit` clamp boundaries; scopes sanitized before storage.
10. Guard pipeline end-to-end: snapshot failure without `force` → 412; with `force` →
    proceeds; approval-required op → 202 with `approval_id`.

## `bridgistic-mcp-server/` — Node/TS MCP server

`contract.test.mjs` checks tool *inventory* (all 43 `bridgistic_*` tools exist, are
named/described correctly, write tools expose `dry_run`/`approval_id`/`force`) but
never invokes a tool. `integration.test.mjs` drives 7 of the 43 tools through a mock
bridge that always returns `200 {ok:true}` — only the happy path is exercised. Neither
test touches error handling, the connection registry, or the HTTP transport's auth
gate directly.

- **`src/services/signer.ts`** — no pinned test of the canonical-string format or
  resulting HMAC output; a silent drift here would weaken every signed request.
- **`src/services/wp-client.ts`** — only 200/JSON is tested. Untested: timeout →
  `408`/`timeout` code, network failure, non-JSON body → `bad_response`, `mapAuthHint`
  for each known/unknown auth-error code, and the query-string-stripped-before-signing
  logic.
- **`src/services/connections.ts`** (`ConnectionRegistry`) — entirely untested:
  partial env vars, malformed `BRIDGISTIC_CONNECTIONS` JSON (should log, not crash),
  alias resolution across 0/1/N connections, file-vs-env alias collision precedence.
- **`src/tools/helpers.ts`** — `present()`'s 50k-char truncation is never triggered;
  `withGuard()`'s `undefined`-omission logic (vs. explicit `false`) is only implicitly
  exercised for 2 of 12 guarded tools.
- **`src/index.ts`** (`bearerMatches`/`isLoopback`) — the HTTP transport's entire auth
  gate is untested: missing header, malformed `Bearer` scheme, wrong-length token,
  loopback fallback. This is the boundary deciding whether `/mcp` — which holds every
  tenant's signing secret — is reachable from the network.
- **Minor**: `src/tools/intel.ts:174` interpolates a free-form `slug` into a URL path
  without `encodeURIComponent`, unlike other dynamic segments in the codebase.

### Proposed test additions (priority order)

1. `signRequest` — known-vector test pinning the exact canonical string and HMAC
   output.
2. `bearerMatches`/`isLoopback` — missing header, wrong scheme, wrong-length token,
   loopback variants. Gates the whole multi-tenant HTTP surface.
3. `ConnectionRegistry.resolve()` across 0/1/N connections, and malformed-config
   handling (log, don't crash).
4. `callBridge` — non-JSON response, simulated timeout, and the `mapAuthHint` table.
5. `withGuard` — omitted params add no keys; explicit `false`/`0` still forwarded.
6. `present()` truncation at the 50k-char limit.
7. Extend `integration.test.mjs` to cover the remaining 10 guarded write tools
   (`update_post`, `fs_write`, `fs_delete`, `db_query`, `toggle_plugin`, etc.) with
   `dry_run`/`force`/`approval_id`, not just the 2 currently exercised.
8. `playbook_get` with a slug containing `/` — fix with `encodeURIComponent` and add a
   regression test.

## Cross-cutting recommendation

Both components would benefit from a real test framework (PHPUnit with a WP stub
harness for the plugin; a minimal test runner or `node --test` for the MCP server)
purely to lower the cost of adding the cases above — the current hand-rolled scripts
work but make incremental additions more tedious than they need to be. This is a
"nice to have," not a blocker; the priority is closing the coverage gaps listed above
regardless of framework.
