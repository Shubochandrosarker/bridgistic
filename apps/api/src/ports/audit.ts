/**
 * The audit log, backed by `action_log` in D1.
 *
 * Every call the executor makes lands here, including the denied ones — a log
 * that records only what succeeded cannot answer the question an incident
 * actually asks, which is what was attempted.
 *
 * ## What is not in a row
 *
 * Arguments. `request_digest` is `sha256(canonical(args))` and the executor
 * computes it before this port is reached, so there is no path by which the
 * arguments arrive here at all. A `db_query` statement or an `execute_php`
 * body can carry customer PII, and an audit table is exactly the place it
 * would sit unnoticed and be exported to a support tool later.
 */

import type { AuditLog, AuditEntry } from "@bridgistic/executor";
import type { SqlDatabase } from "../db/scope.ts";

export class D1AuditLog implements AuditLog {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  async record(entry: AuditEntry): Promise<void> {
    await this.#db
      .prepare(
        `INSERT INTO action_log (
           id, organization_id, site_id, actor_type, actor_id, tool, scope_used,
           approval_id, snapshot_id, idempotency_key, request_digest, outcome,
           error_code, duration_ms, actions_consumed, request_id, created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        entry.id,
        entry.organizationId,
        entry.siteId,
        entry.actorType,
        entry.actorId,
        entry.tool,
        null,
        entry.approvalId ?? null,
        entry.snapshotId ?? null,
        null,
        entry.requestDigest,
        entry.outcome,
        entry.errorClass ?? null,
        // The columns carry CHECK (>= 0). A negative duration from a clock
        // that stepped backwards would abort the insert and lose the row, and
        // losing the record of a call is worse than recording it as instant.
        Math.max(0, Math.round(entry.durationMs)),
        Math.max(0, Math.round(entry.actionsConsumed)),
        null,
        entry.createdAt
      )
      .run();
  }
}
