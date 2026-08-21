/**
 * Tenant-scoped data access.
 *
 * `SECURITY_MODEL.md` §7: every query is scoped by organization, server-side,
 * and the resource is loaded *filtered by* that organization — never loaded and
 * then checked. Loading-then-checking leaks existence through timing and error
 * shape, and it is one forgotten `if` away from a cross-tenant read.
 *
 * The design goal here is that the safe thing is the only thing available. You
 * cannot ask this module for "the site with id X". You can only ask an
 * `OrgScope` for it, an `OrgScope` can only be built from a resolved caller,
 * and every statement it issues carries `organization_id = ?` in the SQL
 * itself. There is no code path that reaches a row without the filter, because
 * there is no function that accepts an id without a scope.
 *
 * That is a stronger guarantee than a review checklist, and it costs one
 * indirection.
 */

import type { Role } from "@bridgistic/identity";

/**
 * The subset of D1 this module uses.
 *
 * Declared structurally rather than importing `D1Database` so the same code
 * runs against `node:sqlite` in tests. A tenant-isolation test that cannot run
 * against a real database is a test of the mock.
 */
export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
}

export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  /**
   * Returns how many rows the write changed.
   *
   * D1 reports it as `meta.changes`, node:sqlite as `changes`. Both are
   * accepted because this is the ONLY race-free way to know whether an
   * `INSERT … ON CONFLICT DO NOTHING` actually inserted — and therefore
   * whether this caller owns the row it was competing for.
   */
  run(): Promise<{ changes?: number; meta?: { changes?: number } }>;
}

/** A caller, resolved from a token. Never from a request body. */
export interface Caller {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: Role;
  readonly isMachineToken: boolean;
  /** Present for an API key restricted to one site. */
  readonly restrictedToSiteId?: string;
}

export interface SiteRow {
  readonly id: string;
  readonly organization_id: string;
  readonly site_url: string;
  readonly label: string | null;
  readonly key_scopes: string;
  readonly health: string;
  readonly plugin_version: string | null;
  readonly created_at: number;
  readonly last_seen_at: number | null;
}

export interface MembershipRow {
  readonly organization_id: string;
  readonly user_id: string;
  readonly role: string;
  readonly created_at: number;
}

/**
 * A handle that can only see one organization's data.
 *
 * Construct it from a resolved caller and nothing else — `forCaller` is the
 * only constructor, and it takes the org id from the caller rather than as a
 * separate argument, so the two cannot disagree.
 */
export class OrgScope {
  readonly #db: SqlDatabase;
  readonly organizationId: string;
  readonly caller: Caller;

  private constructor(db: SqlDatabase, caller: Caller) {
    this.#db = db;
    this.organizationId = caller.organizationId;
    this.caller = caller;
  }

  static forCaller(db: SqlDatabase, caller: Caller): OrgScope {
    return new OrgScope(db, caller);
  }

  // ------------------------------------------------------------------ sites --

  async listSites(): Promise<SiteRow[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT id, organization_id, site_url, label, key_scopes, health, plugin_version, created_at, last_seen_at
           FROM sites
          WHERE organization_id = ?
          ORDER BY created_at`
      )
      .bind(this.organizationId)
      .all<SiteRow>();

    // An API key restricted to one site sees one site. The restriction is
    // applied here rather than at each call site, because "each call site" is
    // where it gets forgotten.
    return this.caller.restrictedToSiteId === undefined
      ? results
      : results.filter((site) => site.id === this.caller.restrictedToSiteId);
  }

  /**
   * One site, or undefined.
   *
   * Undefined covers both "does not exist" and "belongs to another
   * organization", deliberately and identically — the caller cannot tell them
   * apart, which is the point. A route that turned one into 404 and the other
   * into 403 would be an existence oracle for every site id on the platform.
   */
  async site(siteId: string): Promise<SiteRow | undefined> {
    if (this.caller.restrictedToSiteId !== undefined && this.caller.restrictedToSiteId !== siteId) {
      return undefined;
    }
    const row = await this.#db
      .prepare(
        `SELECT id, organization_id, site_url, label, key_scopes, health, plugin_version, created_at, last_seen_at
           FROM sites
          WHERE id = ? AND organization_id = ?`
      )
      .bind(siteId, this.organizationId)
      .first<SiteRow>();
    return row ?? undefined;
  }

  async siteCount(): Promise<number> {
    const row = await this.#db
      .prepare(`SELECT COUNT(*) AS n FROM sites WHERE organization_id = ?`)
      .bind(this.organizationId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /**
   * The scopes granted on a site, intersected with the key's ceiling.
   *
   * Reads the `site_effective_scopes` view from migration 0006, so the
   * intersection is computed in one place rather than reassembled by every
   * caller — BR-010.
   */
  async siteScopes(siteId: string): Promise<string[]> {
    // Ownership first. Without this the view would happily return another
    // organization's grants for a guessed id.
    const owned = await this.site(siteId);
    if (!owned) return [];

    const { results } = await this.#db
      .prepare(`SELECT scope FROM site_effective_scopes WHERE site_id = ? ORDER BY scope`)
      .bind(siteId)
      .all<{ scope: string }>();
    return results.map((row) => row.scope);
  }

  /** The scopes the plugin baked into this site's key. The ceiling. */
  async siteKeyScopes(siteId: string): Promise<string[]> {
    const site = await this.site(siteId);
    if (!site) return [];
    try {
      const parsed: unknown = JSON.parse(site.key_scopes);
      return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
    } catch {
      // A malformed value means no ceiling can be established, and no ceiling
      // must mean nothing is authorised — not "unbounded".
      return [];
    }
  }

  // ------------------------------------------------------------- membership --

  async members(): Promise<MembershipRow[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT organization_id, user_id, role, created_at
           FROM memberships
          WHERE organization_id = ?
          ORDER BY created_at`
      )
      .bind(this.organizationId)
      .all<MembershipRow>();
    return results;
  }

  async ownerCount(): Promise<number> {
    const row = await this.#db
      .prepare(`SELECT COUNT(*) AS n FROM memberships WHERE organization_id = ? AND role = 'owner'`)
      .bind(this.organizationId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  // ---------------------------------------------------------- subscription --

  async plan(): Promise<string> {
    const row = await this.#db
      .prepare(
        `SELECT plan FROM subscriptions
          WHERE organization_id = ?
            AND status IN ('active','trialing','past_due')
          ORDER BY created_at DESC
          LIMIT 1`
      )
      .bind(this.organizationId)
      .first<{ plan: string }>();

    // Every organization gets a Free subscription at creation, so a missing row
    // is a data problem rather than a normal state. Falling back to `free`
    // fails safe: the narrowest plan, never the widest.
    return row?.plan ?? "free";
  }
}

/**
 * The memberships a user holds, across organizations.
 *
 * The one query that is legitimately not organization-scoped, because
 * answering "which organizations am I in?" is precisely the question that
 * establishes the scope. It takes a user id and returns only that user's rows.
 */
export async function membershipsForUser(
  db: SqlDatabase,
  userId: string
): Promise<{ organizationId: string; role: string; name: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT m.organization_id AS organizationId, m.role AS role, o.name AS name
         FROM memberships m
         JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = ?
        ORDER BY o.name`
    )
    .bind(userId)
    .all<{ organizationId: string; role: string; name: string }>();
  return results;
}
