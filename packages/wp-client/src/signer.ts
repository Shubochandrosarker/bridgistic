/**
 * HMAC-SHA256 request signing for the Bridgistic WordPress plugin.
 *
 * MUST mirror `includes/security/class-hmac-verifier.php` exactly:
 *
 *   canonical = METHOD \n PATH \n TIMESTAMP \n NONCE \n sha256(body)
 *   signature = HMAC-SHA256(secret, canonical), lowercase hex
 *
 * Ported from the free repo's `cloud/src/services/signer.ts` onto WebCrypto so
 * the same file runs unchanged in a Cloudflare Worker, in Node, and in a test.
 * The Node-crypto version it replaces could not run on the edge.
 */

export interface SignedHeaders {
  "X-Bridgistic-Key": string;
  "X-Bridgistic-Timestamp": string;
  "X-Bridgistic-Nonce": string;
  "X-Bridgistic-Signature": string;
}

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
}

/**
 * The exact string the plugin recomputes and HMACs. Exported so a contract test
 * can assert it byte for byte against the PHP side without going over a wire.
 */
export function canonicalString(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  bodyHash: string
): string {
  return [method.toUpperCase(), path, timestamp, nonce, bodyHash].join("\n");
}

export interface SignOptions {
  /** Seconds since epoch. Injected in tests; defaults to now. */
  timestamp?: number;
  /** 32 hex chars. Injected in tests; defaults to 16 random bytes. */
  nonce?: string;
}

export async function signRequest(
  method: string,
  path: string,
  body: string,
  keyId: string,
  secret: string,
  options: SignOptions = {}
): Promise<SignedHeaders> {
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1_000));
  const nonce = options.nonce ?? toHex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const bodyHash = await sha256Hex(body);

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = toHex(
    await crypto.subtle.sign("HMAC", key, encoder.encode(canonicalString(method, path, timestamp, nonce, bodyHash)))
  );

  return {
    "X-Bridgistic-Key": keyId,
    "X-Bridgistic-Timestamp": timestamp,
    "X-Bridgistic-Nonce": nonce,
    "X-Bridgistic-Signature": signature,
  };
}
