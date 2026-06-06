# Bridgistic

**Give Claude and Claude Cowork production-safe, scoped control of WordPress.**

Bridgistic replaces the "hand the AI a full-admin Application Password" approach with signed, least-privilege keys, human approval on destructive ops, and one-call rollback. Built for agencies running many sites — one MCP server, many installs, each with its own scoped key. Part of the WordPressistic Galaxy.

[![CI](https://github.com/shuvoskr/bridgistic/actions/workflows/ci.yml/badge.svg)](https://github.com/shuvoskr/bridgistic/actions)
[![License: GPL v2](https://img.shields.io/badge/License-GPL_v2-blue.svg)](https://www.gnu.org/licenses/gpl-2.0.html)

Two components:

| Component | Tech | Role |
|-----------|------|------|
| `bridgistic/` | WordPress plugin (PHP 8+) | Installs on each site. Exposes a hardened, HMAC-authenticated REST API with scoped permissions, auditing, snapshots, metering, and a PHP sandbox. |
| `bridgistic-mcp-server/` | MCP server (TypeScript) | Connects Claude to one or many sites. Signs every request, resolves which site to act on, exposes 43 tools. |

```
Claude / Claude Cowork ──MCP──▶ bridgistic-mcp-server ──HMAC HTTPS──▶ bridgistic (per site)
```

## Why not just use an Application Password

| | App Password bridge | Bridgistic |
|---|---|---|
| Sites per server | 1 | Many (agency registry) |
| Auth | Full-admin bearer | HMAC-signed + scoped key + nonce/replay guard + IP allowlist + rate limit |
| Permissions | All-or-nothing | Per-key least-privilege scopes |
| Destructive ops | Immediate | Dry-run → approval → auto-snapshot → execute |
| Undo | None | One-call rollback from any snapshot |
| Audit trail | None | Every op logged |
| Billing | None | Per-key metering + monthly quota tiers |
| Unattended work | None | Scheduled playbooks via cron |
| Transport | Local stdio only | stdio **and** remote Streamable HTTP |

## Security model (what makes it safe)

- **HMAC-SHA256** request signing. The secret never travels on the wire. Canonical string: `METHOD\nPATH\nTIMESTAMP\nNONCE\nsha256(body)` — path matches WordPress `get_route()` (no query string); sensitive params travel in the signed body.
- **Replay protection**: ±300s timestamp window **and** single-use nonces.
- **Scoped keys**: a key only does what its scopes allow (`site:read`, `posts:write`, `php:execute`, `db:read`/`db:write`, `fs:*`, `plugins:manage`, `snapshot:manage`, `memory:*`, `playbook:manage`, `schedule:manage`). `php:execute` is opt-in and isolated.
- **Secrets encrypted at rest** (libsodium / AES-256-GCM), not just hashed, because HMAC needs them live.
- **PHP write sandbox**: executable PHP can only be written inside `wp-content/uploads/bridgistic-sandbox/` (web-exec blocked via `.htaccess`). No backdoors into autoload dirs.
- **Full audit log** of who/what/when/status/IP.

> Harden further: define `BRIDGISTIC_ENC_KEY` in `wp-config.php` so the secret-encryption key lives outside the database.

## Install — WordPress plugin

1. Zip the `bridgistic/` folder and upload via **Plugins → Add New → Upload**, or drop it in `wp-content/plugins/`.
2. Activate. Go to **Bridgistic → Connect**.
3. Create a key: pick a label and the **minimum scopes** the task needs. Copy the one-time secret block.

## Install — MCP server

```bash
cd bridgistic-mcp-server
npm install
npm run build
```

### Connect a single site (local dev)

Set env, then point your MCP client at the server:

```bash
export WP_SITE_URL="https://your-site.com"
export BRIDGISTIC_KEY_ID="wpk_..."
export BRIDGISTIC_KEY_SECRET="wps_..."
node dist/index.js          # stdio
```

Claude Code / Desktop config:

```json
{
  "mcpServers": {
    "client-site": {
      "command": "node",
      "args": ["/abs/path/bridgistic-mcp-server/dist/index.js"],
      "env": {
        "WP_SITE_URL": "https://your-site.com",
        "BRIDGISTIC_KEY_ID": "wpk_...",
        "BRIDGISTIC_KEY_SECRET": "wps_..."
      }
    }
  }
}
```

### Connect many sites (agency / Galaxy Command Center)

Create a registry file and point `BRIDGISTIC_CONNECTIONS` at it:

```bash
export BRIDGISTIC_CONNECTIONS="/secure/path/connections.json"
```

See `connections.example.json`. The agent then passes `site: "guns2ammo"` to any tool, or omits it when only one site is configured.

### Run as a remote service (Cowork-ready)

```bash
TRANSPORT=http PORT=3000 node dist/index.js
# MCP endpoint: POST http://host:3000/mcp   •   health: GET /health
```

## Tools (43)

Every write tool accepts three guard params: `dry_run` (preview only), `approval_id` (re-submit after a human approves), and `force` (proceed without a snapshot — irreversible). Destructive writes auto-snapshot first and return a `snapshot_id`.

**Core**

| Tool | Scope | Notes |
|------|-------|-------|
| `bridgistic_list_sites` | — | Lists configured aliases |
| `bridgistic_get_site_info` | `site:read` | Stack discovery, read-only |
| `bridgistic_execute_php` | `php:execute` | Full WP-context PHP |
| `bridgistic_db_query` | `db:read` / `db:write` | Auto-classified SQL; writes are Guard-routed (dry-run in a rolled-back txn, auto table snapshot) |

**Content** — `bridgistic_list_posts`, `bridgistic_get_post`, `bridgistic_create_post`, `bridgistic_update_post`, `bridgistic_delete_post` (`posts:read`/`posts:write`); `bridgistic_list_media`, `bridgistic_upload_media`, `bridgistic_delete_media` (`media:write`); `bridgistic_list_users`, `bridgistic_create_user`, `bridgistic_update_user` (`users:read`/`users:write`).

**Admin** — `bridgistic_get_option`, `bridgistic_update_option` (`options:*`, allowlisted both ways); `bridgistic_list_plugins`, `bridgistic_toggle_plugin` (`plugins:manage`, always approval-gated); `bridgistic_fs_list`, `bridgistic_fs_read`, `bridgistic_fs_write`, `bridgistic_fs_delete` (`fs:read`/`fs:write`, ABSPATH-confined, PHP writes sandbox-only).

**Safety** — `bridgistic_snapshot_create`, `bridgistic_snapshot_restore`, `bridgistic_snapshot_list`, `bridgistic_snapshot_delete` (`snapshot:manage`); `bridgistic_approval_status`.

**Metering** — `bridgistic_usage` (any key reads its own tier, rate limit, monthly quota + current usage).

**Memory** — `bridgistic_memory_set`, `bridgistic_memory_get`, `bridgistic_memory_list`, `bridgistic_memory_delete` (`memory:read`/`memory:write`): durable per-site notes the agent recalls across sessions.

**Playbooks** — `bridgistic_playbook_save`, `bridgistic_playbook_list`, `bridgistic_playbook_get`, `bridgistic_playbook_run`, `bridgistic_playbook_delete` (`playbook:manage`): save and replay parameterised multi-step operations.

**Scheduling** — `bridgistic_schedule_create`, `bridgistic_schedule_list`, `bridgistic_schedule_toggle`, `bridgistic_schedule_delete`, `bridgistic_schedule_run_now` (`schedule:manage`): run playbooks unattended on a recurrence.

## Safety layer (how live writes stay reversible)

1. **Dry-run** — any write with `dry_run:true` reports what *would* change. SQL writes run inside a transaction that is rolled back, returning `would_affect_rows`.
2. **Approval queue** — keys flagged *require approval* (or inherently high-risk ops: plugin toggle, file delete, raw SQL write) enqueue instead of executing. A human approves in **WP Admin → Bridgistic → Approvals**; the agent retries the same call with the returned `approval_id`. The approval is bound to an action+payload hash, so changed args won't reuse it.
3. **Auto-snapshot** — before any destructive op, the Guard captures a reversible snapshot (post / user / option / table / file) and returns `snapshot_id`. One `bridgistic_snapshot_restore` call reverts it. If a snapshot can't be taken, the op aborts unless `force:true`.

## Metering & monetization

Every authenticated request passes one choke point (`Controller::authenticate`) that enforces two limits and meters usage in an atomic counter table (`wp_bridgistic_usage`):

- **Rate limit** — per-minute throttle from the key's `rate_limit`. Over-limit returns `429` + `Retry-After` and `X-Bridgistic-RateLimit-*` headers.
- **Monthly quota** — billing cap from the key's `monthly_quota` (0 = unlimited). Over-quota returns `402`.

Keys are minted against a **tier** (Free / Starter / Pro / Agency / Unlimited / Custom) that sets rate + quota together; see **WP Admin → Bridgistic → Usage** for live per-key counts. This is the hook you bill against — usage is recorded per key, per day, per month, and per action.

## Memory & playbooks (the Galaxy Command Center layer)

- **Memory** — durable, categorised key/value notes per site. The agent records site quirks, IDs, and client preferences once (`bridgistic_memory_set`) and recalls them in later sessions (`bridgistic_memory_list`).
- **Playbooks** — vetted, parameterised sequences. Save once, replay with `vars`. Steps reference run inputs (`{{vars.title}}`) and prior step results (`{{steps.page.data.result.id}}`). Each step runs through the **real REST pipeline** via an unforgeable internal token, so it inherits the calling key's scopes plus the full Guard (dry-run / approval / snapshot). A step that needs approval pauses the run and returns a resumable `approval_id`.
- **Scheduled playbooks** — run a playbook unattended on a recurrence (every 5/15/30 min, hourly, twice-daily, daily, weekly, or once). Each schedule is bound to a key and executes under that key's *current* scopes, so revoking the key stops its schedules. Runs are metered against the key's quota. Manage them in **WP Admin → Bridgistic → Schedules** (run-now / pause / delete) or from the agent. **Reliability:** WP-Cron only fires on traffic — for true autonomy, set `define('DISABLE_WP_CRON', true);` and point a system cron at `wp-cron.php` (the Schedules screen shows the exact line). Unattended runs never auto-approve, so use a key without `require_approval` for fully autonomous schedules.

## Roadmap

- [x] Snapshot + rollback module
- [x] Structured tools: posts, media, users, options (allowlisted), plugins, filesystem
- [x] Approval queue + dry-run for destructive ops
- [x] Per-key rate-limit enforcement + metering (monetization hook)
- [x] Per-site memory + reusable playbooks
- [ ] MCP evaluations (per the mcp-builder eval guide)
- [ ] `php:execute` approval gating
- [x] Scheduled playbooks (cron-triggered runs)

## License

GPL-2.0-or-later (plugin)
