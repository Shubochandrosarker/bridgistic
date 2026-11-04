/**
 * Redaction.
 *
 * `SECURITY_MODEL.md` §5 lists what must never reach a log, a table, an error,
 * a notification or a queue payload: passwords, API keys, HMAC secrets, OAuth
 * tokens and codes, PKCE verifiers, full request bodies, full WordPress
 * responses, customer content, PII.
 *
 * The hard part is not writing that list. It is that the list only helps if
 * something applies it *by default*, because the leak is never in the code
 * somebody wrote carefully — it is in the `catch (e) { log(e) }` that seemed
 * fine, or the debug line that shipped, or the error whose `.cause` carried a
 * request body nobody remembered was attached.
 *
 * So this is deny-by-default in two directions at once:
 *
 *  1. **By key.** Anything whose key looks credential-ish is replaced, at any
 *     depth, however it is nested.
 *  2. **By shape.** Anything that LOOKS like a credential is replaced even
 *     when its key is innocent, because the value that leaks is usually
 *     attached to a key like `detail` or `raw`.
 *
 * Free-text is the case that cannot be solved by either rule, so long strings
 * are truncated rather than trusted: a 40KB `message` is not a message, it is
 * a response body somebody attached to an error.
 */

export const REDACTED = "[redacted]";

/**
 * Keys whose values are never logged, matched case-insensitively as a
 * substring so `wpSecret`, `key_secret_enc` and `X-Api-Key` are all caught.
 *
 * Substring matching over-redacts — `keyboard_layout` would be caught — and
 * that is the correct direction to be wrong in. A redacted field somebody
 * needed is a bug report; a logged credential is an incident.
 */
const SENSITIVE_KEY_PARTS = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "authorization",
  "auth",
  "credential",
  "private",
  "signature",
  "hmac",
  "nonce",
  "verifier",
  "challenge",
  "cookie",
  "session",
  "salt",
  "hash",
  "code_verifier",
  "client_secret",
  "refresh",
  "bearer",
  "enc",
];

/**
 * Keys that look sensitive by the rule above but are safe and useful, so the
 * over-redaction does not cost us the fields we most need when debugging.
 *
 * Each one is here because it names an identifier, not a credential.
 */
const SAFE_KEY_EXACT = new Set([
  "tokencount",
  "token_count",
  "tokens",
  "authmethod",
  "auth_method",
  "authtype",
  "auth_type",
  "sessionid",
  "session_id",
  "encversion",
  "enc_version",
  "enc_key_version",
  "hashalgorithm",
  "hash_algorithm",
  "requestdigest",
  "request_digest",
]);

function isSensitiveKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[-\s]/g, "_");
  if (SAFE_KEY_EXACT.has(normalised) || SAFE_KEY_EXACT.has(normalised.replace(/_/g, ""))) return false;
  return SENSITIVE_KEY_PARTS.some((part) => normalised.includes(part));
}

/**
 * Values that are credentials whatever they are called.
 *
 * Ordered most specific first so a Bridgistic key is reported as one rather
 * than as a generic high-entropy string.
 */
const SENSITIVE_VALUE_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "bridgistic-key", pattern: /\bbrg_(live|test)_[a-z2-9]{8}_[a-z2-9]{24}\b/g },
  { label: "wordpress-key", pattern: /\bwpk_[A-Za-z0-9_-]{16,}\b/g },
  // Both base64 alphabets. `btoa` produces the standard one (+/=), but a
  // value that has been through a URL or a JWT-ish encoder arrives base64url
  // (-_), and a pattern that only knows one of them catches half the leaks.
  { label: "envelope", pattern: /\bv2\.aes256gcm\.[A-Za-z0-9+/=_-]{12,}\.[A-Za-z0-9+/=_-]{12,}/g },
  { label: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { label: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi },
  { label: "basic-auth", pattern: /\bBasic\s+[A-Za-z0-9+/]{16,}=*/gi },
  { label: "stripe-key", pattern: /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{16,}\b/g },
  { label: "url-credentials", pattern: /\b([a-z][a-z0-9+.-]*):\/\/[^/\s:@]+:[^/\s@]+@/gi },
  { label: "private-key", pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g },
];

