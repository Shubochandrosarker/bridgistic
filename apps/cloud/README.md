# bridgistic-cloud

> Lives in `apps/cloud` of Shubochandrosarker/bridgistic since 2026-11-11 (it was
> removed from Wordpressistic/bridgistic on 2026-10-23 and had no repo home).
> Standalone package with its own lockfile; not part of the root npm workspaces.
> Deploy: `scripts/manual-deploy/bridgistic-deploy.sh --only cloud` (records the
> live version id first; roll back with `--rollback cloud <version-id>`).
> Secrets are never committed: `TENANT_ENC_KEY` is a Worker secret
> (`wrangler secret put TENANT_ENC_KEY`).

`mcp.bridgistic.app` — a hosted, multi-tenant MCP relay. Instead of running the
Bridgistic MCP server locally, a user pastes one URL into Claude (or any other
MCP-capable client that supports remote connectors) and approves a connection
in their own WordPress admin. No Node.js, no config files, no copy-pasted
secrets.

## Status

**Deployed as a public beta — linked from the plugin UI (WP Admin →
Bridgistic Cloud), free to use.** See
[`docs/CLOUD_CONNECTOR.md`](../docs/CLOUD_CONNECTOR.md) for exactly what's
live, what a maintainer still needs to confirm by hand (secret, DNS route),
and the checklist before this is fully vetted and generally announced.
Summary of what's left, in order:

1. A real deployment (see below) tested end-to-end against a real WordPress
   site and a real MCP client (Claude Desktop's "Add custom connector", or
   equivalent).
2. An independent security review of the OAuth relay and the D1 tenant store
   — this Worker holds a live Bridgistic key for every connected site. See
   "Security notes" below for what that review should focus on. This is the
   biggest remaining gap — the in-plugin UI says so explicitly wherever a
   user can reach this connector.
3. Further load/abuse testing beyond the basic per-IP rate limiter shipped
   in `src/rate-limit.ts` (KV/D1 quota behavior under many concurrent
   connections).

## Architecture

This Worker is simultaneously two different OAuth roles:

- **An OAuth 2.1 *server* to the AI client** (Claude, ChatGPT, ...) — handled
  entirely by [`@cloudflare/workers-oauth-provider`][oauth-provider]. It
  implements token issuance, refresh, dynamic client registration, and PKCE
  verification for whichever client is adding this as a remote connector.
- **An OAuth 2.1 *client* to the connecting WordPress site** — our own code
  in `src/default-handler.ts`, talking to the new `Bridgistic\Oauth`
  authorization server shipped in the WordPress plugin
  (`wordpress-plugin/bridgistic/includes/class-oauth.php`). There is no
  client secret on this leg by design: this Worker is a public OAuth client
  to every WordPress site it has never seen before, so PKCE (not a
  pre-shared secret) is the actual security boundary — see that file's
  docblock.

The actual 43 Bridgistic tools (`src/tools/*.ts`) are **copies** of
`mcp-server/src/tools/*.ts`, kept runtime-portable through the `SiteRegistry`
interface (`mcp-server/src/types.ts`) both the local stdio server and this
Worker implement. `src/services/signer.ts` and `src/services/wp-client.ts`
are copied unchanged — they only use `fetch` and (via the `nodejs_compat`
compatibility flag) `node:crypto`, both of which run fine on Workers.

**These copies need to be kept in sync with `mcp-server/src/tools/*.ts` by
hand for now.** A follow-up worth doing once this is live: a CI check that
diffs the two directories and fails if they drift, or a small build step
that copies them automatically instead of committing the copy.

```
Claude / ChatGPT / any MCP client
        |  paste https://mcp.bridgistic.app/mcp, OAuth popup
        v
mcp.bridgistic.app (this Worker)
        |  Durable Object per session, tenant resolved from the access token
        |  HMAC-signed HTTPS (per-tenant key, decrypted from D1 for this call)
        v
WordPress site's existing /wp-json/bridgistic/v1/* API — unchanged
```

## One-time setup

```bash
npm install
wrangler login

# D1: stores one row per connected WordPress site (site_url, key_id, an
# AES-256-GCM-encrypted key_secret, granted scopes).
wrangler d1 create bridgistic-cloud
# Paste the returned database_id into wrangler.toml's [[d1_databases]] block.
npm run d1:migrate:remote

# KV: required by @cloudflare/workers-oauth-provider for its own grant/token/
# client storage (nothing Bridgistic-specific lives here).
wrangler kv namespace create OAUTH_KV
# Paste the returned id into wrangler.toml's [[kv_namespaces]] block.

# Secret: the AES-256-GCM key protecting tenant key_secrets at rest in D1.
# Generate once, store it somewhere durable (a password manager) — losing it
# means every connected site has to reconnect.
wrangler secret put TENANT_ENC_KEY
# when prompted, paste the output of: openssl rand -base64 32
```

Then point `mcp.bridgistic.app` at this Worker in your Cloudflare zone
(`wrangler.toml`'s `routes` block assumes the zone is already `wpistic.cloud`
on this Cloudflare account).

## Deploy

```bash
npm run deploy
```

## Local development

```bash
wrangler dev
```

Note that OAuth redirects need a real, publicly-reachable HTTPS origin for
the WordPress leg (`/wp-callback`) to work end-to-end — `wrangler dev`'s
local tunnel URL works for this since Cloudflare exposes it over HTTPS.

## Security notes for the eventual review

- **Tenant secrets in D1 are encrypted (`src/crypto.ts`, AES-256-GCM), never
  plaintext.** Losing `TENANT_ENC_KEY` is equivalent to losing every
  tenant's credentials — treat it like a root secret, not a config value.
- **No client secret on the WordPress leg is intentional**, not an
  oversight — see `Bridgistic\Oauth`'s docblock. PKCE S256 is the actual
  protection; verify that assumption holds under review rather than assuming
  it does because it's written down here.
- **Every WordPress-issued key is scoped to whatever preset the admin picked
  on the consent screen** — same `Presets`/`Scopes` enforcement as every
  other Bridgistic key, nothing new to audit there.
- **Basic per-IP rate limiting exists** (`src/rate-limit.ts`, wired in
  `src/index.ts`): 120 req/min/IP on `/mcp`, 20 req/min/IP on the OAuth
  handshake routes, backed by a KV fixed-window counter (best-effort, not
  atomic — can slightly undercount races at a window boundary). WordPress's
  own per-key rate limit still applies once a request reaches it. This
  blunts a hammering token or a scripted flood; it is not a precision quota
  system, and per-tenant (rather than per-IP) limiting inside the Durable
  Object is still a possible future hardening step if per-IP limiting proves
  insufficient under real traffic.

[oauth-provider]: https://github.com/cloudflare/workers-oauth-provider
