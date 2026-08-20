/**
 * The Bridgistic scope vocabulary, mirrored from the free WordPress plugin
 * (`includes/security/class-scopes.php`) and classified into risk tiers.
 *
 * The plugin owns the *names*; this file owns the *classification*, because
 * the platform is what decides which plan may hold which class and what has
 * to be approval-gated. Keep SCOPES in sync with the plugin — `packages/tools`
 * has a test that fails if a tool references a scope that is not listed here.
 */

export const SCOPE_CLASSES = ["read", "content_write", "operational", "destructive"] as const;
export type ScopeClass = (typeof SCOPE_CLASSES)[number];

export interface ScopeDefinition {
  /** Wire name, e.g. `posts:write`. Must match the plugin exactly. */
  readonly scope: string;
  readonly class: ScopeClass;
  readonly description: string;
}

/**
 * Every scope the plugin can mint, with its risk class.
 *
 * Classification rules (MASTER-PROMPT-Bridgistic-App.md §1.3):
 *   read           — free, no approval
 *   content_write  — Starter+, logged
 *   operational    — Starter+, logged, snapshot first
 *   destructive    — Agency+, approval + snapshot + step-up auth, EVERY time
 */
export const SCOPES: readonly ScopeDefinition[] = [
  { scope: "site:read", class: "read", description: "Read site metadata, plugins, theme, health" },
  { scope: "posts:read", class: "read", description: "Read posts, pages, custom post types" },
  { scope: "users:read", class: "read", description: "Read user accounts (no passwords)" },
  { scope: "options:read", class: "read", description: "Read wp_options (allowlist enforced)" },
  { scope: "db:read", class: "read", description: "Run read-only SQL (SELECT / SHOW / EXPLAIN)" },
  { scope: "fs:read", class: "read", description: "Read files inside ABSPATH" },
  { scope: "memory:read", class: "read", description: "Read per-site memory notes" },
  { scope: "woo:products:read", class: "read", description: "WooCommerce: read products, variations, stock" },
  { scope: "woo:orders:read", class: "read", description: "WooCommerce: read orders and line items" },
  { scope: "woo:customers:read", class: "read", description: "WooCommerce: read customers (no payment data)" },
  { scope: "woo:analytics:read", class: "read", description: "WooCommerce: read sales and inventory summaries" },

  { scope: "posts:write", class: "content_write", description: "Create / update / delete content" },
  { scope: "media:write", class: "content_write", description: "Upload and manage media" },
  { scope: "memory:write", class: "content_write", description: "Write per-site memory notes" },
  { scope: "woo:products:write", class: "content_write", description: "WooCommerce: create / update products and stock" },

  { scope: "users:write", class: "operational", description: "Create / update users" },
  { scope: "options:write", class: "operational", description: "Write wp_options (allowlist enforced)" },
  { scope: "schedule:manage", class: "operational", description: "Schedule playbooks to run unattended" },
  { scope: "playbook:manage", class: "operational", description: "Save / run reusable playbooks" },
  { scope: "snapshot:manage", class: "operational", description: "Create / restore DB + file snapshots" },
  { scope: "woo:orders:write", class: "operational", description: "WooCommerce: change order status" },

  { scope: "db:write", class: "destructive", description: "Run write SQL (snapshot taken first)" },
  { scope: "fs:write", class: "destructive", description: "Write non-PHP files; PHP only inside sandbox" },
  { scope: "plugins:manage", class: "destructive", description: "Activate / deactivate plugins" },
  { scope: "php:execute", class: "destructive", description: "Execute arbitrary PHP (highest privilege)" },
] as const;

export const ALL_SCOPES: readonly string[] = SCOPES.map((s) => s.scope);

const SCOPE_INDEX = new Map<string, ScopeDefinition>(SCOPES.map((s) => [s.scope, s]));

export function scopeDefinition(scope: string): ScopeDefinition | undefined {
  return SCOPE_INDEX.get(scope);
}

export function isKnownScope(scope: string): boolean {
  return SCOPE_INDEX.has(scope);
}

export function scopeClass(scope: string): ScopeClass | undefined {
  return SCOPE_INDEX.get(scope)?.class;
}

export function scopesInClass(cls: ScopeClass): readonly string[] {
  return SCOPES.filter((s) => s.class === cls).map((s) => s.scope);
}

/**
 * Destructive scopes are approval + snapshot + step-up gated on every call, on
 * every plan. INVARIANT 3: there is no tier that turns this off.
 */
export function requiresApproval(scope: string): boolean {
  return scopeClass(scope) === "destructive";
}

/** Operational and destructive work snapshots first (INVARIANT 4). */
export function requiresSnapshot(scope: string): boolean {
  const cls = scopeClass(scope);
  return cls === "operational" || cls === "destructive";
}

/**
 * INVARIANT 2 — effective scope = requested ∩ plan entitlement ∩ site grant,
 * computed server-side on every call. Unknown scopes are dropped rather than
 * passed through, so a client cannot invent a scope name the plugin might
 * later honour.
 */
export function effectiveScopes(
  requested: readonly string[],
  planEntitled: readonly string[],
  siteGranted: readonly string[]
): string[] {
  const plan = new Set(planEntitled);
  const site = new Set(siteGranted);
  return [...new Set(requested)]
    .filter((s) => isKnownScope(s) && plan.has(s) && site.has(s))
    .sort();
}
