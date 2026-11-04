import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, compileSchema } from "../src/json-schema.ts";
import type { JsonSchema } from "../src/json-schema.ts";

const ok = (schema: JsonSchema, value: unknown) => validate(schema, value).valid;
const errs = (schema: JsonSchema, value: unknown) => validate(schema, value).errors;

// ------------------------------------------------------------------ types --

test("types are checked strictly, including the JSON/JS mismatches", () => {
  assert.ok(ok({ type: "string" }, "x"));
  assert.ok(!ok({ type: "string" }, 1));

  // `typeof null === "object"` is the classic way an object check lets null
  // through, and null reaching a property access is a 500.
  assert.ok(!ok({ type: "object" }, null));
  assert.ok(ok({ type: "null" }, null));

  // An array is an object to `typeof`, so an object schema must reject it or
  // `{...args}` silently produces `{0: …, 1: …}`.
  assert.ok(!ok({ type: "object" }, [1, 2]));
  assert.ok(ok({ type: "array" }, [1, 2]));

  assert.ok(ok({ type: "integer" }, 5));
  assert.ok(!ok({ type: "integer" }, 5.5));
  assert.ok(ok({ type: "number" }, 5.5));
});

test("NaN and Infinity are not numbers as far as a meter is concerned", () => {
  // They cannot arrive in JSON, but they can arrive from our own arithmetic,
  // and a quota check against NaN passes every comparison it is given.
  assert.ok(!ok({ type: "number" }, Number.NaN));
  assert.ok(!ok({ type: "number" }, Number.POSITIVE_INFINITY));
  assert.ok(!ok({ type: "integer" }, Number.NaN));
  assert.match(errs({ type: "number" }, Number.NaN)[0]!.message, /non-finite/);
});

test("a wrong type reports once, not once per keyword", () => {
  // A caller who sent a string where a number goes should get one clear error,
  // not that plus "must be >= 1" plus "must be <= 100".
  const schema: JsonSchema = { type: "integer", minimum: 1, maximum: 100 };
  assert.equal(errs(schema, "nope").length, 1);
});

// ------------------------------------------------------------- properties --

test("required and additionalProperties are both enforced", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: { a: { type: "string" }, b: { type: "integer" } },
    required: ["a"],
    additionalProperties: false,
  };
  assert.ok(ok(schema, { a: "x" }));
  assert.ok(ok(schema, { a: "x", b: 1 }));
  assert.ok(!ok(schema, { b: 1 }), "missing required");
  assert.ok(!ok(schema, { a: "x", c: true }), "unknown property");

  const e = errs(schema, { a: "x", c: true });
  assert.equal(e[0]!.path, "/c");
  assert.match(e[0]!.message, /not a permitted property/);
});

test("a property present but undefined still counts as present", () => {
  // `{a: undefined}` has the key. JSON cannot express it, but our own code can
  // build it, and treating it as absent would let a required field through as
  // undefined.
  const schema: JsonSchema = {
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a"],
  };
  assert.ok(!ok(schema, { a: undefined }), "undefined is not a string");
});

test("a prototype-polluting key is an unknown property like any other", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: { a: { type: "string" } },
    additionalProperties: false,
  };
  assert.ok(!ok(schema, JSON.parse('{"a":"x","__proto__":{"admin":true}}')));
  assert.ok(!ok(schema, JSON.parse('{"a":"x","constructor":{}}')));
});

test("required uses hasOwn, so an inherited property does not satisfy it", () => {
  const schema: JsonSchema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
  const inherited = Object.create({ a: "from the prototype" }) as Record<string, unknown>;
  assert.ok(!ok(schema, inherited), "a prototype's property is not the object's own");
});

// ------------------------------------------------------------------ bounds --

test("numeric bounds, inclusive and exclusive", () => {
  assert.ok(ok({ type: "integer", minimum: 1, maximum: 10 }, 1));
  assert.ok(ok({ type: "integer", minimum: 1, maximum: 10 }, 10));
  assert.ok(!ok({ type: "integer", minimum: 1 }, 0));
  assert.ok(!ok({ type: "integer", maximum: 10 }, 11));
  assert.ok(!ok({ type: "number", exclusiveMinimum: 0 }, 0));
  assert.ok(ok({ type: "number", exclusiveMinimum: 0 }, 0.1));
  assert.ok(!ok({ type: "integer", multipleOf: 5 }, 7));
  assert.ok(ok({ type: "integer", multipleOf: 5 }, 10));
});

test("string length counts code points, not UTF-16 units", () => {
  // "👍" is two UTF-16 units and one character. A 1-character limit that
  // rejects one emoji is a bug report nobody enjoys writing.
  assert.ok(ok({ type: "string", maxLength: 1 }, "👍"));
  assert.ok(!ok({ type: "string", maxLength: 1 }, "👍👍"));
  assert.ok(ok({ type: "string", minLength: 2 }, "👍👍"));
});

test("patterns are unicode-mode and anchored as written", () => {
  const schema: JsonSchema = { type: "string", pattern: "^[a-z0-9][a-z0-9_-]*$" };
  assert.ok(ok(schema, "my-site1"));
  assert.ok(!ok(schema, "-leading"));
  assert.ok(!ok(schema, "Has Capitals"));
  assert.ok(!ok(schema, "trailing\n"), "a trailing newline must not slip past $");
});

// ----------------------------------------------------------------- formats --

