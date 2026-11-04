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

export interface OrganizationRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly wpistic_org_id: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface SubscriptionRow {
  readonly id: string;
  readonly plan: string;
  readonly billing_interval: string;
  readonly status: string;
  readonly api_addon: number;
  readonly trial_ends_at: number | null;
  readonly current_period_start: number;
  readonly current_period_end: number;
}

/** Safe audit fields. Arguments never leave the executor into this row. */
export interface ActionRow {
  readonly id: string;
  readonly site_id: string | null;
  readonly actor_type: string;
  readonly actor_id: string;
  readonly tool: string;
  readonly scope_used: string | null;
  readonly approval_id: string | null;
  readonly snapshot_id: string | null;
  readonly idempotency_key: string | null;
  readonly request_digest: string;
  readonly outcome: string;
  readonly error_code: string | null;
  readonly duration_ms: number;
  readonly actions_consumed: number;
  readonly request_id: string | null;
  readonly created_at: number;
}

export interface UsageRollupRow {
  readonly period: string;
  readonly actions_consumed: number;
  readonly reads: number;
  readonly writes: number;
  readonly destructive: number;
  readonly failures: number;
  readonly soft_limit_notified_at: number | null;
  readonly hard_limit_hit_at: number | null;
  readonly updated_at: number;
}

/** Job fields safe for a dashboard. `vars_json` is deliberately excluded. */
export interface JobRow {
  readonly id: string;
  readonly organization_id: string;
  readonly site_id: string;
  readonly name: string;
  readonly playbook_slug: string;
  readonly schedule_kind: string;
  readonly cron_expr: string | null;
  readonly interval_seconds: number | null;
  readonly run_once_at: number | null;
  readonly timezone: string;
  readonly next_run_at: number | null;
  readonly last_run_at: number | null;
  readonly last_status: string | null;
  readonly enabled: number;
  readonly dry_run: number;
  readonly overlap_policy: string;
  readonly catchup_policy: string;
  readonly max_retries: number;
  readonly retry_backoff_seconds: number;
  readonly timeout_seconds: number;
  readonly concurrency_key: string;
  readonly notify_on: string;
  readonly created_by: string;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface JobRunRow {
  readonly id: string;
  readonly job_id: string;
  readonly organization_id: string;
  readonly site_id: string;
  readonly scheduled_for: number;
  readonly started_at: number | null;
  readonly finished_at: number | null;
  readonly status: string;
  readonly attempt: number;
  readonly snapshot_id: string | null;
  readonly approval_id: string | null;
  readonly steps_summary_json: string;
  readonly error_code: string | null;
  readonly actions_consumed: number;
  readonly idempotency_key: string;
  readonly created_at: number;
}

export interface ApprovalRow {
  readonly id: string;
  readonly organization_id: string;
  readonly site_id: string;
  readonly tool: string;
  readonly scope_requested: string;
  readonly request_digest: string;
  readonly summary: string;
  readonly requested_by_type: string;
  readonly requested_by_id: string;
  readonly status: string;
  readonly step_up_verified_at: number | null;
  readonly decided_by: string | null;
  readonly decided_at: number | null;
  readonly expires_at: number;
  readonly created_at: number;
}

export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

export interface PageCursor {
  readonly createdAt: number;
  readonly id: string;
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

  /** The caller's organization, or undefined if its row is missing. */
  async organization(): Promise<OrganizationRow | undefined> {
    const row = await this.#db
      .prepare(
        `SELECT id, name, slug, wpistic_org_id, created_at, updated_at
           FROM organizations
          WHERE id = ?`
      )
      .bind(this.organizationId)
      .first<OrganizationRow>();
    return row ?? undefined;
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
            AND status IN ('active','trialing')
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

  /** The effective subscription. Inactive or past-due plans fall back to Free. */
  async subscription(): Promise<SubscriptionRow | undefined> {
    const row = await this.#db
      .prepare(
        `SELECT id, plan, billing_interval, status, api_addon, trial_ends_at,
                current_period_start, current_period_end
           FROM subscriptions
          WHERE organization_id = ?
            AND status IN ('active','trialing')
          ORDER BY created_at DESC
          LIMIT 1`
      )
      .bind(this.organizationId)
      .first<SubscriptionRow>();
    return row ?? undefined;
  }

  async usageRollups(limit = 12): Promise<UsageRollupRow[]> {
    const bounded = Math.max(1, Math.min(12, Math.floor(limit)));
    const { results } = await this.#db
      .prepare(
        `SELECT period, actions_consumed, reads, writes, destructive, failures,
                soft_limit_notified_at, hard_limit_hit_at, updated_at
           FROM usage_counters
          WHERE organization_id = ?
          ORDER BY period DESC
          LIMIT ?`
      )
      .bind(this.organizationId, bounded)
      .all<UsageRollupRow>();
    return results;
  }

  async actions(options: { readonly limit: number; readonly cursor?: PageCursor }): Promise<Page<ActionRow>> {
    const siteId = this.caller.restrictedToSiteId;
    const siteClause = siteId === undefined ? "" : " AND site_id = ?";
    const cursorClause = options.cursor === undefined
      ? ""
      : " AND (created_at < ? OR (created_at = ? AND id < ?))";
    const values: unknown[] = [this.organizationId];
    if (siteId !== undefined) values.push(siteId);
    if (options.cursor !== undefined) values.push(options.cursor.createdAt, options.cursor.createdAt, options.cursor.id);
    values.push(options.limit + 1);

    const { results } = await this.#db
      .prepare(
        `SELECT id, site_id, actor_type, actor_id, tool, scope_used,
                approval_id, snapshot_id, idempotency_key, request_digest,
                outcome, error_code, duration_ms, actions_consumed,
                request_id, created_at
           FROM action_log
          WHERE organization_id = ?${siteClause}${cursorClause}
          ORDER BY created_at DESC, id DESC
          LIMIT ?`
      )
      .bind(...values)
      .all<ActionRow>();
    return page(results, options.limit);
  }

  async jobs(): Promise<JobRow[]> {
    const siteId = this.caller.restrictedToSiteId;
    const siteClause = siteId === undefined ? "" : " AND site_id = ?";
    const statement = this.#db.prepare(
      `SELECT id, organization_id, site_id, name, playbook_slug,
              schedule_kind, cron_expr, interval_seconds, run_once_at,
              timezone, next_run_at, last_run_at, last_status, enabled,
              dry_run, overlap_policy, catchup_policy, max_retries,
              retry_backoff_seconds, timeout_seconds, concurrency_key,
              notify_on, created_by, created_at, updated_at
         FROM jobs
        WHERE organization_id = ?${siteClause}
        ORDER BY created_at DESC
        LIMIT 500`
    );
    const { results } = siteId === undefined
      ? await statement.bind(this.organizationId).all<JobRow>()
      : await statement.bind(this.organizationId, siteId).all<JobRow>();
    return results;
  }

