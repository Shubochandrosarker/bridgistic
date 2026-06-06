import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ConnectionRegistry } from "../services/connections.js";
import { callBridge } from "../services/wp-client.js";
import { siteParam, guardParams, withGuard, run, present } from "./helpers.js";

const WRITE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function registerAdminTools(server: McpServer, registry: ConnectionRegistry): void {
  // ---- options.get --------------------------------------------------------
  server.registerTool(
    "bridgistic_get_option",
    {
      title: "Get an option",
      description:
        "Read a wp_options value BY NAME. Scope: `options:read`. The name must be in the site's allowlist (WP Admin → Bridgistic → Settings) — secrets are unreadable by design.",
      inputSchema: { site: siteParam, name: z.string() },
      annotations: READ,
    },
    async ({ site, name }) =>
      run(async () =>
        present(await callBridge(registry.resolve(site), "GET", `options?name=${encodeURIComponent(name)}`))
      )
  );

  // ---- options.update -----------------------------------------------------
  server.registerTool(
    "bridgistic_update_option",
    {
      title: "Update an option",
      description:
        "Write a wp_options value. Scope: `options:write`. Name must be allowlisted. Auto-snapshots the old value. Supports dry_run + approval.",
      inputSchema: {
        site: siteParam,
        name: z.string(),
        value: z.unknown(),
        ...guardParams,
      },
      annotations: WRITE,
    },
    async ({ site, name, value, dry_run, approval_id, force }) =>
      run(async () => {
        const body = withGuard({ name, value }, { dry_run, approval_id, force });
        return present(await callBridge(registry.resolve(site), "POST", "options", body));
      })
  );

  // ---- plugins.list -------------------------------------------------------
  server.registerTool(
    "bridgistic_list_plugins",
    {
      title: "List plugins",
      description: "List installed plugins with active flag + version. Scope: `plugins:manage`.",
      inputSchema: { site: siteParam },
      annotations: READ,
    },
    async ({ site }) =>
      run(async () => present(await callBridge(registry.resolve(site), "GET", "plugins")))
  );

  // ---- plugins.toggle -----------------------------------------------------
  server.registerTool(
    "bridgistic_toggle_plugin",
    {
      title: "Activate / deactivate a plugin",
      description:
        "Activate or deactivate a plugin. Scope: `plugins:manage`. High-risk: ALWAYS routes through approval and snapshots active_plugins first. Args: plugin (file, e.g. 'woocommerce/woocommerce.php'), state ('activate'|'deactivate').",
      inputSchema: {
        site: siteParam,
        plugin: z.string(),
        state: z.enum(["activate", "deactivate"]),
        ...guardParams,
      },
      annotations: WRITE,
    },
    async ({ site, plugin, state, dry_run, approval_id, force }) =>
      run(async () => {
        const body = withGuard({ plugin, state }, { dry_run, approval_id, force });
        return present(await callBridge(registry.resolve(site), "POST", "plugins/toggle", body));
      })
  );

  // ---- fs.list ------------------------------------------------------------
  server.registerTool(
    "bridgistic_fs_list",
    {
      title: "List a directory",
      description: "List files/dirs under a path (confined to ABSPATH). Scope: `fs:read`.",
      inputSchema: { site: siteParam, path: z.string() },
      annotations: READ,
    },
    async ({ site, path }) =>
      run(async () => present(await callBridge(registry.resolve(site), "POST", "fs/list", { path })))
  );

  // ---- fs.read ------------------------------------------------------------
  server.registerTool(
    "bridgistic_fs_read",
    {
      title: "Read a file",
      description: "Read a file's contents (≤5MB, inside ABSPATH). Scope: `fs:read`.",
      inputSchema: { site: siteParam, path: z.string() },
      annotations: READ,
    },
    async ({ site, path }) =>
      run(async () => present(await callBridge(registry.resolve(site), "POST", "fs/read", { path })))
  );

  // ---- fs.write -----------------------------------------------------------
  server.registerTool(
    "bridgistic_fs_write",
    {
      title: "Write a file",
      description:
        "Write a file inside ABSPATH. Scope: `fs:write`. PHP files may ONLY be written inside the uploads/bridgistic-sandbox dir. Overwrites auto-snapshot the old file. Supports dry_run + approval.",
      inputSchema: {
        site: siteParam,
        path: z.string(),
        content: z.string(),
        ...guardParams,
      },
      annotations: WRITE,
    },
    async ({ site, path, content, dry_run, approval_id, force }) =>
      run(async () => {
        const body = withGuard({ path, content }, { dry_run, approval_id, force });
        return present(await callBridge(registry.resolve(site), "POST", "fs/write", body));
      })
  );

  // ---- fs.delete ----------------------------------------------------------
  server.registerTool(
    "bridgistic_fs_delete",
    {
      title: "Delete a file",
      description:
        "Delete a file inside ABSPATH. Scope: `fs:write`. High-risk: always routes through approval and snapshots the file first. Supports dry_run.",
      inputSchema: { site: siteParam, path: z.string(), ...guardParams },
      annotations: WRITE,
    },
    async ({ site, path, dry_run, approval_id, force }) =>
      run(async () => {
        const body = withGuard({ path }, { dry_run, approval_id, force });
        return present(await callBridge(registry.resolve(site), "POST", "fs/delete", body));
      })
  );
}
