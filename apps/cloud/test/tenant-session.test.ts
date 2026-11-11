/**
 * Tests for src/tenant-session.ts's resolveTenantRegistry() - the second
 * half of "request flow -> tool call" that oauth-flow.test.ts doesn't cover
 * (that file stops at completeAuthorization(); this proves the resulting
 * `props.tenantId` actually resolves to the right tenant's tools, and that
 * registerTools() wires a real, callable tool set against it). This logic
 * was extracted out of agent.ts's init() specifically so it's importable
 * without `agents/mcp`, which pulls in Cloudflare-Workers-only globals
 * (`cloudflare:workers`) unavailable under plain `node:test` - see
 * tenant-session.ts's docblock.
 *
 * Run: npx tsx --test test/tenant-session.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { D1Database } from "@cloudflare/workers-types";
import { resolveTenantRegistry } from "../src/tenant-session.js";
import { registerTools } from "../src/tools/register.js";
import { upsertTenant } from "../src/tenants-db.js";

const ENC_KEY = Buffer.alloc(32, 9).toString("base64");

/** Same fake D1 shape used in tenants-db.test.ts / oauth-flow.test.ts. */
interface FakeRow {
  id: string;
  site_url: string;
  key_id: string;
  key_secret_enc: string;
  scopes: string;
  created_at: number;
  last_used_at: number;
}
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
      if (row) row.last_used_at = this.tick();
      return;
    }
    throw new Error(`FakeD1Database: unrecognized run() query:\n${sql}`);
  }
}

function fakeEnv(db: FakeD1Database) {
  return { DB: db as unknown as D1Database, TENANT_ENC_KEY: ENC_KEY };
}

describe("resolveTenantRegistry", () => {
  test("throws when no tenantId is bound to the session", async () => {
    await assert.rejects(() => resolveTenantRegistry(fakeEnv(new FakeD1Database()), undefined), /No tenant bound to this session/);
  });

  test("throws a reconnect-instructing error when the tenant id doesn't resolve in D1", async () => {
    await assert.rejects(
      () => resolveTenantRegistry(fakeEnv(new FakeD1Database()), "ghost-tenant"),
      /no longer known to the cloud connector.*Reconnect/s
    );
  });

  test("resolves to a registry scoped to exactly that tenant's site", async () => {
    const db = new FakeD1Database();
    const tenantId = await upsertTenant(db as unknown as D1Database, ENC_KEY, "https://example.com", "wpk_abc", "wps_secret", ["posts:read"]);

    const registry = await resolveTenantRegistry(fakeEnv(db), tenantId);
    const sites = registry.list();
    assert.equal(sites.length, 1);
    assert.equal(sites[0].siteUrl, "https://example.com");
    assert.equal(sites[0].alias, "default");
  });

  test("two different tenants resolve to registries scoped to their own site, not each other's", async () => {
    const db = new FakeD1Database();
    const tenantA = await upsertTenant(db as unknown as D1Database, ENC_KEY, "https://a.example", "k1", "s1", ["read"]);
    const tenantB = await upsertTenant(db as unknown as D1Database, ENC_KEY, "https://b.example", "k2", "s2", ["read"]);

    const registryA = await resolveTenantRegistry(fakeEnv(db), tenantA);
    const registryB = await resolveTenantRegistry(fakeEnv(db), tenantB);

    assert.equal(registryA.list()[0].siteUrl, "https://a.example");
    assert.equal(registryB.list()[0].siteUrl, "https://b.example");
  });
});

interface RegisteredTool {
  name: string;
  config: unknown;
  handler: (...args: unknown[]) => Promise<unknown>;
}

/** Records every server.registerTool(...) call registerTools() makes - the exact call shape agent.ts's real McpServer receives, without needing the SDK's transport machinery. */
class FakeMcpServer {
  tools: RegisteredTool[] = [];
  registerTool(name: string, config: unknown, handler: (...args: unknown[]) => Promise<unknown>) {
    this.tools.push({ name, config, handler });
  }
}

describe("resolveTenantRegistry + registerTools: the full request-flow-to-tool-call wiring", () => {
  test("registerTools wires a real, callable tool set against the resolved tenant - this is what agent.ts's init() does", async () => {
    const db = new FakeD1Database();
    const tenantId = await upsertTenant(db as unknown as D1Database, ENC_KEY, "https://example.com", "wpk_abc", "wps_secret", ["posts:read"]);
    const registry = await resolveTenantRegistry(fakeEnv(db), tenantId);

    const server = new FakeMcpServer();
    registerTools(server as unknown as never, registry);

    assert.ok(server.tools.length > 1, "registerTools should have registered more than one tool");
    const listSites = server.tools.find((t) => t.name === "bridgistic_list_sites");
    assert.ok(listSites, "bridgistic_list_sites must be among the registered tools");

    const result = (await listSites!.handler()) as { structuredContent: { count: number; sites: Array<{ alias: string; siteUrl: string }> } };
    assert.equal(result.structuredContent.count, 1);
    assert.equal(result.structuredContent.sites[0].siteUrl, "https://example.com");
    assert.equal(result.structuredContent.sites[0].alias, "default");
  });

  test("registered tools for two different tenants each see only their own site", async () => {
    const db = new FakeD1Database();
    const tenantA = await upsertTenant(db as unknown as D1Database, ENC_KEY, "https://a.example", "k1", "s1", ["read"]);
    const tenantB = await upsertTenant(db as unknown as D1Database, ENC_KEY, "https://b.example", "k2", "s2", ["read"]);

    const serverA = new FakeMcpServer();
    registerTools(serverA as unknown as never, await resolveTenantRegistry(fakeEnv(db), tenantA));
    const resultA = (await serverA.tools.find((t) => t.name === "bridgistic_list_sites")!.handler()) as {
      structuredContent: { sites: Array<{ siteUrl: string }> };
    };
    assert.equal(resultA.structuredContent.sites[0].siteUrl, "https://a.example");

    const serverB = new FakeMcpServer();
    registerTools(serverB as unknown as never, await resolveTenantRegistry(fakeEnv(db), tenantB));
    const resultB = (await serverB.tools.find((t) => t.name === "bridgistic_list_sites")!.handler()) as {
      structuredContent: { sites: Array<{ siteUrl: string }> };
    };
    assert.equal(resultB.structuredContent.sites[0].siteUrl, "https://b.example");
  });
});
