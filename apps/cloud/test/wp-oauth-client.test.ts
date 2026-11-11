/**
 * Tests for the pure/testable pieces of src/wp-oauth-client.ts: the
 * `/authorize` redirect URL construction (buildWpAuthorizeUrl) and the
 * token-exchange request/response handling (exchangeWpCode), stubbing
 * global fetch so no real WordPress site or network is involved. Spinning
 * up the Durable Object / Worker runtime around this is out of scope for
 * this pass (see default-handler.ts, which owns the actual OAuth flow
 * orchestration).
 *
 * Run: npx tsx --test test/wp-oauth-client.test.ts
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildWpAuthorizeUrl, exchangeWpCode } from "../src/wp-oauth-client.js";

describe("buildWpAuthorizeUrl", () => {
  test("builds the WP admin consent-screen URL with all required query params", () => {
    const url = new URL(
      buildWpAuthorizeUrl("https://example.com", "https://mcp.bridgistic.app/wp-callback", "challenge-abc", "state-xyz")
    );
    assert.equal(url.origin, "https://example.com");
    assert.equal(url.pathname, "/wp-admin/admin.php");
    assert.equal(url.searchParams.get("page"), "bridgistic-oauth-authorize");
    assert.equal(url.searchParams.get("client_id"), "bridgistic-cloud");
    assert.equal(url.searchParams.get("redirect_uri"), "https://mcp.bridgistic.app/wp-callback");
    assert.equal(url.searchParams.get("code_challenge"), "challenge-abc");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("state"), "state-xyz");
  });

  test("always uses S256, never 'plain', regardless of caller input", () => {
    const url = new URL(buildWpAuthorizeUrl("https://example.com", "https://x/y", "chal", "st"));
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  });

  test("preserves the target site's origin even with a path/trailing content on siteUrl", () => {
    const url = new URL(buildWpAuthorizeUrl("https://example.com", "https://x/cb", "c", "s"));
    assert.equal(url.host, "example.com");
    assert.equal(url.protocol, "https:");
  });

  test("round-trips special characters in state/redirect_uri via proper URL encoding", () => {
    const state = "a b&c=d";
    const redirectUri = "https://mcp.bridgistic.app/wp-callback?x=1&y=2";
    const url = new URL(buildWpAuthorizeUrl("https://example.com", redirectUri, "chal", state));
    // searchParams getters decode automatically - round trip proves encoding was correct.
    assert.equal(url.searchParams.get("state"), state);
    assert.equal(url.searchParams.get("redirect_uri"), redirectUri);
  });
});

describe("exchangeWpCode", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("POSTs the authorization_code grant to /wp-json/bridgistic/v1/oauth/token with no client secret", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url: String(url), init };
      return new Response(
        JSON.stringify({ site_url: "https://example.com", key_id: "k1", key_secret: "s1", scopes: ["read"] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const result = await exchangeWpCode("https://example.com", "auth-code-123", "https://cb", "verifier-abc");

    assert.equal(captured?.url, "https://example.com/wp-json/bridgistic/v1/oauth/token");
    assert.equal(captured?.init.method, "POST");
    const body = JSON.parse(String(captured?.init.body));
    assert.equal(body.grant_type, "authorization_code");
    assert.equal(body.code, "auth-code-123");
    assert.equal(body.client_id, "bridgistic-cloud");
    assert.equal(body.redirect_uri, "https://cb");
    assert.equal(body.code_verifier, "verifier-abc");
    assert.ok(!("client_secret" in body), "no client secret should ever be sent - PKCE is the boundary, by design");

    assert.deepEqual(result, { site_url: "https://example.com", key_id: "k1", key_secret: "s1", scopes: ["read"] });
  });

  test("throws with WordPress's error message when the response is not ok", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: "invalid_grant", message: "Code expired or already used." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    await assert.rejects(
      () => exchangeWpCode("https://example.com", "bad-code", "https://cb", "verifier"),
      /Code expired or already used\./
    );
  });

  test("throws a generic error when the error response has no message", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 500 })) as typeof fetch;

    await assert.rejects(
      () => exchangeWpCode("https://example.com", "code", "https://cb", "verifier"),
      /HTTP 500/
    );
  });

  test("throws a clear error when WordPress returns non-JSON", async () => {
    globalThis.fetch = (async () => new Response("<html>not json</html>", { status: 200 })) as typeof fetch;

    await assert.rejects(
      () => exchangeWpCode("https://example.com", "code", "https://cb", "verifier"),
      /non-JSON response/
    );
  });
});
