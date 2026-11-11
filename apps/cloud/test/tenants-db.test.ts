/**
 * Tests for src/tenants-db.ts - upsertTenant()/getTenant() against a
 * hand-rolled fake D1Database (no Miniflare / Workers runtime). The fake
 * only implements the exact call shape tenants-db.ts actually uses:
 * `db.prepare(sql).bind(...).first()` and `db.prepare(sql).bind(...).run()`,
 * and only recognizes the four literal queries that file issues (see
 * FakeD1Database below) - it is not a general SQL engine.
 *
 * Covers the three behavioral guarantees called out in the review brief:
 *   1. upsert is keyed by the unique `site_url` column (insert-or-update).
 *   2. `key_secret` is passed through crypto.ts encryption before storage
 *      and decrypted before being returned.
 *   3. `last_used_at` is bumped on getTenant().
 *
 * Run: npx tsx --test test/tenants-db.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { D1Database } from "@cloudflare/workers-types";
import { upsertTenant, getTenant } from "../src/tenants-db.js";

interface FakeRow {
  id: string;
  site_url: string;
  key_id: string;
  key_secret_enc: string;
  scopes: string;
  created_at: number;
  last_used_at: number;
}

/**
 * Minimal fake of the D1Database surface tenants-db.ts calls:
 *   prepare(sql).bind(...params).first<T>()
 *   prepare(sql).bind(...params).run()
 * Matches on the literal SQL text of the four queries tenants-db.ts issues.
 * Uses an internal monotonic "clock" in place of SQLite's unixepoch() so
 * that `last_used_at` bumps are observable without relying on wall-clock
 * time / sleeping in tests.
 */
class FakeD1Database {
  rows: FakeRow[] = [];
  private clock = 1_700_000_000;

  private tick(): number {
    this.clock += 1;
    return this.clock;
  }

  prepare(sql: string) {
    const q = sql.trim();
    return {
      bind: (...params: unknown[]) => ({
        first: async <T>(): Promise<T | null> => this.execFirst(q, params) as T | null,
        run: async (): Promise<{ success: true }> => {
          this.execRun(q, params);
          return { success: true };
        },
      }),
    };
  }

  private execFirst(sql: string, params: unknown[]): unknown {
    if (sql.startsWith("SELECT id FROM tenants WHERE site_url")) {
      const [siteUrl] = params as [string];
      const row = this.rows.find((r) => r.site_url === siteUrl);
      return row ? { id: row.id } : null;
    }
    if (sql.startsWith("SELECT id, site_url, key_id, key_secret_enc, scopes FROM tenants WHERE id")) {
      const [id] = params as [string];
      const row = this.rows.find((r) => r.id === id);
      return row ? { ...row } : null;
    }
    throw new Error(`FakeD1Database: unrecognized first() query:\n${sql}`);
  }

  private execRun(sql: string, params: unknown[]): void {
    if (sql.startsWith("INSERT INTO tenants")) {
      const [id, siteUrl, keyId, keySecretEnc, scopes] = params as [string, string, string, string, string];
      const existing = this.rows.find((r) => r.id === id);
      const now = this.tick();
      if (existing) {
        // Mirrors the real ON CONFLICT(id) DO UPDATE clause.
        existing.key_id = keyId;
        existing.key_secret_enc = keySecretEnc;
        existing.scopes = scopes;
        existing.last_used_at = now;
      } else {
        this.rows.push({
          id,
          site_url: siteUrl,
          key_id: keyId,
          key_secret_enc: keySecretEnc,
          scopes,
          created_at: now,
          last_used_at: now,
        });
      }
      return;
    }
    if (sql.startsWith("UPDATE tenants") && sql.includes("SET key_id")) {
      // Mirrors upsertTenant's update path for an existing site_url.
      const [keyId, keySecretEnc, scopes, id] = params as [string, string, string, string];
      const row = this.rows.find((r) => r.id === id);
      if (row) {
        row.key_id = keyId;
        row.key_secret_enc = keySecretEnc;
        row.scopes = scopes;
        row.last_used_at = this.tick();
      }
      return;
    }
    if (sql.startsWith("UPDATE tenants SET last_used_at")) {
      const [id] = params as [string];
      const row = this.rows.find((r) => r.id === id);
      if (row) row.last_used_at = this.tick();
      return;
    }
    throw new Error(`FakeD1Database: unrecognized run() query:\n${sql}`);
  }
}

const ENC_KEY = Buffer.alloc(32, 9).toString("base64");

function fakeDb(): { fake: FakeD1Database; db: D1Database } {
  const fake = new FakeD1Database();
  return { fake, db: fake as unknown as D1Database };
}

