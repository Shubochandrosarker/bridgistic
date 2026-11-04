/**
 * Input schemas for all 54 tools, and the descriptions the model reads.
 *
 * Transcribed from the pinned engine's Zod schemas at `a9cf564`
 * (`cloud/src/tools/*.ts`) so the hosted platform accepts exactly what the
 * free local server accepts. `scripts/check-tool-drift.mjs` fails if the two
 * lists diverge.
 *
 * Differences from the transcription, all deliberate, all tightened:
 *
 *  - `force` is gone from every tool. BR-013 — see `params.ts`.
 *  - `idempotency_key` is added to every write, because the hosted platform
 *    can be retried by a queue and the local one cannot.
 *  - Free-form `url` inputs are `format: "https-url"` rather than `uri`.
 *  - Every object schema is `additionalProperties: false`. The local server
 *    ignored unknown arguments; here an unknown argument is an error, since a
 *    silently-dropped argument makes a call look like it did what was asked.
 */

import type { JsonSchema } from "./json-schema.ts";
import {
  SITE_PARAM,
  GUARD_PARAMS,
  DRY_RUN_PARAM,
  IDEMPOTENCY_KEY_PARAM,
  PER_PAGE_PARAM,
  PAGE_PARAM,
  ID_PARAM,
} from "./params.ts";

/** Build an object schema with the house rules applied. */
function object(
  properties: Record<string, JsonSchema>,
  required: readonly string[] = []
): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

/** A site-targeting tool: `site` plus whatever else it takes. */
function siteTool(properties: Record<string, JsonSchema> = {}, required: readonly string[] = []): JsonSchema {
  return object({ site: SITE_PARAM, ...properties }, required);
}

/** A site-targeting write: adds dry_run / approval_id / idempotency_key. */
function writeTool(properties: Record<string, JsonSchema> = {}, required: readonly string[] = []): JsonSchema {
  return object({ site: SITE_PARAM, ...properties, ...GUARD_PARAMS }, required);
}

/**
 * A gated write whose plugin route has no dry-run mode.
 *
 * `approval_id` is still here — an approval-gated tool that cannot receive the
 * approval id has no way to complete its own flow — but `dry_run` is not.
 * Advertising a preview switch the plugin ignores would mean a caller asking
 * for a preview and getting the real thing, which is the worst possible way
 * for that argument to be wrong.
 */
function gatedTool(properties: Record<string, JsonSchema> = {}, required: readonly string[] = []): JsonSchema {
  const { dry_run: _omitted, ...rest } = GUARD_PARAMS;
  return object({ site: SITE_PARAM, ...properties, ...rest }, required);
}

const STRING = (max = 1_000, description?: string): JsonSchema => ({
  type: "string",
  maxLength: max,
  ...(description ? { description } : {}),
});

/** Arbitrary caller-defined JSON, bounded. Used for post meta and job vars. */
const FREE_OBJECT: JsonSchema = {
  type: "object",
  maxProperties: 100,
  additionalProperties: true,
};

const PAGINATION = { per_page: PER_PAGE_PARAM, page: PAGE_PARAM };

const PLAYBOOK_STEP: JsonSchema = {
  type: "object",
  properties: {
    tool: { type: "string", minLength: 1, maxLength: 64, description: "Tool name to invoke." },
    args: FREE_OBJECT,
    label: STRING(200),
    continue_on_error: { type: "boolean" },
  },
  required: ["tool"],
  additionalProperties: false,
};

export interface SchemaEntry {
  readonly description: string;
  readonly inputSchema: JsonSchema;
  /** Overrides the default derived from the risk class, where a tool needs longer. */
  readonly timeoutMs?: number;
  /**
   * Overrides the default. False means a retry is NOT safe and the executor
   * must never replay it automatically.
   */
  readonly supportsIdempotency?: boolean;
}

