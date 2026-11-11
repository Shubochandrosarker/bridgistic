/**
 * Tests for the one pure, isolable piece of src/default-handler.ts:
 * cleanSiteUrl(), which validates/normalizes the WordPress site URL an admin
 * types into the "Connect your WordPress site" form before it's used to
 * build the upstream /authorize redirect. It was module-private; exported
 * (behavior unchanged) purely so it's unit-testable without booting the
 * Durable Object / Worker runtime, which is out of scope for this pass -
 * see cloud/src/default-handler.ts's own top-of-file comment.
 *
 * Run: npx tsx --test test/default-handler.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { cleanSiteUrl } from "../src/default-handler.js";

describe("cleanSiteUrl", () => {
  test("accepts a plain https URL and returns its origin", () => {
    assert.equal(cleanSiteUrl("https://example.com"), "https://example.com");
  });

  test("strips path/query/fragment down to the origin", () => {
    assert.equal(cleanSiteUrl("https://example.com/wp-admin/?ref=1#frag"), "https://example.com");
  });

  test("trims surrounding whitespace before parsing", () => {
    assert.equal(cleanSiteUrl("  https://example.com  "), "https://example.com");
  });

  test("rejects a non-default port", () => {
    // Deliberate behaviour change in 1.2.0: a custom port is how an internal
    // service behind a proxy is normally addressed, and a public WordPress
    // install is on 443. Accepting arbitrary ports made the connect form a
    // port-scanning primitive against whatever the Worker can reach.
    assert.equal(cleanSiteUrl("https://example.com:8443/anything"), null);
  });

  test("keeps the default https port", () => {
    assert.equal(cleanSiteUrl("https://example.com:443/anything"), "https://example.com");
  });

  test("rejects http:// (only https is accepted)", () => {
    assert.equal(cleanSiteUrl("http://example.com"), null);
  });

  test("rejects non-URL garbage", () => {
    assert.equal(cleanSiteUrl("not a url"), null);
    assert.equal(cleanSiteUrl(""), null);
  });

  test("rejects other schemes (ftp, javascript, data)", () => {
    assert.equal(cleanSiteUrl("ftp://example.com"), null);
    assert.equal(cleanSiteUrl("javascript:alert(1)"), null);
    assert.equal(cleanSiteUrl("data:text/html,hi"), null);
  });

  test("is deterministic / idempotent for the same input", () => {
    const a = cleanSiteUrl("https://example.com/foo");
    const b = cleanSiteUrl("https://example.com/foo");
    assert.equal(a, b);
  });
});
