// Minimal D1 shim over sql.js (pure WASM SQLite) for unit tests.
import initSqlJs from "sql.js";
import { readFileSync } from "node:fs";

export async function makeD1(): Promise<D1Database> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  for (const f of ["0001_schema.sql", "0002_site_connections.sql"]) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (sql: string, params: unknown[] = []) => ({
    bind: (...p: unknown[]) => stmt(sql, p),
    async first<T>() {
      const s = db.prepare(sql); s.bind(params as never);
      const row = s.step() ? (s.getAsObject() as T) : null; s.free(); return row;
    },
    async all<T>() {
      const s = db.prepare(sql); s.bind(params as never);
      const results: T[] = []; while (s.step()) results.push(s.getAsObject() as T); s.free();
      return { results, success: true, meta: {} };
    },
    async run() { db.run(sql, params as never); return { success: true, meta: { changes: db.getRowsModified() } }; },
  });
  return { prepare: (sql: string) => stmt(sql), exec: async (sql: string) => { db.exec(sql); return { count: 0, duration: 0 }; } } as unknown as D1Database;
}
