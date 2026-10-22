/**
 * Server-side client for the Bridgistic WordPress plugin REST API.
 *
 * Signing mirrors packages/wp-client (and the plugin's class-hmac-verifier.php):
 *   canonical = METHOD \n PATH \n TIMESTAMP \n NONCE \n sha256(body)
 *   signature = HMAC-SHA256(secret, canonical), lowercase hex
 *
 * Outbound URL policy: https only, hostname must be a public registrable
 * domain — localhost, loopback, bare IPs and private/reserved ranges are
 * refused before any request is made.
 */

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class SiteCallError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const BLOCKED_HOSTNAME =
  /^(localhost$|.*\.local$|.*\.localhost$|.*\.test$|.*\.example$|.*\.invalid$|127\.\d+\.\d+\.\d+$|10\.\d+\.\d+\.\d+$|192\.168\.\d+\.\d+$|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$|169\.254\.\d+\.\d+$|0\.0\.0\.0$|\[::1\]$|\[fc00.*\]$|\[fd.*\]$)/i;

export function normalizeSiteUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new SiteCallError(400, "bad_site_url", "Enter a valid site URL, e.g. https://example.com");
  }
  if (url.protocol !== "https:") throw new SiteCallError(400, "insecure_site_url", "The site URL must use https.");
  if (BLOCKED_HOSTNAME.test(url.hostname)) throw new SiteCallError(400, "blocked_host", "This host is not reachable as a production site.");
  url.hash = "";
  url.search = "";
  return url.origin;
}

export function sitePath(route: string): string {
  return `/wp-json/bridgistic/v1/${route.replace(/^\/+/, "")}`;
}

async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
}

export async function signedHeaders(
  method: string,
  path: string,
  body: string,
  keyId: string,
  secret: string
): Promise<Record<string, string>> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer);
  const bodyHash = await sha256Hex(body);
  const canonical = [method.toUpperCase(), path, timestamp, nonce, bodyHash].join("\n");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(canonical)));
  return {
    "X-Bridgistic-Key": keyId,
    "X-Bridgistic-Timestamp": timestamp,
    "X-Bridgistic-Nonce": nonce,
    "X-Bridgistic-Signature": signature,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

export interface SiteCallResult {
  status: number;
  data: unknown;
  ok: boolean;
  error?: { code: string; message: string };
}

/** One signed call to a site. Unwraps the plugin envelope {ok, data}. */
export async function callSite(
  siteUrl: string,
  keyId: string,
  secret: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  route: string,
  body?: Record<string, unknown>
): Promise<SiteCallResult> {
  const origin = normalizeSiteUrl(siteUrl);
  const path = sitePath(route);
  const bodyText = body === undefined ? "" : JSON.stringify(body);
  const headers = await signedHeaders(method, path, bodyText, keyId, secret);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, {
      method,
      headers,
      body: bodyText === "" || method === "GET" ? undefined : bodyText,
      signal: controller.signal,
      redirect: "manual",
    });
  } catch {
    throw new SiteCallError(502, "site_unreachable", "Could not reach the site. Check the URL and that the Bridgistic plugin is active.");
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text === "" ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  const envelope = json as { ok?: boolean; data?: unknown; code?: string; message?: string } | null;
  if (envelope && typeof envelope === "object" && "ok" in envelope) {
    return {
      status: response.status,
      ok: envelope.ok === true,
      data: envelope.data,
      error: envelope.ok ? undefined : { code: String(envelope.code ?? "error"), message: String(envelope.message ?? "The site refused the request.") },
    };
  }
  return {
    status: response.status,
    ok: response.ok,
    data: json,
    error: response.ok ? undefined : { code: "site_error", message: `The site responded with HTTP ${response.status}.` },
  };
}

export function keyMask(keyId: string): string {
  if (keyId.length <= 8) return "•".repeat(6);
  return `${keyId.slice(0, 4)}…${keyId.slice(-4)}`;
}
