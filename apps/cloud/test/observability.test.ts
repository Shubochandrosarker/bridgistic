/**
 * Tests for src/observability.ts.
 *
 * The value of a logging module is entirely in what it refuses to emit, so
 * these tests are mostly negative: given a log call, assert that no secret
 * material can appear in the output, and that tenant handles are one-way.
 *
 * Run: npx tsx --test test/observability.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { categorizeError, hashIdentifier, logEvent, newRequestId } from "../src/observability.js";

/** Capture whatever logEvent writes, without it reaching the test output. */
function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

describe("observability: request ids", () => {
  test("are unique per call", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newRequestId()));
    assert.equal(ids.size, 100);
  });

  test("look like a UUID, so they are recognisable in a support ticket", () => {
    assert.match(newRequestId(), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

describe("observability: tenant handles are one-way", () => {
  test("the same input always produces the same handle, so logs group correctly", async () => {
    const a = await hashIdentifier("tenant-abc");
    const b = await hashIdentifier("tenant-abc");
    assert.equal(a, b);
  });

  test("different inputs produce different handles", async () => {
    assert.notEqual(await hashIdentifier("tenant-abc"), await hashIdentifier("tenant-xyz"));
  });

  test("the handle does not contain the input", async () => {
    const handle = await hashIdentifier("https://customer-site.example");
    assert.ok(!handle.includes("customer"));
    assert.ok(!handle.includes("example"));
  });

  test("the handle is short hex, not a full digest that invites reversing by lookup", async () => {
    assert.match(await hashIdentifier("anything"), /^[0-9a-f]{12}$/);
  });

  test("a bearer token digest cannot be turned back into the token", async () => {
    const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.super-secret-token";
    const handle = await hashIdentifier(token);
    assert.ok(!handle.includes("secret"));
    assert.ok(!token.includes(handle));
  });
});

describe("observability: emitted lines carry no secret material", () => {
  test("only the declared fields are emitted", () => {
    const [line] = captureLog(() =>
      logEvent({ requestId: "req-1", route: "/mcp", result: "ok", status: 200, latencyMs: 12, tenant: "abc123def456" })
    );
    const parsed = JSON.parse(line);
    assert.deepEqual(
      Object.keys(parsed).sort(),
      ["latencyMs", "requestId", "result", "route", "status", "tenant", "ts"].sort()
    );
  });

  test("a log line is valid JSON on a single line, so it survives log shipping", () => {
    const [line] = captureLog(() => logEvent({ requestId: "req-2", route: "/authorize", result: "ok" }));
    assert.equal(line.includes("\n"), false);
    assert.doesNotThrow(() => JSON.parse(line));
  });

  test("an error category is a stable label, never the exception message", () => {
    // The message can carry the site URL or an upstream response body.
    const err = new Error("WordPress rejected the token exchange for https://customer.example (code wps_abc123)");
    const category = categorizeError(err);
    assert.equal(category, "upstream_rejected_grant");
    assert.ok(!category.includes("customer.example"));
    assert.ok(!category.includes("wps_"));
  });

  test("an unrecognised error collapses to a generic category rather than leaking its message", () => {
    assert.equal(categorizeError(new Error("secret=wps_deadbeef")), "upstream_error");
    assert.equal(categorizeError("a bare string with a token in it"), "upstream_error");
  });

  test("a timeout is distinguishable from a generic failure", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    assert.equal(categorizeError(abort), "upstream_timeout");
  });
});
