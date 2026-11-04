/**
 * PKCE (RFC 7636) and the OAuth 2.1 state that goes with it.
 *
 * Ported from the pinned engine's `cloud/src/pkce.ts`, with verification added.
 * The engine only ever *generates* a pair — it is an OAuth client to WordPress
 * and never has to check one. The hosted platform is also an OAuth **server**
 * to the MCP client, so it has to verify, and verification is where the
 * mistakes are.
 *
 * There are two independent PKCE pairs in a single connection:
 *
 *   AI client  ──challenge──▶  Bridgistic   (we verify)
 *   Bridgistic ──challenge──▶  WordPress    (WordPress verifies)
 *
 * Mixing them up means checking a verifier against the wrong challenge, which
 * fails safe but is impossible to debug, so the types are separate.
 *
 * S256 only. `plain` is in the RFC and is the same as not having PKCE at all;
 * OAuth 2.1 drops it, and accepting it "for compatibility" means an attacker
 * who can intercept the authorization code can simply send `plain`.
 */

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636 §4.1: 43–128 characters from the unreserved set. */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
/** A base64url SHA-256 digest is always 43 characters. */
const CHALLENGE_PATTERN = /^[A-Za-z0-9\-_]{43}$/;

export function generateCodeVerifier(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

export function isValidCodeVerifier(verifier: string): boolean {
  return VERIFIER_PATTERN.test(verifier);
}

export function isValidCodeChallenge(challenge: string): boolean {
  return CHALLENGE_PATTERN.test(challenge);
}

export type PkceRejection =
  | "malformed_verifier"
  | "malformed_challenge"
  | "unsupported_method"
  | "mismatch";

/**
 * Verify a presented verifier against the stored challenge.
 *
 * `method` is taken from what the client registered at authorization time, not
 * from the token request — otherwise a client can register S256 and then
 * present `plain`, which is the downgrade this whole mechanism exists to stop.
 */
export async function verifyCodeChallenge(
  verifier: string,
  storedChallenge: string,
  method: string
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: PkceRejection }> {
  if (method !== "S256") return { ok: false, reason: "unsupported_method" };
  if (!isValidCodeVerifier(verifier)) return { ok: false, reason: "malformed_verifier" };
  if (!isValidCodeChallenge(storedChallenge)) return { ok: false, reason: "malformed_challenge" };

  const derived = await deriveCodeChallenge(verifier);

  // Constant-time. Both values are public-ish, but the comparison is cheap to
  // do correctly and expensive to reason about if it is not.
  if (derived.length !== storedChallenge.length) return { ok: false, reason: "mismatch" };
  let difference = 0;
  for (let i = 0; i < derived.length; i++) {
    difference |= derived.charCodeAt(i) ^ storedChallenge.charCodeAt(i);
  }
  return difference === 0 ? { ok: true } : { ok: false, reason: "mismatch" };
}

/**
 * An opaque, unguessable value for `state` or `nonce`.
 *
 * 32 bytes. The point of `state` is CSRF protection on the redirect, and it
 * only works if an attacker cannot predict or replay it — so it is random,
 * single-use, and bound to the session that started the flow.
 */
export function generateOpaqueToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Redirect URI matching for OAuth 2.1.
 *
 * Exact string comparison against the registered set. Not prefix matching, not
 * "same origin", not "starts with" — every one of those has been a real
 * account-takeover bug in a real product:
 *
 *   registered  https://app.example.com/callback
 *   presented   https://app.example.com/callback/../../evil
 *   presented   https://app.example.com.evil.test/callback
 *   presented   https://app.example.com/callback?next=https://evil.test
 *
 * A prefix or origin check accepts at least one of those. Exact match accepts
 * none, and costs a client nothing: they registered the URI, so they can send
 * it back unchanged.
 *
 * The one concession is loopback, which RFC 8252 requires for native clients
 * because the port is assigned at runtime and cannot be registered in advance.
 */
export function isRegisteredRedirectUri(presented: string, registered: readonly string[]): boolean {
  if (registered.includes(presented)) return true;

  let url: URL;
  try {
    url = new URL(presented);
  } catch {
    return false;
  }

  // RFC 8252 §7.3 — a native client on a loopback address may vary its port.
  // Everything else about the URI must still match exactly.
  const isLoopback =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1");
  if (!isLoopback) return false;

  return registered.some((candidate) => {
    let registeredUrl: URL;
    try {
      registeredUrl = new URL(candidate);
    } catch {
      return false;
    }
    return (
      registeredUrl.protocol === url.protocol &&
      registeredUrl.hostname === url.hostname &&
      registeredUrl.pathname === url.pathname &&
      registeredUrl.search === url.search &&
      registeredUrl.hash === url.hash
    );
  });
}

/** An authorization code, and everything that must match when it is redeemed. */
export interface AuthorizationCodeRecord {
  readonly code: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly scopes: readonly string[];
  readonly createdAt: number;
  readonly expiresAt: number;
  /** Set the moment it is redeemed. A second redemption is an attack. */
  readonly redeemedAt: number | null;
}

export type CodeRejection =
  | "unknown_code"
  | "expired"
  | "already_redeemed"
  | "client_mismatch"
  | "redirect_uri_mismatch"
  | PkceRejection;

/**
 * The token-exchange check.
 *
 * Every term is compared against what was recorded at authorization time, not
 * against what the token request asserts. A token request is unauthenticated
 * by definition — the code is the only thing proving anything — so anything it
 * claims about itself is a claim, not a fact.
 *
 * Replay handling is the part worth being careful about. RFC 6749 §4.1.2 says
 * an authorization code must be single-use, and that a repeat presentation
 * SHOULD cause every token issued from it to be revoked: a second redemption
 * means either the code leaked or the client is broken, and in the first case
 * the attacker already has a token. Returning `already_redeemed` lets the
 * caller do that; it must not be treated as a benign retry.
 */
export async function verifyAuthorizationCode(
  presented: {
    readonly clientId: string;
    readonly redirectUri: string;
    readonly codeVerifier: string;
  },
  record: AuthorizationCodeRecord | undefined,
  now: number
): Promise<{ readonly ok: true; readonly record: AuthorizationCodeRecord } | { readonly ok: false; readonly reason: CodeRejection }> {
  if (!record) return { ok: false, reason: "unknown_code" };
  if (record.redeemedAt !== null) return { ok: false, reason: "already_redeemed" };
  if (record.expiresAt <= now) return { ok: false, reason: "expired" };
  if (record.clientId !== presented.clientId) return { ok: false, reason: "client_mismatch" };

  // Exact, not "registered": the redirect URI presented at the token endpoint
  // must be the one used at the authorization endpoint, which is a narrower
  // check than "one of the client's registered URIs".
  if (record.redirectUri !== presented.redirectUri) {
    return { ok: false, reason: "redirect_uri_mismatch" };
  }

  const pkce = await verifyCodeChallenge(
    presented.codeVerifier,
    record.codeChallenge,
    record.codeChallengeMethod
  );
  if (!pkce.ok) return { ok: false, reason: pkce.reason };

  return { ok: true, record };
}

/**
 * How long an authorization code lives.
 *
 * RFC 6749 recommends a maximum of ten minutes; the code is exchanged
 * immediately in every real flow, so a minute is generous and shrinks the
 * window in which a leaked code is useful.
 */
export const AUTHORIZATION_CODE_TTL_SECONDS = 60;

/** State and nonce live only as long as the redirect round-trip. */
export const OAUTH_STATE_TTL_SECONDS = 600;