test("https-url refuses everything that is not a plain https URL", () => {
  const schema: JsonSchema = { type: "string", format: "https-url" };
  assert.ok(ok(schema, "https://example.com/a.png"));
  assert.ok(!ok(schema, "http://example.com/a.png"), "plaintext");
  assert.ok(!ok(schema, "file:///etc/passwd"), "local file");
  assert.ok(!ok(schema, "javascript:alert(1)"), "script URL");
  assert.ok(!ok(schema, "https://user:pass@example.com/"), "credentials in the URL");
  assert.ok(!ok(schema, "not a url"));
});

test("email and uuid formats reject near-misses", () => {
  assert.ok(ok({ type: "string", format: "email" }, "a@b.co"));
  assert.ok(!ok({ type: "string", format: "email" }, "a@b"), "no TLD");
  assert.ok(!ok({ type: "string", format: "email" }, "a b@c.co"), "whitespace");
  assert.ok(ok({ type: "string", format: "uuid" }, "123e4567-e89b-12d3-a456-426614174000"));
  assert.ok(!ok({ type: "string", format: "uuid" }, "123e4567-e89b-12d3-a456-42661417400"));
});

// ------------------------------------------------------------------ arrays --

test("array bounds, item schemas and uniqueness", () => {
  const schema: JsonSchema = {
    type: "array",
    items: { type: "integer", minimum: 0 },
    minItems: 1,
    maxItems: 3,
    uniqueItems: true,
  };
  assert.ok(ok(schema, [1, 2]));
  assert.ok(!ok(schema, []), "below minItems");
  assert.ok(!ok(schema, [1, 2, 3, 4]), "above maxItems");
  assert.ok(!ok(schema, [1, 1]), "duplicates");
  assert.ok(!ok(schema, [1, -1]), "item fails its own schema");
  assert.equal(errs(schema, [1, -1])[0]!.path, "/1", "the path points at the offending item");
});

test("uniqueItems compares by value, ignoring key order", () => {
  const schema: JsonSchema = { type: "array", uniqueItems: true };
  assert.ok(!ok(schema, [{ a: 1, b: 2 }, { b: 2, a: 1 }]), "same object, different key order");
  assert.ok(ok(schema, [{ a: 1 }, { a: 2 }]));
});

// ----------------------------------------------------------------- nesting --

test("errors point at the exact path through nested structures", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: { tool: { type: "string", minLength: 1 } },
          required: ["tool"],
        },
      },
    },
  };
  const e = errs(schema, { steps: [{ tool: "ok" }, { tool: "" }, {}] });
  const paths = e.map((x) => x.path);
  assert.ok(paths.includes("/steps/1/tool"), `expected /steps/1/tool in ${paths.join(", ")}`);
  assert.ok(paths.includes("/steps/2/tool"), "a missing required field reports at its own path");
});

test("every error is collected, not just the first", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: { a: { type: "string" }, b: { type: "integer" } },
    required: ["a", "b"],
  };
  assert.equal(errs(schema, {}).length, 2, "a caller should learn about both missing fields at once");
});

// ---------------------------------------------------------- combinators ----

test("enum, const, anyOf, oneOf and not", () => {
  assert.ok(ok({ enum: ["a", "b"] }, "a"));
  assert.ok(!ok({ enum: ["a", "b"] }, "c"));
  assert.ok(ok({ const: 42 }, 42));
  assert.ok(!ok({ const: 42 }, 43));

  const anyOf: JsonSchema = { anyOf: [{ type: "string" }, { type: "integer" }] };
  assert.ok(ok(anyOf, "x"));
  assert.ok(ok(anyOf, 1));
  assert.ok(!ok(anyOf, true));

  // oneOf is exclusive: matching both is as wrong as matching neither.
  const oneOf: JsonSchema = { oneOf: [{ type: "integer" }, { type: "number", minimum: 0 }] };
  assert.ok(!ok(oneOf, 1), "1 is both an integer and a non-negative number");
  assert.ok(ok(oneOf, 1.5));

  assert.ok(!ok({ not: { type: "string" } }, "x"));
  assert.ok(ok({ not: { type: "string" } }, 1));
});

test("$ref resolves against local $defs", () => {
  const schema: JsonSchema = {
    $defs: { id: { type: "integer", minimum: 1 } },
    type: "object",
    properties: { a: { $ref: "#/$defs/id" }, b: { $ref: "#/$defs/id" } },
  };
  assert.ok(ok(schema, { a: 1, b: 2 }));
  assert.ok(!ok(schema, { a: 0, b: 2 }));
});

// ----------------------------------------------------------- compileSchema --

test("compileSchema refuses a keyword it cannot enforce", () => {
  // The failure mode this prevents: an author writes `patternProperties`,
  // the validator does not know it, ignores it, and the published schema is
  // stricter than the one actually enforced.
  assert.throws(
    () => compileSchema({ type: "object", patternProperties: {} } as unknown as JsonSchema),
    /unsupported JSON Schema keyword "patternProperties"/
  );
  assert.throws(() => compileSchema({ type: "string", format: "hostname" }), /unsupported format/);
  assert.throws(() => compileSchema({ type: "string", pattern: "([" }), /not a valid regular expression/);
});

test("compileSchema refuses a remote $ref", () => {
  assert.throws(
    () => compileSchema({ $ref: "https://example.com/schema.json" }),
    /only local "#\/\$defs\/<name>" references/
  );
});

test("compileSchema recurses into every branch", () => {
  assert.throws(
    () => compileSchema({ type: "object", properties: { a: { type: "array", items: { format: "nope" } } } }),
    /#\/properties\/a\/items: unsupported format/
  );
  assert.throws(
    () => compileSchema({ anyOf: [{ type: "string" }, { format: "nope" }] }),
    /#\/anyOf\/1/
  );
});
