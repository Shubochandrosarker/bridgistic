/**
 * End-to-end integration test for the Worker's own OAuth *client* leg to
 * WordPress: GET /authorize -> POST /authorize -> GET /wp-callback -> tenant
 * upserted in D1 -> OAUTH_PROVIDER.completeAuthorization() called. This
 * exercises src/default-handler.ts's real `fetch()` export against fakes for
 * everything Cloudflare-runtime-specific (KV, D1, the injected
 * OAUTH_PROVIDER, and the outbound fetch to WordPress's token endpoint) -
 * no Miniflare / Durable Object runtime needed, since default-handler.ts's
 * three routes never touch the Durable Object.
 *
 * What this does NOT cover: the Durable Object session itself (tool
 * registration against a decrypted tenant) - see agent.test.ts for that half
 * of "request flow -> tool call".
 *
 * Run: npx tsx --test test/oauth-flow.test.ts
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { D1Database } from "@cloudflare/workers-types";
import defaultHandler, { parseAuthRequestWithRetry } from "../src/default-handler.js";
import { getTenant } from "../src/tenants-db.js";

const ENC_KEY = Buffer.alloc(32, 9).toString("base64");

// ---- fakes -----------------------------------------------------------------

/** Same minimal KV surface used elsewhere (get/put/delete, in-memory). `store` is public for test introspection. */
class FakeKv {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string, _opts?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/** Same fake D1 shape as tenants-db.test.ts, duplicated here to keep this file self-contained. */
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

interface CompleteAuthorizationCall {
  request: unknown;
  userId: string;
  metadata: unknown;
  scope: string[];
  props: unknown;
}

function fakeEnv() {
  const kv = new FakeKv();
  const d1 = new FakeD1Database();
  const completeAuthorizationCalls: CompleteAuthorizationCall[] = [];
  const authRequest = { redirectUri: "https://ai-client.example/oauth/callback", state: "client-state-abc" };

  const env = {
    DB: d1 as unknown as D1Database,
    TENANT_ENC_KEY: ENC_KEY,
    OAUTH_KV: kv as unknown as KVNamespace,
    OAUTH_PROVIDER: {
      parseAuthRequest: async () => authRequest,
      completeAuthorization: async (options: CompleteAuthorizationCall) => {
        completeAuthorizationCalls.push(options);
        return { redirectTo: "https://ai-client.example/oauth/callback?code=final-code&state=client-state-abc" };
      },
    },
  };

  return { env, kv, d1, completeAuthorizationCalls, authRequest };
}

function stubFetchForWpTokenExchange(response: { site_url: string; key_id: string; key_secret: string; scopes: string[] }) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
}

describe("OAuth flow: GET /authorize", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("stores the parsed auth request in KV and returns the site-URL form", async () => {
    const { env, kv } = fakeEnv();
    const res = await defaultHandler.fetch(new Request("https://mcp.bridgistic.app/authorize"), env as never, {} as ExecutionContext);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /Connect your WordPress site/);
    assert.match(body, /name="flow_id"/);

    // Exactly one flow: stored under an opaque UUID key.
    const flowKeys = [...kv.store.keys()].filter((k) => k.startsWith("flow:"));
    assert.equal(flowKeys.length, 1);
  });

  test("retries a just-registered client while KV converges", async () => {
    let attempts = 0;
    const request = new Request("https://mcp.bridgistic.app/authorize");
    const result = await parseAuthRequestWithRetry(
      {
        parseAuthRequest: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error("Invalid client. The clientId provided does not match to this client.");
          return { redirectUri: "https://client.example/callback", state: "state" };
        },
      } as never,
      request
    );
    assert.equal(attempts, 3);
    assert.equal(result.redirectUri, "https://client.example/callback");
  });

  test("renders a safe 400 instead of leaking an authorization exception as 1101", async () => {
    const { env } = fakeEnv();
    env.OAUTH_PROVIDER.parseAuthRequest = async () => {
      throw new Error("Invalid client. The clientId provided does not match to this client.");
    };
    const res = await defaultHandler.fetch(
      new Request("https://mcp.bridgistic.app/authorize?client_id=expired"),
      env as never,
      {} as ExecutionContext
    );
    assert.equal(res.status, 400);
    assert.match(await res.text(), /invalid or expired/i);
  });
});

