/**
 * Per-site concurrency locks, against a real database.
 *
 * A lock is only worth having if it holds under the case it exists for: two
 * callers arriving at once. Every test here is about contention, expiry, or the
 * handover between the two.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { D1ConcurrencyLock } from "../src/ports/locks.ts";
import { adapt, migratedDatabase } from "./helpers/sqlite.ts";
import type { SqlDatabase } from "../src/db/scope.ts";

const NOW = 1_800_000_000_000;

let db: DatabaseSync;
let sql: SqlDatabase;

beforeEach(() => {
  db = migratedDatabase();
  sql = adapt(db);
});

const lock = (now: () => number = () => NOW, holder?: () => string) =>
  new D1ConcurrencyLock({ db: sql, now, ...(holder ? { newHolder: holder } : {}) });

test("one holder at a time, and the loser is told so", async () => {
  const first = await lock().acquire("site:site_1", 30_000);
  assert.ok(first, "the first caller did not get the lock");

  const second = await lock().acquire("site:site_1", 30_000);
  assert.equal(second, null, "two callers hold the same site");

  // A different site is unaffected: this is a lock, not a global mutex.
  assert.ok(await lock().acquire("site:site_2", 30_000));
});

test("concurrent acquires produce exactly one holder", async () => {
  // The reason ownership is decided by rows-changed rather than by reading the
  // row: read-then-write lets every caller see "free".
  const results = await Promise.all(
    Array.from({ length: 50 }, () => lock().acquire("site:site_1", 30_000))
  );
  assert.equal(results.filter(Boolean).length, 1, `${results.filter(Boolean).length} callers held it at once`);
});

test("releasing lets the next caller in", async () => {
  const release = await lock().acquire("site:site_1", 30_000);
  assert.ok(release);
  await release();

  assert.ok(await lock().acquire("site:site_1", 30_000), "the lock was not released");
});

test("an expired lock is taken over rather than held forever", async () => {
  // The crash-recovery path. A holder that never returns must not lock a site
  // out permanently.
  assert.ok(await lock(() => NOW).acquire("site:site_1", 1_000));
  assert.equal(await lock(() => NOW + 500).acquire("site:site_1", 1_000), null, "taken over early");
  assert.ok(await lock(() => NOW + 2_000).acquire("site:site_1", 1_000), "never became available");
});

test("an expired holder cannot unlock the site somebody else took", async () => {
  // The fencing token. Without the holder check, a slow call finishing late
  // unlocks a site that another call is actively mutating — the exact state
  // the lock exists to make impossible.
  let handle = 0;
  const slow = await lock(() => NOW, () => `holder_${++handle}`).acquire("site:site_1", 1_000);
  assert.ok(slow);

  const next = await lock(() => NOW + 2_000, () => `holder_${++handle}`).acquire("site:site_1", 30_000);
  assert.ok(next, "the second caller never got it");

  // The first holder finally finishes and releases.
  await slow();

  // The second holder must still hold it.
  const third = await lock(() => NOW + 2_100).acquire("site:site_1", 30_000);
  assert.equal(third, null, "a late release unlocked the site under its new holder");

  // And the real holder can still release it.
  await next();
  assert.ok(await lock(() => NOW + 2_200).acquire("site:site_1", 30_000));
});

test("a released lock leaves no row behind", async () => {
  const release = await lock().acquire("site:site_1", 30_000);
  await release!();
  const count = db.prepare(`SELECT COUNT(*) AS c FROM execution_locks`).get() as { c: number };
  assert.equal(count.c, 0);
});

test("a non-positive ttl still locks, rather than writing an expired row", async () => {
  // expires_at > acquired_at is a CHECK. A zero or negative ttl would abort the
  // insert, and the caller would read that as "somebody else holds it".
  for (const ttl of [0, -1, Number.NaN]) {
    db.exec(`DELETE FROM execution_locks`);
    assert.ok(await lock().acquire("site:site_1", ttl), `ttl ${ttl} failed to lock`);
  }
});

test("the sweep clears abandoned locks and leaves live ones", async () => {
  await lock(() => NOW).acquire("site:expired", 1_000);
  await lock(() => NOW).acquire("site:live", 60_000);

  const swept = await lock(() => NOW + 2_000).sweepExpired();
  assert.equal(swept, 1);

  const rows = db.prepare(`SELECT lock_key FROM execution_locks`).all() as { lock_key: string }[];
  assert.deepEqual(rows.map((r) => r.lock_key), ["site:live"]);
});
