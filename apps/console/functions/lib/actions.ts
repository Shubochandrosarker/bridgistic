/**
 * The Actions catalogue: what the Actions tab may run on a connected site, and
 * the server-side executor behind POST /api/actions/run.
 *
 * Every entry is a route the WordPress plugin actually registers (see
 * plugin-routes.json, generated from the plugin's includes/rest) and every
 * field is a parameter its controller reads — the parameter names here were
 * taken from the controllers, not guessed:
 *
 *   posts            title, content, excerpt, status, slug, type
 *   media            url, filename (+ content_base64, which the form does not offer)
 *   plugins/toggle   plugin, state
 *   options          name, value
 *   woo/products     name, sku, description, status, regular_price, stock_status
 *   woo/orders       page, per_page, status, customer_id, after
 *   woo/orders/{id}/status   status, note
 *   permalinks       structure, category_base, tag_base
 *
 * The read-only WooCommerce routes (products, orders, customers, inventory and
 * the sales summary) are catalogued too, so an assistant can answer "what is in
 * this store" without being granted db:read or php:execute.
 *
 * Cache and permalink writes go through the plugin's Guard like every other
 * mutation, so a site that requires approval answers pending_approval and the
 * run is logged as queued.
 *
 * All calls go through functions/lib/wp.ts. Nothing here signs or sends a
 * request on its own — the catalog decides what, wp.ts decides how.
 */

import { audit, requireOrgMember } from "./auth.ts";
import { decryptSecret } from "./crypto.ts";
import { callSite, SiteCallError } from "./wp.ts";

type Fetch = typeof fetch;

export type ActionDomain = "content" | "media" | "plugins" | "site" | "woo";
export type ActionMethod = "GET" | "POST" | "DELETE";

/** One rendered form input. Shared with the agent registry (agents.ts). */
export interface FormField {
  name: string;
  label: string;
  type?: "text" | "textarea" | "number" | "select";
  required?: boolean;
  options?: { value: string; label: string }[];
  placeholder?: string;
  hint?: string;
  /** Prefilled value in the UI; never injected into a call the browser did not send. */
  default?: string;
}

export interface ActionDef {
  id: string;
  domain: ActionDomain;
  label: string;
  description: string;
  method: ActionMethod;
  /** Parameters consumed by `route` (path or query); never sent in the body. */
  routeParams?: string[];
  route: (params: Record<string, string>) => string;
  fields: FormField[];
  /**
   * Reshapes form values into the request body when the plugin expects a
   * different shape (e.g. a preset select plus a free-text override). Defaults
   * to echoing every declared field that is not a route parameter.
   */
  bodyFor?: (params: Record<string, string>) => Record<string, unknown>;
  /** Overwrites or deletes site state: the UI warns, the run log keeps the record. */
  destructive?: boolean;
}

const STATUS_OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "pending", label: "Pending review" },
  { value: "publish", label: "Published" },
  { value: "private", label: "Private" },
];

const PERMALINK_OPTIONS = [
  { value: "/%postname%/", label: "Post name" },
  { value: "/%year%/%monthnum%/%day%/%postname%/", label: "Day and name" },
  { value: "/%year%/%monthnum%/%postname%/", label: "Month and name" },
  { value: "/archives/%post_id%/", label: "Numeric" },
  { value: "/%post_id%/", label: "Post ID" },
];

const WOO_STOCK_OPTIONS = [
  { value: "instock", label: "In stock" },
  { value: "outofstock", label: "Out of stock" },
  { value: "onbackorder", label: "On backorder" },
];

