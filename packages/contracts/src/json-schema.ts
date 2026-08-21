/**
 * A JSON Schema validator, draft 2020-12 subset, with no dependencies.
 *
 * Why not Zod, which the pinned engine already uses:
 *
 * MCP puts JSON Schema on the wire. `tools/list` returns `inputSchema` as JSON
 * Schema, and that is what every client — Claude, ChatGPT, Codex, Cursor,
 * Gemini — reads to decide what to send. Authoring in Zod means converting to
 * JSON Schema to advertise, which makes two artefacts: the one we validate
 * against and the one we published. They drift, and the drift is invisible
 * until a client sends something the published schema allows and the validator
 * rejects.
 *
 * Authoring in JSON Schema keeps it to one artefact. The cost is this file.
 *
 * Deliberately not implemented: remote `$ref`, `dynamicRef`, `if/then/else`,
 * `dependentSchemas`, `patternProperties`, `contains`, `unevaluated*`. A
 * contract that needs one of those is a contract that is too clever to be a
 * stable public interface. `compileSchema` rejects an unknown keyword rather
 * than ignoring it — silently ignoring a constraint the author wrote is how a
 * validator ends up weaker than the schema it claims to enforce.
 */

export type JsonSchema = {
  readonly type?: JsonType | readonly JsonType[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly multipleOf?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: string;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly minProperties?: number;
  readonly maxProperties?: number;
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly allOf?: readonly JsonSchema[];
  readonly not?: JsonSchema;
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, JsonSchema>>;
  readonly description?: string;
  readonly title?: string;
  readonly default?: unknown;
  readonly examples?: readonly unknown[];
  readonly deprecated?: boolean;
  readonly $schema?: string;
};

export type JsonType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

/** Keywords this validator understands. Anything else fails `compileSchema`. */
const KNOWN_KEYWORDS = new Set([
  "type", "properties", "required", "additionalProperties", "items", "enum", "const",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "pattern", "format",
  "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties",
  "anyOf", "oneOf", "allOf", "not", "$ref", "$defs",
  "description", "title", "default", "examples", "deprecated", "$schema",
]);

export interface ValidationError {
  /** JSON Pointer to the offending value, e.g. `/steps/0/tool`. */
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ValidationError[];
}

/**
 * Formats validated by `format`. An unrecognised format is a compile error
 * rather than a no-op: writing `format: "uri"` and getting no checking at all
 * is worse than being told the keyword is unsupported.
 */
const FORMATS: Record<string, (value: string) => boolean> = {
  "date-time": (v) => !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}[Tt]/.test(v),
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)),
  email: (v) => /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v),
  uuid: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v),
  uri: (v) => {
    try {
      // eslint-disable-next-line no-new
      new URL(v);
      return true;
    } catch {
      return false;
    }
  },
  /**
   * Deliberately narrower than `uri`: only https, and nothing that carries
   * credentials. A tool argument that accepts any URI is a request-forgery
   * primitive, and the guard belongs in the schema rather than only in the
   * handler that remembers to call it.
   */
  "https-url": (v) => {
    try {
      const url = new URL(v);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  },
};

/**
 * Check a schema is one this validator can actually enforce.
 *
 * Called once per contract at module load, so a malformed schema fails the
 * test suite rather than the first request that happens to exercise it.
 */
export function compileSchema(schema: JsonSchema, path = "#"): void {
  for (const key of Object.keys(schema)) {
    if (!KNOWN_KEYWORDS.has(key)) {
      throw new Error(
        `${path}: unsupported JSON Schema keyword "${key}". ` +
          `This validator enforces a deliberate subset; a keyword it does not know would be ` +
          `silently ignored, leaving the published schema stricter than the one enforced.`
      );
    }
  }

  if (schema.format !== undefined && !(schema.format in FORMATS)) {
    throw new Error(`${path}: unsupported format "${schema.format}". Known: ${Object.keys(FORMATS).join(", ")}.`);
  }

  if (schema.pattern !== undefined) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(schema.pattern, "u");
    } catch (error) {
      throw new Error(`${path}: pattern is not a valid regular expression: ${String(error)}`);
    }
  }

  if (schema.$ref !== undefined && !schema.$ref.startsWith("#/$defs/")) {
    throw new Error(
      `${path}: $ref "${schema.$ref}" — only local "#/$defs/<name>" references are supported. ` +
        `A remote ref would make validation depend on the network.`
    );
  }

  for (const [name, sub] of Object.entries(schema.properties ?? {})) compileSchema(sub, `${path}/properties/${name}`);
  for (const [name, sub] of Object.entries(schema.$defs ?? {})) compileSchema(sub, `${path}/$defs/${name}`);
  if (schema.items) compileSchema(schema.items, `${path}/items`);
  if (typeof schema.additionalProperties === "object") {
    compileSchema(schema.additionalProperties, `${path}/additionalProperties`);
  }
  if (schema.not) compileSchema(schema.not, `${path}/not`);
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    (schema[key] ?? []).forEach((sub, i) => compileSchema(sub, `${path}/${key}/${i}`));
  }
}

/** Validate `value` against `schema`. Collects every error, not just the first. */
export function validate(schema: JsonSchema, value: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  check(schema, value, "", schema, errors);
  return { valid: errors.length === 0, errors };
}

