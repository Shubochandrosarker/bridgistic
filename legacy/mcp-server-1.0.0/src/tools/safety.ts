import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ConnectionRegistry } from "../services/connections.js";
import { callBridge } from "../services/wp-client.js";
import { siteParam, run, present } from "./helpers.js";

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function registerSafetyTools(server: McpServer, registry: ConnectionRegistry): void {
  // ---- snapshot.create ----------------------------------------------------
  server.registerTool(
    "bridgistic_snapshot_create",
    {
      title: "Create a snapshot",
      description:
        "Manually capture reversible state before a risky change. Scope: `snapshot:manage`. Types + target:\n  - post   { id }\n  - user   { id }\n  - option { name }\n  - tables { tables: [\"wp_options\", ...] } (≤50k rows each)\n  - file   { path }\nReturns a snapshot_id for bridgistic_snapshot_restore.",
      inputSchema: {
        site: siteParam,
        type: z.enum(["post", "user", "option", "tables", "file"]),
        target: z.record(z.string(), z.unknown()),
        label: z.string().optional(),
      },
      annotations: { ...READ, readOnlyHint: false, idempotentHint: false },
    },
    async ({ site, type, target, label }) =>
      run(async () =>
        present(await callBridge(registry.resolve(site), "POST", "snapshot", { type, target, label }))
      )
  );

  // ---- snapshot.restore ---------------------------------------------------
  server.registerTool(
    "bridgistic_snapshot_restore",
    {
      title: "Restore a snapshot",
      description:
        "Roll back to a snapshot by id (undo a write/delete). Scope: `snapshot:manage`. Use the snapshot_id returned by a write tool or by bridgistic_snapshot_create / bridgistic_snapshot_list.",
      inputSchema: { site: siteParam, snapshot_id: z.string() },
      annotations: { ...READ, readOnlyHint: false, idempotentHint: true },
    },
    async ({ site, snapshot_id }) =>
      run(async () =>
        present(await callBridge(registry.resolve(site), "POST", "snapshot/restore", { snapshot_id }))
      )
  );

  // ---- snapshot.list ------------------------------------------------------
  server.registerTool(
    "bridgistic_snapshot_list",
    {
      title: "List snapshots",
      description: "List recent snapshots (auto + manual) with id/type/label/size/created/restored. Scope: `snapshot:manage`.",
      inputSchema: { site: siteParam, limit: z.number().int().min(1).max(500).optional() },
      annotations: READ,
    },
    async ({ site, limit }) =>
      run(async () => {
        const route = "snapshot" + (limit ? `?limit=${limit}` : "");
        return present(await callBridge(registry.resolve(site), "GET", route));
      })
  );

  // ---- snapshot.delete ----------------------------------------------------
  server.registerTool(
    "bridgistic_snapshot_delete",
    {
      title: "Delete a snapshot",
      description: "Delete a stored snapshot by id (frees space; cannot be restored after). Scope: `snapshot:manage`.",
      inputSchema: { site: siteParam, snapshot_id: z.string() },
      annotations: { ...READ, readOnlyHint: false, idempotentHint: true },
    },
    async ({ site, snapshot_id }) =>
      run(async () =>
        present(await callBridge(registry.resolve(site), "POST", "snapshot/delete", { snapshot_id }))
      )
  );

  // ---- approval.status ----------------------------------------------------
  server.registerTool(
    "bridgistic_approval_status",
    {
      title: "Check approval status",
      description:
        "Check whether a queued operation has been approved. Returns status: pending | approved | rejected | executed. When approved, retry the ORIGINAL tool call with the same args plus approval_id to execute it.",
      inputSchema: { site: siteParam, approval_id: z.string() },
      annotations: READ,
    },
    async ({ site, approval_id }) =>
      run(async () =>
        present(
          await callBridge(
            registry.resolve(site),
            "GET",
            `approvals/status?approval_id=${encodeURIComponent(approval_id)}`
          )
        )
      )
  );
}
