/**
 * Per-site concurrency locks, backed by `execution_locks` in D1.
 *
 * The executor takes one before it calls WordPress, so two calls cannot be
 * halfway through mutating the same install at once — and so a destructive
 * call cannot begin while another one's snapshot is still being taken.
 *
 * ## Ownership is decided by rows-changed, never by reading the row
 *
 * The same rule as `D1IdempotencyStore`, for the same reason: reading the lock
 * and then writing it is the race the lock exists to prevent, because two
 * callers can both read "free". The conditional `INSERT … ON CONFLICT DO
 * UPDATE … WHERE expires_at <= ?` is applied atomically, and exactly one of
 * them changes a row.
 *
 * ## Release is conditional on the holder
 *
 * A lock that expires while its holder is still running can be taken by
 * somebody else. When the first holder finishes it must not delete the second
 * holder's lock, so `holder` is checked on release — a fencing token. Without
 * it, a slow call silently unlocks a site another call is actively mutating.
 */

import type { ConcurrencyLock } from "@bridgistic/executor";
import type { SqlDatabase } from "../db/scope.ts";

export interface D1ConcurrencyLockOptions {
  readonly db: SqlDatabase;
  readonly now?: () => number;
  readonly newHolder?: () => string;
}

export class D1ConcurrencyLock implements ConcurrencyLock {
  readonly #db: SqlDatabase;
  readonly #now: () => number;
  readonly #newHolder: () => string;

  constructor(options: D1ConcurrencyLockOptions) {
    this.#db = options.db;
    this.#now = options.now ?? (() => Date.now());
    this.#newHolder = options.newHolder ?? (() => crypto.randomUUID());
  }

  async acquire(key: string, ttlMs: number): Promise<(() => Promise<void>) | null> {
    const now = this.#now();
    const holder = this.#newHolder();

    // A non-positive TTL would write a lock that is already expired — which the
    // CHECK rejects, and which would mean "locked" for no time at all. A
    // non-finite one is worse: `Math.max(1, NaN)` is NaN, so the row goes in
    // with a NULL expiry, the insert fails on NOT NULL, and the caller reads
    // that as "somebody else holds it" — a site locked out by arithmetic.
    const ttl = Number.isFinite(ttlMs) ? Math.floor(ttlMs) : 0;
    const expiresAt = now + Math.max(1, ttl);

    const written = await this.#db
      .prepare(
        `INSERT INTO execution_locks (lock_key, holder, acquired_at, expires_at)
              VALUES (?,?,?,?)
         ON CONFLICT(lock_key) DO UPDATE
                 SET holder = excluded.holder,
                     acquired_at = excluded.acquired_at,
                     expires_at = excluded.expires_at
               WHERE execution_locks.expires_at <= ?`
      )
      .bind(key, holder, now, expiresAt, now)
      .run();

    const changed = written.meta?.changes ?? written.changes ?? 0;
    if (changed === 0) return null;

    return async () => {
      await this.#db
        .prepare(`DELETE FROM execution_locks WHERE lock_key = ? AND holder = ?`)
        .bind(key, holder)
        .run();
    };
  }

  /**
   * Drop locks whose holder never came back.
   *
   * `acquire` already takes over an expired lock, so this is housekeeping
   * rather than correctness: without it the table keeps a row per site that was
   * ever locked. Called from the scheduled sweep.
   */
  async sweepExpired(): Promise<number> {
    const result = await this.#db
      .prepare(`DELETE FROM execution_locks WHERE expires_at <= ?`)
      .bind(this.#now())
      .run();
    return result.meta?.changes ?? result.changes ?? 0;
  }
}