describe("OAuth flow: POST /authorize", () => {
  test("rejects a missing/expired flow_id", async () => {
    const { env } = fakeEnv();
    const form = new URLSearchParams({ flow_id: "does-not-exist", site_url: "https://example.com" });
    const res = await defaultHandler.fetch(
      new Request("https://mcp.bridgistic.app/authorize", { method: "POST", body: form }),
      env as never,
      {} as ExecutionContext
    );
    assert.equal(res.status, 400);
    assert.match(await res.text(), /expired/);
  });

  test("rejects a non-https site URL and re-shows the form with an error", async () => {
    const { env } = fakeEnv();
    const getRes = await defaultHandler.fetch(new Request("https://mcp.bridgistic.app/authorize"), env as never, {} as ExecutionContext);
    const flowId = (await getRes.text()).match(/name="flow_id" value="([^"]+)"/)?.[1];
    assert.ok(flowId);

    const form = new URLSearchParams({ flow_id: flowId!, site_url: "http://example.com" });
    const res = await defaultHandler.fetch(
      new Request("https://mcp.bridgistic.app/authorize", { method: "POST", body: form }),
      env as never,
      {} as ExecutionContext
    );
    assert.equal(res.status, 400);
    assert.match(await res.text(), /must start with https/);
  });

  test("valid site URL redirects to that site's WP admin consent screen and stores wpstate", async () => {
    const { env, kv } = fakeEnv();
    const getRes = await defaultHandler.fetch(new Request("https://mcp.bridgistic.app/authorize"), env as never, {} as ExecutionContext);
    const flowId = (await getRes.text()).match(/name="flow_id" value="([^"]+)"/)?.[1]!;

    const form = new URLSearchParams({ flow_id: flowId, site_url: "https://example.com" });
    const res = await defaultHandler.fetch(
      new Request("https://mcp.bridgistic.app/authorize", { method: "POST", body: form, redirect: "manual" }),
      env as never,
      {} as ExecutionContext
    );
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get("Location")!);
    assert.equal(location.origin, "https://example.com");
    assert.equal(location.pathname, "/wp-admin/admin.php");
    assert.equal(location.searchParams.get("page"), "bridgistic-oauth-authorize");
    assert.equal(location.searchParams.get("client_id"), "bridgistic-cloud");
    assert.equal(location.searchParams.get("code_challenge_method"), "S256");
    const wpState = location.searchParams.get("state");
    assert.ok(wpState);

    const stored = await kv.get(`wpstate:${wpState}`);
    assert.ok(stored);
    const parsed = JSON.parse(stored!);
    assert.equal(parsed.siteUrl, "https://example.com");
    assert.equal(parsed.flowId, flowId);
  });
});