/** Only the query values that were actually filled, URL-encoded. */
function queryString(params: Record<string, string>): string {
  const parts = Object.entries(params)
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

export const ACTIONS: ActionDef[] = [
  // ── Content ───────────────────────────────────────────────────────────────
  {
    id: "content.create-post",
    domain: "content",
    label: "Create post",
    description: "Insert a new post or page on the site.",
    method: "POST",
    route: () => "posts",
    fields: [
      { name: "title", label: "Title", required: true, placeholder: "What the article is called" },
      { name: "content", label: "Content", type: "textarea", hint: "HTML or block markup. Leave empty for a stub." },
      { name: "status", label: "Status", type: "select", options: STATUS_OPTIONS, default: "draft" },
      {
        name: "type",
        label: "Type",
        type: "select",
        options: [
          { value: "post", label: "Post" },
          { value: "page", label: "Page" },
        ],
        default: "post",
      },
      { name: "excerpt", label: "Excerpt", type: "textarea" },
      { name: "slug", label: "Slug", placeholder: "leave-empty-to-derive-from-title" },
    ],
  },
  {
    id: "content.update-post",
    domain: "content",
    label: "Update post",
    description: "Change fields on an existing post. Only the fields you fill are sent.",
    method: "POST",
    routeParams: ["id"],
    route: (p) => `posts/${p.id}`,
    fields: [
      { name: "id", label: "Post ID", type: "number", required: true, placeholder: "123" },
      { name: "title", label: "Title" },
      { name: "content", label: "Content", type: "textarea" },
      { name: "status", label: "Status", type: "select", options: STATUS_OPTIONS },
      { name: "excerpt", label: "Excerpt", type: "textarea" },
      { name: "slug", label: "Slug" },
    ],
  },
  // ── Media ─────────────────────────────────────────────────────────────────
  {
    id: "media.list",
    domain: "media",
    label: "List media",
    description: "Read the media library, newest first.",
    method: "GET",
    routeParams: ["per_page"],
    route: (p) => `media?per_page=${p.per_page ?? "20"}`,
    fields: [{ name: "per_page", label: "Items", type: "number", default: "20", hint: "1–100" }],
  },
  {
    id: "media.upload",
    domain: "media",
    label: "Upload media from URL",
    description: "Sideload one file from a public URL into the media library.",
    method: "POST",
    route: () => "media",
    fields: [
      { name: "url", label: "Source URL", required: true, placeholder: "https://…/image.jpg" },
      { name: "filename", label: "Filename", placeholder: "optional; defaults to the URL's basename" },
    ],
  },
  // ── Plugins ───────────────────────────────────────────────────────────────
  {
    id: "plugins.list",
    domain: "plugins",
    label: "List plugins",
    description: "Read installed plugins, versions and active state.",
    method: "GET",
    route: () => "plugins",
    fields: [],
  },
  {
    id: "plugins.toggle",
    domain: "plugins",
    label: "Activate / deactivate plugin",
    description: "Queue a plugin state change. Sites that require approval hold it until a person confirms.",
    method: "POST",
    route: () => "plugins/toggle",
    destructive: true,
    fields: [
      { name: "plugin", label: "Plugin file", required: true, placeholder: "akismet/akismet.php", hint: "The path shown by List plugins." },
      {
        name: "state",
        label: "Action",
        type: "select",
        required: true,
        options: [
          { value: "activate", label: "Activate" },
          { value: "deactivate", label: "Deactivate" },
        ],
      },
    ],
  },
  // ── Site ──────────────────────────────────────────────────────────────────
  {
    id: "site.info",
    domain: "site",
    label: "Site info",
    description: "Read the site name, WordPress/PHP versions and the key's scopes.",
    method: "GET",
    route: () => "site-info",
    fields: [],
  },
  {
    id: "site.get-option",
    domain: "site",
    label: "Read option",
    description: "Read one allow-listed WordPress option.",
    method: "GET",
    routeParams: ["name"],
    route: (p) => `options?name=${encodeURIComponent(p.name ?? "")}`,
    fields: [{ name: "name", label: "Option name", required: true, placeholder: "blogname" }],
  },
  {
    id: "site.update-option",
    domain: "site",
    label: "Update option",
    description: "Write one allow-listed option. The plugin refuses names outside its allowlist.",
    method: "POST",
    route: () => "options",
    destructive: true,
    fields: [
      { name: "name", label: "Option name", required: true, placeholder: "blogdescription" },
      { name: "value", label: "Value", type: "textarea", required: true },
    ],
  },
  {
    id: "cache.flush",
    domain: "site",
    label: "Flush cache",
    description: "Clear the site's page and object cache so the next request rebuilds it. Safe to repeat; nothing is permanently deleted.",
    method: "POST",
    route: () => "cache/flush",
    fields: [],
  },
  {
    id: "permalinks.get",
    domain: "site",
    label: "Read permalink settings",
    description: "Read the current permalink structure and the category and tag bases.",
    method: "GET",
    route: () => "permalinks",
    fields: [],
  },
  {
    id: "permalinks.update",
    domain: "site",
    label: "Update permalinks",
    description:
      "Change the permalink structure or the category/tag base. Every existing URL changes shape, so old links, feeds and shared URLs may stop resolving.",
    method: "POST",
    route: () => "permalinks",
    destructive: true,
    // The select offers presets; the free-text field wins when it is filled.
    // The plugin validates the final structure against its own whitelist.
    bodyFor: (p) => {
      const structure = (p.custom || p.structure || "").trim();
      const body: Record<string, unknown> = {};
      if (structure) body.structure = structure;
      if (p.category_base) body.category_base = p.category_base;
      if (p.tag_base) body.tag_base = p.tag_base;
      return body;
    },
    fields: [
      {
        name: "structure",
        label: "Structure",
        type: "select",
        options: PERMALINK_OPTIONS,
        hint: "A preset. To use your own pattern, fill the field below instead.",
      },
      {
        name: "custom",
        label: "Custom structure",
        placeholder: "/%category%/%postname%/",
        hint: "Overrides the preset. Must contain %post_id% or %postname%.",
      },
      { name: "category_base", label: "Category base", placeholder: "category", hint: "Leave empty to keep the current base." },
      { name: "tag_base", label: "Tag base", placeholder: "tag", hint: "Leave empty to keep the current base." },
    ],
  },
  // ── WooCommerce ───────────────────────────────────────────────────────────
  {
    id: "woo.list-products",
    domain: "woo",
    label: "List products",
    description: "Read products newest first, with price, stock and status. Filter by search term, status, stock or category.",
    method: "GET",
    routeParams: ["page", "per_page", "search", "status", "stock_status", "category"],
    route: (p) => `woo/products${queryString(p)}`,
    fields: [
      { name: "page", label: "Page", type: "number", default: "1" },
      { name: "per_page", label: "Per page", type: "number", default: "20", hint: "1–100" },
      { name: "search", label: "Search", placeholder: "hoodie" },
      {
        name: "status",
        label: "Product status",
        type: "select",
        options: [
          { value: "publish", label: "Published" },
          { value: "draft", label: "Draft" },
          { value: "pending", label: "Pending review" },
          { value: "private", label: "Private" },
        ],
      },
      { name: "stock_status", label: "Stock", type: "select", options: WOO_STOCK_OPTIONS },
      { name: "category", label: "Category", placeholder: "clothing", hint: "Category slug." },
    ],
  },
  {
    id: "woo.get-product",
    domain: "woo",
    label: "Product detail",
    description: "Read one product: descriptions, prices, categories, attributes and every variation's stock.",
    method: "GET",
    routeParams: ["id"],
    route: (p) => `woo/products/${p.id}`,
    fields: [{ name: "id", label: "Product ID", type: "number", required: true }],
  },
  {
    id: "woo.create-product",
    domain: "woo",
    label: "Create product",
    description: "Create a simple WooCommerce product.",
    method: "POST",
    route: () => "woo/products",
    fields: [
      { name: "name", label: "Product name", required: true },
      { name: "sku", label: "SKU" },
      { name: "regular_price", label: "Regular price", placeholder: "19.99" },
      { name: "status", label: "Status", type: "select", options: STATUS_OPTIONS, default: "draft" },
      { name: "description", label: "Description", type: "textarea" },
    ],
  },
  {
    id: "woo.update-product",
    domain: "woo",
    label: "Update product",
    description: "Change a product's name, price, status or stock state.",
    method: "POST",
    routeParams: ["id"],
    route: (p) => `woo/products/${p.id}`,
    fields: [
      { name: "id", label: "Product ID", type: "number", required: true },
      { name: "name", label: "Product name" },
      { name: "regular_price", label: "Regular price", placeholder: "19.99" },
      { name: "status", label: "Status", type: "select", options: STATUS_OPTIONS },
      {
        name: "stock_status",
        label: "Stock",
        type: "select",
        options: [
          { value: "instock", label: "In stock" },
          { value: "outofstock", label: "Out of stock" },
          { value: "onbackorder", label: "On backorder" },
        ],
      },
    ],
  },
  {
    id: "woo.list-orders",
    domain: "woo",
    label: "List orders",
    description: "Read orders newest first with totals, status and customer. Filter by status, customer or creation date.",
    method: "GET",
    routeParams: ["page", "per_page", "status", "customer_id", "after"],
    route: (p) => `woo/orders${queryString(p)}`,
    fields: [
      { name: "page", label: "Page", type: "number", default: "1" },
      { name: "per_page", label: "Per page", type: "number", default: "20", hint: "1–100" },
      {
        name: "status",
        label: "Statuses",
        placeholder: "processing,completed",
        hint: "Comma-separated. Empty returns every status; the store drops statuses it does not define.",
      },
      { name: "customer_id", label: "Customer ID", type: "number", hint: "Only this customer's orders." },
      { name: "after", label: "Created on or after", placeholder: "2026-01-01", hint: "A date or ISO timestamp." },
    ],
  },
  {
    id: "woo.get-order",
    domain: "woo",
    label: "Order detail",
    description: "Read one order: line items, totals, shipping, tax, customer note and payment method title.",
    method: "GET",
    routeParams: ["id"],
    route: (p) => `woo/orders/${p.id}`,
    fields: [{ name: "id", label: "Order ID", type: "number", required: true }],
  },
  {
    id: "woo.order-status",
    domain: "woo",
    label: "Change order status",
    description: "Move an order to a new status. This fires the store's status hooks — emails, stock, gateway actions.",
    method: "POST",
    routeParams: ["id"],
    route: (p) => `woo/orders/${p.id}/status`,
    destructive: true,
    fields: [
      { name: "id", label: "Order ID", type: "number", required: true },
      { name: "status", label: "New status", required: true, placeholder: "completed", hint: "processing, completed, refunded… the site validates it." },
      { name: "note", label: "Order note", type: "textarea", hint: "Recorded alongside the change." },
    ],
  },
  {
    id: "woo.list-customers",
    domain: "woo",
    label: "List customers",
    description: "Read customer accounts newest first with order count and lifetime spend. Search by name or email.",
    method: "GET",
    routeParams: ["page", "per_page", "search"],
    route: (p) => `woo/customers${queryString(p)}`,
    fields: [
      { name: "page", label: "Page", type: "number", default: "1" },
      { name: "per_page", label: "Per page", type: "number", default: "20", hint: "1–100" },
      { name: "search", label: "Search", placeholder: "name or email" },
    ],
  },
  {
    id: "woo.get-customer",
    domain: "woo",
    label: "Customer detail",
    description: "Read one customer: order count, lifetime spend, billing/shipping country and last order date.",
    method: "GET",
    routeParams: ["id"],
    route: (p) => `woo/customers/${p.id}`,
    fields: [{ name: "id", label: "Customer ID", type: "number", required: true }],
  },
  {
    id: "woo.inventory",
    domain: "woo",
    label: "Inventory status",
    description: "Read stock health: out-of-stock products and everything at or below the low-stock threshold.",
    method: "GET",
    routeParams: ["low_stock_threshold", "limit"],
    route: (p) => `woo/inventory${queryString(p)}`,
    fields: [
      { name: "low_stock_threshold", label: "Low stock threshold", type: "number", hint: "Defaults to the store's own low-stock amount." },
      { name: "limit", label: "Max rows", type: "number", default: "50", hint: "1–100" },
    ],
  },
  {
    id: "woo.sales-summary",
    domain: "woo",
    label: "Sales summary",
    description: "Read revenue, order count, average order value and top products for a period (processing, completed and on-hold orders).",
    method: "GET",
    routeParams: ["days"],
    route: (p) => `woo/sales-summary${queryString(p)}`,
    fields: [{ name: "days", label: "Days back", type: "number", default: "30", hint: "1–365" }],
  },
];

/** What the browser gets: no route functions, no server-only fields. */
export function catalogForClient(): Array<Omit<ActionDef, "route" | "routeParams" | "bodyFor">> {
  return ACTIONS.map(({ route: _route, routeParams: _routeParams, bodyFor: _bodyFor, ...rest }) => rest);
}

const MAX_STRING = 100_000;
const MAX_BODY = 512_000;

export interface PreparedAction {
  def: ActionDef;
  route: string;
  body: Record<string, unknown> | undefined;
}

export type PrepareResult =
  | { ok: true; prepared: PreparedAction }
  | { ok: false; status: number; error: string; message: string };

function bad(status: number, error: string, message: string): PrepareResult {
  return { ok: false, status, error, message };
}

/**
 * Read one form's declared fields out of raw input. Shared by site actions and
 * agents so a missing or malformed value is refused the same way everywhere.
 */
export type FieldValues =
  | { ok: true; values: Record<string, string> }
  | { ok: false; status: number; error: string; message: string };

export function collectFields(fields: FormField[], raw: unknown): FieldValues {
  if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) {
    return { ok: false, status: 400, error: "invalid_params", message: "Parameters must be an object." };
  }
  const input = (raw ?? {}) as Record<string, unknown>;
  const values: Record<string, string> = {};
  for (const field of fields) {
    const rawValue = input[field.name];
    const value = rawValue === undefined || rawValue === null ? "" : String(rawValue).trim();
    if (value === "") {
      if (field.required) return { ok: false, status: 400, error: "missing_param", message: `${field.label} is required.` };
      continue;
    }
    if (value.length > MAX_STRING) return { ok: false, status: 400, error: "param_too_long", message: `${field.label} is too long.` };
    if (field.type === "number") {
      if (!/^\d+$/.test(value) || Number(value) < 1) {
        return { ok: false, status: 400, error: "invalid_param", message: `${field.label} must be a positive whole number.` };
      }
    }
    if (field.type === "select" && field.options && !field.options.some((o) => o.value === value)) {
      return { ok: false, status: 400, error: "invalid_param", message: `${field.label} must be one of: ${field.options.map((o) => o.value).join(", ")}.` };
    }
    values[field.name] = value;
  }
  return { ok: true, values };
}

