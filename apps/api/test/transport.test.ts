/**
 * The signed transport.
 *
 * The tests are about the boundary rather than the happy path: what happens
 * when the site returns too much, redirects, hangs, or cannot be decrypted.
 * Each of those decides whether a customer is charged, and one of them decides
 * whether a Worker survives.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { WordPressTransport, stripPlatformArgs, toTransportResult, MAX_RESPONSE_BYTES } from "../src/transport.ts";
import { adapt, migratedDatabase } from "./helpers/sqlite.ts";
import { encryptSecret } from "@bridgistic/crypto";
import { contractFor } from "@bridgistic/contracts";
import { BridgeRequestError } from "@bridgistic/wp-client";
import type { SqlDatabase } from "../src/db/scope.ts";
import type { TransportRequest } from "@bridgistic/executor";

const NOW = 1_800_000_000;
const ENC_KEY = btoa("bridgistic-test-key-never-real!!");

let db: DatabaseSync;
let sql: SqlDatabase;

beforeEach(async () => {
  db = migratedDatabase();
  sql = adapt(db);
  db.exec(`
    INSERT INTO organizations (id,name,slug,wpistic_org_id,created_at,updated_at)
      VALUES ('org_1','Acme','acme',NULL,${NOW},${NOW}),
             ('org_2','Evil','evil',NULL,${NOW},${NOW});
    INSERT INTO sites (id,organization_id,site_url,label,key_id,key_secret_enc,enc_key_version,key_scopes,health,plugin_version,created_at,last_seen_at)
      VALUES ('site_1','org_1','https://shop.example',NULL,'wpk_1','placeholder',1,'["posts:read"]','healthy',NULL,${NOW},NULL),
             ('site_nocred','org_1','https://other.example',NULL,'wpk_2','placeholder',1,'[]','healthy',NULL,${NOW},NULL),
             ('site_other_org','org_2','https://victim.example',NULL,'wpk_3','placeholder',1,'["posts:read"]','healthy',NULL,${NOW},NULL);
  `);

  // Credentials are written explicitly. 0007's backfill only covers sites that
  // existed when it ran; a site connected afterwards gets its credential row
  // from the connection flow, which is what this fixture stands in for.
  // site_nocred deliberately gets none, so "no live credential" is exercised.
  const sealed = await encryptSecret("wpk_secret_value", ENC_KEY);
  db.prepare(
    `INSERT INTO site_credentials (site_id,version,key_id,key_secret_enc,enc_key_version,created_at,retired_at)
     VALUES ('site_1',1,'wpk_1',?,1,?,NULL)`
  ).run(sealed, NOW);

  // A live, decryptable credential on the OTHER organization's site, so the
  // cross-tenant test fails for the right reason: the only thing between org_1
  // and this credential is the organization scope, not a missing row.
  db.prepare(
    `INSERT INTO site_credentials (site_id,version,key_id,key_secret_enc,enc_key_version,created_at,retired_at)
     VALUES ('site_other_org',1,'wpk_3',?,1,?,NULL)`
  ).run(sealed, NOW);
});

function transport(fetchImpl: typeof fetch, maxResponseBytes?: number) {
  return new WordPressTransport({
    db: sql,
    encryptionKey: ENC_KEY,
    fetchImpl,
    ...(maxResponseBytes !== undefined ? { maxResponseBytes } : {}),
  });
}

function req(overrides: Partial<TransportRequest> = {}): TransportRequest {
  return {
    organizationId: "org_1",
    siteId: "site_1",
    contract: contractFor("bridgistic_list_posts")!,
    args: { site: "shop" },
    requestId: "req_1",
    timeoutMs: 5_000,
    ...overrides,
  };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify({ ok: true, data: body }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

// --------------------------------------------------------------- signing ---

test("a call is signed and reaches the site's stored origin", async () => {
  let seenUrl = "";
  let seenHeaders: Headers | undefined;

  const result = await transport(async (input, init) => {
    seenUrl = String(input);
    seenHeaders = new Headers(init?.headers);
    return ok({ posts: [] });
  }).call(req());

  assert.equal(result.ok, true);
  assert.ok(seenUrl.startsWith("https://shop.example/wp-json/bridgistic/v1/"), `went to ${seenUrl}`);
  assert.ok(seenHeaders?.get("X-Bridgistic-Signature"), "the request was not signed");
  assert.ok(seenHeaders?.get("X-Bridgistic-Key"), "no key id");
  assert.equal(seenHeaders?.get("X-Bridgistic-Request-Id"), "req_1");
});

test("the secret never appears in the request", async () => {
  let serialised = "";
  await transport(async (input, init) => {
    serialised = `${String(input)} ${JSON.stringify([...new Headers(init?.headers)])} ${String(init?.body ?? "")}`;
    return ok({});
  }).call(req());

  assert.ok(!serialised.includes("wpk_secret_value"), "the decrypted secret reached the wire");
});

test("platform arguments are not forwarded to the plugin", async () => {
  // `idempotency_key` and `approval_id` are consumed by the executor and the
  // gate. Forwarding them would have the plugin reject an argument it does not
  // know, and put a platform concern on the site's wire.
  let body = "";
  await transport(async (_input, init) => {
    body = String(init?.body ?? "");
    return ok({});
  }).call(
    req({
      contract: contractFor("bridgistic_create_post")!,
      args: { site: "shop", title: "Hello", idempotency_key: "idem-1", approval_id: "approval-1" },
    })
  );

  assert.ok(body.includes("Hello"));
  assert.ok(!body.includes("idem-1"), "idempotency_key was forwarded");
  assert.ok(!body.includes("approval-1"), "approval_id was forwarded");
});

test("stripPlatformArgs keeps tool arguments and drops platform ones", () => {
  assert.deepEqual(
    stripPlatformArgs({ site: "shop", title: "x", idempotency_key: "k", approval_id: "a", dry_run: true }),
    { title: "x", dry_run: true }
  );
});

// ------------------------------------------------------------ boundaries ---

test("a redirect is refused rather than followed", async () => {
  // A signed request replayed to wherever a redirect points arrives with valid
  // credentials attached, and "same origin" does not survive an open redirect
  // on the site itself — which WordPress plugins produce routinely.
  const result = await transport(
    async () => new Response(null, { status: 302, headers: { Location: "https://evil.example/steal" } })
  ).call(req());

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "site_error");
  assert.match(result.ok === false ? result.message : "", /does not follow redirects/);
});

test("redirect handling is requested as manual, so the runtime cannot chase one", async () => {
  let redirectMode: RequestInit["redirect"];
  await transport(async (_input, init) => {
    redirectMode = init?.redirect;
    return ok({});
  }).call(req());
  assert.equal(redirectMode, "manual");
});

test("an oversized response is refused by its declared length", async () => {
  const result = await transport(
    async () =>
      new Response("{}", {
        status: 200,
        headers: { "Content-Length": String(MAX_RESPONSE_BYTES + 1), "Content-Type": "application/json" },
      }),
    1_000
  ).call(req());

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "too_large");
});

test("an oversized response is refused even when it lies about its length", async () => {
  // A Content-Length can be absent, wrong, or absent under chunked encoding,
  // which is exactly when a body is worth bounding. Without the streamed check
  // the whole thing is already in memory by the time anything notices.
  const big = "x".repeat(50_000);
  const result = await transport(
    async () =>
      new Response(big, {
        status: 200,
        // Understated on purpose.
        headers: { "Content-Length": "2", "Content-Type": "application/json" },
      }),
    1_000
  ).call(req());

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "too_large");
});

test("a response just under the cap is fine", async () => {
  const payload = { data: "y".repeat(500) };
  const result = await transport(async () => ok(payload), 100_000).call(req());
  assert.equal(result.ok, true);
});

// -------------------------------------------------------------- failures ---

test("unreachable is distinguished from a site error, because they bill differently", async () => {
  const unreachable = await transport(async () => {
    throw new TypeError("fetch failed");
  }).call(req());
  assert.equal(unreachable.ok === false && unreachable.kind, "unreachable");

  const siteError = await transport(
    async () =>
      new Response(JSON.stringify({ code: "bridgistic_scope_denied", message: "nope" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
  ).call(req());
  assert.equal(siteError.ok === false && siteError.kind, "site_error");
});

test("a timeout is its own outcome", async () => {
  const result = await transport(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })
  ).call(req({ timeoutMs: 20 }));

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "timeout");
});

test("a non-JSON response is a site error, not a crash", async () => {
  // A security plugin or a cache returning an HTML block page is the common
  // case, and it must not throw out of the transport.
  const result = await transport(
    async () => new Response("<html>Blocked by firewall</html>", { status: 200 })
  ).call(req());

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "site_error");
});

test("a site with no live credential is unreachable, not a site error", async () => {
  // We never got as far as the site, and the executor charges those
  // differently.
  const result = await transport(async () => ok({})).call(req({ siteId: "site_nocred" }));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "unreachable");
  assert.match(result.ok === false ? result.message : "", /no live credential/);
});

test("an undecryptable credential does not leak key material into the error", async () => {
  // Almost always TENANT_ENC_KEY rotated without the re-encrypt walk. The
  // error must not carry the envelope or the key.
  const wrongKey = new WordPressTransport({
    db: sql,
    encryptionKey: btoa("bridgistic-other-key-never-real!"),
    fetchImpl: async () => ok({}),
  });
  const result = await wrongKey.call(req());

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "unreachable");
  const message = result.ok === false ? result.message : "";
  assert.ok(!message.includes("aes256gcm"));
  assert.ok(!message.includes("bridgistic-other-key"));
});

test("another organization's site is unreachable even with a live credential", async () => {
  // The executor authorises the site before the transport sees it, so this is
  // the second lock on the same door. It exists because the failure it prevents
  // is not a data leak: a signed call to another tenant's site is code
  // execution on somebody else's business.
  let called = false;
  const result = await transport(async () => {
    called = true;
    return ok({});
  }).call(req({ siteId: "site_other_org" }));

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "unreachable");
  assert.equal(called, false, "a signed request went to another tenant's site");

  // Indistinguishable from a site that does not exist, so the transport is not
  // an existence oracle for site ids.
  const missing = await transport(async () => ok({})).call(req({ siteId: "site_nope" }));
  assert.equal(
    result.ok === false ? result.message : "x",
    missing.ok === false ? missing.message : "y"
  );

  // …and the same site IS reachable from the organization that owns it, so
  // this is isolation and not breakage.
  const owner = await transport(async () => ok({})).call(
    req({ organizationId: "org_2", siteId: "site_other_org" })
  );
  assert.equal(owner.ok, true);
});

test("an unknown site is unreachable rather than an exception", async () => {
  const result = await transport(async () => ok({})).call(req({ siteId: "site_does_not_exist" }));
  assert.equal(result.ok === false && result.kind, "unreachable");
});

test("a platform-local tool never reaches the transport's site path", async () => {
  const result = await transport(async () => ok({})).call(
    req({ contract: contractFor("bridgistic_list_sites")!, args: {} })
  );
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.message : "", /does not call the site/);
});

// --------------------------------------------------------------- mapping ---

test("the error mapping covers every code the client can raise", () => {
  const cases: [string, string][] = [
    ["timeout", "timeout"],
    ["network", "unreachable"],
    ["response_too_large", "too_large"],
    ["redirect_refused", "site_error"],
    ["bad_response", "site_error"],
    ["bridgistic_scope_denied", "site_error"],
    ["http_error", "site_error"],
  ];
  for (const [code, expected] of cases) {
    const result = toTransportResult(new BridgeRequestError("m", 500, code));
    assert.equal(result.ok === false && result.kind, expected, `${code} mapped wrong`);
  }

  // Anything that is not a BridgeRequestError must still produce a safe result
  // rather than propagating.
  const unknown = toTransportResult(new Error("connection to 10.0.0.5 failed with password=hunter2"));
  assert.equal(unknown.ok === false && unknown.kind, "site_error");
  assert.ok(unknown.ok === false && !unknown.message.includes("hunter2"));
  assert.ok(unknown.ok === false && !unknown.message.includes("10.0.0.5"));
});
