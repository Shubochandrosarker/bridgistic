/**
 * Redaction and logging.
 *
 * The tests that matter are the ones where the credential arrives somewhere
 * nobody expected: nested six levels deep, attached to an error's `.cause`,
 * inside a free-text message, or under a key called `detail`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { redact, redactString, findLeaks, REDACTED } from "../src/redact.ts";
import { Logger, requestIdFrom, errorClassOf } from "../src/log.ts";
import type { LogLine } from "../src/log.ts";

/**
 * The credential-shaped strings this suite needs live in their own file.
 *
 * Testing a redactor requires realistic secrets, and realistic secrets in
 * source are what a secret scanner is for. Keeping them in one small,
 * single-purpose JSON file means only that file is allowlisted — THIS file
 * stays scanned, so a real credential landing here still fails CI.
 */
const V = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "leak-vectors.json"), "utf8")
) as Record<string, string>;

const SECRET = V.wordpressKey!;
const KEY = V.bridgisticKey!;

// ------------------------------------------------------------- by key -------

test("credential-shaped keys are redacted at any depth", () => {
  const input = {
    a: { b: { c: { d: { password: "hunter2", apiKey: KEY, safe: "keep me" } } } },
  };
  const out = redact(input) as Record<string, any>;

  assert.equal(out.a.b.c.d.password, REDACTED);
  assert.equal(out.a.b.c.d.apiKey, REDACTED);
  assert.equal(out.a.b.c.d.safe, "keep me");
});

test("key matching is case- and separator-insensitive", () => {
  const out = redact({
    PASSWORD: "x",
    "X-Api-Key": "y",
    key_secret_enc: "z",
    clientSecret: "w",
    HMAC_Signature: "v",
    code_verifier: "u",
  }) as Record<string, unknown>;

  for (const key of Object.keys(out)) {
    assert.equal(out[key], REDACTED, `${key} was not redacted`);
  }
});

test("identifiers that merely look sensitive survive", () => {
  // Over-redaction is the right direction to be wrong in, but not so far that
  // the fields needed to debug an incident are gone.
  const out = redact({
    sessionId: "ses_123",
    request_digest: "deadbeef",
    enc_key_version: 2,
    token_count: 42,
    auth_method: "oauth",
  }) as Record<string, unknown>;

  assert.equal(out.sessionId, "ses_123");
  assert.equal(out.request_digest, "deadbeef");
  assert.equal(out.enc_key_version, 2);
  assert.equal(out.token_count, 42);
  assert.equal(out.auth_method, "oauth");
});

// ----------------------------------------------------------- by shape -------

test("credential-shaped VALUES are redacted under innocent keys", () => {
  // The leak is rarely under a key called `password`. It is under `detail`,
  // `raw`, `body`, or `note`.
  const out = redact({
    detail: `request failed with key ${KEY}`,
    note: `stored as ${SECRET}`,
    raw: `Authorization: ${V.bearerHeader}`,
  }) as Record<string, string | undefined>;

  assert.ok(!out.detail!.includes(KEY), "a Bridgistic key survived under `detail`");
  assert.ok(out.detail!.includes("[redacted:bridgistic-key]"));
  assert.ok(!out.note!.includes(SECRET));
  assert.ok(!out.raw!.includes("Bearer abcdefghij"));
});

test("every credential shape we know about is caught in free text", () => {
  const cases: [string, string][] = [
    ["a bridgistic key", KEY],
    ["a wordpress key", SECRET],
    ["an envelope (standard base64)", V.envelopeStandardBase64!],
    ["an envelope (base64url)", V.envelopeUrlSafeBase64!],
    ["a jwt", V.jwt!],
    ["a bearer header", V.bearerHeader!],
    ["a basic header", V.basicHeader!],
    // Joined at run time — see `$partsNote` in the vectors file.
    ["a stripe key", (V.stripeKeyParts as unknown as string[]).join("_")],
    ["credentials in a URL", V.urlWithCredentials!],
    ["a private key", V.privateKey!],
  ];

  for (const [label, secret] of cases) {
    const cleaned = redactString(`before ${secret} after`);
    assert.ok(!cleaned.includes(secret), `${label} survived redaction: ${cleaned}`);
    assert.ok(cleaned.includes("before") && cleaned.includes("after"), `${label} destroyed the context`);
  }
});

