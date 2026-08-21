# Security policy

## Reporting a vulnerability

Email **security@wordpressistic.com** with a description, reproduction steps and
the impact you believe it has. Do not open a public issue.

You will get an acknowledgement within 72 hours and an assessment within seven
days. If the issue affects the free plugin or the local MCP server, the fix
lands in
[`bridgistic-claude-marketplace`](https://github.com/Shubochandrosarker/bridgistic-claude-marketplace)
**first** — security fixes always land in the free version.

## What this platform holds

Be blunt about it, because it shapes what counts as severe:

- An **encrypted, live Bridgistic key for every connected WordPress site**. That
  key can be scoped down to read-only, but on an Agency plan it can also carry
  `php:execute`. Treat anything touching `TENANT_ENC_KEY`, the `sites` table, or
  the credential envelope as critical by default.
- OAuth grants and refresh tokens for the dashboard and the hosted MCP endpoint.
- An audit trail of what was done to each site. It stores **digests, never
  request bodies** — that is deliberate, and a change that starts storing bodies
  is itself a security bug.

It does **not** hold WordPress passwords or application passwords, and it never
will.

## Known, documented, unmitigated

Stated rather than buried:

- **DNS rebinding.** The SSRF guard rejects private addresses, IP literals,
  obfuscated IPv4 forms and internal-only hostname suffixes, but a hostname that
  resolves to a private address *at fetch time* cannot be caught before the
  fetch, because Cloudflare Workers cannot resolve a name first. This is
  documented in the guard's own docblock and is in scope for the phase-8 abuse
  testing.
- **No independent security review yet.** This is the first of four hard gates
  and nothing ships to a paying customer until it is done and published — see
  [docs/HARD-GATES.md](docs/HARD-GATES.md).

## Scope

In scope: everything under `apps/`, `packages/`, `db/` and `scripts/`.

Out of scope: `legacy/`, which is superseded code that is not built or shipped;
report anything you find there against `bridgistic-claude-marketplace` instead.