export const SCHEMAS: Readonly<Record<string, SchemaEntry>> = {
  // ---- core -----------------------------------------------------------------
  bridgistic_list_sites: {
    description:
      "List the sites connected to your organization, with alias, health and last-seen. " +
      "Platform-local: does not contact any site, and is not metered.",
    inputSchema: object({}),
  },
  bridgistic_get_site_info: {
    description:
      "Site metadata: WordPress and PHP versions, active theme, plugin list, multisite status, health summary. " +
      "Scope: `site:read`.",
    inputSchema: siteTool(),
  },
  bridgistic_execute_php: {
    description:
      "Execute PHP on the site and return its value. Highest privilege in the product. " +
      "Scope: `php:execute`. Requires approval, a snapshot and step-up authentication on every call, " +
      "plus a per-site opt-in. Not retried automatically.",
    inputSchema: gatedTool(
      {
        code: {
          type: "string",
          minLength: 1,
          maxLength: 100_000,
          description: 'PHP source. Example: return get_option("blogname");',
        },
      },
      ["code"]
    ),
    timeoutMs: 60_000,
    // Arbitrary PHP has arbitrary side effects. The executor cannot know
    // whether a replay is safe, so it never assumes it is.
    supportsIdempotency: false,
  },
  bridgistic_db_query: {
    description:
      "Run one SQL statement. A SELECT/SHOW/EXPLAIN needs `db:read` and runs immediately. Anything that writes " +
      "needs `db:write`, and then requires approval, a snapshot and step-up authentication before it runs. " +
      "Scope: `db:write` (or `db:read` for reads only). Not retried automatically.",
    inputSchema: writeTool(
      {
        sql: { type: "string", minLength: 1, maxLength: 20_000, description: "A single SQL statement." },
      },
      ["sql"]
    ),
    timeoutMs: 30_000,
    supportsIdempotency: false,
  },
  bridgistic_usage: {
    description: "This site's Bridgistic usage: calls, actions consumed, and the current period's limits.",
    inputSchema: siteTool(),
  },

  // ---- content --------------------------------------------------------------
  bridgistic_list_posts: {
    description:
      "List content with pagination. Scope: `posts:read`. Returns id/title/type/status/slug/link plus total and has_more.",
    inputSchema: siteTool({
      post_type: STRING(64, "Post type slug. Default 'post'."),
      status: STRING(32, "Status filter. Default 'any'."),
      search: STRING(200),
      ...PAGINATION,
    }),
  },
  bridgistic_get_post: {
    description: "Fetch one post/page/CPT by id, with full content and meta. Scope: `posts:read`.",
    inputSchema: siteTool({ id: ID_PARAM }, ["id"]),
  },
  bridgistic_create_post: {
    description: "Create a post, page or custom post type. Scope: `posts:write`.",
    inputSchema: writeTool({
      title: STRING(500),
      content: STRING(2_000_000),
      excerpt: STRING(5_000),
      status: STRING(32),
      slug: STRING(200),
      type: STRING(64),
      author: ID_PARAM,
      parent: ID_PARAM,
      meta: FREE_OBJECT,
    }),
  },
  bridgistic_update_post: {
    description: "Update an existing post. Only the fields sent are changed. Scope: `posts:write`.",
    inputSchema: writeTool(
      {
        id: ID_PARAM,
        title: STRING(500),
        content: STRING(2_000_000),
        excerpt: STRING(5_000),
        status: STRING(32),
        slug: STRING(200),
        meta: FREE_OBJECT,
      },
      ["id"]
    ),
  },
  bridgistic_delete_post: {
    description:
      "Trash a post, or delete it permanently with permanent=true. Scope: `posts:write`. " +
      "A trashed post is recoverable from the site; a permanent delete is not, and is reversible only from a snapshot.",
    inputSchema: writeTool(
      {
        id: ID_PARAM,
        permanent: { type: "boolean", description: "Skip the trash and delete irreversibly." },
      },
      ["id"]
    ),
  },
  bridgistic_list_media: {
    description: "List media library items with pagination. Scope: `posts:read`.",
    inputSchema: siteTool(PAGINATION),
  },
  bridgistic_upload_media: {
    description:
      "Add an item to the media library, either from an https URL or from base64 content. Scope: `media:write`.",
    inputSchema: writeTool({
      url: { type: "string", format: "https-url", maxLength: 2_000, description: "https:// source to fetch." },
      filename: STRING(255),
      content_base64: { type: "string", maxLength: 20_000_000, description: "Base64 file content." },
    }),
    timeoutMs: 60_000,
  },
  bridgistic_delete_media: {
    description: "Delete a media item. Scope: `media:write`.",
    inputSchema: writeTool({ id: ID_PARAM }, ["id"]),
  },

  // ---- admin ----------------------------------------------------------------
  bridgistic_get_option: {
    description: "Read one wp_options value. Allowlist enforced by the plugin. Scope: `options:read`.",
    inputSchema: siteTool({ name: STRING(191, "Option name.") }, ["name"]),
  },
  bridgistic_update_option: {
    description: "Write one wp_options value. Allowlist enforced. Scope: `options:write`. Snapshot taken first.",
    inputSchema: writeTool({ name: STRING(191), value: {} }, ["name", "value"]),
  },
  bridgistic_list_plugins: {
    description: "List installed plugins with version and active state. Scope: `site:read`.",
    inputSchema: siteTool(),
  },
  bridgistic_toggle_plugin: {
    description:
      "Activate or deactivate a plugin. Scope: `plugins:manage`. Requires approval, a snapshot and step-up " +
      "authentication — deactivating the wrong plugin can take a site offline.",
    inputSchema: writeTool(
      {
        plugin: STRING(255, "Plugin file, e.g. 'woocommerce/woocommerce.php'."),
        state: { type: "string", enum: ["activate", "deactivate"] },
      },
      ["plugin", "state"]
    ),
  },
  bridgistic_list_users: {
    description: "List user accounts. Scope: `users:read` — sensitive: this is personal data.",
    inputSchema: siteTool({ search: STRING(200), ...PAGINATION }),
  },
  bridgistic_create_user: {
    // BR-014 — `password` was in the pinned engine's schema and is not here.
    //
    // A password supplied as a tool argument travels through the model's
    // context window, the MCP transport, the client's own logging, and this
    // Worker before it reaches WordPress. Every one of those is a place a
    // credential should never be, and several are outside our control.
    //
    // The free local server can keep it: it runs on the operator's machine,
    // against their own site, with their own credentials. The hosted product
    // passes through third-party infrastructure and a language model, so the
    // same argument is a different risk. WordPress already generates a strong
    // password and emails the user, which is both safer and less work.
    description:
      "Create a WordPress user. WordPress generates the password and emails it to them directly — it is never " +
      "sent through Bridgistic. Scope: `users:write`. Requires approval and step-up authentication, and is " +
      "never available to an API key or service account: creating a user is how access is made persistent.",
    inputSchema: writeTool(
      {
        login: STRING(60),
        email: { type: "string", format: "email", maxLength: 254 },
        role: STRING(32),
        display_name: STRING(250),
      },
      ["login", "email"]
    ),
  },
  bridgistic_update_user: {
    description:
      "Update a user's email, display name or role. Scope: `users:write`. Requires approval and step-up — " +
      "a role change is a privilege change.",
    inputSchema: writeTool(
      {
        id: ID_PARAM,
        email: { type: "string", format: "email", maxLength: 254 },
        display_name: STRING(250),
        role: STRING(32),
      },
      ["id"]
    ),
  },
  bridgistic_fs_list: {
    description: "List a directory inside ABSPATH. Scope: `fs:read` — sensitive.",
    inputSchema: siteTool({ path: STRING(1_024, "Path relative to ABSPATH.") }, ["path"]),
  },
  bridgistic_fs_read: {
    description:
      "Read a file inside ABSPATH. Scope: `fs:read` — sensitive: ABSPATH contains wp-config.php, which holds " +
      "the database credentials and authentication salts.",
    inputSchema: siteTool({ path: STRING(1_024) }, ["path"]),
  },
  bridgistic_fs_write: {
    description:
      "Write a file inside ABSPATH. PHP only inside the sandbox directory. Scope: `fs:write`. Requires approval, " +
      "a snapshot and step-up authentication.",
    inputSchema: writeTool({ path: STRING(1_024), content: STRING(5_000_000) }, ["path", "content"]),
    supportsIdempotency: false,
  },
  bridgistic_fs_delete: {
    description: "Delete a file inside ABSPATH. Scope: `fs:write`. Requires approval, a snapshot and step-up.",
    inputSchema: writeTool({ path: STRING(1_024) }, ["path"]),
  },

  // ---- intel ----------------------------------------------------------------
  bridgistic_memory_set: {
    description: "Store a per-site note the model can read back later. Scope: `memory:write`.",
    inputSchema: siteTool({ category: STRING(64), key: STRING(191), value: {} }, ["key", "value"]),
  },
  bridgistic_memory_get: {
    description: "Read one per-site note. Scope: `memory:read`.",
    inputSchema: siteTool({ category: STRING(64), key: STRING(191) }, ["key"]),
  },
  bridgistic_memory_list: {
    description: "List per-site notes, optionally within one category. Scope: `memory:read`.",
    inputSchema: siteTool({ category: STRING(64) }),
  },
  bridgistic_memory_delete: {
    description: "Delete one per-site note. Scope: `memory:write`.",
    inputSchema: siteTool({ category: STRING(64), key: STRING(191) }, ["key"]),
  },
  bridgistic_playbook_save: {
    description: "Save a reusable sequence of tool calls. Scope: `playbook:manage`.",
    inputSchema: siteTool(
      {
        slug: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9_-]*$" },
        name: STRING(200),
        description: STRING(2_000),
        steps: { type: "array", items: PLAYBOOK_STEP, minItems: 1, maxItems: 50 },
      },
      ["slug", "steps"]
    ),
  },
  bridgistic_playbook_list: {
    description: "List saved playbooks. Scope: `playbook:manage`.",
    inputSchema: siteTool(),
  },
  bridgistic_playbook_get: {
    description: "Fetch one playbook with its steps. Scope: `playbook:manage`.",
    inputSchema: siteTool({ slug: STRING(64) }, ["slug"]),
  },
  bridgistic_playbook_run: {
    description:
      "Run a saved playbook. Scope: `playbook:manage`. Every step is gated individually — a playbook cannot " +
      "reach a tool the caller could not call directly, and a destructive step still needs its own approval.",
    // No single `approval_id` here: a playbook is not gated as a unit, its
    // steps are gated individually, and `approvals` carries one id per step.
    // A lone approval_id would be ambiguous about which step it authorised —
    // and an ambiguous approval is one that gets applied to the wrong thing.
    inputSchema: object(
      {
        site: SITE_PARAM,
        slug: STRING(64),
        vars: FREE_OBJECT,
        dry_run: DRY_RUN_PARAM,
        idempotency_key: IDEMPOTENCY_KEY_PARAM,
        approvals: {
          type: "object",
          maxProperties: 50,
          additionalProperties: { type: "string", maxLength: 128 },
          description: "Approval ids per step, for steps that required one.",
        },
      },
      ["slug"]
    ),
    timeoutMs: 300_000,
    supportsIdempotency: false,
  },
  bridgistic_playbook_delete: {
    description: "Delete a playbook. Scope: `playbook:manage`.",
    inputSchema: siteTool({ slug: STRING(64) }, ["slug"]),
  },

  // ---- safety ---------------------------------------------------------------
  bridgistic_snapshot_create: {
    description:
      "Take a snapshot of one object, a set of tables, or a file, so a later change can be rolled back. " +
      "Scope: `snapshot:manage`.",
    inputSchema: siteTool(
      {
        type: { type: "string", enum: ["post", "user", "option", "tables", "file"] },
        target: FREE_OBJECT,
        label: STRING(200),
      },
      ["type", "target"]
    ),
    timeoutMs: 120_000,
  },
  bridgistic_snapshot_restore: {
    description:
      "Restore a snapshot. Scope: `snapshot:manage`. Destructive: this discards every change made since the " +
      "snapshot was taken. Requires approval and step-up authentication, and takes a snapshot of the current " +
      "state first so the restore itself can be undone.",
    inputSchema: gatedTool({ snapshot_id: STRING(128) }, ["snapshot_id"]),
    timeoutMs: 300_000,
    supportsIdempotency: false,
  },
  bridgistic_snapshot_list: {
    description: "List snapshots for this site, newest first. Scope: `snapshot:manage`.",
    inputSchema: siteTool({ limit: { type: "integer", minimum: 1, maximum: 500 } }),
  },
  bridgistic_snapshot_delete: {
    description:
      "Delete a snapshot. Scope: `snapshot:manage`. Destructive: it removes a rollback path that other gated " +
      "operations depend on. Requires approval and step-up.",
    inputSchema: gatedTool({ snapshot_id: STRING(128) }, ["snapshot_id"]),
  },
  bridgistic_approval_status: {
    description: "Check whether a pending approval has been granted, rejected, or has expired.",
    inputSchema: siteTool({ approval_id: STRING(128) }, ["approval_id"]),
  },

  // ---- schedule -------------------------------------------------------------
  bridgistic_schedule_create: {
    description:
      "Schedule a playbook to run unattended. Scope: `schedule:manage`. The interval floor comes from the plan; " +
      "a scheduled run is gated exactly as the same call made by hand, and a step needing approval pauses the run.",
    inputSchema: siteTool(
      {
        playbook: STRING(64),
        recurrence: {
          type: "string",
          maxLength: 100,
          description: "Cron expression (5 fields) or a named interval such as 'hourly' or 'daily'.",
        },
        timezone: STRING(64, "IANA timezone, e.g. 'Europe/London'. Defaults to the organization's."),
        vars: FREE_OBJECT,
        start_at: { type: "integer", minimum: 0, description: "Unix seconds; omit to start at the next occurrence." },
        dry_run: { type: "boolean" },
      },
      ["playbook", "recurrence"]
    ),
  },
  bridgistic_schedule_list: {
    description: "List scheduled jobs with their next run time and last outcome. Scope: `schedule:manage`.",
    inputSchema: siteTool(),
  },
  bridgistic_schedule_toggle: {
    description: "Enable or disable a scheduled job. Scope: `schedule:manage`.",
    inputSchema: siteTool({ schedule_id: STRING(128), enabled: { type: "boolean" } }, ["schedule_id", "enabled"]),
  },
  bridgistic_schedule_delete: {
    description: "Delete a scheduled job. Scope: `schedule:manage`.",
    inputSchema: siteTool({ schedule_id: STRING(128) }, ["schedule_id"]),
  },
  bridgistic_schedule_run_now: {
    description: "Run a scheduled job immediately, without changing its schedule. Scope: `schedule:manage`.",
    inputSchema: siteTool({ schedule_id: STRING(128) }, ["schedule_id"]),
    supportsIdempotency: false,
  },

  // ---- woo ------------------------------------------------------------------
  bridgistic_woo_list_products: {
    description: "List WooCommerce products with filters and pagination. Scope: `woo:products:read`.",
    inputSchema: siteTool({
      search: STRING(200),
      status: STRING(32),
      stock_status: { type: "string", enum: ["instock", "outofstock", "onbackorder"] },
      category: STRING(200, "Product category slug."),
      ...PAGINATION,
    }),
  },
  bridgistic_woo_get_product: {
    description: "Fetch one product with variations and stock. Scope: `woo:products:read`.",
    inputSchema: siteTool({ id: ID_PARAM }, ["id"]),
  },
  bridgistic_woo_create_product: {
    description: "Create a WooCommerce product. Scope: `woo:products:write`.",
    inputSchema: writeTool(
      {
        name: { type: "string", minLength: 1, maxLength: 500 },
        sku: STRING(100),
        description: STRING(500_000),
        short_description: STRING(10_000),
        status: { type: "string", enum: ["draft", "pending", "private", "publish"] },
        regular_price: STRING(20, 'Decimal string, e.g. "19.99".'),
        sale_price: STRING(20),
        stock_quantity: { type: "integer", minimum: 0 },
        manage_stock: { type: "boolean" },
        stock_status: { type: "string", enum: ["instock", "outofstock", "onbackorder"] },
      },
      ["name"]
    ),
  },
  bridgistic_woo_update_product: {
    description: "Update a product. Only the fields sent are changed. Scope: `woo:products:write`.",
    inputSchema: writeTool(
      {
        id: ID_PARAM,
        name: STRING(500),
        sku: STRING(100),
        description: STRING(500_000),
        short_description: STRING(10_000),
        status: { type: "string", enum: ["draft", "pending", "private", "publish"] },
        regular_price: STRING(20),
        sale_price: STRING(20),
        stock_quantity: { type: "integer", minimum: 0 },
        manage_stock: { type: "boolean" },
        stock_status: { type: "string", enum: ["instock", "outofstock", "onbackorder"] },
      },
      ["id"]
    ),
  },
  bridgistic_woo_update_stock: {
    description: "Set stock quantity or stock status for a product. Scope: `woo:products:write`.",
    inputSchema: writeTool(
      {
        id: ID_PARAM,
        stock_quantity: { type: "integer", minimum: 0 },
        stock_status: { type: "string", enum: ["instock", "outofstock", "onbackorder"] },
      },
      ["id"]
    ),
  },
  bridgistic_woo_list_orders: {
    description:
      "List orders. Scope: `woo:orders:read` — sensitive: orders contain customer names, addresses and contact details.",
    inputSchema: siteTool({
      status: STRING(200, 'Comma-separated statuses, e.g. "processing,completed".'),
      customer_id: ID_PARAM,
      after: { type: "string", format: "date-time", description: "Only orders created on or after this time." },
      ...PAGINATION,
    }),
  },
  bridgistic_woo_get_order: {
    description: "Fetch one order with line items. Scope: `woo:orders:read` — sensitive: customer personal data.",
    inputSchema: siteTool({ id: ID_PARAM }, ["id"]),
  },
  bridgistic_woo_update_order_status: {
    description:
      "Change an order's status. Scope: `woo:orders:write`. Snapshot taken first — a status change can trigger " +
      "customer email, refunds and stock movement that are not undone by changing it back.",
    inputSchema: writeTool(
      {
        id: ID_PARAM,
        status: { type: "string", minLength: 1, maxLength: 50, description: 'Target status, e.g. "completed". The "wc-" prefix is optional.' },
        note: STRING(2_000, "Order note recorded alongside the change."),
      },
      ["id", "status"]
    ),
  },
  bridgistic_woo_list_customers: {
    description: "List customers. Scope: `woo:customers:read` — sensitive: personal data.",
    inputSchema: siteTool({ search: STRING(200), ...PAGINATION }),
  },
  bridgistic_woo_get_customer: {
    description: "Fetch one customer. Scope: `woo:customers:read` — sensitive: personal data, no payment details.",
    inputSchema: siteTool({ id: ID_PARAM }, ["id"]),
  },
  bridgistic_woo_inventory_status: {
    description: "Low-stock and out-of-stock summary. Scope: `woo:analytics:read`.",
    inputSchema: siteTool({
      low_stock_threshold: { type: "integer", minimum: 0, maximum: 100_000 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    }),
  },
  bridgistic_woo_sales_summary: {
    description: "Sales totals over a recent window. Scope: `woo:analytics:read`.",
    inputSchema: siteTool({ days: { type: "integer", minimum: 1, maximum: 365 } }),
  },
};