// --------------------------------------------------------- structures -------

test("errors are walked, including .cause, and the stack is dropped", () => {
  // `.cause` is where a request body most often ends up.
  const inner = new Error(`upstream rejected ${KEY}`);
  const outer = new Error("call failed", { cause: { body: SECRET, status: 500 } });

  const out = redact({ a: inner, b: outer }) as Record<string, any>;

  assert.equal(out.a.name, "Error");
  assert.ok(!out.a.message.includes(KEY));
  assert.equal(out.a.stack, undefined, "the stack carries file paths and sometimes arguments");
  assert.equal(out.b.cause.status, 500);
  assert.ok(!JSON.stringify(out.b).includes(SECRET), "a secret survived in .cause");
});

test("cycles, depth and size are all bounded", () => {
  const cyclic: Record<string, unknown> = { name: "root" };
  cyclic.self = cyclic;
  assert.equal((redact(cyclic) as any).self, "[circular]");

  let deep: unknown = "bottom";
  for (let i = 0; i < 20; i++) deep = { nested: deep };
  assert.ok(JSON.stringify(redact(deep)).includes("[depth exceeded]"));

  const long = redact({ items: Array.from({ length: 200 }, (_, i) => i) }) as any;
  assert.equal(long.items.length, 51);
  assert.match(String(long.items[50]), /150 more/);
});

test("a long string is truncated rather than trusted", () => {
  // A 40KB "message" is not a message. It is a response body somebody attached
  // to an error, and pattern-matching cannot reliably scan one.
  const body = "x".repeat(40_000);
  const out = redact({ message: body }) as Record<string, string | undefined>;
  assert.ok(out.message!.length < 700);
  assert.match(out.message!, /truncated 39\d\d\d chars/);
});

test("non-plain objects are summarised, never walked", () => {
  // Walking one could invoke a getter, which is arbitrary code inside the
  // logger — and getters are exactly where a lazily-decrypted credential lives.
  class Credential {
    get value(): string {
      throw new Error("a getter was invoked during logging");
    }
  }
  const out = redact({ cred: new Credential(), map: new Map([["k", SECRET]]), set: new Set([1]) }) as Record<string, unknown>;

  assert.equal(out.cred, "[Credential]");
  assert.equal(out.map, "[Map]");
  assert.equal(out.set, "[Set]");
});

test("functions, symbols and non-finite numbers do not pass through", () => {
  const out = redact({ fn: () => SECRET, sym: Symbol("x"), nan: NaN, inf: Infinity }) as Record<string, unknown>;
  assert.equal(out.fn, "[Function]");
  assert.equal(out.sym, "[Symbol]");
  assert.equal(out.nan, "NaN");
  assert.equal(out.inf, "Infinity");
});

test("null and undefined survive as themselves", () => {
  // They are meaningfully different from each other and from "[redacted]".
  const out = redact({ a: null, b: undefined, c: 0, d: false, e: "" }) as Record<string, unknown>;
  assert.equal(out.a, null);
  assert.equal(out.b, undefined);
  assert.equal(out.c, 0);
  assert.equal(out.d, false);
  assert.equal(out.e, "");
});

// ------------------------------------------------------------- logger -------

function capture(): { lines: LogLine[]; logger: Logger } {
  const lines: LogLine[] = [];
  const logger = new Logger({
    sink: (line) => lines.push(line),
    minLevel: "debug",
    now: () => new Date("2026-08-21T12:00:00.000Z"),
  });
  return { lines, logger };
}

