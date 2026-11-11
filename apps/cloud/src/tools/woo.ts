import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SiteRegistry } from "../types.js";
import { callBridge } from "../services/wp-client.js";
import { siteParam, guardParams, withGuard, run, present } from "./helpers.js";

/**
 * WooCommerce store operations.
 *
 * These exist so an agent never has to reach for `bridgistic_db_query` or
 * `bridgistic_execute_php` to answer an ordinary store question. That matters
 * for two reasons: those two tools need the broadest scopes the bridge has,
 * and raw SQL against Woo is a correctness trap — orders live in wp_posts on
 * some installs and in dedicated HPOS tables on others, so a query that works
 * on one store silently returns nothing on the next. Everything here goes
 * through WooCommerce's own API on the WordPress side, which is storage-agnostic.
 *
 * Annotations are set from what the WordPress route actually does, not from
 * what reads well: `bridgistic_woo_update_order_status` is marked destructive
 * because a status change fires customer emails, stock movements, and gateway
 * actions that setting the status back does not undo.
 */

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** Creates a new record: mutating, but there is no prior state to destroy. */
const CREATE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/** Overwrites or triggers side effects that are not undone by reverting the field. */
const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/** Build a query string from defined values only. */
function query(params: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") qs.set(key, String(value));
  }
  const encoded = qs.toString();
  return encoded ? `?${encoded}` : "";
}

