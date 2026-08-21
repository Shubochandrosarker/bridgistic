/**
 * The tool catalogue: every MCP tool Bridgistic exposes, with the scope it
 * needs and the risk class that scope carries.
 *
 * This is the seam that makes `scripts/check-cloud-tools-drift.js` in the free
 * repo unnecessary. Drift detection compares two copies and tells you they
 * diverged; a shared dependency means there is only one copy. The free local
 * MCP server, the hosted MCP Worker and the API all resolve scope, approval and
 * metering from THIS list.
 *
 * `scope` is what the WordPress plugin's controller enforces
 * (`$this->require_scope( $request, Scopes::… )`). If a tool's controller
 * changes which scope it demands, change it here in the same commit — the
 * platform would otherwise bill and authorise against a stale answer.
 */

import { scopeClass, isKnownScope, requiresApproval, requiresSnapshot } from "@bridgistic/types";
import type { ScopeClass } from "@bridgistic/types";

export interface ToolDefinition {
  /** MCP tool name, exactly as registered. */
  readonly name: string;
  /**
   * The scope the plugin requires in the WORST case. Authorisation and
   * approval gating use this, so a tool can never be under-classified.
   */
  readonly scope: string | null;
  /**
   * A lesser scope that also authorises this tool, for the one case where the
   * plugin classifies the request at run time rather than at the route: a
   * SELECT through `bridgistic_db_query` needs only `db:read`. Holding the
   * lesser scope admits the call; the plugin still rejects anything beyond it.
   *
   * Without this, `db:read` would be a scope a customer can be granted and no
   * tool would ever accept — which is exactly what the catalogue test caught.
   */
  readonly minScope?: string;
  /** Route under `bridgistic/v1`, or `null` for platform-local tools. */
  readonly route: string | null;
  readonly method: "GET" | "POST" | "DELETE" | null;
  /**
   * The route is a read, even though the scope it demands is a writing one.
   *
   * BR-015. `GET /plugins` is enforced by the plugin at `Scopes::PLUGINS_MANAGE`
   * — a destructive scope — for an operation that lists plugin names and
   * versions and changes nothing. The platform has to authorise against what
   * the plugin actually checks, or it admits calls the site will reject; but
   * applying destructive gating to a listing would mean asking a human to
   * approve, and taking a snapshot before, reading a list.
   *
   * So the two are separated: `scope` is what the plugin demands and what
   * authorisation uses; this flag says what the operation does and what the
   * gate should therefore be. It may ONLY be set on a GET route, and it only
   * ever relaxes the gate — it can never widen who is allowed to call.
   *
   * The real fix belongs in the plugin: a read-only scope for the listing
   * route. Until that ships, this keeps the platform honest in both
   * directions rather than picking one to be wrong about.
   */
  readonly readOnlyOperation?: true;
  /** Grouping used by the dashboard and the docs. */
  readonly group:
    | "core"
    | "content"
    | "admin"
    | "safety"
    | "intel"
    | "schedule"
    | "woo";
}

