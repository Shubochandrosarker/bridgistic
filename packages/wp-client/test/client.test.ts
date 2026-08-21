import { test } from "node:test";
import assert from "node:assert/strict";
import { callBridge, BridgeRequestError, WP_NAMESPACE } from "../src/client.ts";
import type { Connection } from "../src/client.ts";
import { normalizeSiteUrl, isSameSite, InvalidSiteUrlError } from "../src/site-url.ts";

const conn: Connection = {
  alias: "acme",
  siteUrl: "https://acme.example",
  keyId: "wpk_abc",
  secret: "wps_shh",
};

function stubFetch(response: { status?: number; body: unknown | string }): {
  impl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const text = typeof response.body === "string" ? response.body : JSON.stringify(response.body);
    return new Response(text, { status: response.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("a GET is signed over the route path and unwraps the ok envelope", async () => {
  const { impl, calls } = stubFetch({ body: { ok: true, data: { name: "Acme" } } });
  const data = await callBridge(conn, "GET", "site-info", undefined, { fetchImpl: impl });

  assert.deepEqual(data, { name: "Acme" });
  assert.equal(calls[0]!.url, `https://acme.example/wp-json/${WP_NAMESPACE}/site-info`);

  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.ok(headers["X-Bridgistic-Signature"]);
  assert.equal(headers["X-Bridgistic-Key"], "wpk_abc");
  assert.equal(calls[0]!.init.body, undefined, "a GET carries no body");
});

test("a query string travels in the URL but is not part of the signed path", async () => {
  const { impl, calls } = stubFetch({ body: { ok: true, data: [] } });
  await callBridge(conn, "GET", "posts?per_page=5", undefined, { fetchImpl: impl });
  assert.ok(calls[0]!.url.endsWith("/posts?per_page=5"));
});

test("a request id is echoed on the wire so one report maps to one log line", async () => {
  const { impl, calls } = stubFetch({ body: { ok: true, data: {} } });
  await callBridge(conn, "GET", "site-info", undefined, { fetchImpl: impl, requestId: "req_1" });
  assert.equal((calls[0]!.init.headers as Record<string, string>)["X-Bridgistic-Request-Id"], "req_1");
});

test("a plugin error becomes an actionable BridgeRequestError", async () => {
  const { impl } = stubFetch({
    status: 403,
    body: { code: "bridgistic_scope_denied", message: "Scope db:write not granted." },
  });
  await assert.rejects(
    () => callBridge(conn, "POST", "db/query", { sql: "DELETE FROM x" }, { fetchImpl: impl }),
    (err: unknown) => {
      assert.ok(err instanceof BridgeRequestError);
      assert.equal(err.status, 403);
      assert.equal(err.code, "bridgistic_scope_denied");
      assert.match(err.message, /Mint a key with the needed scope/);
      assert.equal(err.isTransportFailure, false, "a signed 4xx is a denial, not a transport failure");
      return true;
    }
  );
});

test("a security plugin serving HTML is reported as such, not as a parse crash", async () => {
  const { impl } = stubFetch({ status: 200, body: "<html>blocked by firewall</html>" });
  await assert.rejects(
    () => callBridge(conn, "GET", "site-info", undefined, { fetchImpl: impl }),
    (err: unknown) => {
      assert.ok(err instanceof BridgeRequestError);
      assert.equal(err.code, "bad_response");
      return true;
    }
  );
});

test("unreachable is not denied", async () => {
  const impl = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;

  await assert.rejects(
    () => callBridge(conn, "GET", "site-info", undefined, { fetchImpl: impl }),
    (err: unknown) => {
      assert.ok(err instanceof BridgeRequestError);
      assert.equal(err.code, "network");
      assert.equal(err.isTransportFailure, true);
      return true;
    }
  );
});

test("site URLs normalise to one canonical form per site", () => {
  assert.equal(normalizeSiteUrl("https://Example.com/"), "https://example.com");
  assert.equal(normalizeSiteUrl("example.com"), "https://example.com");
  assert.equal(normalizeSiteUrl("https://example.com/blog/"), "https://example.com");
  assert.equal(normalizeSiteUrl("https://example.com:443"), "https://example.com");
  assert.equal(normalizeSiteUrl("https://example.com:8443"), "https://example.com:8443");
  assert.ok(isSameSite("EXAMPLE.com", "https://example.com/wp-admin"));
});

test("site URLs that would leak or downgrade are refused", () => {
  for (const bad of ["http://example.com", "ftp://example.com", "https://user:pw@example.com", "", "   "]) {
    assert.throws(() => normalizeSiteUrl(bad), InvalidSiteUrlError, `"${bad}" should be refused`);
  }
});
