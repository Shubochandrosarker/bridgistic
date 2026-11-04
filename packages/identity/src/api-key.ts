/**
 * API keys.
 *
 * The shape is `brg_{env}_{public}_{secret}`:
 *
 *   brg_live_a1b2c3d4e5f6g7h8_9i0j1k2l3m4n5o6p7q8r9s0t1u2v3w4x5
 *   ^^^ ^^^^ ^^^^^^^^^^^^^^^^ ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 *   |   |    |                the secret — hashed, never stored
 *   |   |    the public id — indexed, safe to log, safe to show
 *   |   environment, so a staging key cannot be pasted into production
 *   product prefix, so secret scanners can recognise it
 *
 * Splitting public from secret is what makes the lookup a single indexed read
 * instead of a scan-and-compare over every key in the table. A scheme that
 * hashes the whole key forces you to either hash-and-compare row by row —
 * which does not scale and leaks timing — or store something reversible.
 *
 * The product prefix is not decoration. GitHub, GitGuardian and gitleaks match
 * on prefixes; a key that looks like a random string is a key nobody's scanner
 * will ever catch in a public commit.
 */

/** `live` never appears in staging, and vice versa. */
export const KEY_ENVIRONMENTS = ["live", "test"] as const;
export type KeyEnvironment = (typeof KEY_ENVIRONMENTS)[number];

export const KEY_PRODUCT_PREFIX = "brg";
const PUBLIC_ID_BYTES = 8;
const SECRET_BYTES = 24;

/** Base32-ish alphabet: no vowels, so no key ever spells anything unfortunate, and no 0/O/1/l confusion. */
const ALPHABET = "23456789bcdfghjkmnpqrstvwxyz";

export interface GeneratedKey {
  /** Shown to the user exactly once. Never stored, never logged. */
  readonly plaintext: string;
  /** Indexed for lookup. Safe to store, display and log. */
  readonly publicId: string;
  /** What goes in `api_keys.key_hash`. */
  readonly secretHash: string;
  readonly environment: KeyEnvironment;
}

export interface ParsedKey {
  readonly publicId: string;
  readonly secret: string;
  readonly environment: KeyEnvironment;
}

function randomString(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  let out = "";
  for (const byte of buffer) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

/** SHA-256, hex. */
export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Mint a key.
 *
 * The plaintext is returned once and is the caller's problem thereafter. There
 * is deliberately no way to read it back: a key store that can show you the key
 * again is a key store whose compromise hands over every key at once.
 */
export async function generateApiKey(environment: KeyEnvironment): Promise<GeneratedKey> {
  const publicId = randomString(PUBLIC_ID_BYTES);
  const secret = randomString(SECRET_BYTES);
  return {
    plaintext: `${KEY_PRODUCT_PREFIX}_${environment}_${publicId}_${secret}`,
    publicId,
    secretHash: await hashSecret(secret),
    environment,
  };
}

/**
 * Split a presented key into its parts.
 *
 * Returns null rather than throwing, and never says *why* it failed. A caller
 * probing with malformed keys should learn nothing about which part was wrong.
 */
export function parseApiKey(presented: string): ParsedKey | null {
  const parts = presented.trim().split("_");
  if (parts.length !== 4) return null;

  const [product, environment, publicId, secret] = parts as [string, string, string, string];
  if (product !== KEY_PRODUCT_PREFIX) return null;
  if (!(KEY_ENVIRONMENTS as readonly string[]).includes(environment)) return null;
  if (publicId.length !== PUBLIC_ID_BYTES || secret.length !== SECRET_BYTES) return null;

  const allowed = new Set(ALPHABET);
  if ([...publicId, ...secret].some((char) => !allowed.has(char))) return null;

  return { publicId, secret, environment: environment as KeyEnvironment };
}

/**
 * Compare two hex digests without leaking where they differ.
 *
 * `a === b` on strings short-circuits at the first differing character, and
 * the time that takes is measurable across enough requests. It is a narrow
 * attack against a hash comparison — the attacker would have to forge a
 * preimage afterwards — but the cost of doing it right is four lines.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/** What a key row must provide for verification. */
export interface StoredKey {
  readonly id: string;
  readonly organizationId: string;
  readonly publicId: string;
  readonly secretHash: string;
  readonly environment: KeyEnvironment;
  readonly revokedAt: number | null;
  readonly expiresAt: number | null;
}

export type KeyVerdict =
  | { readonly ok: true; readonly key: StoredKey }
  | { readonly ok: false; readonly reason: KeyRejection };

/**
 * Why a key was refused.
 *
 * Distinguished for logging and metrics, NOT for the response. Every one of
 * these produces the same `unauthenticated` to the caller: telling somebody
 * "that key is expired" confirms the key was real.
 */
export type KeyRejection = "malformed" | "unknown" | "wrong_environment" | "revoked" | "expired" | "bad_secret";

/**
 * Verify a presented key against its stored row.
 *
 * The row is fetched by `publicId` before this is called; `lookup` returning
 * undefined is the not-found case.
 */
export async function verifyApiKey(
  presented: string,
  lookup: (publicId: string) => Promise<StoredKey | undefined>,
  context: { readonly environment: KeyEnvironment; readonly now: number }
): Promise<KeyVerdict> {
  const parsed = parseApiKey(presented);
  if (!parsed) return { ok: false, reason: "malformed" };

  const stored = await lookup(parsed.publicId);
  if (!stored) return { ok: false, reason: "unknown" };

  // A staging key presented to production must fail even if the row somehow
  // exists in both — this is the check that stops a test key from ever being
  // a live one.
  if (stored.environment !== parsed.environment || stored.environment !== context.environment) {
    return { ok: false, reason: "wrong_environment" };
  }

  if (stored.revokedAt !== null && stored.revokedAt <= context.now) {
    return { ok: false, reason: "revoked" };
  }
  if (stored.expiresAt !== null && stored.expiresAt <= context.now) {
    return { ok: false, reason: "expired" };
  }

  const presentedHash = await hashSecret(parsed.secret);
  if (!constantTimeEqual(presentedHash, stored.secretHash)) {
    return { ok: false, reason: "bad_secret" };
  }

  return { ok: true, key: stored };
}

/**
 * Mask a key for display or a log line.
 *
 * Shows the product, environment and public id — enough for somebody to
 * recognise which key it is — and nothing that could authenticate.
 */
export function maskApiKey(presented: string): string {
  const parsed = parseApiKey(presented);
  if (!parsed) return `${KEY_PRODUCT_PREFIX}_…`;
  return `${KEY_PRODUCT_PREFIX}_${parsed.environment}_${parsed.publicId}_${"·".repeat(8)}`;
}
