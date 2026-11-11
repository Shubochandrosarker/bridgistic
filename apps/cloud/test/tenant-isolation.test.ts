/**
 * Cross-tenant isolation.
 *
 * This is the property that makes a multi-tenant relay safe to run at all: a
 * session bound to tenant A must never be able to observe or act on tenant B's
 * site URL, key id, key secret, scopes, or tools. Every other cloud test can
 * pass while this one fails, and the product would still be unshippable - so
 * these assertions are written against the boundary itself (resolveTenantRegistry,
 * the only thing that turns an OAuth-derived tenantId into a callable registry)
 * rather than against any single helper.
 *
 * Run: npx tsx --test test/tenant-isolation.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { D1Database } from "@cloudflare/workers-types";
import { upsertTenant } from "../src/tenants-db.js";
import { resolveTenantRegistry, type TenantSessionEnv } from "../src/tenant-session.js";

interface FakeRow {
  id: string;
  site_url: string;
  key_id: string;
  key_secret_enc: string;
  scopes: string;
  created_at: number;
  last_used_at: number;
}

/** Same shape as test/tenants-db.test.ts's fake; only the queries in use. */
class FakeD1Database {
  rows: FakeRow[] = [];
  /** Every id ever looked up, so a test can assert nothing else was queried. */
  lookups: string[] = [];
  private clock = 1_700_000_000;

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
      this.lookups.push(id);
      const row = this.rows.find((r) => r.id === id);
      return row ? { ...row } : null;
    }
    throw new Error(`FakeD1Database: unrecognized first() query:\n${sql}`);
  }

  private execRun(sql: string, params: unknown[]): void {
    if (sql.startsWith("INSERT INTO tenants")) {
      const [id, siteUrl, keyId, keySecretEnc, scopes] = params as [string, string, string, string, string];
      const existing = this.rows.find((r) => r.id === id);
      const now = ++this.clock;
      if (existing) {
        existing.key_id = keyId;
        existing.key_secret_enc = keySecretEnc;
        existing.scopes = scopes;
        existing.last_used_at = now;
      } else {
        this.rows.push({ id, site_url: siteUrl, key_id: keyId, key_secret_enc: keySecretEnc, scopes, created_at: now, last_used_at: now });
      }
      return;
    }
    if (sql.startsWith("UPDATE tenants SET last_used_at")) {
      const [id] = params as [string];
      const row = this.rows.find((r) => r.id === id);
      if (row) row.last_used_at = ++this.clock;
      return;
    }
    throw new Error(`FakeD1Database: unrecognized run() query:\n${sql}`);
  }
}

const ENC_KEY = Buffer.alloc(32, 7).toString("base64");

/** Two connected sites with deliberately distinct, greppable credentials. */
async function twoTenants() {
  const fake = new FakeD1Database();
  const db = fake as unknown as D1Database;
  const env: TenantSessionEnv = { DB: db, TENANT_ENC_KEY: ENC_KEY };

  const alphaId = await upsertTenant(db, ENC_KEY, "https://alpha.example", "wpk_alpha", "wps_alpha_secret", ["site:read"]);
  const betaId = await upsertTenant(db, ENC_KEY, "https://beta.example", "wpk_beta", "wps_beta_secret", [
    "site:read",
    "posts:write",
    "php:execute",
  ]);

  return { fake, env, alphaId, betaId };
}

