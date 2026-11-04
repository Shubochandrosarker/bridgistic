import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { signRequest, canonicalString, sha256Hex } from "../src/signer.ts";

/**
 * An independent implementation of the PHP verifier's algorithm, written with
 * node:crypto rather than WebCrypto. If these two ever disagree, every signed
 * request in the field fails — so the check is deliberately not a re-run of the
 * same code path.
 */
function referenceSignature(
  method: string,
  path: string,
  body: string,
  secret: string,
  timestamp: string,
  nonce: string
): string {
  const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
  const canonical = [method.toUpperCase(), path, timestamp, nonce, bodyHash].join("\n");
  return createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

test("WebCrypto signing matches the reference implementation", async () => {
  const cases: Array<[string, string, string]> = [
    ["GET", "/bridgistic/v1/site-info", ""],
    ["POST", "/bridgistic/v1/db/query", JSON.stringify({ sql: "SELECT 1" })],
    ["DELETE", "/bridgistic/v1/posts/42", ""],
    ["POST", "/bridgistic/v1/execute", JSON.stringify({ code: 'return "héllo — ünicode";' })],
  ];

  for (const [method, path, body] of cases) {
    const headers = await signRequest(method, path, body, "wpk_test", "wps_secret", {
      timestamp: 1_800_000_000,
      nonce: "0".repeat(32),
    });
    assert.equal(
      headers["X-Bridgistic-Signature"],
      referenceSignature(method, path, body, "wps_secret", "1800000000", "0".repeat(32)),
      `${method} ${path}`
    );
  }
});

test("the canonical string is exactly five newline-joined fields", () => {
  assert.equal(
    canonicalString("get", "/bridgistic/v1/site-info", "1800000000", "abc", "def"),
    "GET\n/bridgistic/v1/site-info\n1800000000\nabc\ndef"
  );
});

test("an empty body hashes to the sha256 of the empty string", async () => {
  assert.equal(await sha256Hex(""), createHash("sha256").update("").digest("hex"));
});

test("nonces and timestamps are fresh by default", async () => {
  const a = await signRequest("GET", "/x", "", "k", "s");
  const b = await signRequest("GET", "/x", "", "k", "s");
  assert.notEqual(a["X-Bridgistic-Nonce"], b["X-Bridgistic-Nonce"], "nonces are single-use");
  assert.match(a["X-Bridgistic-Nonce"], /^[0-9a-f]{32}$/);
  assert.ok(Math.abs(Number(a["X-Bridgistic-Timestamp"]) - Math.floor(Date.now() / 1000)) <= 2);
});

test("the secret never appears in the headers", async () => {
  const headers = await signRequest("GET", "/x", "", "wpk_id", "wps_supersecret");
  assert.ok(!JSON.stringify(headers).includes("wps_supersecret"));
});
