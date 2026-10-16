# Bridgistic feature inventory → dashboard map (plugin v1.5.3, Wordpressistic/bridgistic@37ac22c)

Source: `wordpress-plugin/bridgistic/includes/rest/*` (54 REST routes under `bridgistic/v1`, same list as `plugin-routes.json` in the monorepo), `includes/security/class-scopes.php` (25 scopes), `mcp-server/src/tools/*` (54 MCP tools), `admin/*` (WP Admin pages).
Every REST call is HMAC-signed: headers `X-Bridgistic-Key/Timestamp/Nonce/Signature`, canonical `METHOD\nPATH\nTS\nNONCE\nsha256(body)`. Responses are `{ok:true,data:{…}}`.

Legend: **Live** = works against a v1.5.3 site today. **Plugin PR** = needs the companion plugin PR (route not in 1.5.3; the screen shows "Needs plugin update" on older sites). **WP Admin** = only a WP administrator can do it, the dashboard deep-links.

| Feature | Plugin code | REST routes (scope) | MCP tools | Dashboard screen | Status |
|---|---|---|---|---|---|
| Site info, health, detected stack | rest/class-site-controller.php | GET site-info (site:read) | bridgistic_get_site_info, bridgistic_list_sites | Overview, Sites, Keys, Plugins | Live |
| Site connect | security/class-key-store.php, HMAC verifier | any signed call; connect = test GET site-info | — | Sites → Connect site (3-step form) | Live |
| Keys & scopes | class-key-store.php, class-scopes.php, admin keys page | none (by design) — scopes of the current key come back in site-info `bridge.scopes` | — | Keys & scopes (granted/not granted for all 25) | Live (read). Mint/rotate/revoke: WP Admin |
| OAuth (cloud connector) | class-oauth.php, rest/class-oauth-controller.php | POST oauth/token | — | (Sites: Coming soon "saved connections") | Not surfaced; hosted API pending |
| Approvals queue | class-approvals.php, rest/class-approvals-controller.php, admin approvals page | GET approvals/status?approval_id (any key, own approvals); **GET approvals** (plugin PR, own key's approvals) | bridgistic_approval_status | Approvals (tabs pending/approved/denied, single lookup) | Status lookup Live; list Plugin PR; decide: WP Admin only (an AI key must never approve itself) |
| Audit log | class-audit-log.php (table: created_at,key_id,action,status,ip,params_hash,summary) | **GET audit?filter=** (plugin PR, new scope audit:read) | — | Audit log (search, status filter, CSV export), Overview charts | Plugin PR |
| Snapshots / rollback | class-snapshot.php, rest/class-snapshot-controller.php | GET snapshot, POST snapshot, POST snapshot/restore, POST snapshot/delete (snapshot:manage) | bridgistic_snapshot_list/create/restore/delete | Snapshots (timeline, take, restore, delete with confirm) | Live |
| Usage / metering | class-usage.php, rest/class-usage-controller.php | GET usage (any) | bridgistic_usage | Overview stats + quota bar + top actions chart, Usage | Live |
| Posts & pages | rest/class-posts-controller.php | GET posts, GET/POST/DELETE posts/{id}, POST posts (posts:read/write) | bridgistic_list_posts/get_post/create_post/update_post/delete_post | Posts & pages (list) | Live (read). Edit from AI client |
| Media | rest/class-media-controller.php | GET media, POST media, DELETE media/{id} (media:write) | bridgistic_list_media/upload_media/delete_media | Media (list) | Live (read) |
| Users | rest/class-users-controller.php | GET users, GET/POST users/{id}, POST users (users:read/write, writes approval-gated) | bridgistic_list_users/create_user/update_user | Users (list) | Live (read) |
| Plugins | rest/class-plugins-controller.php | GET plugins, POST plugins/toggle {plugin,state} (plugins:manage, approval-gated) | bridgistic_list_plugins/toggle_plugin | Plugins (list + activate/deactivate → approval) | Live |
| Options | rest/class-options-controller.php | GET options, POST options (options:read/write) | bridgistic_get_option/update_option | Options (list) | Live (read) |
| Files | rest/class-fs-controller.php | POST fs/list, fs/read, fs/write, fs/delete (fs:read/write) | bridgistic_fs_list/read/write/delete | Files (browse) | Live (list) |
| Database | rest/class-execute-controller.php, security/class-sql-classifier.php | POST db/query {sql} (db:read; writes approval-gated) | bridgistic_db_query | Database (query runner) | Live |
| PHP execute | class-execute-controller.php | POST execute (php:execute, off by default, always approval) | bridgistic_execute_php | Keys (scope shown with risk) | Deliberately not exposed in the UI |
| Memory | class-memory.php, rest/class-memory-controller.php | GET memory, POST memory, POST memory/delete | bridgistic_memory_get/set/list/delete | Memory (list) | Live (read) |
| Playbooks | class-playbooks.php, rest/class-playbook-controller.php | GET playbooks, GET playbooks/{slug}, POST playbooks, playbooks/run, playbooks/delete (playbook:manage) | bridgistic_playbook_list/get/save/run/delete | Playbooks (cards) | Live (read) |
| Schedules | class-scheduler.php, rest/class-schedule-controller.php | GET schedules, POST schedules, schedules/toggle, schedules/run-now, schedules/delete (schedule:manage) | bridgistic_schedule_list/create/toggle/run_now/delete | Schedules (table, pause/resume, run now) | Live |
| WooCommerce | rest/class-woo-controller.php | GET woo/products(/{id}), POST woo/products(/{id}), GET woo/orders(/{id}), POST woo/orders/{id}/status, GET woo/customers(/{id}), GET woo/inventory, GET woo/sales-summary (woo:* scopes) | bridgistic_woo_* (9) | WooCommerce (summary stats, tabs orders/products/customers/inventory) | Live (read) |
| License | class-license.php is free-only stub in 1.5.x (activation removed in 1.5.0) | **GET license, POST license/activate, license/deactivate, license/validate** (plugin PR, new scope license:manage) | — | License (status, activate, check now, deactivate) | Plugin PR |
| Premium / paid features | class-license.php PAID_FEATURES (display-only) | — | — | Coming soon + Roadmap | Not functional, labelled |
| Multisite, health check, export package, AI setup | admin/* pages | none | — | Not in v1 (WP Admin) | Remaining |

## Not available over REST (and why)
- Key minting/revocation and approval decisions: WP Admin only. Exposing them to an API key would let an AI widen its own access or approve its own request.
- Audit log and approval list: added in the plugin PR as read-only, scoped routes.

## Competitor reference (dashboard level we matched)
From baseline-2026-10.md §competitors (fetched 2026-10) and re-checked today:
- Official WordPress MCP Adapter: https://wordpress.org/plugins/mcp-adapter/ , https://github.com/WordPress/mcp-adapter — no dashboard; abilities + WP permissions. We exceed it on audit/approvals/snapshots UI.
- WPVibe: https://wpvibe.ai , https://wpvibe.ai/pricing/ — hosted relay, in-chat approvals, approval log, fleet updates. Matched: approvals view, audit, usage meter. Gap: fleet/bulk ops (Coming soon).
- AI Engine (Meow Apps): https://meowapps.com/ai-engine/ , https://meowapps.com/ai-engine/mcp/ — settings-centric WP Admin UI, no external dashboard. Matched/exceeded.
- MainWP: https://mainwp.com/ (403 to automated fetch today; not re-verified) — agency multi-site dashboard: per-site health, updates, bulk actions. Gap: multi-site fleet table, updates, bulk (Coming soon / Roadmap).
- InstaWP InstaMCP: https://instawp.com/mcp/ , https://instawp.com/wordpress-mcp-server/ — token scopes, power tools off by default. Matched: scope view with risk labels, php:execute off by default.
