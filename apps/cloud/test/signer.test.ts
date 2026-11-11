/**
 * Tests for src/services/signer.ts - HMAC request signing shared verbatim
 * with mcp-server/src/services/signer.ts (the two files are byte-identical;
 * see cloud/README.md: "src/services/signer.ts ... [is] copied unchanged").
 * mcp-server/evals/integration.test.mjs already exercises this indirectly by
 * re-verifying signatures the same way the PHP plugin does
 * (`includes/security/class-hmac-verifier.php`); these tests apply that same
 * independent-reverification technique directly against signRequest(), plus
 * dedicated coverage of canonical-string sensitivity to each input.
 *
 * Per the file's own docblock, the canonical format is:
 *   METHOD \n PATH \n TIMESTAMP \n NONCE \n sha256(body)
 *   signature = HMAC-SHA256(secret, canonical), lowercase hex
 *
 * Run: npx tsx --test test/signer.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { signRequest } from "../src/services/signer.js";

const KEY_ID = "k_test123";
const SECRET = "s_test_secret_value_1234567890";

/** Independent reimplementation of the documented canonical format, used to
 *  cross-check signRequest()'s real output (test 1) before being trusted as
 *  an oracle for sensitivity checks (test 2+). */
function expectedSignature(method: string, path: string, timestamp: string, nonce: string, body: string, secret: string): string {
  const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
  const canonical = [method.toUpperCase(), path, timestamp, nonce, bodyHash].join("\n");
  return createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

describe("signRequest: header shape", () => {
  test("returns all four expected headers with the right key id", () => {
    const headers = signRequest("GET", "/bridgistic/v1/site-info", "", KEY_ID, SECRET);
    assert.equal(headers["X-Bridgistic-Key"], KEY_ID);
    assert.match(headers["X-Bridgistic-Timestamp"], /^\d+$/);
    assert.match(headers["X-Bridgistic-Nonce"], /^[0-9a-f]{32}$/); // 16 random bytes, hex
    assert.match(headers["X-Bridgistic-Signature"], /^[0-9a-f]{64}$/); // sha256 hmac, hex
  });

  test("nonce is randomized on every call, even for identical inputs", () => {
    const a = signRequest("GET", "/x", "", KEY_ID, SECRET);
    const b = signRequest("GET", "/x", "", KEY_ID, SECRET);
    assert.notEqual(a["X-Bridgistic-Nonce"], b["X-Bridgistic-Nonce"]);
    assert.notEqual(a["X-Bridgistic-Signature"], b["X-Bridgistic-Signature"]);
  });
});

describe("signRequest: canonical string construction", () => {
  test("signature matches independently-recomputed HMAC over METHOD\\nPATH\\nTS\\nNONCE\\nsha256(body)", () => {
    const cases: Array<[string, string, string]> = [
      ["GET", "/bridgistic/v1/site-info", ""],
      ["POST", "/bridgistic/v1/posts", JSON.stringify({ title: "hi" })],
      ["DELETE", "/bridgistic/v1/posts/42", JSON.stringify({ force: true })],
      ["put", "/bridgistic/v1/options/foo", "{}"], // lowercase method input
    ];
    for (const [method, path, body] of cases) {
      const headers = signRequest(method, path, body, KEY_ID, SECRET);
      const expected = expectedSignature(
        method,
        path,
        headers["X-Bridgistic-Timestamp"],
        headers["X-Bridgistic-Nonce"],
        body,
        SECRET
      );
      assert.equal(headers["X-Bridgistic-Signature"], expected);
    }
  });

  test("method is uppercased in the canonical string (raw-case input would sign differently)", () => {
    const headers = signRequest("get", "/x", "", KEY_ID, SECRET);
    const bodyHash = createHash("sha256").update("", "utf8").digest("hex");

    // Hypothesis A: signRequest signs the method as-received ("get"), unmodified.
    const canonicalRawCase = ["get", "/x", headers["X-Bridgistic-Timestamp"], headers["X-Bridgistic-Nonce"], bodyHash].join("\n");
    const signatureIfNotUppercased = createHmac("sha256", SECRET).update(canonicalRawCase, "utf8").digest("hex");

    // Hypothesis B (per the docblock): signRequest uppercases the method first.
    const canonicalUppercased = ["GET", "/x", headers["X-Bridgistic-Timestamp"], headers["X-Bridgistic-Nonce"], bodyHash].join("\n");
    const signatureIfUppercased = createHmac("sha256", SECRET).update(canonicalUppercased, "utf8").digest("hex");

    assert.notEqual(signatureIfNotUppercased, signatureIfUppercased, "test sanity: the two hypotheses must be distinguishable");
    assert.equal(headers["X-Bridgistic-Signature"], signatureIfUppercased);
  });
});

// The oracle above is proven equivalent to signRequest()'s real algorithm by
// the tests in the previous block, so it's used here as a controlled
// substitute for signRequest() itself: signRequest() cannot be called with
// an explicit timestamp/nonce (it always generates fresh random ones), which
// would otherwise make it impossible to hold every other input fixed while
// varying exactly one.
describe("signRequest: canonical string is sensitive to every input", () => {
  const base = { method: "POST", path: "/bridgistic/v1/posts", timestamp: "1700000000", nonce: "aa".repeat(16), body: "{}" };

  test("changing method changes the signature", () => {
    const a = expectedSignature(base.method, base.path, base.timestamp, base.nonce, base.body, SECRET);
    const b = expectedSignature("GET", base.path, base.timestamp, base.nonce, base.body, SECRET);
    assert.notEqual(a, b);
  });

  test("changing path changes the signature", () => {
    const a = expectedSignature(base.method, base.path, base.timestamp, base.nonce, base.body, SECRET);
    const b = expectedSignature(base.method, "/bridgistic/v1/posts/99", base.timestamp, base.nonce, base.body, SECRET);
    assert.notEqual(a, b);
  });

  test("changing timestamp changes the signature", () => {
    const a = expectedSignature(base.method, base.path, base.timestamp, base.nonce, base.body, SECRET);
    const b = expectedSignature(base.method, base.path, "1700000001", base.nonce, base.body, SECRET);
    assert.notEqual(a, b);
  });

  test("changing nonce changes the signature", () => {
    const a = expectedSignature(base.method, base.path, base.timestamp, base.nonce, base.body, SECRET);
    const b = expectedSignature(base.method, base.path, base.timestamp, "bb".repeat(16), base.body, SECRET);
    assert.notEqual(a, b);
  });

  test("changing body changes the signature", () => {
    const a = expectedSignature(base.method, base.path, base.timestamp, base.nonce, base.body, SECRET);
    const b = expectedSignature(base.method, base.path, base.timestamp, base.nonce, '{"title":"changed"}', SECRET);
    assert.notEqual(a, b);
  });

  test("changing the secret changes the signature (but not the canonical string)", () => {
    const a = expectedSignature(base.method, base.path, base.timestamp, base.nonce, base.body, SECRET);
    const b = expectedSignature(base.method, base.path, base.timestamp, base.nonce, base.body, "a-totally-different-secret");
    assert.notEqual(a, b);
  });

  test("confirms this sensitivity oracle is genuinely exercising signRequest()'s real algorithm, not a divergent one", () => {
    // Re-derive the same case through the real function and check equality,
    // tying this describe block back to the real source under test.
    const headers = signRequest(base.method, base.path, base.body, KEY_ID, SECRET);
    const viaOracle = expectedSignature(base.method, base.path, headers["X-Bridgistic-Timestamp"], headers["X-Bridgistic-Nonce"], base.body, SECRET);
    assert.equal(headers["X-Bridgistic-Signature"], viaOracle);
  });
});

describe("signRequest: key_id is transmitted but not part of the signed canonical string", () => {
  test("keyId does not affect the signature, only the X-Bridgistic-Key header value", () => {
    // Documents actual behavior per the docblock: the canonical string is
    // METHOD\nPATH\nTIMESTAMP\nNONCE\nsha256(body) - keyId is NOT one of its
    // components, it's only carried as the X-Bridgistic-Key header value so
    // WordPress knows which key's secret to verify against.
    const headers = signRequest("GET", "/x", "", "k_one", SECRET);
    const recomputedWithDifferentKeyIdSameSecret = expectedSignature(
      "GET",
      "/x",
      headers["X-Bridgistic-Timestamp"],
      headers["X-Bridgistic-Nonce"],
      "",
      SECRET
    );
    // Signature depends only on method/path/timestamp/nonce/body/secret.
    assert.equal(headers["X-Bridgistic-Signature"], recomputedWithDifferentKeyIdSameSecret);
    assert.equal(headers["X-Bridgistic-Key"], "k_one");
  });
});