/**
 * Turn raw form input into one signed call: whitelist the declared fields only,
 * reject missing required values and out-of-range numbers, and keep route
 * parameters out of the body (the plugin reads them from the route).
 */
export function prepareAction(actionId: string, raw: unknown): PrepareResult {
  const def = ACTIONS.find((a) => a.id === actionId);
  if (!def) return bad(400, "unknown_action", "That action is not in the catalog.");
  const collected = collectFields(def.fields, raw);
  if (!collected.ok) return bad(collected.status, collected.error, collected.message);
  const params = collected.values;
  const body: Record<string, unknown> = {};
  const routeParams = new Set(def.routeParams ?? []);
  if (def.bodyFor) {
    Object.assign(body, def.bodyFor(params));
  } else {
    for (const [name, value] of Object.entries(params)) {
      if (!routeParams.has(name)) body[name] = value;
    }
  }
  if (def.method === "GET" && Object.keys(body).length > 0) {
    return bad(400, "invalid_params", `${def.label} takes its values in the URL, not the body.`);
  }
  if (JSON.stringify(body).length > MAX_BODY) return bad(413, "payload_too_large", "The request is too large.");
  return { ok: true, prepared: { def, route: def.route(params), body: def.method === "GET" ? undefined : body } };
}

export interface ActionRunRow {
  id: string;
  site_id: string;
  action: string;
  status: "ok" | "queued" | "error";
  duration_ms: number;
  error: string;
  created_at: string;
}

