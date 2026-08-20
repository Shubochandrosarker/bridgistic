# apps/web — bridgistic.app

The marketing site and the free-tool SEO surface. Static / SSG; no account
system, no billing code, nothing that needs a runtime beyond the CDN.

**Phase 6.** Nothing is served from `bridgistic.app` today — the domain is on
the Cloudflare account and unused.

## Pages

| Path | Purpose |
|---|---|
| `/` | *Run every WordPress site you manage from your AI.* Signed requests, scoped keys, approval before anything destructive, a snapshot before every change. |
| `/pricing` | The four plans, yearly = one month free, 7-day trial, 7-day refund, the API add-on, and the metering rule in plain words. |
| `/faq` | The three real objections, answered without hedging — see below. |
| `/mcp` | The one-line install, the client configs, the connector-directory link. |
| `/tools/*` | Ten zero-login utilities, one page each. |
| `/compare/*` | One page per competitor. |
| `/security` | The published independent review. This is the strongest thing on an agency-facing site, because no competitor leads with one. |

## The three objections, answered on the page

1. **Will you break my site?** Nothing destructive runs without approval; a
   snapshot is taken first; one-click rollback. Show the approval screen as a
   screenshot, not as a paragraph.
2. **Do you store my WordPress password?** No. Scoped HMAC keys minted in your
   own WP Admin, revocable in one click. Never a password.
3. **Can the AI go rogue?** Least-privilege scopes; `php:execute` off by default
   and approval-gated forever; every action logged with an actor and a digest.

## Free tools

WP Cron Health Checker · robots.txt & llms.txt Generator · Schema Markup
Validator · Plugin Conflict Detector · Core Web Vitals Quick Test · WP REST API
Explorer · wp-config Hardening Checklist · WooCommerce Fee Calculator · Site
Migration Checklist · **MCP Config Generator**.

The last one is the funnel: it emits a ready-to-paste config, which needs the
plugin, which needs an account.

## Comparison pages

vs ManageWP · vs MainWP · vs WP Remote · vs InfiniteWP · vs Automattic's
WordPress MCP · vs hand-rolled WP-CLI. Plus *"best WordPress MCP server"*,
*"Claude WordPress agent"*, *"ChatGPT WordPress connector"*.
