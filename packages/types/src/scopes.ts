/**
 * The Bridgistic scope vocabulary, mirrored from the free WordPress plugin
 * (`includes/security/class-scopes.php`) and classified into risk tiers.
 *
 * The plugin owns the *names*; this file owns the *classification*, because
 * the platform is what decides which plan may hold which class and what has
 * to be approval-gated. Keep SCOPES in sync with the plugin — `packages/tools`
 * has a test that fails if a tool references a scope that is not listed here.
 */

/**
 * Ordered least to most dangerous. The order is meaningful: `atLeastAsRisky`
 * relies on it, and a plan that holds a class holds every class before it.
 */
export const SCOPE_CLASSES = [
  "safe_read",
  "sensitive_read",
  "content_write",
  "operational",
  "destructive",
  "credential",
  "code_execution",
] as const;
export type ScopeClass = (typeof SCOPE_CLASSES)[number];

const CLASS_RANK = new Map<ScopeClass, number>(SCOPE_CLASSES.map((c, i) => [c, i]));

/** True when `a` is at least as dangerous as `b`. */
export function atLeastAsRisky(a: ScopeClass, b: ScopeClass): boolean {
  return (CLASS_RANK.get(a) ?? 0) >= (CLASS_RANK.get(b) ?? 0);
}

export interface ScopeDefinition {
  /** Wire name, e.g. `posts:write`. Must match the plugin exactly. */
  readonly scope: string;
  readonly class: ScopeClass;
  readonly description: string;
}

/**
 * Every scope the plugin can mint, with its risk class.
 *
 * Classification (SECURITY_MODEL.md §3):
 *   safe_read       — scope + grant. Public-facing or structural data.
 *   sensitive_read  — scope + grant + PAID PLAN. Credentials, PII, raw SQL,
 *                     arbitrary file reads. Not on Free.
 *   content_write   — scope + grant + audit.
 *   operational     — snapshot first.
 *   destructive     — approval + snapshot + step-up auth, EVERY time.
 *   credential      — owner/admin + step-up. Never a machine token.
 *   code_execution  — approval + snapshot + step-up + per-site opt-in.
 *
 * BR-002: `fs:read`, `db:read`, `users:read`, `options:read` and the
 * WooCommerce order/customer reads were all in one flat `read` class, and the
 * Free plan held that whole class. `fs:read` reads inside ABSPATH, which is
 * where `wp-config.php` lives — the database credentials and the eight auth
 * salts. A free signup could read a connected site's credentials and its
 * customer list.
 *
 * Read is not automatically safe. Splitting the class is the fix; the Free
 * plan now holds `safe_read` only.
 */