/** Replace credential-shaped substrings inside a free-text value. */
export function redactString(value: string): string {
  let out = value;
  for (const { label, pattern } of SENSITIVE_VALUE_PATTERNS) {
    out = out.replace(pattern, (match) =>
      label === "url-credentials" ? `${match.split("://")[0]}://${REDACTED}@` : `[redacted:${label}]`
    );
  }
  return out;
}

export interface RedactOptions {
  /**
   * Longest string kept whole. Past this, the value is truncated with a note.
   *
   * A long string in a log line is almost never a message. It is a response
   * body, a rendered page, or a stack trace with a request attached — the
   * things pattern-matching cannot reliably scan and that carry customer
   * content when they leak.
   */
  readonly maxStringLength?: number;
  /** Deepest object nesting kept. Past this, `[depth exceeded]`. */
  readonly maxDepth?: number;
  /** Longest array kept. Past this, the remainder is summarised. */
  readonly maxArrayLength?: number;
}

const DEFAULTS: Required<RedactOptions> = {
  maxStringLength: 512,
  maxDepth: 6,
  maxArrayLength: 50,
};

/**
 * Make a value safe to log.
 *
 * Total, not best-effort: everything is walked, and anything the walk cannot
 * account for becomes a type marker rather than being passed through. A
 * function, a Map, a Proxy or a class instance with a getter that reads a
 * credential all become `[Function]` / `[object]` rather than being stringified
 * by something that might invoke them.
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const config = { ...DEFAULTS, ...options };
  return walk(value, config, 0, new WeakSet());
}

function walk(value: unknown, config: Required<RedactOptions>, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    const cleaned = redactString(value);
    return cleaned.length > config.maxStringLength
      ? `${cleaned.slice(0, config.maxStringLength)}… [truncated ${cleaned.length - config.maxStringLength} chars]`
      : cleaned;
  }

  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean" || typeof value === "bigint") return value;
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol") return "[Symbol]";

  if (value instanceof Date) return value.toISOString();

  if (value instanceof Error) {
    // `.cause` is where a request body most often ends up, so it is walked
    // rather than trusted, and the stack is dropped entirely: it carries file
    // paths and sometimes arguments, and it is not what a log line is for.
    return {
      name: value.name,
      message: walk(value.message, config, depth + 1, seen),
      ...(value.cause !== undefined ? { cause: walk(value.cause, config, depth + 1, seen) } : {}),
    };
  }

  if (depth >= config.maxDepth) return "[depth exceeded]";

  if (typeof value === "object") {
    // A cycle would otherwise recurse until the stack goes.
    if (seen.has(value)) return "[circular]";
    seen.add(value);

    if (Array.isArray(value)) {
      const kept = value.slice(0, config.maxArrayLength).map((item) => walk(item, config, depth + 1, seen));
      return value.length > config.maxArrayLength
        ? [...kept, `… ${value.length - config.maxArrayLength} more`]
        : kept;
    }

    // Anything that is not a plain object — Map, Set, a class instance, a
    // Proxy — is summarised rather than walked. Walking it could invoke a
    // getter, and a getter is arbitrary code running inside the logger.
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== null && prototype !== Object.prototype) {
      return `[${value.constructor?.name ?? "object"}]`;
    }

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? REDACTED : walk(item, config, depth + 1, seen);
    }
    return out;
  }

  return "[unknown]";
}

/**
 * Assert a value carries nothing that must not be logged.
 *
 * For use in tests, not on the hot path. `redact` is the control; this is how
 * a test proves a specific structure survived it — which is the check that
 * catches a new field somebody added without thinking about where it ends up.
 */
export function findLeaks(value: unknown, needles: readonly string[]): string[] {
  const serialised = JSON.stringify(value) ?? "";
  return needles.filter((needle) => needle.length > 0 && serialised.includes(needle));
}