describe("upsertTenant: keyed by unique site_url", () => {
  test("first call for a new site_url inserts a new row and returns a fresh id", async () => {
    const { fake, db } = fakeDb();
    const id = await upsertTenant(db, ENC_KEY, "https://a.example", "k1", "secret1", ["read"]);
    assert.equal(fake.rows.length, 1);
    assert.equal(fake.rows[0].id, id);
    assert.equal(fake.rows[0].site_url, "https://a.example");
    // Looks like a UUID (crypto.randomUUID()).
    assert.match(id, /^[0-9a-f-]{36}$/i);
  });

  test("a second call for the SAME site_url updates the existing row instead of inserting a new one", async () => {
    const { fake, db } = fakeDb();
    const id1 = await upsertTenant(db, ENC_KEY, "https://a.example", "k1", "secret1", ["read"]);
    const id2 = await upsertTenant(db, ENC_KEY, "https://a.example", "k2", "secret2", ["read", "write"]);

    assert.equal(id2, id1, "upsert for the same site_url must reuse the same tenant id");
    assert.equal(fake.rows.length, 1, "must not create a second row for the same site_url");
    assert.equal(fake.rows[0].key_id, "k2", "key_id should reflect the latest upsert");
  });

  test("a different site_url gets its own row and its own id", async () => {
    const { fake, db } = fakeDb();
    const id1 = await upsertTenant(db, ENC_KEY, "https://a.example", "k1", "secret1", ["read"]);
    const id2 = await upsertTenant(db, ENC_KEY, "https://b.example", "k2", "secret2", ["read"]);

    assert.notEqual(id1, id2);
    assert.equal(fake.rows.length, 2);
  });

  test("scopes are stored and round-trip through JSON", async () => {
    const { db } = fakeDb();
    const id = await upsertTenant(db, ENC_KEY, "https://a.example", "k1", "secret1", ["read", "write", "admin"]);
    const tenant = await getTenant(db, ENC_KEY, id);
    assert.deepEqual(tenant?.scopes, ["read", "write", "admin"]);
  });
});

describe("upsertTenant: key_secret is encrypted before storage", () => {
  test("the stored key_secret_enc is never the plaintext secret", async () => {
    const { fake, db } = fakeDb();
    await upsertTenant(db, ENC_KEY, "https://a.example", "k1", "super-secret-value", ["read"]);
    const stored = fake.rows[0].key_secret_enc;
    assert.notEqual(stored, "super-secret-value");
    assert.ok(!stored.includes("super-secret-value"));
    // Matches crypto.ts's versioned `v2.aes256gcm.${iv}.${ciphertext}` envelope.
    assert.match(stored, /^v2\.aes256gcm\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
  });

  test("re-upserting re-encrypts with a fresh IV even for the same plaintext secret", async () => {
    const { fake, db } = fakeDb();
    await upsertTenant(db, ENC_KEY, "https://a.example", "k1", "same-secret", ["read"]);
    const first = fake.rows[0].key_secret_enc;
    await upsertTenant(db, ENC_KEY, "https://a.example", "k1", "same-secret", ["read"]);
    const second = fake.rows[0].key_secret_enc;
    assert.notEqual(first, second, "AES-GCM IV should be re-randomized on every encrypt");
  });
});

describe("getTenant", () => {
  test("returns null for an unknown id", async () => {
    const { db } = fakeDb();
    assert.equal(await getTenant(db, ENC_KEY, "does-not-exist"), null);
  });

  test("returns the decrypted key_secret matching what was originally passed to upsertTenant", async () => {
    const { db } = fakeDb();
    const id = await upsertTenant(db, ENC_KEY, "https://a.example", "k1", "the-real-secret", ["read"]);
    const tenant = await getTenant(db, ENC_KEY, id);
    assert.equal(tenant?.keySecret, "the-real-secret");
    assert.equal(tenant?.siteUrl, "https://a.example");
    assert.equal(tenant?.keyId, "k1");
    assert.equal(tenant?.id, id);
  });

  test("reflects the most recent upsert's secret, not a stale one", async () => {
    const { db } = fakeDb();
    const id = await upsertTenant(db, ENC_KEY, "https://a.example", "k1", "old-secret", ["read"]);
    await upsertTenant(db, ENC_KEY, "https://a.example", "k1", "new-secret", ["read"]);
    const tenant = await getTenant(db, ENC_KEY, id);
    assert.equal(tenant?.keySecret, "new-secret");
  });

  test("bumps last_used_at on every call", async () => {
    const { fake, db } = fakeDb();
    const id = await upsertTenant(db, ENC_KEY, "https://a.example", "k1", "secret", ["read"]);
    const afterInsert = fake.rows[0].last_used_at;

    await getTenant(db, ENC_KEY, id);
    const afterFirstGet = fake.rows[0].last_used_at;
    assert.ok(afterFirstGet > afterInsert, "last_used_at must advance after getTenant()");

    await getTenant(db, ENC_KEY, id);
    const afterSecondGet = fake.rows[0].last_used_at;
    assert.ok(afterSecondGet > afterFirstGet, "last_used_at must advance on each subsequent getTenant()");
  });

  test("does not bump last_used_at (or throw) when the tenant does not exist", async () => {
    const { fake, db } = fakeDb();
    await upsertTenant(db, ENC_KEY, "https://a.example", "k1", "secret", ["read"]);
    const before = fake.rows[0].last_used_at;
    await getTenant(db, ENC_KEY, "no-such-id");
    assert.equal(fake.rows[0].last_used_at, before);
  });
});