export function registerWooTools(server: McpServer, registry: SiteRegistry): void {
  // ---- products.list ------------------------------------------------------
  server.registerTool(
    "bridgistic_woo_list_products",
    {
      title: "List WooCommerce products",
      description:
        "List store products with pagination. Scope: `woo:products:read`. Args: search, status (draft|publish|...), stock_status (instock|outofstock|onbackorder), category (slug), per_page (≤100), page. Returns id/name/sku/type/status/price/stock per product plus total and has_more. Use this instead of SQL or PHP for any product question — it works the same whether or not the store uses High-Performance Order Storage.",
      inputSchema: {
        site: siteParam,
        search: z.string().optional(),
        status: z.string().optional(),
        stock_status: z.enum(["instock", "outofstock", "onbackorder"]).optional(),
        category: z.string().optional().describe("Product category slug."),
        per_page: z.number().int().min(1).max(100).optional(),
        page: z.number().int().min(1).optional(),
      },
      annotations: READ,
    },
    async ({ site, ...params }) =>
      run(async () => present(await callBridge(registry.resolve(site), "GET", `woo/products${query(params)}`)))
  );

  // ---- products.get -------------------------------------------------------
  server.registerTool(
    "bridgistic_woo_get_product",
    {
      title: "Get one WooCommerce product",
      description:
        "Fetch a single product by id, including description, categories, tags, attributes, and every variation's own price and stock. Scope: `woo:products:read`. For a variable product, the variation list is usually the real answer to \"is this in stock?\".",
      inputSchema: { site: siteParam, id: z.number().int().positive() },
      annotations: READ,
    },
    async ({ site, id }) =>
      run(async () => present(await callBridge(registry.resolve(site), "GET", `woo/products/${id}`)))
  );

  // ---- products.create ----------------------------------------------------
  server.registerTool(
    "bridgistic_woo_create_product",
    {
      title: "Create a WooCommerce product",
      description:
        "Create a simple product. Scope: `woo:products:write`. `name` is required; prices must be non-negative numbers. Supports dry_run to preview the fields that would be set, and the approval queue when the key requires it. Publishes only if you pass status='publish' — the store's own default applies otherwise.",
      inputSchema: {
        site: siteParam,
        name: z.string().min(1).describe("Product name. Required."),
        sku: z.string().optional(),
        description: z.string().optional(),
        short_description: z.string().optional(),
        status: z.enum(["draft", "pending", "private", "publish"]).optional(),
        regular_price: z.string().optional().describe('Decimal string, e.g. "19.99".'),
        sale_price: z.string().optional(),
        manage_stock: z.boolean().optional(),
        stock_quantity: z.number().int().optional(),
        stock_status: z.enum(["instock", "outofstock", "onbackorder"]).optional(),
        ...guardParams,
      },
      annotations: CREATE,
    },
    async ({ site, dry_run, approval_id, force, ...fields }) =>
      run(async () =>
        present(
          await callBridge(registry.resolve(site), "POST", "woo/products", withGuard({ ...fields }, { dry_run, approval_id, force }))
        )
      )
  );

  // ---- products.update ----------------------------------------------------
  server.registerTool(
    "bridgistic_woo_update_product",
    {
      title: "Update a WooCommerce product",
      description:
        "Update an existing product. Scope: `woo:products:write`. Only the fields you pass are changed. Overwrites prior values, so the bridge snapshots the product first and dry_run returns an explicit before/after for exactly the fields supplied.",
      inputSchema: {
        site: siteParam,
        id: z.number().int().positive(),
        name: z.string().optional(),
        sku: z.string().optional(),
        description: z.string().optional(),
        short_description: z.string().optional(),
        status: z.enum(["draft", "pending", "private", "publish"]).optional(),
        regular_price: z.string().optional(),
        sale_price: z.string().optional(),
        manage_stock: z.boolean().optional(),
        stock_quantity: z.number().int().optional(),
        stock_status: z.enum(["instock", "outofstock", "onbackorder"]).optional(),
        ...guardParams,
      },
      annotations: DESTRUCTIVE,
    },
    async ({ site, id, dry_run, approval_id, force, ...fields }) =>
      run(async () =>
        present(
          await callBridge(registry.resolve(site), "POST", `woo/products/${id}`, withGuard({ ...fields }, { dry_run, approval_id, force }))
        )
      )
  );

  // ---- orders.list --------------------------------------------------------
  server.registerTool(
    "bridgistic_woo_list_orders",
    {
      title: "List WooCommerce orders",
      description:
        "List orders newest-first. Scope: `woo:orders:read`. Args: status (comma-separated, e.g. 'processing,completed'), customer_id, after (Y-m-d or ISO 8601), per_page (≤100), page. Returns id/number/status/total/currency/created/customer plus billing name, email, and country. Full addresses and payment details are never returned.",
      inputSchema: {
        site: siteParam,
        status: z.string().optional().describe("Comma-separated statuses, e.g. \"processing,completed\"."),
        customer_id: z.number().int().positive().optional(),
        after: z.string().optional().describe("Only orders created on or after this date."),
        per_page: z.number().int().min(1).max(100).optional(),
        page: z.number().int().min(1).optional(),
      },
      annotations: READ,
    },
    async ({ site, ...params }) =>
      run(async () => present(await callBridge(registry.resolve(site), "GET", `woo/orders${query(params)}`)))
  );

  // ---- orders.get ---------------------------------------------------------
  server.registerTool(
    "bridgistic_woo_get_order",
    {
      title: "Get one WooCommerce order",
      description:
        "Fetch a single order by id with its line items, shipping and tax totals, customer note, and payment method name. Scope: `woo:orders:read`. Payment tokens, transaction ids, and card data are never included.",
      inputSchema: { site: siteParam, id: z.number().int().positive() },
      annotations: READ,
    },
    async ({ site, id }) =>
      run(async () => present(await callBridge(registry.resolve(site), "GET", `woo/orders/${id}`)))
  );

  // ---- orders.status ------------------------------------------------------
  server.registerTool(
    "bridgistic_woo_update_order_status",
    {
      title: "Change a WooCommerce order's status",
      description:
        "Move an order to a different status. Scope: `woo:orders:write`. The status is validated against the statuses this store actually defines, so plugin-added ones work and typos are refused with the valid list.\n\nSIDE EFFECTS: a status change fires WooCommerce hooks — customer emails, stock adjustments, and payment-gateway actions. Setting the status back afterwards does not un-send an email or un-restock an item, which is why this is marked destructive, snapshots first, and honours the approval queue. Use dry_run to see the transition before committing.",
      inputSchema: {
        site: siteParam,
        id: z.number().int().positive(),
        status: z.string().min(1).describe('Target status, e.g. "processing", "completed", "refunded". The "wc-" prefix is optional.'),
        note: z.string().optional().describe("Order note recorded alongside the change."),
        ...guardParams,
      },
      annotations: DESTRUCTIVE,
    },
    async ({ site, id, status, note, dry_run, approval_id, force }) =>
      run(async () =>
        present(
          await callBridge(
            registry.resolve(site),
            "POST",
            `woo/orders/${id}/status`,
            withGuard({ status, note }, { dry_run, approval_id, force })
          )
        )
      )
  );

  // ---- customers.list -----------------------------------------------------
  server.registerTool(
    "bridgistic_woo_list_customers",
    {
      title: "List WooCommerce customers",
      description:
        "List users with the customer role, newest-first, with their order count and lifetime spend. Scope: `woo:customers:read`. Args: search (name/email/login), per_page (≤100), page. Password hashes, session tokens, and payment methods are never returned.",
      inputSchema: {
        site: siteParam,
        search: z.string().optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        page: z.number().int().min(1).optional(),
      },
      annotations: READ,
    },
    async ({ site, ...params }) =>
      run(async () => present(await callBridge(registry.resolve(site), "GET", `woo/customers${query(params)}`)))
  );

  // ---- customers.get ------------------------------------------------------
  server.registerTool(
    "bridgistic_woo_get_customer",
    {
      title: "Get one WooCommerce customer",
      description:
        "Fetch a single customer by user id with order count, lifetime spend, billing/shipping country and city, and last order date. Scope: `woo:customers:read`. Street addresses, phone numbers, password hashes, and payment methods are not exposed.",
      inputSchema: { site: siteParam, id: z.number().int().positive() },
      annotations: READ,
    },
    async ({ site, id }) =>
      run(async () => present(await callBridge(registry.resolve(site), "GET", `woo/customers/${id}`)))
  );

  // ---- inventory ----------------------------------------------------------
  server.registerTool(
    "bridgistic_woo_inventory_status",
    {
      title: "WooCommerce inventory status",
      description:
        "Out-of-stock and low-stock products in one call, with counts. Scope: `woo:analytics:read`. `low_stock_threshold` defaults to the store's own low-stock setting. Only stock-managed products can be low, so unmanaged products are counted separately rather than reported as zero.",
      inputSchema: {
        site: siteParam,
        low_stock_threshold: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: READ,
    },
    async ({ site, ...params }) =>
      run(async () => present(await callBridge(registry.resolve(site), "GET", `woo/inventory${query(params)}`)))
  );

  // ---- sales summary ------------------------------------------------------
  server.registerTool(
    "bridgistic_woo_sales_summary",
    {
      title: "WooCommerce sales summary",
      description:
        "Revenue, order count, average order value, orders by status, and top products for the last N days (default 30, max 365). Scope: `woo:analytics:read`. Counts only processing, completed, and on-hold orders — pending, cancelled, and failed orders are excluded so the revenue figure reconciles with what the store actually took. The counted statuses are echoed back in the response.",
      inputSchema: {
        site: siteParam,
        days: z.number().int().min(1).max(365).optional(),
      },
      annotations: READ,
    },
    async ({ site, ...params }) =>
      run(async () => present(await callBridge(registry.resolve(site), "GET", `woo/sales-summary${query(params)}`)))
  );
}
