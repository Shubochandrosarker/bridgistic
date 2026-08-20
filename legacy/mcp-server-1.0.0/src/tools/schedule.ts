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

const recurrence = z.enum([
  "once",
  "bridgistic_5min",
  "bridgistic_15min",
  "bridgistic_30min",
  "hourly",
  "twicedaily",
  "daily",
  "weekly",
]);

export function registerScheduleTools(server: McpServer, registry: ConnectionRegistry): void {
  // ---- schedule.create ----------------------------------------------------
  server.registerTool(
    "bridgistic_schedule_create",
    {
      title: "Schedule a playbook",
      description: `Run a saved playbook unattended on a recurrence (WP-Cron). Scope: \`schedule:manage\`. The schedule runs under THIS key's current scopes, so the key must hold the scopes every step needs.

Args:
  - playbook (slug), recurrence (once|bridgistic_5min|bridgistic_15min|bridgistic_30min|hourly|twicedaily|daily|weekly)
  - vars (object passed to the run), start_at (unix seconds, optional first-run time)
  - dry_run (run in preview mode every time — good for testing a schedule), force.

Note: unattended runs never auto-approve. If a step needs approval the run records "paused_for_approval" and stops — use a key WITHOUT require_approval for fully autonomous schedules.`,
      inputSchema: {
        site: siteParam,
        playbook: z.string(),
        recurrence,
        vars: z.record(z.string(), z.unknown()).optional(),
        start_at: z.number().int().optional(),
        dry_run: z.boolean().optional(),
        force: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ site, ...body }) =>
      run(async () => present(await callBridge(registry.resolve(site), "POST", "schedules", body)))
  );

  // ---- schedule.list ------------------------------------------------------
  server.registerTool(
    "bridgistic_schedule_list",
    {
      title: "List schedules",
      description:
        "List scheduled playbooks with recurrence, next/last run, and last status. Scope: `schedule:manage`.",
      inputSchema: { site: siteParam },
      annotations: READ,
    },
    async ({ site }) =>
      run(async () => present(await callBridge(registry.resolve(site), "GET", "schedules")))
  );

  // ---- schedule.toggle ----------------------------------------------------
  server.registerTool(
    "bridgistic_schedule_toggle",
    {
      title: "Enable / disable a schedule",
      description: "Pause or resume a schedule without deleting it. Scope: `schedule:manage`.",
      inputSchema: { site: siteParam, schedule_id: z.string(), enabled: z.boolean() },
      annotations: { ...READ, readOnlyHint: false },
    },
    async ({ site, schedule_id, enabled }) =>
      run(async () =>
        present(await callBridge(registry.resolve(site), "POST", "schedules/toggle", { schedule_id, enabled }))
      )
  );

  // ---- schedule.delete ----------------------------------------------------
  server.registerTool(
    "bridgistic_schedule_delete",
    {
      title: "Delete a schedule",
      description: "Remove a schedule and unregister its cron event. Scope: `schedule:manage`.",
      inputSchema: { site: siteParam, schedule_id: z.string() },
      annotations: { ...READ, readOnlyHint: false },
    },
    async ({ site, schedule_id }) =>
      run(async () =>
        present(await callBridge(registry.resolve(site), "POST", "schedules/delete", { schedule_id }))
      )
  );

  // ---- schedule.run_now ---------------------------------------------------
  server.registerTool(
    "bridgistic_schedule_run_now",
    {
      title: "Run a schedule now",
      description:
        "Trigger a scheduled playbook immediately (does not change its recurrence). Scope: `schedule:manage`. Useful to test a schedule end-to-end.",
      inputSchema: { site: siteParam, schedule_id: z.string() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ site, schedule_id }) =>
      run(async () =>
        present(await callBridge(registry.resolve(site), "POST", "schedules/run-now", { schedule_id }))
      )
  );
}