describe("tenant isolation: a session sees exactly one site", () => {
  test("alpha's session resolves to alpha's site only", async () => {
    const { env, alphaId } = await twoTenants();
    const registry = await resolveTenantRegistry(env, alphaId);

    const sites = registry.list();
    assert.equal(sites.length, 1);
    assert.equal(sites[0].siteUrl, "https://alpha.example");
  });

  test("beta's site never appears in alpha's registry listing", async () => {
    const { env, alphaId } = await twoTenants();
    const registry = await resolveTenantRegistry(env, alphaId);
    const serialized = JSON.stringify(registry.list());

    assert.ok(!serialized.includes("beta"), "beta must not be discoverable from alpha's session");
  });

  test("alpha's connection carries alpha's key id and secret, never beta's", async () => {
    const { env, alphaId } = await twoTenants();
    const conn = (await resolveTenantRegistry(env, alphaId)).resolve();

    assert.equal(conn.keyId, "wpk_alpha");
    assert.equal(conn.secret, "wps_alpha_secret");
    assert.notEqual(conn.secret, "wps_beta_secret");
  });

  test("alpha's session inherits alpha's scopes, not beta's broader set", async () => {
    // beta holds php:execute; a leak here would hand alpha the highest-privilege
    // tool on a site it has no grant for.
    const { env, alphaId, fake } = await twoTenants();
    await resolveTenantRegistry(env, alphaId);

    const alphaRow = fake.rows.find((r) => r.id === alphaId)!;
    assert.deepEqual(JSON.parse(alphaRow.scopes), ["site:read"]);
  });

  test("an alias from another tenant does not reach that tenant's site", async () => {
    // The cloud registry is single-site by construction: whatever alias a
    // caller passes, it resolves to the one site bound to the session. This
    // asserts that "unknown alias" can never mean "some other tenant's site".
    const { env, alphaId } = await twoTenants();
    const registry = await resolveTenantRegistry(env, alphaId);

    for (const alias of ["beta", "https://beta.example", "default", "", "../beta"]) {
      assert.equal(registry.resolve(alias).siteUrl, "https://alpha.example", `alias ${JSON.stringify(alias)} escaped its tenant`);
    }
  });

  test("only the session's own tenant row is ever queried", async () => {
    const { env, alphaId, fake } = await twoTenants();
    await resolveTenantRegistry(env, alphaId);

    assert.deepEqual(fake.lookups, [alphaId], "resolving one session must not read any other tenant's row");
  });
});

describe("tenant isolation: resolution fails closed", () => {
  test("a missing tenantId throws instead of yielding an empty or default registry", async () => {
    const { env } = await twoTenants();
    await assert.rejects(() => resolveTenantRegistry(env, undefined), /No tenant bound to this session/);
  });

  test("an empty-string tenantId is treated as missing, not as a wildcard", async () => {
    const { env } = await twoTenants();
    await assert.rejects(() => resolveTenantRegistry(env, ""), /No tenant bound to this session/);
  });

  test("an unknown tenantId throws rather than falling back to any existing tenant", async () => {
    const { env } = await twoTenants();
    await assert.rejects(
      () => resolveTenantRegistry(env, "00000000-0000-0000-0000-000000000000"),
      /no longer known to the cloud connector/
    );
  });

  test("a revoked tenant (row deleted) stops resolving immediately", async () => {
    const { env, fake, alphaId } = await twoTenants();
    fake.rows = fake.rows.filter((r) => r.id !== alphaId);
    await assert.rejects(() => resolveTenantRegistry(env, alphaId), /no longer known to the cloud connector/);
  });

  test("a tenant row whose stored site URL is not a public https site is refused at use time", async () => {
    // Rows written before the SSRF guard existed were only checked for "is
    // https". Trusting the database because it is the database is exactly how
    // a stored-value SSRF survives the fix that was supposed to close it.
    const { env, fake, alphaId } = await twoTenants();
    fake.rows.find((r) => r.id === alphaId)!.site_url = "https://169.254.169.254";
    await assert.rejects(() => resolveTenantRegistry(env, alphaId), /not a valid public https site/);
  });
});

describe("tenant isolation: secrets at rest", () => {
  test("no plaintext key secret is ever stored in the tenants table", async () => {
    const { fake } = await twoTenants();
    for (const row of fake.rows) {
      assert.ok(!row.key_secret_enc.includes("wps_"), `row ${row.id} stored a plaintext-looking secret`);
      assert.match(row.key_secret_enc, /^v2\.aes256gcm\./, "secrets must be stored in the versioned AES-GCM envelope");
    }
  });

  test("two tenants with the same secret still get distinct ciphertext", async () => {
    // A shared IV or deterministic encryption would let anyone with a D1 export
    // tell which sites share a credential.
    const fake = new FakeD1Database();
    const db = fake as unknown as D1Database;
    await upsertTenant(db, ENC_KEY, "https://one.example", "k", "identical-secret", []);
    await upsertTenant(db, ENC_KEY, "https://two.example", "k", "identical-secret", []);

    assert.notEqual(fake.rows[0].key_secret_enc, fake.rows[1].key_secret_enc);
  });
});