export const SCOPES: readonly ScopeDefinition[] = [
  // -- safe_read: structural or already-public information -------------------
  { scope: "site:read", class: "safe_read", description: "Read site metadata, plugins, theme, health" },
  { scope: "posts:read", class: "safe_read", description: "Read posts, pages, custom post types" },
  { scope: "memory:read", class: "safe_read", description: "Read per-site memory notes" },
  { scope: "woo:products:read", class: "safe_read", description: "WooCommerce: read products, variations, stock" },
  { scope: "woo:analytics:read", class: "safe_read", description: "WooCommerce: read sales and inventory summaries" },

  // -- sensitive_read: credentials, PII, or an unbounded read primitive ------
  // Every one of these is an exfiltration path. None are on the Free plan.
  { scope: "users:read", class: "sensitive_read", description: "Read user accounts — PII (no passwords)" },
  { scope: "options:read", class: "sensitive_read", description: "Read wp_options (allowlist enforced) — may hold third-party API keys" },
  { scope: "db:read", class: "sensitive_read", description: "Run read-only SQL (SELECT / SHOW / EXPLAIN) — unbounded read of every table" },
  { scope: "fs:read", class: "sensitive_read", description: "Read files inside ABSPATH — includes wp-config.php: DB credentials and auth salts" },
  { scope: "woo:orders:read", class: "sensitive_read", description: "WooCommerce: read orders and line items — customer PII" },
  { scope: "woo:customers:read", class: "sensitive_read", description: "WooCommerce: read customers — customer PII (no payment data)" },

  // -- content_write ---------------------------------------------------------
  { scope: "posts:write", class: "content_write", description: "Create / update / delete content" },
  { scope: "media:write", class: "content_write", description: "Upload and manage media" },
  { scope: "memory:write", class: "content_write", description: "Write per-site memory notes" },
  { scope: "woo:products:write", class: "content_write", description: "WooCommerce: create / update products and stock" },

  // -- operational -----------------------------------------------------------
  { scope: "options:write", class: "operational", description: "Write wp_options (allowlist enforced)" },
  { scope: "schedule:manage", class: "operational", description: "Schedule playbooks to run unattended" },
  { scope: "playbook:manage", class: "operational", description: "Save / run reusable playbooks" },
  { scope: "snapshot:manage", class: "operational", description: "Create / restore DB + file snapshots — restore and delete are gated separately, see snapshotOperationClass" },
  { scope: "woo:orders:write", class: "operational", description: "WooCommerce: change order status" },

  // -- destructive -----------------------------------------------------------
  { scope: "db:write", class: "destructive", description: "Run write SQL (snapshot taken first)" },
  { scope: "plugins:manage", class: "destructive", description: "Activate / deactivate plugins" },

  // -- credential ------------------------------------------------------------
  // Creating or changing a WordPress user is how an attacker persists after
  // losing the original access, so it sits with credential operations rather
  // than with the operational writes it superficially resembles.
  { scope: "users:write", class: "credential", description: "Create / update users and roles — a persistence primitive" },

  // -- code_execution --------------------------------------------------------
  { scope: "fs:write", class: "code_execution", description: "Write non-PHP files; PHP only inside sandbox" },
  { scope: "php:execute", class: "code_execution", description: "Execute arbitrary PHP (highest privilege)" },
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

/** Classes that need human approval before the call reaches the site. */
const APPROVAL_CLASSES = new Set<ScopeClass>(["destructive", "credential", "code_execution"]);

/** Classes that take a snapshot first, so the change has a way back. */
const SNAPSHOT_CLASSES = new Set<ScopeClass>([
  "operational",
  "destructive",
  "credential",
  "code_execution",
]);

/** Classes that require re-authentication at the moment of the call. */
const STEP_UP_CLASSES = new Set<ScopeClass>(["destructive", "credential", "code_execution"]);

/** Classes a machine token (API key, service account) may never hold. */
const HUMAN_ONLY_CLASSES = new Set<ScopeClass>(["credential"]);

/**
 * Approval is required on every call, on every plan. INVARIANT 3: there is no
 * tier that turns this off, and no per-customer setting either. A gate a
 * customer can disable is a gate an attacker with the customer's session can
 * disable.
 */
export function requiresApproval(scope: string): boolean {
  const cls = scopeClass(scope);
  return cls !== undefined && APPROVAL_CLASSES.has(cls);
}

/** Snapshot first (INVARIANT 4), so every gated change has a way back. */
export function requiresSnapshot(scope: string): boolean {
  const cls = scopeClass(scope);
  return cls !== undefined && SNAPSHOT_CLASSES.has(cls);
}

/** Re-authenticate at the moment of the call, not at the start of the session. */
export function requiresStepUp(scope: string): boolean {
  const cls = scopeClass(scope);
  return cls !== undefined && STEP_UP_CLASSES.has(cls);
}

/**
 * A machine token cannot answer a step-up challenge, so it must not hold a
 * scope whose gate depends on one. An unattended API key that can create a
 * WordPress administrator is a backdoor with a support ticket attached.
 */
export function allowedForMachineToken(scope: string): boolean {
  const cls = scopeClass(scope);
  return cls !== undefined && !HUMAN_ONLY_CLASSES.has(cls);
}

/**
 * How a change made under this scope is undone.
 *
 * Every mutating scope must have an answer. "None" is not one — a change with
 * no way back is a change nobody should be able to make through an API.
 *
 * A full snapshot is not always the right answer, and insisting on one would
 * be worse than useless: snapshotting the database before every post edit
 * makes ordinary content work so slow that people turn the whole product off.
 * Content writes are reversible per object instead — WordPress already keeps
 * post revisions, and the platform records the prior state so the previous
 * version can be restored without touching the rest of the site.
 *
 * The requirement is a rollback path, not a particular implementation of one.
 */
export type RollbackMechanism =
  /** Nothing changed; nothing to undo. */
  | "none_needed"
  /** Per-object revision or prior-state restore. Cheap, narrow. */
  | "object_revision"
  /** Full DB + files snapshot taken before the call. Expensive, total. */
  | "snapshot";

const ROLLBACK: Readonly<Record<ScopeClass, RollbackMechanism>> = {
  safe_read: "none_needed",
  sensitive_read: "none_needed",
  content_write: "object_revision",
  operational: "snapshot",
  destructive: "snapshot",
  credential: "snapshot",
  code_execution: "snapshot",
};

export function rollbackMechanism(scope: string): RollbackMechanism | undefined {
  const cls = scopeClass(scope);
  return cls === undefined ? undefined : ROLLBACK[cls];
}

/** True when the scope changes the site at all, by any mechanism. */
export function isMutating(scope: string): boolean {
  const mechanism = rollbackMechanism(scope);
  return mechanism !== undefined && mechanism !== "none_needed";
}

/**
 * `snapshot:manage` is three different risks wearing one scope name, so the
 * operation decides the gate rather than the scope.
 *
 * SECURITY_MODEL.md §4:
 *   create  — operational. Costs storage; cannot destroy anything.
 *   restore — destructive. Silently discards every change since the snapshot.
 *   delete  — destructive. Removes the rollback path other gates depend on.
 *
 * Treating all three as `operational` because they share a scope would mean a
 * restore — which throws away a week of a customer's work — is waved through
 * on the same gate as taking a backup.
 */
export type SnapshotOperation = "create" | "restore" | "delete";

export function snapshotOperationClass(operation: SnapshotOperation): ScopeClass {
  return operation === "create" ? "operational" : "destructive";
}

/** The four terms of the intersection. Named, because an argument list of four string arrays is unreadable at the call site and dangerous to reorder. */
export interface ScopeTerms {
  /** What the operation needs. Never what the caller asked for. */
  readonly requested: readonly string[];
  /** What the plan entitles. */
  readonly planEntitled: readonly string[];
  /** What the organization granted on this site. Policy; ours; revocable. */
  readonly siteGranted: readonly string[];
  /**
   * What the WordPress plugin baked into the signed key when it was minted —
   * the ceiling the site itself enforces.
   *
   * BR-010. Omitting this term does not fail safe: it authorises calls the
   * plugin will reject, which is a confusing failure for the customer and a
   * metering error for us. Optional only so a caller who genuinely has no key
   * yet (an unconnected site) does not have to invent one; when it is absent
   * the ceiling is treated as unbounded, and every code path that has a key
   * must pass it.
   */
  readonly keyCeiling?: readonly string[];
}

/**
 * INVARIANT 2 — the effective scope of a call, computed server-side, every
 * time.
 *
 *     effective = requested ∩ plan ∩ site grant ∩ key ceiling
 *
 * Unknown scopes are dropped rather than passed through, so a client cannot
 * invent a name a future plugin version might honour. Intersection only: no
 * term can widen another, which is why this takes sets and not rules.
 */
export function effectiveScopes(terms: ScopeTerms): string[] {
  const plan = new Set(terms.planEntitled);
  const site = new Set(terms.siteGranted);
  const key = terms.keyCeiling === undefined ? null : new Set(terms.keyCeiling);
  return [...new Set(terms.requested)]
    .filter((s) => isKnownScope(s) && plan.has(s) && site.has(s) && (key === null || key.has(s)))
    .sort();
}
