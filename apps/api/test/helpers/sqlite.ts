/**
 * A D1-shaped adapter over `node:sqlite`, so the production code under test
 * runs unchanged against a real database.
 *
 * Factored out because it was copy-pasted into three test files, and a fourth
 * copy would have been the one that drifted — most likely in `run()`, which is
 * exactly where the idempotency store's correctness comes from.
 */

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlDatabase, SqlStatement } from "../../src/db/scope.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

export function adapt(db: DatabaseSync): SqlDatabase {
  return {
    prepare(sql: string): SqlStatement {
      let bound: unknown[] = [];
      const statement: SqlStatement = {
        bind(...values: unknown[]) {
          bound = values;
          return statement;
        },
        async first<T>() {
          return (db.prepare(sql).get(...(bound as never[])) as T) ?? null;
        },
        async all<T>() {
          return { results: db.prepare(sql).all(...(bound as never[])) as T[] };
        },
        async run() {
          const result = db.prepare(sql).run(...(bound as never[]));
          // node:sqlite reports `changes` as number | bigint; D1 reports it as
          // a number under `meta`. Normalised here so the port sees one shape,
          // and so a bigint can never reach a `> 0` comparison as a surprise.
          return { changes: Number(result.changes) };
        },
      };
      return statement;
    },
  };
}

/** A fresh in-memory database with every migration applied, in order. */
export function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const dir = join(REPO_ROOT, "db", "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dir, file), "utf8"));
  }
  return db;
}
