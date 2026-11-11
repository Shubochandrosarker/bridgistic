/**
 * AES-256-GCM encrypt/decrypt for tenant credentials at rest in D1, keyed by
 * the TENANT_ENC_KEY Wrangler secret (32 raw bytes, base64-encoded).
 *
 * This is the single most security-sensitive file in this Worker: it is
 * what stands between "a leaked D1 export" and "every connected site's
 * Bridgistic key is exposed." Generate TENANT_ENC_KEY with:
 *   openssl rand -base64 32
 * and set it with `wrangler secret put TENANT_ENC_KEY` - never commit it,
 * never reuse it across environments.
 */

async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  if (raw.length !== 32) {
    throw new Error("TENANT_ENC_KEY must decode to exactly 32 bytes (openssl rand -base64 32).");
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/**
 * Envelope version tag. v1 is the original, untagged `iv.ciphertext` form; v2
 * prefixes `v2.aes256gcm.` so a future algorithm or key-rotation scheme has
 * somewhere to declare itself instead of being guessed from field count.
 *
 * Rows written before this change decrypt unchanged (see decryptSecret), and
 * are silently upgraded to v2 the next time they are re-encrypted.
 */
const ENVELOPE_V2_PREFIX = "v2.aes256gcm.";

/** Returns `v2.aes256gcm.${ivBase64}.${ciphertextBase64}` - store this whole string. */
export async function encryptSecret(plaintext: string, base64Key: string): Promise<string> {
  const key = await importKey(base64Key);
  // A fresh random IV per encryption. Reusing one under the same key would
  // leak plaintext relationships and break GCM's authentication guarantee
  // outright, so this is never derived from anything.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return `${ENVELOPE_V2_PREFIX}${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}

/**
 * Decrypt either envelope version.
 *
 * A tampered ciphertext or tag makes crypto.subtle.decrypt reject; that
 * rejection is deliberately allowed to propagate rather than being caught and
 * turned into a null return, so a corrupted or forged row can never be
 * mistaken for "no secret stored".
 *
 * Note the honest limitation: this decrypts with exactly the key it is given.
 * Replacing TENANT_ENC_KEY does not migrate existing rows - every stored
 * secret encrypted under the old key becomes undecryptable, and those tenants
 * must reconnect. Rotation therefore needs a real migration step (decrypt-all
 * with the old key, re-encrypt with the new one) before the secret is swapped;
 * see docs/CLOUD_CONNECTOR.md.
 */
export async function decryptSecret(stored: string, base64Key: string): Promise<string> {
  const body = stored.startsWith(ENVELOPE_V2_PREFIX) ? stored.slice(ENVELOPE_V2_PREFIX.length) : stored;

  const [ivB64, ctB64] = body.split(".");
  if (!ivB64 || !ctB64) {
    throw new Error("Malformed encrypted secret (expected ivBase64.ciphertextBase64).");
  }
  const key = await importKey(base64Key);
  const iv = fromBase64(ivB64);
  if (iv.length !== 12) {
    throw new Error("Malformed encrypted secret (IV must be 12 bytes).");
  }
  const ciphertext = fromBase64(ctB64);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}
