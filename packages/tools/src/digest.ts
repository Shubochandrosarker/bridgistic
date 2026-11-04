/**
 * Request digests.
 *
 * INVARIANT 6 — digests, not bodies. A `bridgistic_db_query` or
 * `bridgistic_execute_php` argument can contain customer PII, credentials, or
 * an entire table. The `action_log` row therefore stores `sha256(canonical(args))`
 * and nothing else: enough to prove two calls were identical, useless to anyone
 * who exfiltrates the table.
 *
 * The canonical form sorts object keys recursively so `{a:1,b:2}` and
 * `{b:2,a:1}` produce one digest — otherwise idempotency keys derived from a
 * digest would depend on the client's JSON key order.
 */

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): CanonicalValue {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      // NaN and ±Infinity have no JSON form; encoding them as null silently
      // would make two different arguments share a digest.
      if (!Number.isFinite(value)) throw new TypeError(`Cannot canonicalise non-finite number ${value}.`);
      return value;
    case "undefined":
      return null;
    case "object": {
      const out: Record<string, CanonicalValue> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        const child = (value as Record<string, unknown>)[key];
        if (child === undefined) continue; // JSON.stringify drops these anyway
        out[key] = canonicalize(child);
      }
      return out;
    }
    default:
      throw new TypeError(`Cannot canonicalise a ${typeof value}.`);
  }
}

const encoder = new TextEncoder();

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The value that goes in `action_log.request_digest`. Never the args themselves. */
export function requestDigest(tool: string, args: unknown): Promise<string> {
  return sha256Hex(`${tool}\n${canonicalJson(args)}`);
}

/**
 * INVARIANT 7 — idempotency on every mutating call. A client that retries after
 * a timeout must not double-execute; deriving the default key from the digest
 * means a naive retry of the identical call is deduplicated for free, while a
 * genuinely different call is not.
 */
export async function defaultIdempotencyKey(
  organizationId: string,
  siteId: string,
  tool: string,
  args: unknown
): Promise<string> {
  return sha256Hex(`${organizationId}\n${siteId}\n${tool}\n${canonicalJson(args)}`);
}