export const TOOLS: readonly ToolDefinition[] = [
  // ---- core ---------------------------------------------------------------
  { name: "bridgistic_list_sites", scope: null, route: null, method: null, group: "core" },
  { name: "bridgistic_get_site_info", scope: "site:read", route: "site-info", method: "GET", group: "core" },
  { name: "bridgistic_execute_php", scope: "php:execute", route: "execute", method: "POST", group: "core" },
  // db_query is classified by the plugin at run time: a SELECT needs db:read,
  // anything else needs db:write. The catalogue records the HIGHER of the two
  // so authorisation and metering never under-charge a write that arrives
  // looking like a read.
  { name: "bridgistic_db_query", scope: "db:write", minScope: "db:read", route: "db/query", method: "POST", group: "core" },

  // ---- content ------------------------------------------------------------
  { name: "bridgistic_list_posts", scope: "posts:read", route: "posts", method: "GET", group: "content" },
  { name: "bridgistic_get_post", scope: "posts:read", route: "posts", method: "GET", group: "content" },
  { name: "bridgistic_create_post", scope: "posts:write", route: "posts", method: "POST", group: "content" },
  { name: "bridgistic_update_post", scope: "posts:write", route: "posts", method: "POST", group: "content" },
  { name: "bridgistic_delete_post", scope: "posts:write", route: "posts", method: "DELETE", group: "content" },
  { name: "bridgistic_list_media", scope: "posts:read", route: "media", method: "GET", group: "content" },
  { name: "bridgistic_upload_media", scope: "media:write", route: "media", method: "POST", group: "content" },
  { name: "bridgistic_delete_media", scope: "media:write", route: "media", method: "DELETE", group: "content" },
  { name: "bridgistic_list_users", scope: "users:read", route: "users", method: "GET", group: "content" },
  { name: "bridgistic_create_user", scope: "users:write", route: "users", method: "POST", group: "content" },
  { name: "bridgistic_update_user", scope: "users:write", route: "users", method: "POST", group: "content" },

  // ---- admin --------------------------------------------------------------
  { name: "bridgistic_get_option", scope: "options:read", route: "options", method: "GET", group: "admin" },
  { name: "bridgistic_update_option", scope: "options:write", route: "options", method: "POST", group: "admin" },
  { name: "bridgistic_list_plugins", scope: "plugins:manage", readOnlyOperation: true, route: "plugins", method: "GET", group: "admin" },
  { name: "bridgistic_toggle_plugin", scope: "plugins:manage", route: "plugins/toggle", method: "POST", group: "admin" },
  { name: "bridgistic_fs_list", scope: "fs:read", route: "fs/list", method: "GET", group: "admin" },
  { name: "bridgistic_fs_read", scope: "fs:read", route: "fs/read", method: "GET", group: "admin" },
  { name: "bridgistic_fs_write", scope: "fs:write", route: "fs/write", method: "POST", group: "admin" },
  { name: "bridgistic_fs_delete", scope: "fs:write", route: "fs/delete", method: "POST", group: "admin" },

  // ---- safety -------------------------------------------------------------
  { name: "bridgistic_snapshot_create", scope: "snapshot:manage", route: "snapshots", method: "POST", group: "safety" },
  { name: "bridgistic_snapshot_restore", scope: "snapshot:manage", route: "snapshots/restore", method: "POST", group: "safety" },
  { name: "bridgistic_snapshot_list", scope: "snapshot:manage", route: "snapshots", method: "GET", group: "safety" },
  { name: "bridgistic_snapshot_delete", scope: "snapshot:manage", route: "snapshots", method: "DELETE", group: "safety" },
  { name: "bridgistic_approval_status", scope: "site:read", route: "approvals", method: "GET", group: "safety" },

  // ---- intel --------------------------------------------------------------
  { name: "bridgistic_usage", scope: "site:read", route: "usage", method: "GET", group: "intel" },
  { name: "bridgistic_memory_set", scope: "memory:write", route: "memory", method: "POST", group: "intel" },
  { name: "bridgistic_memory_get", scope: "memory:read", route: "memory", method: "GET", group: "intel" },
  { name: "bridgistic_memory_list", scope: "memory:read", route: "memory", method: "GET", group: "intel" },
  { name: "bridgistic_memory_delete", scope: "memory:write", route: "memory", method: "DELETE", group: "intel" },
  { name: "bridgistic_playbook_save", scope: "playbook:manage", route: "playbooks", method: "POST", group: "intel" },
  { name: "bridgistic_playbook_list", scope: "playbook:manage", route: "playbooks", method: "GET", group: "intel" },
  { name: "bridgistic_playbook_get", scope: "playbook:manage", route: "playbooks", method: "GET", group: "intel" },
  { name: "bridgistic_playbook_run", scope: "playbook:manage", route: "playbooks/run", method: "POST", group: "intel" },
  { name: "bridgistic_playbook_delete", scope: "playbook:manage", route: "playbooks", method: "DELETE", group: "intel" },

  // ---- schedule -----------------------------------------------------------
  { name: "bridgistic_schedule_create", scope: "schedule:manage", route: "schedules", method: "POST", group: "schedule" },
  { name: "bridgistic_schedule_list", scope: "schedule:manage", route: "schedules", method: "GET", group: "schedule" },
  { name: "bridgistic_schedule_toggle", scope: "schedule:manage", route: "schedules/toggle", method: "POST", group: "schedule" },
  { name: "bridgistic_schedule_delete", scope: "schedule:manage", route: "schedules", method: "DELETE", group: "schedule" },
  { name: "bridgistic_schedule_run_now", scope: "schedule:manage", route: "schedules/run", method: "POST", group: "schedule" },

  // ---- woocommerce --------------------------------------------------------
  { name: "bridgistic_woo_list_products", scope: "woo:products:read", route: "woo/products", method: "GET", group: "woo" },
  { name: "bridgistic_woo_get_product", scope: "woo:products:read", route: "woo/products", method: "GET", group: "woo" },
  { name: "bridgistic_woo_create_product", scope: "woo:products:write", route: "woo/products", method: "POST", group: "woo" },
  { name: "bridgistic_woo_update_product", scope: "woo:products:write", route: "woo/products", method: "POST", group: "woo" },
  { name: "bridgistic_woo_list_orders", scope: "woo:orders:read", route: "woo/orders", method: "GET", group: "woo" },
  { name: "bridgistic_woo_get_order", scope: "woo:orders:read", route: "woo/orders", method: "GET", group: "woo" },
  { name: "bridgistic_woo_update_order_status", scope: "woo:orders:write", route: "woo/orders/status", method: "POST", group: "woo" },
  { name: "bridgistic_woo_list_customers", scope: "woo:customers:read", route: "woo/customers", method: "GET", group: "woo" },
  { name: "bridgistic_woo_get_customer", scope: "woo:customers:read", route: "woo/customers", method: "GET", group: "woo" },
  { name: "bridgistic_woo_inventory_status", scope: "woo:analytics:read", route: "woo/inventory", method: "GET", group: "woo" },
  { name: "bridgistic_woo_sales_summary", scope: "woo:analytics:read", route: "woo/sales", method: "GET", group: "woo" },
] as const;