  async job(jobId: string): Promise<JobRow | undefined> {
    const siteId = this.caller.restrictedToSiteId;
    const siteClause = siteId === undefined ? "" : " AND site_id = ?";
    const statement = this.#db.prepare(
      `SELECT id, organization_id, site_id, name, playbook_slug,
              schedule_kind, cron_expr, interval_seconds, run_once_at,
              timezone, next_run_at, last_run_at, last_status, enabled,
              dry_run, overlap_policy, catchup_policy, max_retries,
              retry_backoff_seconds, timeout_seconds, concurrency_key,
              notify_on, created_by, created_at, updated_at
         FROM jobs
        WHERE id = ? AND organization_id = ?${siteClause}`
    );
    const row = siteId === undefined
      ? await statement.bind(jobId, this.organizationId).first<JobRow>()
      : await statement.bind(jobId, this.organizationId, siteId).first<JobRow>();
    return row ?? undefined;
  }

  async jobRuns(jobId: string, options: { readonly limit: number; readonly cursor?: PageCursor }): Promise<Page<JobRunRow> | undefined> {
    if (!(await this.job(jobId))) return undefined;
    const siteId = this.caller.restrictedToSiteId;
    const siteClause = siteId === undefined ? "" : " AND site_id = ?";
    const cursorClause = options.cursor === undefined
      ? ""
      : " AND (created_at < ? OR (created_at = ? AND id < ?))";
    const values: unknown[] = [jobId, this.organizationId];
    if (siteId !== undefined) values.push(siteId);
    if (options.cursor !== undefined) values.push(options.cursor.createdAt, options.cursor.createdAt, options.cursor.id);
    values.push(options.limit + 1);

    const { results } = await this.#db
      .prepare(
        `SELECT id, job_id, organization_id, site_id, scheduled_for,
                started_at, finished_at, status, attempt, snapshot_id,
                approval_id, steps_summary_json, error_code, actions_consumed,
                idempotency_key, created_at
           FROM job_runs
          WHERE job_id = ? AND organization_id = ?${siteClause}${cursorClause}
          ORDER BY created_at DESC, id DESC
          LIMIT ?`
      )
      .bind(...values)
      .all<JobRunRow>();
    return page(results, options.limit);
  }

  async pendingApprovals(now: number): Promise<ApprovalRow[]> {
    const siteId = this.caller.restrictedToSiteId;
    const siteClause = siteId === undefined ? "" : " AND site_id = ?";
    const statement = this.#db.prepare(
      `SELECT id, organization_id, site_id, tool, scope_requested,
              request_digest, summary, requested_by_type, requested_by_id,
              status, step_up_verified_at, decided_by, decided_at,
              expires_at, created_at
         FROM approvals
        WHERE organization_id = ?
          AND status = 'pending'
          AND expires_at > ?${siteClause}
        ORDER BY expires_at ASC, created_at ASC
        LIMIT 500`
    );
    const { results } = siteId === undefined
      ? await statement.bind(this.organizationId, now).all<ApprovalRow>()
      : await statement.bind(this.organizationId, now, siteId).all<ApprovalRow>();
    return results;
  }
}

function page<T extends { readonly id: string; readonly created_at: number }>(rows: T[], limit: number): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? `${last.created_at}:${last.id}` : null,
  };
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
