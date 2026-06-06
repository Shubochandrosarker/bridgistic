import { createHash, createHmac, randomBytes } from "node:crypto";

export interface SignedHeaders {
  "X-Bridgistic-Key": string;
  "X-Bridgistic-Timestamp": string;
  "X-Bridgistic-Nonce": string;
  "X-Bridgistic-Signature": string;
}

/**
 * Build the signed headers for a bridge request.
 *
 * MUST mirror includes/security/class-hmac-verifier.php exactly:
 *   canonical = METHOD \n PATH \n TIMESTAMP \n NONCE \n sha256(body)
 *   signature = HMAC-SHA256(secret, canonical)  (lowercase hex)
 *
 * `path` is the WP route as seen by the server, e.g. "/bridgistic/v1/site-info".
 * `body` is the EXACT string sent on the wire ("" for GET).
 */
export function signRequest(
  method: string,
  path: string,
  body: string,
  keyId: string,
  secret: string
): SignedHeaders {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString("hex");
  const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");

  const canonical = [
    method.toUpperCase(),
    path,
    timestamp,
    nonce,
    bodyHash,
  ].join("\n");

  const signature = createHmac("sha256", secret)
    .update(canonical, "utf8")
    .digest("hex");

  return {
    "X-Bridgistic-Key": keyId,
    "X-Bridgistic-Timestamp": timestamp,
    "X-Bridgistic-Nonce": nonce,
    "X-Bridgistic-Signature": signature,
  };
}
