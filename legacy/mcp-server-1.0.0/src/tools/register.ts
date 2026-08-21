import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ConnectionRegistry } from "../services/connections.js";
import { callBridge } from "../services/wp-client.js";
import { siteParam, guardParams, withGuard, run, present } from "./helpers.js";
import { registerContentTools } from "./content.js";
import { registerAdminTools } from "./admin.js";
import { registerSafetyTools } from "./safety.js";
import { registerIntelTools } from "./intel.js";
import { registerScheduleTools } from "./schedule.js";

export function registerTools(server: McpServer, registry: ConnectionRegistry): void {
  // ---- list sites ---------------------------------------------------------
  server.registerTool(
    "bridgistic_list_sites",
    {
      title: "List connected WordPress sites",
      description:
        "List the WordPress sites this bridge can operate on, by alias. Use the returned alias as the `site` parameter in other tools. Returns no secrets.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      run(async () => {
        const sites = registry.list();
        return present({ count: sites.length, sites });
      })
  );

  // ---- site info ----------------------------------------------------------
  server.registerTool(
    "bridgistic_get_site_info",
    {
      title: "Get WordPress site info",
      description:
        "Discover a site's stack before acting: WP/PHP versions, active theme, installed plugins (active flag), and detected frameworks (WooCommerce, Elementor, ACF). Read-only; requires the key's `site:read` scope. Always call this first on an unfamiliar site.",
      inputSchema: { site: siteParam },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ site }) =>
      run(async () => {
        const conn = registry.resolve(site);
        return present(await callBridge(conn, "GET", "site-info"));
      })
  );

  // ---- execute php --------------------------------------------------------
  server.registerTool(
    "bridgistic_execute_php",
    {
      title: "Execute PHP in WordPress context",
      description: `Run PHP inside the full WordPress runtime ($wpdb, all functions, loaded plugins). Highest-privilege tool; requires the key's \`php:execute\` scope. Use \`return\` to surface a value; echoed output is captured separately.

Args:
  - code (string): PHP to run. A leading "<?php" is optional.
  - site (string, optional): target alias.

Returns: { output, return, errors[], exception, elapsed_ms }.

Use when: a task has no dedicated structured tool yet. Prefer the structured tools (posts/options/etc.) when they exist, and snapshot before risky writes.`,
      inputSchema: {
        code: z
          .string()
          .min(1, "code must not be empty")
          .max(100_000)
          .describe('PHP source. Example: return get_option("blogname");'),
        site: siteParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ code, site }) =>
      run(async () => {
        const conn = registry.resolve(site);
        return present(await callBridge(conn, "POST", "execute", { code }));
      })
  );

  // ---- db query -----------------------------------------------------------
  server.registerTool(
    "bridgistic_db_query",
    {
      title: "Run a SQL query",
      description: `Execute SQL against the site database. The bridge classifies the statement: SELECT/SHOW/EXPLAIN/DESCRIBE/WITH need \`db:read\`; anything else needs \`db:write\`. Writes are routed through the Guard: dry_run previews impact in a rolled-back transaction, destructive writes auto-snapshot the affected table(s), and approval applies if the key requires it.

Args:
  - sql (string): a single SQL statement using the site's real table prefix.
  - site (string, optional): target alias.
  - dry_run / approval_id / force: guard controls (writes only).`,
      inputSchema: {
        sql: z.string().min(1, "sql must not be empty").max(20_000).describe("Single SQL statement."),
        site: siteParam,
        ...guardParams,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ sql, site, dry_run, approval_id, force }) =>
      run(async () => {
        const conn = registry.resolve(site);
        const body = withGuard({ sql }, { dry_run, approval_id, force });
        return present(await callBridge(conn, "POST", "db/query", body));
      })
  );

  // ---- structured + safety toolsets --------------------------------------
  registerContentTools(server, registry);
  registerAdminTools(server, registry);
  registerSafetyTools(server, registry);
  registerIntelTools(server, registry);
  registerScheduleTools(server, registry);
}
