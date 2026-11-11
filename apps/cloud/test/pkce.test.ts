/**
 * Tests for src/pkce.ts - PKCE (RFC 7636) code verifier generation and S256
 * challenge derivation for the Worker's own upstream OAuth *client* leg to
 * WordPress (see that file's docblock: this is a distinct PKCE pair from the
 * one @cloudflare/workers-oauth-provider verifies on the AI-client leg).
 *
 * Run: npx tsx --test test/pkce.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { generateCodeVerifier, deriveCodeChallenge } from "../src/pkce.js";

// RFC 7636 §4.1 / Appendix B unreserved characters allowed in a code
// verifier: ALPHA / DIGIT / "-" / "." / "_" / "~". This implementation only
// ever emits a subset of that (base64url has no "." or "~"), which RFC 7636
// explicitly permits - it just must not emit anything OUTSIDE the allowed set.
const RFC7636_UNRESERVED = /^[A-Za-z0-9\-._~]+$/;

describe("pkce: generateCodeVerifier", () => {
  test("uses only RFC 7636 unreserved characters", () => {
    for (let i = 0; i < 20; i++) {
      assert.match(generateCodeVerifier(), RFC7636_UNRESERVED);
    }
  });

  test("length is within RFC 7636's required 43-128 character range", () => {
    const verifier = generateCodeVerifier();
    assert.ok(verifier.length >= 43, `verifier too short: ${verifier.length}`);
    assert.ok(verifier.length <= 128, `verifier too long: ${verifier.length}`);
  });

  test("length is deterministic (32 random bytes -> 43-char base64url, unpadded)", () => {
    for (let i = 0; i < 10; i++) {
      assert.equal(generateCodeVerifier().length, 43);
    }
  });

  test("contains no base64 padding", () => {
    assert.ok(!generateCodeVerifier().includes("="));
  });

  test("successive calls produce different verifiers (backed by CSPRNG)", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateCodeVerifier()));
    assert.equal(seen.size, 50);
  });
});

describe("pkce: deriveCodeChallenge", () => {
  test("matches the RFC 7636 Appendix B.1 worked example exactly", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await deriveCodeChallenge(verifier);
    assert.equal(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("is the base64url(SHA-256(verifier)) for arbitrary verifiers, independently recomputed", async () => {
    for (const verifier of ["abc", "a-very-different-verifier-value-1234567890", generateCodeVerifier()]) {
      const expected = crypto
        .createHash("sha256")
        .update(verifier)
        .digest("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      assert.equal(await deriveCodeChallenge(verifier), expected);
    }
  });

  test("is deterministic for a given verifier", async () => {
    const verifier = generateCodeVerifier();
    const a = await deriveCodeChallenge(verifier);
    const b = await deriveCodeChallenge(verifier);
    assert.equal(a, b);
  });

  test("different verifiers produce different challenges", async () => {
    const a = await deriveCodeChallenge(generateCodeVerifier());
    const b = await deriveCodeChallenge(generateCodeVerifier());
    assert.notEqual(a, b);
  });

  test("does NOT implement the 'plain' method - the challenge is never the verifier itself", async () => {
    const verifier = generateCodeVerifier();
    const challenge = await deriveCodeChallenge(verifier);
    assert.notEqual(challenge, verifier);
  });

  test("challenge output uses base64url charset only (no +, /, or = padding)", async () => {
    const challenge = await deriveCodeChallenge(generateCodeVerifier());
    assert.doesNotMatch(challenge, /[+/=]/);
    assert.match(challenge, /^[A-Za-z0-9\-_]+$/);
  });
});