describe("OAuth flow: GET /wp-callback (full happy path)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Drives GET /authorize -> POST /authorize to get to a valid wp-callback URL, without asserting on those steps. */
  async function driveToWpCallback(env: ReturnType<typeof fakeEnv>["env"]) {
    const getRes = await defaultHandler.fetch(new Request("https://mcp.bridgistic.app/authorize"), env as never, {} as ExecutionContext);
    const flowId = (await getRes.text()).match(/name="flow_id" value="([^"]+)"/)?.[1]!;
    const form = new URLSearchParams({ flow_id: flowId, site_url: "https://example.com" });
    const postRes = await defaultHandler.fetch(
      new Request("https://mcp.bridgistic.app/authorize", { method: "POST", body: form, redirect: "manual" }),
      env as never,
      {} as ExecutionContext
    );
    return new URL(postRes.headers.get("Location")!);
  }

  test("exchanges the code, upserts the tenant with a decrypted-round-trippable secret, and completes authorization", async () => {
    const { env, d1, completeAuthorizationCalls, authRequest } = fakeEnv();
    stubFetchForWpTokenExchange({
      site_url: "https://example.com",
      key_id: "wpk_abc123",
      key_secret: "wps_the_real_secret",
      scopes: ["posts:read", "posts:write"],
    });

    const redirectedTo = await driveToWpCallback(env);
    const wpState = redirectedTo.searchParams.get("state")!;

    const callbackUrl = `https://mcp.bridgistic.app/wp-callback?code=wp-auth-code&state=${wpState}`;
    const res = await defaultHandler.fetch(new Request(callbackUrl, { redirect: "manual" }), env as never, {} as ExecutionContext);

    // Success is now a branded interstitial page (200) that meta-refreshes to
    // the AI client's redirect_uri with the code — the OAuth flow is intact.
    assert.equal(res.status, 200);
    const successHtml = await res.text();
    assert.match(successHtml, /Connected/);
    assert.match(successHtml, /example\.com/); // the connected site echoed back
    assert.ok(
      successHtml.includes("https://ai-client.example/oauth/callback?code=final-code&amp;state=client-state-abc"),
      "meta refresh must carry the client's redirect with code + state"
    );

    // Tenant really landed in D1, and the secret really round-trips through encryption.
    assert.equal(d1.rows.length, 1);
    assert.equal(d1.rows[0].site_url, "https://example.com");
    assert.equal(d1.rows[0].key_id, "wpk_abc123");
    assert.notEqual(d1.rows[0].key_secret_enc, "wps_the_real_secret", "must never store the plaintext secret");
    const tenant = await getTenant(env.DB, env.TENANT_ENC_KEY, d1.rows[0].id);
    assert.equal(tenant?.keySecret, "wps_the_real_secret");
    assert.deepEqual(tenant?.scopes, ["posts:read", "posts:write"]);

    // completeAuthorization was called with the AI client's original auth request,
    // the new tenant as userId, the WordPress-derived scopes, and props.tenantId
    // set to that same tenant id - this is what agent.ts's init() later trusts.
    assert.equal(completeAuthorizationCalls.length, 1);
    const call = completeAuthorizationCalls[0];
    // request comes back out of a JSON round-trip through KV, so it's a
    // structurally-equal copy, not the same object reference.
    assert.deepEqual(call.request, authRequest);
    assert.equal(call.userId, d1.rows[0].id);
    assert.deepEqual(call.scope, ["posts:read", "posts:write"]);
    assert.deepEqual(call.props, { tenantId: d1.rows[0].id });
  });

  test("a WordPress-side deny bounces access_denied back to the AI client's own redirect_uri, without touching D1", async () => {
    const { env, d1, completeAuthorizationCalls, authRequest } = fakeEnv();
    const redirectedTo = await driveToWpCallback(env);
    const wpState = redirectedTo.searchParams.get("state")!;

    const callbackUrl = `https://mcp.bridgistic.app/wp-callback?error=access_denied&state=${wpState}`;
    const res = await defaultHandler.fetch(new Request(callbackUrl, { redirect: "manual" }), env as never, {} as ExecutionContext);

    assert.equal(res.status, 302);
    const location = new URL(res.headers.get("Location")!);
    assert.equal(location.origin, new URL(authRequest.redirectUri).origin);
    assert.equal(location.searchParams.get("error"), "access_denied");
    assert.equal(location.searchParams.get("state"), authRequest.state);

    assert.equal(d1.rows.length, 0, "a denied consent must never create a tenant row");
    assert.equal(completeAuthorizationCalls.length, 0);
  });

  test("rejects a wp-callback with an unknown/reused state", async () => {
    const { env } = fakeEnv();
    const res = await defaultHandler.fetch(
      new Request("https://mcp.bridgistic.app/wp-callback?code=x&state=never-issued", { redirect: "manual" }),
      env as never,
      {} as ExecutionContext
    );
    assert.equal(res.status, 400);
    assert.match(await res.text(), /expired or was already used/);
  });

  test("the wpstate is single-use: replaying the same callback URL fails the second time", async () => {
    const { env } = fakeEnv();
    stubFetchForWpTokenExchange({ site_url: "https://example.com", key_id: "k1", key_secret: "s1", scopes: ["read"] });
    const redirectedTo = await driveToWpCallback(env);
    const wpState = redirectedTo.searchParams.get("state")!;
    const callbackUrl = `https://mcp.bridgistic.app/wp-callback?code=wp-auth-code&state=${wpState}`;

    const first = await defaultHandler.fetch(new Request(callbackUrl, { redirect: "manual" }), env as never, {} as ExecutionContext);
    assert.equal(first.status, 200);

    const second = await defaultHandler.fetch(new Request(callbackUrl, { redirect: "manual" }), env as never, {} as ExecutionContext);
    assert.equal(second.status, 400);
  });

  test("surfaces a clear error, without touching D1, when the WordPress token exchange itself fails", async () => {
    const { env, d1, completeAuthorizationCalls } = fakeEnv();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "Code expired or already used." }), { status: 400 })) as typeof fetch;

    const redirectedTo = await driveToWpCallback(env);
    const wpState = redirectedTo.searchParams.get("state")!;
    const callbackUrl = `https://mcp.bridgistic.app/wp-callback?code=wp-auth-code&state=${wpState}`;

    const res = await defaultHandler.fetch(new Request(callbackUrl, { redirect: "manual" }), env as never, {} as ExecutionContext);
    assert.equal(res.status, 502);
    assert.match(await res.text(), /Code expired or already used\./);
    assert.equal(d1.rows.length, 0);
    assert.equal(completeAuthorizationCalls.length, 0);
  });
});

describe("OAuth flow: unrecognized routes", () => {
  test("returns 404 for anything that isn't /authorize or /wp-callback", async () => {
    const { env } = fakeEnv();
    const res = await defaultHandler.fetch(new Request("https://mcp.bridgistic.app/nope"), env as never, {} as ExecutionContext);
    assert.equal(res.status, 404);
  });
});
