# Changelog

All notable changes to Bridgistic are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-06-06

Initial public release.

### Plugin (WordPress)
- HMAC-signed REST API (`bridgistic/v1`) with replay protection (timestamp window + nonce) and optional IP allowlisting.
- Least-privilege scoped keys with preset bundles (read-only, content-ops, developer, full-trust).
- Structured tools: posts, media, users, options (allowlist-enforced), plugins, filesystem (ABSPATH-confined; PHP writes sandbox-only).
- Central Guard: dry-run preview, human approval queue, automatic pre-op snapshot, audit — applied to every destructive operation.
- Snapshot engine (post / user / option / table / file) with one-call rollback.
- Per-key rate limiting + monthly usage metering with billing tiers.
- Per-site memory and reusable, parameterised playbooks (internal trusted dispatch).
- Scheduled playbooks via WP-Cron, bound to a key's current scopes.
- Full audit log with retention.

### MCP server (TypeScript)
- 43 tools across core, content, admin, safety, metering, memory, playbooks, scheduling.
- Single-site and multi-tenant (connection registry) modes.
- Dual transport: stdio (local) and Streamable HTTP (remote / Cowork).

### Evaluations
- Contract test (tool inventory + schema/annotation quality).
- Mock-backend integration test (HMAC verified end-to-end; routing/signing/guard-param forwarding).
- LLM-judged tool-selection eval.

### Fixed during hardening
- Signature now covers the request path without the query string, matching WordPress `get_route()`, so query-string GET reads verify correctly.
