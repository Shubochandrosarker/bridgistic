/**
 * Structured, privacy-safe request logging for the Worker.
 *
 * Cloudflare's tail/Logpush ships whatever `console` emits, so the rule is not
 * "log less" but "log a fixed shape that cannot accidentally carry a secret."
 * Every field below is either a constant, a number, or a value that has been
 * put through {@link hashIdentifier} first.
 *
 * Deliberately absent, and never to be added: the HMAC key secret, OAuth
 * authorization codes, PKCE verifiers, decrypted tenant keys, bearer tokens,
 * and request/response bodies. A tenant is identified by an 12-hex-character
 * digest of its id, which is enough to correlate one tenant's requests across
 * a debugging session without naming the site.
 */

export interface LogEvent {
  /** Correlates every line emitted while handling one request. */
  requestId: string;
  route: string;
  /** "ok" | "rejected" | "error" | "rate_limited" — coarse enough to chart. */
  result: string;
  status?: number;
  latencyMs?: number;
  /** Opaque, non-reversible tenant handle. Use hashIdentifier(). */
  tenant?: string;
  /** Stable machine-readable failure class, never a raw exception message. */
  errorCategory?: string;
}

/** Correlation id handed back to callers in the `X-Bridgistic-Request-Id` header. */
export function newRequestId(): string {
  return crypto.randomUUID();
}

/**
 * One-way handle for an identifier, so logs can group by tenant without
 * carrying the tenant id (which is also the OAuth grant's userId).
 */
export async function hashIdentifier(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .slice(0, 6)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Emit one JSON line. Kept as a single call site so the shape stays fixed and
 * anything added to it has to be added here, in front of this docblock.
 */
export function logEvent(event: LogEvent): void {
  console.log(JSON.stringify({ ts: Date.now(), ...event }));
}

/**
 * Classify an upstream failure into a stable, loggable category.
 *
 * The exception's own message can contain the site URL or an upstream error
 * body, so it is never what gets logged — only the category is.
 */
export function categorizeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError") return "upstream_timeout";
    if (/non-JSON/i.test(err.message)) return "upstream_bad_response";
    if (/rejected the token exchange/i.test(err.message)) return "upstream_rejected_grant";
  }
  return "upstream_error";
}
