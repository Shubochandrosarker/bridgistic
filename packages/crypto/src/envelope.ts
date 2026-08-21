/**
 * AES-256-GCM envelope for credentials at rest.
 *
 * Ported from the pinned engine's `cloud/src/crypto.ts`. The format is
 * **byte-compatible on purpose**: every `key_secret_enc` already in the
 * `tenants` table was written by that code, and the migration carries those
 * values across verbatim rather than re-encrypting them. If this file cannot
 * read what that file wrote, every connected site is locked out at once and
 * the only recovery is asking every customer to reconnect.
 *
 * `test/envelope.test.ts` holds fixtures produced by the engine's
 * implementation and asserts they still decrypt. That test is the contract.
 *
 * ## What this protects against, and what it does not
 *
 * Protects: a leaked D1 export. The rows are useless without the key, which
 * lives in Wrangler secrets and not in the database.
 *
 * Does not protect: a compromised Worker. Anything that can call `decrypt`
 * with the environment's key can read every credential — this is encryption at
 * rest, not a hardware boundary, and calling it more than that would be a
 * claim we could not defend.
 *
 * ## Key rotation
 *
 * Decryption uses exactly the key it is given. Replacing `TENANT_ENC_KEY`
 * does not migrate rows: every secret sealed under the old key becomes
 * undecryptable. `enc_key_version` on each row is what makes a staged
 * decrypt-all/re-encrypt walk resumable, and `docs/KEY-ROTATION.md` is the
 * procedure. Swapping the secret without running it is a full outage.
 */

const ENVELOPE_V2_PREFIX = "v2.aes256gcm.";
const IV_BYTES = 12;
const KEY_BYTES = 32;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// The return type is inferred rather than annotated `Promise<CryptoKey>`.
// This package runs on Cloudflare Workers and on Node (the tests), and the two
// runtimes' type packages spell that type differently — Node scopes it under
// `webcrypto`. Naming either one couples a shared package to one runtime for
// no benefit; the inferred type is correct on both.
async function importKey(base64Key: string) {
  let raw: Uint8Array;
  try {
    raw = fromBase64(base64Key);
  } catch {
    throw new Error("TENANT_ENC_KEY is not valid base64.");
  }
  if (raw.length !== KEY_BYTES) {
    // The length, not the key. A key that is 31 bytes because somebody trimmed
    // a newline should say so; the value itself must never reach a log.
    throw new Error(
      `TENANT_ENC_KEY must decode to exactly ${KEY_BYTES} bytes, got ${raw.length}. ` +
        `Generate it with: openssl rand -base64 32`
    );
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Returns `v2.aes256gcm.{ivBase64}.{ciphertextBase64}` — store the whole string. */
export async function encryptSecret(plaintext: string, base64Key: string): Promise<string> {
  const key = await importKey(base64Key);
  // A fresh random IV per encryption, never derived from anything. Reusing one
  // under the same key leaks plaintext relationships and breaks GCM's
  // authentication outright — it is the single mistake that turns this from
  // encryption into obfuscation.
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return `${ENVELOPE_V2_PREFIX}${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}

/**
 * Decrypt either envelope version.
 *
 * A tampered ciphertext or tag makes `crypto.subtle.decrypt` reject, and that
 * rejection is allowed to propagate rather than being caught and turned into a
 * null return. A forged or corrupted row must never be mistakeable for "no
 * secret stored" — those two lead to very different code paths, and only one
 * of them is safe.
 */
export async function decryptSecret(stored: string, base64Key: string): Promise<string> {
  const body = stored.startsWith(ENVELOPE_V2_PREFIX) ? stored.slice(ENVELOPE_V2_PREFIX.length) : stored;

  const parts = body.split(".");
  if (parts.length !== 2) {
    throw new Error("Malformed encrypted secret (expected ivBase64.ciphertextBase64).");
  }
  const [ivB64, ctB64] = parts as [string, string];
  if (!ivB64 || !ctB64) {
    throw new Error("Malformed encrypted secret (expected ivBase64.ciphertextBase64).");
  }

  const key = await importKey(base64Key);
  const iv = fromBase64(ivB64);
  if (iv.length !== IV_BYTES) {
    throw new Error(`Malformed encrypted secret (IV must be ${IV_BYTES} bytes).`);
  }

  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, fromBase64(ctB64));
  return new TextDecoder().decode(plaintext);
}

/** Does this look like an envelope this code can read? Shape only, no key needed. */
export function isEnvelope(stored: string): boolean {
  const body = stored.startsWith(ENVELOPE_V2_PREFIX) ? stored.slice(ENVELOPE_V2_PREFIX.length) : stored;
  const parts = body.split(".");
  if (parts.length !== 2) return false;
  try {
    return fromBase64(parts[0]!).length === IV_BYTES && fromBase64(parts[1]!).length > 0;
  } catch {
    return false;
  }
}

/** Which envelope version a stored value uses. */
export function envelopeVersion(stored: string): 1 | 2 {
  return stored.startsWith(ENVELOPE_V2_PREFIX) ? 2 : 1;
}

/**
 * Re-seal a secret under a new key, for the rotation walk.
 *
 * Decrypt-then-encrypt as one call so the plaintext exists only inside this
 * function's frame. A rotation loop that decrypts into a variable, does
 * something else, then encrypts is a rotation loop with every credential in
 * memory at once — and one stray log line away from all of them on disk.
 */
export async function reseal(stored: string, oldKey: string, newKey: string): Promise<string> {
  return encryptSecret(await decryptSecret(stored, oldKey), newKey);
}