test("a log line carries the identifying fields and nothing derived from a body", () => {
  const { lines, logger } = capture();
  logger.info("tool call completed", {
    requestId: "req_1",
    organizationId: "org_1",
    siteId: "site_1",
    tool: "bridgistic_list_posts",
    outcome: "success",
    durationMs: 42,
    requestDigest: "deadbeef",
  });

  const line = lines[0]!;
  assert.equal(line.level, "info");
  assert.equal(line.message, "tool call completed");
  assert.equal(line.organizationId, "org_1");
  assert.equal(line.requestDigest, "deadbeef");
  assert.equal(line.timestamp, "2026-08-21T12:00:00.000Z");
});

test("the message itself is redacted, not exempted", () => {
  // A message is a string somebody interpolated something into often enough
  // that exempting it would defeat the point.
  const { lines, logger } = capture();
  logger.warn(`could not authenticate with ${KEY}`);
  assert.ok(!lines[0]!.message.includes(KEY));
  assert.match(lines[0]!.message, /redacted:bridgistic-key/);
});

test("error() takes the error, so .cause goes through redaction", () => {
  const { lines, logger } = capture();
  logger.error("call failed", new Error("upstream said no", { cause: { authorization: `Bearer ${SECRET}` } }));

  const line = lines[0]!;
  assert.equal(line.errorClass, "Error");
  assert.deepEqual(findLeaks(line, [SECRET]), [], "a secret reached the log line");
});

test("child loggers merge fields and do not leak between siblings", () => {
  const { lines, logger } = capture();
  const request = logger.child({ requestId: "req_1", organizationId: "org_1" });
  request.child({ siteId: "site_a" }).info("a");
  request.child({ siteId: "site_b" }).info("b");

  assert.equal(lines[0]!.siteId, "site_a");
  assert.equal(lines[1]!.siteId, "site_b");
  assert.equal(lines[0]!.requestId, "req_1");
  assert.equal(lines[1]!.organizationId, "org_1");
});

test("level filtering drops what it should", () => {
  const lines: LogLine[] = [];
  const logger = new Logger({ sink: (l) => lines.push(l), minLevel: "warn" });
  logger.debug("no");
  logger.info("no");
  logger.warn("yes");
  logger.error("yes");
  assert.deepEqual(lines.map((l) => l.level), ["warn", "error"]);
});

test("a caller-supplied request id is bounded, or replaced", () => {
  // An id flows into every line for the request. An unbounded one is a way to
  // write arbitrary content into the log — newlines included, which is how a
  // forged entry gets injected next to a real one.
  assert.equal(requestIdFrom("req_abc12345"), "req_abc12345");

  for (const bad of ["short", "x".repeat(65), "has spaces", "with\nnewline", "semi;colon", ""]) {
    const id = requestIdFrom(bad);
    assert.notEqual(id, bad, `${JSON.stringify(bad)} was accepted as a request id`);
    assert.match(id, /^[0-9a-f-]{36}$/);
  }
  assert.match(requestIdFrom(null), /^[0-9a-f-]{36}$/);
});

test("errorClassOf groups without exposing the message", () => {
  class TimeoutError extends Error {}
  assert.equal(errorClassOf(new TimeoutError("took too long")), "TimeoutError");
  assert.equal(errorClassOf("a string"), "string");
  assert.equal(errorClassOf(undefined), undefined);
});

test("a realistic failure payload leaks nothing", () => {
  // The end-to-end shape: everything an executor might attach when a call
  // fails, run through the logger, checked for every secret in it.
  const { lines, logger } = capture();
  logger.error(
    "wordpress call failed",
    new Error("502 from site", {
      cause: {
        request: { headers: { authorization: `Bearer ${SECRET}` }, body: { sql: "SELECT user_pass FROM wp_users" } },
        site: { url: V.urlWithCredentials, key_secret_enc: V.envelopeStandardBase64 },
        apiKey: KEY,
      },
    }),
    { organizationId: "org_1", siteId: "site_1", tool: "bridgistic_db_query" }
  );

  assert.deepEqual(
    findLeaks(lines[0], [SECRET, KEY, V.urlPassword!, V.envelopeStandardBase64!]),
    [],
    "something that must never be logged reached the log line"
  );
  // The useful parts survive.
  assert.equal(lines[0]!.siteId, "site_1");
  assert.equal(lines[0]!.tool, "bridgistic_db_query");
});