const BY_NAME = new Map<string, ToolDefinition>(TOOLS.map((t) => [t.name, t]));

export function toolDefinition(name: string): ToolDefinition | undefined {
  return BY_NAME.get(name);
}

/**
 * The class the OPERATION carries — what pricing and read-only hints use.
 * `toolClass` gives the class of the SCOPE, which is what authorisation uses.
 * BR-015 is the one place these differ.
 */
export function operationClass(name: string): ScopeClass | null {
  const tool = toolDefinition(name);
  if (!tool) return null;
  if (tool.readOnlyOperation) return "sensitive_read";
  return toolClass(name);
}

export function toolClass(name: string): ScopeClass | null {
  const tool = BY_NAME.get(name);
  if (!tool || tool.scope === null) return null;
  return scopeClass(tool.scope) ?? null;
}

/**
 * The tool's own class is `destructive`.
 *
 * Prefer `requiresApprovalFor` when the question is "is this gated?" — since
 * the BR-002 reclassification, `credential` and `code_execution` tools are
 * gated exactly as hard as destructive ones without being in that class, and a
 * check written against the class name alone silently stops covering them.
 */
export function isDestructive(name: string): boolean {
  return toolClass(name) === "destructive";
}

/**
 * Approval + step-up before the call reaches the site.
 *
 * Honours `readOnlyOperation` (BR-015) for the same reason the contract
 * registry does: if these two functions and the contract could give different
 * answers about the same tool, there would be two security policies, and the
 * one that got consulted would depend on which surface the call arrived on.
 */
export function requiresApprovalFor(name: string): boolean {
  const tool = toolDefinition(name);
  if (!tool || tool.scope === null || tool.readOnlyOperation) return false;
  return requiresApproval(tool.scope);
}

/** INVARIANT 4: no snapshot id, no gated execution. */
export function requiresSnapshotBefore(name: string): boolean {
  const tool = toolDefinition(name);
  if (!tool || tool.scope === null || tool.readOnlyOperation) return false;
  return requiresSnapshot(tool.scope);
}

/** Every scope the catalogue references. Used to check the plugin has them all. */
export function referencedScopes(): string[] {
  const scopes = TOOLS.flatMap((t) => [t.scope, t.minScope ?? null]);
  return [...new Set(scopes.filter((s): s is string => s !== null && isKnownScope(s)))].sort();
}

/** The tools a caller holding exactly `grantedScopes` may invoke. */
export function toolsForScopes(grantedScopes: readonly string[]): string[] {
  const granted = new Set(grantedScopes);
  return TOOLS.filter(
    (t) => t.scope === null || granted.has(t.scope) || (t.minScope !== undefined && granted.has(t.minScope))
  ).map((t) => t.name);
}

/**
 * The risk class this caller's call actually carries, given what they hold.
 *
 * A Starter key with `db:read` running a SELECT is a read: no approval, no
 * snapshot, metered as a read. The same tool on an Agency key with `db:write`
 * is destructive. Gating on the catalogue's worst case alone would make every
 * SELECT demand an approval, which is how a safety feature turns into noise
 * people learn to click through.
 */
export function effectiveToolClass(name: string, grantedScopes: readonly string[]): ScopeClass | null {
  const tool = BY_NAME.get(name);
  if (!tool || tool.scope === null) return null;
  const granted = new Set(grantedScopes);
  if (granted.has(tool.scope)) return scopeClass(tool.scope) ?? null;
  if (tool.minScope !== undefined && granted.has(tool.minScope)) return scopeClass(tool.minScope) ?? null;
  return null;
}
