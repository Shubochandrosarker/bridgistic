/**
 * Crypto primitives for the console: password hashing, token generation,
 * secret-at-rest encryption (AES-GCM) and the WPistic license-server response
 * signature (HMAC-SHA256 over canonical JSON, hex key decoded to raw bytes —
 * mirrors includes/class-license-link.php verify() byte for byte).
 */

const encoder = new TextEncoder();

export function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomHex(bytes: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)).buffer as ArrayBuffer);
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomHex(12)}`;
}

/** SHA-256 hex for non-secret lookup tokens (for example AppSumo codes). */
export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/** PBKDF2-SHA256 at 100k iterations (the Workers runtime maximum). Stored as pbkdf2$100000$saltHex$hashHex. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, 100_000);
  return `pbkdf2$100000$${toHex(salt.buffer as ArrayBuffer)}$${toHex(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  const salt = hexBytes(parts[2]);
  const expected = parts[3];
  const hash = toHex(await pbkdf2(password, salt, iterations));
  return timingSafeEqual(hash, expected);
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, 256);
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** AES-GCM encryption for site key secrets at rest. Key: 32-byte hex env secret. */
export async function encryptSecret(plaintext: string, keyHex: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", hexBytes(keyHex) as BufferSource, "AES-GCM", false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, encoder.encode(plaintext));
  return `${toHex(iv.buffer as ArrayBuffer)}.${toHex(ciphertext)}`;
}

export async function decryptSecret(encrypted: string, keyHex: string): Promise<string> {
  const [ivHex, ctHex] = encrypted.split(".");
  const key = await crypto.subtle.importKey("raw", hexBytes(keyHex) as BufferSource, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: hexBytes(ivHex) as BufferSource },
    key,
    hexBytes(ctHex) as BufferSource
  );
  return new TextDecoder().decode(plaintext);
}

/**
 * PHP-compatible canonical JSON (class-license-link.php canonical_json):
 * object keys sorted with ksort semantics, arrays in order, no escaped
 * slashes or unicode.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${parts.join(",")}}`;
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return JSON.stringify(String(value));
}

/**
 * Sign a license-server response the way the plugin verifies it: HMAC-SHA256
 * over canonical JSON of the payload minus signature/activation_token/
 * verification_key, keyed by the RAW bytes of the hex verification key.
 * Mutates `response` in place to add `signature`.
 */
export async function signLicenseResponse(response: Record<string, unknown>, verificationKeyHex: string): Promise<void> {
  const payload: Record<string, unknown> = { ...response };
  delete payload.signature;
  delete payload.activation_token;
  delete payload.verification_key;
  const key = await crypto.subtle.importKey("raw", hexBytes(verificationKeyHex) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(canonicalJson(payload)));
  response.signature = toHex(signature);
}
