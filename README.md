<div align="center">

# Bridgistic

**Give Claude and Claude Cowork production-safe, scoped control of WordPress.**

*Signed requests. Least-privilege keys. Human approval on destructive ops. One-call rollback. Full audit. Scheduled playbooks.*

[![CI](https://github.com/Shubochandrosarker/bridgistic/actions/workflows/ci.yml/badge.svg)](https://github.com/Shubochandrosarker/bridgistic/actions/workflows/ci.yml)
[![License: GPL v2+](https://img.shields.io/badge/License-GPL_v2%2B-blue.svg)](https://www.gnu.org/licenses/gpl-2.0.html)
[![WordPress 6.4+](https://img.shields.io/badge/WordPress-6.4%2B-21759b.svg?logo=wordpress&logoColor=white)](https://wordpress.org/)
[![PHP 8.0+](https://img.shields.io/badge/PHP-8.0%2B-777BB4.svg?logo=php&logoColor=white)](https://www.php.net/)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Version 1.0.0](https://img.shields.io/badge/Version-1.0.0-orange.svg)](CHANGELOG.md)

**Part of the [WordPressistic](https://wordpressistic.com) Galaxy** · By [Shuvo Sarker](https://github.com/Shubochandrosarker)

[Features](#-key-features) · [Quick Start](#-quick-start) · [Architecture](#-architecture) · [Security](#-security-model) · [Tools](#-the-43-tools) · [Docs](#-documentation) · [Contributing](CONTRIBUTING.md)

</div>

---

## What is Bridgistic?

Bridgistic is the **safe remote control** that lets an AI assistant — Claude or Claude Cowork — make real changes to a WordPress site without handing it the keys to everything.

It replaces the "hand the AI a full-admin Application Password" pattern with **signed, least-privilege keys, human approval on destructive operations, automatic snapshots, and one-call rollback**. Built for **agencies running many sites**: one MCP server, many installs, each with its own scoped key.

> **The headline number:** 43 tools across content, admin, files, database, safety, metering, memory, playbooks, and scheduling — but each key only unlocks what its scopes allow.

---

## 🎯 Why Bridgistic

| | App Password bridge | **Bridgistic** |
|---|---|---|
| **Sites per server** | 1 | **Many (agency registry)** |
| **Authentication** | Full-admin bearer | **HMAC-signed + scoped key + nonce/replay guard + IP allowlist** |
| **Permissions** | All-or-nothing | **Per-key least-privilege scopes** |
| **Destructive ops** | Immediate | **Dry-run → approval → auto-snapshot → execute** |
| **Undo** | None | **One-call rollback from any snapshot** |
| **Audit trail** | None | **Every request logged** |
| **Billing / metering** | None | **Per-key rate-limit + monthly quota tiers** |
| **Unattended work** | None | **Scheduled playbooks via cron** |
| **Transport** | Local stdio only | **stdio *and* remote Streamable HTTP (Cowork-ready)** |

---

## ✨ Key Features

### 🔒 Security & Access
- **HMAC-SHA256 signed requests** — the secret never travels on the wire
- **Replay protection** — ±300s timestamp window + single-use nonces
- **Scoped keys** — explicit permission set per key (least privilege by default)
- **IP allowlist** — optionally restrict keys to specific source IPs
- **Encrypted secrets at rest** — libsodium / AES-256-GCM (not just hashed)

### 🛟 Safe Changes
- **Dry-run preview** — see what a write would do before it happens
- **Human approval queue** — risky actions wait for an admin click in WP Admin
- **Automatic snapshots** — every destructive op is reversible by default
- **One-call rollback** — restore any snapshot in a single tool call
- **Full audit log** — who, what, when, status, source IP — for every request

### 🛠 What Claude Can Do
| Area | Actions |
|------|---------|
| **Content** | List, read, create, update, delete posts / pages / CPTs |
| **Media** | List, upload (URL or base64), delete attachments |
| **Users** | List, create, update users (scope-gated) |
| **Settings** | Read / write options (allowlist-enforced both ways) |
| **Plugins** | List installed, activate / deactivate (always approval-gated) |
| **Filesystem** | List, read, write, delete files (ABSPATH-confined; PHP writes sandbox-only) |
| **Database** | Run SQL (auto-classified read vs write; auto-snapshot on writes) |
| **PHP** | Execute PHP in the full WordPress runtime (opt-in, isolated) |

### 📈 Scale & Operations
- **Multi-site registry** — one MCP server, dozens of sites, switch by alias
- **Rate limits + monthly quotas** — per-key tiered metering for billing
- **Per-site memory** — Claude remembers durable facts about each site
- **Playbooks** — save a multi-step task once, replay with new inputs
- **Scheduled playbooks** — run unattended on cron (5min through weekly)

### 🔌 Connectivity
Works with **Claude Desktop**, **Claude Code**, and **Claude Cowork** over both transports:
- **stdio** — the connector runs locally on your machine
- **Streamable HTTP** — the connector runs on a server, reachable by Cowork

---

## 🚀 Quick Start

### 1. Install the plugin
Upload `bridgistic.zip` via **WordPress Admin → Plugins → Add New → Upload Plugin**, then **Activate**.

### 2. Mint your first key
Go to **Bridgistic → Connect**, pick the **Read-only** preset, and copy the **Key ID** and **Key Secret** (the secret is shown only once).

### 3. Set up the MCP server
```bash
cd bridgistic-mcp-server
npm install
npm run build
```

### 4. Connect Claude
Add Bridgistic to your Claude Desktop / Claude Code MCP config:
```json
{
  "mcpServers": {
    "bridgistic": {
      "command": "node",
      "args": ["/absolute/path/to/bridgistic-mcp-server/dist/index.js"],
      "env": {
        "WP_SITE_URL": "https://your-site.com",
        "BRIDGISTIC_KEY_ID": "wpk_xxxxxxxx",
        "BRIDGISTIC_KEY_SECRET": "wps_the-secret-you-copied"
      }
    }
  }
}
```
Restart Claude Desktop.

### 5. Verify
> *"Using Bridgistic, show me this site's WordPress version and active theme."*

If Claude returns your site details — you're connected.

📖 **For full setup + best practices, see the [Bridgistic User Guide](docs/Bridgistic-User-Guide.pdf).**

---

## 🏗 Architecture

```
┌──────────────────┐    MCP    ┌──────────────────────────┐    HMAC HTTPS    ┌──────────────┐
│ Claude / Cowork  │ ────────▶ │   bridgistic-mcp-server  │ ───────────────▶ │  Bridgistic  │ ──▶ WordPress
│ (natural lang.) │           │  (signs + routes calls)  │                  │   (plugin)   │
└──────────────────┘           └──────────────────────────┘                  └──────────────┘
```

Two components, one bridge:

| Component | Stack | Role |
|-----------|-------|------|
| [`bridgistic/`](bridgistic/) | WordPress plugin · PHP 8+ | Installs on each site. Exposes a hardened, HMAC-authenticated REST API with scoped permissions, audit log, snapshot engine, usage metering, and a PHP sandbox. |
| [`bridgistic-mcp-server/`](bridgistic-mcp-server/) | MCP server · TypeScript | Bridges Claude to one or many sites. Signs every request, resolves which site to act on, exposes 43 tools. |

### The safety flow (for every destructive operation)
```
 Scope check  →  Dry-run  →  Approval  →  Snapshot  →  Execute + audit log
 (key allowed?)  (preview)   (human Y/N)  (restore point)
```

---

## 🔐 Security Model

- **Authentication.** Every request is HMAC-SHA256 signed over `METHOD\nPATH\nTIMESTAMP\nNONCE\nsha256(body)`. The signature covers the WordPress route as `get_route()` sees it (no query string); sensitive parameters travel in the signed body. Secrets are encrypted at rest with libsodium / AES-256-GCM.
- **Replay protection.** ±300-second timestamp window plus single-use nonces.
- **Least privilege.** Keys carry an explicit scope set (`site:read`, `posts:write`, `php:execute`, `db:read`/`db:write`, `fs:*`, `plugins:manage`, `snapshot:manage`, `memory:*`, `playbook:manage`, `schedule:manage`). Settings are allowlist-enforced both on read *and* write. `php:execute` is opt-in.
- **PHP sandbox.** Executable PHP can only be written inside `wp-content/uploads/bridgistic-sandbox/` — direct web execution is blocked by `.htaccess`. No backdoors into autoload directories.
- **Reversibility.** Destructive operations snapshot first and can require human approval. Approvals are bound to an action+payload hash, so changed args can't reuse them.
- **Internal dispatch.** Playbook steps run through the real REST pipeline via a per-run random token held only in process memory; it cannot be forged from outside.
- **Full audit log.** Every request: action, status, IP, timestamp — with retention.

> 🔧 **Harden further:** define `BRIDGISTIC_ENC_KEY` in `wp-config.php` so the secret-encryption key lives outside the database.

See [SECURITY.md](SECURITY.md) for the full design notes and the vulnerability disclosure process.

---

## 🛠 The 43 Tools

Every write tool accepts three **Guard params**: `dry_run` (preview only), `approval_id` (resubmit after a human approves), and `force` (proceed without a snapshot — irreversible). Destructive writes auto-snapshot first and return a `snapshot_id`.

<details>
<summary><b>Core</b> (4)</summary>

| Tool | Scope | Notes |
|------|-------|-------|
| `bridgistic_list_sites` | — | Lists configured aliases |
| `bridgistic_get_site_info` | `site:read` | Stack discovery — WP/PHP versions, theme, plugins, frameworks |
| `bridgistic_execute_php` | `php:execute` | Full WP-context PHP runtime |
| `bridgistic_db_query` | `db:read` / `db:write` | Auto-classified SQL; writes are Guard-routed (dry-run in a rolled-back txn, auto table snapshot) |
</details>

<details>
<summary><b>Content</b> (11)</summary>

- **Posts** — `bridgistic_list_posts`, `bridgistic_get_post`, `bridgistic_create_post`, `bridgistic_update_post`, `bridgistic_delete_post` (`posts:read` / `posts:write`)
- **Media** — `bridgistic_list_media`, `bridgistic_upload_media`, `bridgistic_delete_media` (`media:write`)
- **Users** — `bridgistic_list_users`, `bridgistic_create_user`, `bridgistic_update_user` (`users:read` / `users:write`)
</details>

<details>
<summary><b>Admin</b> (8)</summary>

- **Options** — `bridgistic_get_option`, `bridgistic_update_option` (`options:*`, allowlisted both ways)
- **Plugins** — `bridgistic_list_plugins`, `bridgistic_toggle_plugin` (`plugins:manage`, always approval-gated)
- **Filesystem** — `bridgistic_fs_list`, `bridgistic_fs_read`, `bridgistic_fs_write`, `bridgistic_fs_delete` (`fs:read` / `fs:write`, ABSPATH-confined, PHP writes sandbox-only)
</details>

<details>
<summary><b>Safety</b> (5)</summary>

- `bridgistic_snapshot_create`, `bridgistic_snapshot_restore`, `bridgistic_snapshot_list`, `bridgistic_snapshot_delete` (`snapshot:manage`)
- `bridgistic_approval_status` — poll a queued op's approval state
</details>

<details>
<summary><b>Metering & Memory</b> (5)</summary>

- `bridgistic_usage` — tier, rate limit, monthly quota + current usage
- `bridgistic_memory_set`, `bridgistic_memory_get`, `bridgistic_memory_list`, `bridgistic_memory_delete` (`memory:*`) — durable per-site notes the agent recalls across sessions
</details>

<details>
<summary><b>Playbooks</b> (5)</summary>

`bridgistic_playbook_save`, `bridgistic_playbook_list`, `bridgistic_playbook_get`, `bridgistic_playbook_run`, `bridgistic_playbook_delete` (`playbook:manage`) — save and replay parameterised multi-step operations. Steps can reference earlier step results (`{{steps.page.data.result.id}}`) and run-time vars (`{{vars.title}}`).
</details>

<details>
<summary><b>Scheduling</b> (5)</summary>

`bridgistic_schedule_create`, `bridgistic_schedule_list`, `bridgistic_schedule_toggle`, `bridgistic_schedule_delete`, `bridgistic_schedule_run_now` (`schedule:manage`) — run playbooks unattended on a recurrence (every 5 / 15 / 30 min, hourly, twice-daily, daily, weekly, or once).
</details>

---

## 🪙 Metering & Monetization

Every authenticated request passes one choke point that enforces **two limits** and meters usage in an atomic counter table (`wp_bridgistic_usage`):

- **Rate limit** — per-minute throttle from the key's `rate_limit`. Over-limit returns HTTP `429` + `Retry-After` and `X-Bridgistic-RateLimit-*` headers.
- **Monthly quota** — billing cap from the key's `monthly_quota` (0 = unlimited). Over-quota returns HTTP `402`.

Keys are minted against a **tier** (Free / Starter / Pro / Agency / Unlimited / Custom) that sets rate + quota together. See **WP Admin → Bridgistic → Usage** for live per-key counts — this is the hook you bill against.

---

## 🎛 Connection Modes

### Single site (local dev)
Set env vars and run the connector with stdio:
```bash
export WP_SITE_URL="https://your-site.com"
export BRIDGISTIC_KEY_ID="wpk_..."
export BRIDGISTIC_KEY_SECRET="wps_..."
node dist/index.js
```

### Multi-site / Agency (Galaxy Command Center)
Create a JSON registry and point `BRIDGISTIC_CONNECTIONS` at it:
```bash
export BRIDGISTIC_CONNECTIONS="/secure/path/connections.json"
```
See [`bridgistic-mcp-server/connections.example.json`](bridgistic-mcp-server/connections.example.json). The agent then passes `site: "client-alias"` to any tool, or omits it when only one site is configured.

### Remote / Cowork-ready
```bash
# Set a bearer token to accept remote clients (binds 0.0.0.0).
TRANSPORT=http PORT=3000 BRIDGISTIC_HTTP_TOKEN="a-long-random-token" node dist/index.js
# MCP endpoint: POST http://host:3000/mcp   •   health: GET /health
# Clients must send:  Authorization: Bearer a-long-random-token
```
Because the server holds every connected site's signing secret, the `/mcp`
endpoint is protected: with `BRIDGISTIC_HTTP_TOKEN` set it requires a matching
`Authorization: Bearer` header; **without** a token it binds to `127.0.0.1` and
accepts loopback requests only. Always terminate TLS in front of it.

---

## ✅ Testing

```bash
cd bridgistic-mcp-server
npm install
npm run build
npm test        # contract + integration evals
```

- **Contract test** — boots the server over stdio and asserts the full 43-tool surface, guard params, descriptions, and annotations.
- **Integration test** — exercises a mock WordPress backend end-to-end (HMAC verified on every call, guard params forwarded, routing correct).
- **Tool-selection eval** — `npm run eval:selection` (requires `ANTHROPIC_API_KEY`) — LLM-judged tool routing accuracy.

The plugin is PHP-linted in CI on every push and PR.

---

## 📚 Documentation

| Document | Purpose |
|----------|---------|
| [`README.md`](README.md) | This file — features, architecture, quick start |
| [`CHANGELOG.md`](CHANGELOG.md) | Version history (Semantic Versioning) |
| [`SECURITY.md`](SECURITY.md) | Security model + responsible disclosure |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to add tools, run evals, ship PRs |
| Bridgistic User Guide (PDF) | Beginner-friendly walkthrough for end users |

---

## 🗺 Roadmap

- [x] Snapshot + rollback engine
- [x] Structured tools: posts, media, users, options (allowlisted), plugins, filesystem
- [x] Approval queue + dry-run for destructive ops
- [x] Per-key rate-limit + monthly metering (monetization hook)
- [x] Per-site memory + reusable playbooks
- [x] Scheduled playbooks (cron-triggered runs)
- [ ] MCP tool-selection evaluations (continuous LLM-judged accuracy)
- [ ] `php:execute` approval gating
- [ ] Native WP-CLI subcommand
- [ ] First-party Galaxy Command Center dashboard

---

## 🤝 Contributing

Pull requests are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR. In short:

1. **Server changes** — `npm install && npm run build && npm test` must pass.
2. **Plugin changes** — follow WordPress coding standards: sanitize on input, escape on output, `$wpdb->prepare()` for SQL, nonces on every admin form.
3. **HMAC contract is load-bearing** — if you touch `signer.ts` or `class-hmac-verifier.php`, the canonical string must stay byte-identical on both sides.

---

## 🛡 Security

Found a vulnerability? **Please don't open a public issue.** See [SECURITY.md](SECURITY.md) for the disclosure process.

---

## 📄 License

**GPL-2.0-or-later** — matches the WordPress ecosystem. See [LICENSE](LICENSE).

---

<div align="center">

### Part of the WordPressistic Galaxy 🌌

**Bridgistic** is one of several products in the [WordPressistic](https://wordpressistic.com) ecosystem — purpose-built tooling for agencies and creators who run WordPress at scale.

Crafted by **[Shuvo Sarker](https://github.com/Shubochandrosarker)** · © 2026 WordPressistic · Released under GPL-2.0-or-later

[Website](https://wordpressistic.com) · [GitHub](https://github.com/Shubochandrosarker/bridgistic) · [Report an Issue](https://github.com/Shubochandrosarker/bridgistic/issues)

</div>
