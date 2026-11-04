/**
 * D1-backed idempotency, claimed before the side effect.
 *
 * The atomicity is the whole thing, and it comes from one statement:
 *
 *     INSERT INTO idempotency_claims (…) VALUES (…) ON CONFLICT(key) DO NOTHING
 *
 * SQLite evaluates that as a single write. Either this caller inserted the row
 * — and therefore owns the claim and must perform the call — or somebody else
 * already had it, and the follow-up read says what they did with it. There is
 * no window between "check whether the key exists" and "take it", because
 * there is no check: the primary key does the deciding.
 *
 * A read-then-write would have that window, and two concurrent retries would
 * both read "absent", both proceed, and both call WordPress. That is the exact
 * failure idempotency exists to prevent, and it is invisible in testing
 * because it needs two requests landing inside the same few milliseconds.
 */

import type { IdempotencyStore, IdempotencyClaim, ClaimOutcome } from "@bridgistic/executor";
import type { SqlDatabase } from "./scope.ts";

/**
 * How long a claim may stay pending before a retry may take it.
 *
 * Matched to the meter's reservation TTL: the two expire together, so a
 * crashed call does not have its quota returned while its key is still blocked,
 * or vice versa. Divergent TTLs here produce a window where a customer can see
 * their quota back but still cannot retry, which reads as a bug in both.
 */
export const CLAIM_TTL_MS = 600_000;

interface ClaimRow {
  readonly key: string;
  readonly state: string;
  readonly request_hash: string;
  readonly result_json: string | null;
  readonly expires_at: number;
}

export class D1IdempotencyStore implements IdempotencyStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = () => Date.now()) {
    this.#db = db;
    this.#now = now;
  }

  async claim(claim: Omit<IdempotencyClaim, "state">): Promise<ClaimOutcome> {
    const now = this.#now();

    // First, reclaim the key if a previous attempt died holding it. Scoped to
    // this key and to `pending` past its expiry, so it can never disturb a
    // claim that is genuinely in flight or already settled.
    await this.#db
      .prepare(
        `UPDATE idempotency_claims
            SET state = 'expired', settled_at = ?
          WHERE key = ? AND state = 'pending' AND expires_at <= ?`
      )
      .bind(now, claim.key, now)
      .run();

    // The atomic claim, and the ONLY authoritative signal of who won it: the
    // number of rows this statement changed.
    //
    // The first version of this decided ownership by comparing the stored
    // `expires_at` against the one it had just computed. That is the same race
    // it was meant to detect — two callers in the same millisecond compute the
    // same expiry, so both conclude they won, and both call WordPress. The
    // database is the only thing that can settle it, and it does: exactly one
    // INSERT can change a row.
    const written = await this.#db
      .prepare(
        `INSERT INTO idempotency_claims
           (key, organization_id, site_id, actor_id, tool, request_hash, state, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           -- Re-taking an expired claim, and only an expired one. The WHERE
           -- makes this a no-op for pending, succeeded and failed rows.
           state = 'pending',
           request_hash = excluded.request_hash,
           actor_id = excluded.actor_id,
           tool = excluded.tool,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at,
           settled_at = NULL,
           result_json = NULL
         WHERE idempotency_claims.state = 'expired'`
      )
      .bind(
        claim.key,
        claim.organizationId,
        claim.siteId,
        claim.actorId,
        claim.tool,
        claim.requestHash,
        now,
        now + CLAIM_TTL_MS
      )
      .run();

    const changed = written.meta?.changes ?? written.changes ?? 0;
    const weWonTheInsert = changed > 0;

    // Read back what is there, to distinguish replay from conflict.
    const row = await this.#db
      .prepare(`SELECT key, state, request_hash, result_json, expires_at FROM idempotency_claims WHERE key = ?`)
      .bind(claim.key)
      .first<ClaimRow>();

    if (!row) {
      // Should be unreachable — we just inserted or updated. Failing closed
      // rather than assuming success, because proceeding without a claim is
      // exactly the duplicate mutation this module exists to prevent.
      return { kind: "conflict" };
    }

    // Bound to the REQUEST, not only to the caller. Checked before state, so a
    // key reused for different arguments is a conflict whatever happened to
    // the first call — including if it succeeded, where the alternative would
    // be replaying somebody else's result.
    if (row.request_hash !== claim.requestHash) return { kind: "conflict" };

    switch (row.state) {
      case "succeeded":
        return { kind: "replay", result: row.result_json === null ? null : safeParse(row.result_json) };
      case "failed":
        // A failed call may be retried: the key is bound to the request, the
        // request did not take effect, and refusing forever would strand the
        // caller on a key they cannot reuse and cannot replace.
        {
          // Conditional on the row still being `failed`, so two concurrent
          // retries of a failed call do not both re-open it. Whichever UPDATE
          // changes the row owns the retry; the other sees it in flight.
          const reopened = await this.#db
            .prepare(
              `UPDATE idempotency_claims
                  SET state = 'pending', created_at = ?, expires_at = ?, settled_at = NULL
                WHERE key = ? AND state = 'failed'`
            )
            .bind(now, now + CLAIM_TTL_MS, claim.key)
            .run();
          const reopenedRows = reopened.meta?.changes ?? reopened.changes ?? 0;
          return reopenedRows > 0 ? { kind: "claimed" } : { kind: "in_flight" };
        }
      case "pending":
        // Decided by the write, not by inspecting the row. We own it if and
        // only if our statement is the one that put it there.
        return weWonTheInsert ? { kind: "claimed" } : { kind: "in_flight" };
      default:
        return { kind: "conflict" };
    }
  }

  async settle(key: string, state: "succeeded" | "failed", result?: unknown): Promise<void> {
    const serialised = state === "succeeded" && result !== undefined ? JSON.stringify(result) : null;

    // Only a pending claim settles. A settle arriving after the sweeper
    // expired the claim must not resurrect it as succeeded — the caller has
    // already been told the call failed, and the two answers must not diverge.
    await this.#db
      .prepare(
        `UPDATE idempotency_claims
            SET state = ?, settled_at = ?, result_json = ?
          WHERE key = ? AND state = 'pending'`
      )
      .bind(state, this.#now(), serialised, key)
      .run();
  }

  /**
   * Expire pending claims whose calls never came back.
   *
   * Run on the same cron as the meter's sweep. Returns the count so a rising
   * number is observable rather than absorbed.
   */
  async sweep(limit = 1_000): Promise<number> {
    const now = this.#now();
    const { results } = await this.#db
      .prepare(
        `SELECT key FROM idempotency_claims
          WHERE state = 'pending' AND expires_at <= ?
          LIMIT ?`
      )
      .bind(now, limit)
      .all<{ key: string }>();

    for (const row of results) {
      await this.#db
        .prepare(
          `UPDATE idempotency_claims SET state = 'expired', settled_at = ?
            WHERE key = ? AND state = 'pending'`
        )
        .bind(now, row.key)
        .run();
    }
    return results.length;
  }
}

/** A stored result that will not parse is treated as absent, never as a crash. */
function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