export type ActionOutcome =
  | { ok: true; status: "ok" | "queued"; data: unknown; run_id: string; duration_ms: number }
  | { ok: false; status: number; error: string; message: string; run_id: string | null; duration_ms: number };

export interface ActionEnv {
  DB: D1Database;
  SECRET_ENCRYPTION_KEY?: string;
}

/** The plugin's approval gate answers 200 with a pending_approval payload. */
function isQueued(data: unknown): boolean {
  return Boolean(data) && typeof data === "object" && (data as { status?: unknown }).status === "pending_approval";
}

/**
 * Run one catalog action against one site the caller's org owns.
 *
 * Nothing is logged until the call has been attempted: a rejected parameter or
 * a site the caller cannot see is never a "run". Once signed and sent, the
 * outcome — success, site refusal, queueing, transport failure — is written to
 * action_runs, because the log is the only proof of what the dashboard did.
 */
export async function runAction(
  env: ActionEnv,
  user: { id: string; email: string },
  input: { site_id?: unknown; action?: unknown; params?: unknown },
  fetchImpl: Fetch = fetch
): Promise<ActionOutcome> {
  const siteId = String(input.site_id ?? "").trim();
  if (!siteId) return { ok: false, status: 400, error: "missing_site", message: "Choose a site.", run_id: null, duration_ms: 0 };
  const actionId = String(input.action ?? "").trim();
  const prepared = prepareAction(actionId, input.params);
  if (!prepared.ok) {
    return { ok: false, status: prepared.status, error: prepared.error, message: prepared.message, run_id: null, duration_ms: 0 };
  }
  const { def, route, body } = prepared.prepared;

  const site = await env.DB.prepare("SELECT id, org_id, url, key_id, secret_enc FROM sites WHERE id = ?")
    .bind(siteId)
    .first<{ id: string; org_id: string; url: string; key_id: string; secret_enc: string }>();
  if (!site) return { ok: false, status: 404, error: "site_not_found", message: "Site not found.", run_id: null, duration_ms: 0 };
  await requireOrgMember(env.DB, user.id, site.org_id);
  if (!env.SECRET_ENCRYPTION_KEY) {
    return { ok: false, status: 503, error: "not_configured", message: "SECRET_ENCRYPTION_KEY is not set on this deployment.", run_id: null, duration_ms: 0 };
  }

  let secret: string;
  try {
    secret = await decryptSecret(site.secret_enc, env.SECRET_ENCRYPTION_KEY);
  } catch {
    return { ok: false, status: 503, error: "site_key_unreadable", message: "The stored site key could not be decrypted. Reconnect the site.", run_id: null, duration_ms: 0 };
  }

  const started = Date.now();
  let status: "ok" | "queued" | "error" = "error";
  let errorMessage = "";
  let data: unknown = null;
  let httpStatus = 502;
  try {
    const result = await callSite(site.url, site.key_id, secret, def.method, route, body, fetchImpl);
    data = result.data;
    if (result.ok) {
      status = isQueued(result.data) ? "queued" : "ok";
      httpStatus = 200;
    } else {
      errorMessage = result.error?.message ?? "The site refused the request.";
      httpStatus = result.status >= 400 && result.status < 600 ? result.status : 502;
    }
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : "The site call failed.";
    httpStatus = e instanceof SiteCallError ? e.status : 502;
  }
  const durationMs = Date.now() - started;

  const runId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO action_runs (id, user_id, site_id, action, status, duration_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(runId, user.id, site.id, def.id, status, durationMs, errorMessage)
    .run();

  if (status !== "error") {
    await env.DB.prepare("UPDATE sites SET last_seen = ? WHERE id = ?").bind(new Date().toISOString(), site.id).run();
  }
  await audit(env.DB, user.email, `action.${def.id}`, new URL(site.url).hostname, status);

  if (status === "error") {
    return { ok: false, status: httpStatus, error: "action_failed", message: errorMessage || "The site refused the request.", run_id: runId, duration_ms: durationMs };
  }
  return { ok: true, status, data, run_id: runId, duration_ms: durationMs };
}

/** Recent runs for this person, newest first. Never another member's runs. */
export async function listActionRuns(
  db: D1Database,
  userId: string,
  opts: { siteId?: string; limit?: number } = {}
): Promise<ActionRunRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const siteId = (opts.siteId ?? "").trim();
  const sql = siteId
    ? "SELECT id, site_id, action, status, duration_ms, error, created_at FROM action_runs WHERE user_id = ? AND site_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?"
    : "SELECT id, site_id, action, status, duration_ms, error, created_at FROM action_runs WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?";
  const stmt = db.prepare(sql);
  const bound = siteId ? stmt.bind(userId, siteId, limit) : stmt.bind(userId, limit);
  const { results } = await bound.all<ActionRunRow>();
  return results ?? [];
}
