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

const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export function registerIntelTools(server: McpServer, registry: ConnectionRegistry): void {
  // ---- usage --------------------------------------------------------------
  server.registerTool(
    "bridgistic_usage",
    {
      title: "Check this key's usage & limits",
      description:
        "Return the calling key's tier, rate limit (req/min), monthly quota, and current usage (this minute / today / this month + top actions). Call before large batch operations to avoid hitting the quota mid-run.",
      inputSchema: { site: siteParam },
      annotations: READ,
    },
    async ({ site }) =>
      run(async () => present(await callBridge(registry.resolve(site), "GET", "usage")))
  );

  // ---- memory.set ---------------------------------------------------------
  server.registerTool(
    "bridgistic_memory_set",
    {
      title: "Save a site memory note",
      description:
        "Persist a fact about this site for future sessions (conventions, IDs, client preferences, quirks). Scope: `memory:write`. Args: key (required), value (any JSON), category (default 'general'). Overwrites the same category+key.",
      inputSchema: {
        site: siteParam,
        category: z.string().optional(),
        key: z.string(),
        value: z.unknown(),
      },
      annotations: WRITE,
    },
    async ({ site, category, key, value }) =>
      run(async () =>
        present(await callBridge(registry.resolve(site), "POST", "memory", { category, key, value }))
      )
  );

  // ---- memory.get ---------------------------------------------------------
  server.registerTool(
    "bridgistic_memory_get",
    {
      title: "Get a site memory note",
      description: "Read one memory note by key (+optional category). Scope: `memory:read`.",
      inputSchema: { site: siteParam, category: z.string().optional(), key: z.string() },
      annotations: READ,
    },
    async ({ site, category, key }) =>
      run(async () => {
        const qs = new URLSearchParams({ key });
        if (category) qs.set("category", category);
        return present(await callBridge(registry.resolve(site), "GET", `memory?${qs}`));
      })
  );

  // ---- memory.list --------------------------------------------------------
  server.registerTool(
    "bridgistic_memory_list",
    {
      title: "List site memory",
      description:
        "List stored memory notes, optionally filtered by category. Scope: `memory:read`. Call at the start of a session to recall what's known about a site.",
      inputSchema: { site: siteParam, category: z.string().optional() },
      annotations: READ,
    },
    async ({ site, category }) =>
      run(async () => {
        const qs = new URLSearchParams();
        if (category) qs.set("category", category);
        const route = "memory" + (qs.toString() ? `?${qs}` : "");
        return present(await callBridge(registry.resolve(site), "GET", route));
      })
  );

  // ---- memory.delete ------------------------------------------------------
  server.registerTool(
    "bridgistic_memory_delete",
    {
      title: "Delete a site memory note",
      description: "Remove a memory note by key (+optional category). Scope: `memory:write`.",
      inputSchema: { site: siteParam, category: z.string().optional(), key: z.string() },
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ site, category, key }) =>
      run(async () =>
        present(await callBridge(registry.resolve(site), "POST", "memory/delete", { category, key }))
      )
  );

  // ---- playbook step schema ----------------------------------------------
  const stepSchema = z.object({
    method: z.enum(["GET", "POST", "DELETE"]).default("POST"),
    route: z
      .string()
      .describe('Namespace-relative route, e.g. "posts", "posts/123", "options", "media".'),
    params: z.record(z.string(), z.unknown()).optional(),
    save_as: z.string().optional().describe("Name to reference this step's result later."),
  });

  // ---- playbook.save ------------------------------------------------------
  server.registerTool(
    "bridgistic_playbook_save",
    {
      title: "Save a reusable playbook",
      description: `Store an ordered, parameterised sequence of bridge operations for replay. Scope: \`playbook:manage\`.

Each step = { method, route, params, save_as }. Use templates in params:
  - {{vars.NAME}}                 → a run-time input
  - {{steps.REF.data.result.id}}  → a value from an earlier step's result envelope

Example steps (create a landing page then set it as the front page):
[
  { "method":"POST","route":"posts","params":{"type":"page","title":"{{vars.title}}","status":"publish"},"save_as":"page" },
  { "method":"POST","route":"options","params":{"name":"page_on_front","value":"{{steps.page.data.result.id}}"} }
]`,
      inputSchema: {
        site: siteParam,
        slug: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
        steps: z.array(stepSchema).min(1),
      },
      annotations: WRITE,
    },
    async ({ site, slug, name, description, steps }) =>
      run(async () =>
        present(
          await callBridge(registry.resolve(site), "POST", "playbooks", { slug, name, description, steps })
        )
      )
  );

  // ---- playbook.list ------------------------------------------------------
  server.registerTool(
    "bridgistic_playbook_list",
    {
      title: "List playbooks",
      description: "List saved playbooks (slug/name/description). Scope: `playbook:manage`.",
      inputSchema: { site: siteParam },
      annotations: READ,
    },
    async ({ site }) =>
      run(async () => present(await callBridge(registry.resolve(site), "GET", "playbooks")))
  );

  // ---- playbook.get -------------------------------------------------------
  server.registerTool(
    "bridgistic_playbook_get",
    {
      title: "Get a playbook",
      description: "Fetch one playbook incl. its steps. Scope: `playbook:manage`.",
      inputSchema: { site: siteParam, slug: z.string() },
      annotations: READ,
    },
    async ({ site, slug }) =>
      run(async () => present(await callBridge(registry.resolve(site), "GET", `playbooks/${slug}`)))
  );

  // ---- playbook.run -------------------------------------------------------
  server.registerTool(
    "bridgistic_playbook_run",
    {
      title: "Run a playbook",
      description: `Execute a saved playbook. Scope: \`playbook:manage\`; each step also enforces its own scope + the Guard. Args:
  - slug, vars (object of run inputs)
  - dry_run (preview every step), force (skip snapshot aborts)
  - approvals: { "<step ref>": "<approval_id>" } to resume a step that paused for approval.

If a step needs approval the run pauses and returns { status: "paused_for_approval", paused_at, approval_id }; approve in WP Admin, then re-run with approvals mapped to that ref.`,
      inputSchema: {
        site: siteParam,
        slug: z.string(),
        vars: z.record(z.string(), z.unknown()).optional(),
        dry_run: z.boolean().optional(),
        force: z.boolean().optional(),
        approvals: z.record(z.string(), z.string()).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ site, slug, vars, dry_run, force, approvals }) =>
      run(async () =>
        present(
          await callBridge(registry.resolve(site), "POST", "playbooks/run", {
            slug,
            vars,
            dry_run,
            force,
            approvals,
          })
        )
      )
  );

  // ---- playbook.delete ----------------------------------------------------
  server.registerTool(
    "bridgistic_playbook_delete",
    {
      title: "Delete a playbook",
      description: "Delete a playbook by slug. Scope: `playbook:manage`.",
      inputSchema: { site: siteParam, slug: z.string() },
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ site, slug }) =>
      run(async () =>
        present(await callBridge(registry.resolve(site), "POST", "playbooks/delete", { slug }))
      )
  );
}