function check(
  schema: JsonSchema,
  value: unknown,
  path: string,
  root: JsonSchema,
  errors: ValidationError[]
): void {
  if (schema.$ref !== undefined) {
    const name = schema.$ref.slice("#/$defs/".length);
    const target = root.$defs?.[name];
    if (!target) {
      errors.push({ path, message: `unresolved $ref "${schema.$ref}"` });
      return;
    }
    check(target, value, path, root, errors);
    return;
  }

  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push({ path, message: `must be ${JSON.stringify(schema.const)}` });
  }

  if (schema.enum !== undefined && !schema.enum.some((allowed) => deepEqual(value, allowed))) {
    errors.push({ path, message: `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}` });
  }

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((t) => matchesType(value, t))) {
      errors.push({ path, message: `expected ${allowed.join(" or ")}, got ${describe(value)}` });
      // Type is wrong, so every keyword below would produce noise on top of
      // the one error that actually explains the problem.
      return;
    }
  }

  if (typeof value === "number") checkNumber(schema, value, path, errors);
  if (typeof value === "string") checkString(schema, value, path, errors);
  if (Array.isArray(value)) checkArray(schema, value, path, root, errors);
  if (isPlainObject(value)) checkObject(schema, value, path, root, errors);

  for (const sub of schema.allOf ?? []) check(sub, value, path, root, errors);

  if (schema.anyOf !== undefined) {
    const matched = schema.anyOf.some((sub) => validateAgainst(sub, value, root));
    if (!matched) errors.push({ path, message: "did not match any permitted shape" });
  }

  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((sub) => validateAgainst(sub, value, root)).length;
    if (matches !== 1) {
      errors.push({ path, message: `must match exactly one permitted shape, matched ${matches}` });
    }
  }

  if (schema.not !== undefined && validateAgainst(schema.not, value, root)) {
    errors.push({ path, message: "matched a forbidden shape" });
  }
}

function checkNumber(schema: JsonSchema, value: number, path: string, errors: ValidationError[]): void {
  if (schema.minimum !== undefined && value < schema.minimum) {
    errors.push({ path, message: `must be >= ${schema.minimum}` });
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    errors.push({ path, message: `must be <= ${schema.maximum}` });
  }
  if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
    errors.push({ path, message: `must be > ${schema.exclusiveMinimum}` });
  }
  if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
    errors.push({ path, message: `must be < ${schema.exclusiveMaximum}` });
  }
  if (schema.multipleOf !== undefined) {
    const quotient = value / schema.multipleOf;
    if (!Number.isFinite(quotient) || Math.abs(quotient - Math.round(quotient)) > 1e-9) {
      errors.push({ path, message: `must be a multiple of ${schema.multipleOf}` });
    }
  }
}

function checkString(schema: JsonSchema, value: string, path: string, errors: ValidationError[]): void {
  // Length in code points, not UTF-16 units, so an emoji counts as one
  // character the way a person writing a 100-character limit expects.
  const length = [...value].length;
  if (schema.minLength !== undefined && length < schema.minLength) {
    errors.push({ path, message: `must be at least ${schema.minLength} characters` });
  }
  if (schema.maxLength !== undefined && length > schema.maxLength) {
    errors.push({ path, message: `must be at most ${schema.maxLength} characters` });
  }
  if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
    errors.push({ path, message: `must match ${schema.pattern}` });
  }
  if (schema.format !== undefined) {
    const test = FORMATS[schema.format];
    if (test && !test(value)) errors.push({ path, message: `must be a valid ${schema.format}` });
  }
}

function checkArray(
  schema: JsonSchema,
  value: readonly unknown[],
  path: string,
  root: JsonSchema,
  errors: ValidationError[]
): void {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    errors.push({ path, message: `must have at least ${schema.minItems} items` });
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    errors.push({ path, message: `must have at most ${schema.maxItems} items` });
  }
  if (schema.uniqueItems === true) {
    const seen = new Set(value.map((item) => JSON.stringify(canonical(item))));
    if (seen.size !== value.length) errors.push({ path, message: "items must be unique" });
  }
  if (schema.items) {
    value.forEach((item, i) => check(schema.items!, item, `${path}/${i}`, root, errors));
  }
}

function checkObject(
  schema: JsonSchema,
  value: Record<string, unknown>,
  path: string,
  root: JsonSchema,
  errors: ValidationError[]
): void {
  const keys = Object.keys(value);

  if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
    errors.push({ path, message: `must have at least ${schema.minProperties} properties` });
  }
  if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
    errors.push({ path, message: `must have at most ${schema.maxProperties} properties` });
  }

  for (const name of schema.required ?? []) {
    if (!Object.hasOwn(value, name)) {
      errors.push({ path: `${path}/${name}`, message: "is required" });
    }
  }

  for (const [name, sub] of Object.entries(schema.properties ?? {})) {
    if (Object.hasOwn(value, name)) check(sub, value[name], `${path}/${name}`, root, errors);
  }

  if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
    const declared = new Set(Object.keys(schema.properties ?? {}));
    for (const name of keys) {
      if (declared.has(name)) continue;
      if (schema.additionalProperties === false) {
        // Rejecting rather than stripping. An argument the caller believed was
        // meaningful and we quietly discarded is worse than an error: the call
        // appears to succeed while doing something other than what was asked.
        errors.push({ path: `${path}/${name}`, message: "is not a permitted property" });
      } else {
        check(schema.additionalProperties, value[name], `${path}/${name}`, root, errors);
      }
    }
  }
}

function validateAgainst(schema: JsonSchema, value: unknown, root: JsonSchema): boolean {
  const errors: ValidationError[] = [];
  check(schema, value, "", root, errors);
  return errors.length === 0;
}

function matchesType(value: unknown, type: JsonType): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    // A NaN or Infinity has no JSON representation, so it cannot have arrived
    // in a request body — but it can arrive from our own code, and a meter
    // that accepts Infinity is a billing incident.
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && !Number.isFinite(value)) return "a non-finite number";
  return typeof value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Key-sorted copy, so `{a:1,b:2}` and `{b:2,a:1}` compare equal. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])])
  );
}
