/**
 * The signed transport to a site's Bridgistic plugin.
 *
 * Ported from the free repo's `cloud/src/services/wp-client.ts`. The platform
 * and the free local MCP server both call THIS, so a change to the wire format
 * cannot land on one side only — that is the whole point of extracting it
 * (it replaces `scripts/check-cloud-tools-drift.js`).
 */

import { signRequest } from "./signer.ts";

/** WordPress REST namespace the bridge plugin registers. */
export const WP_NAMESPACE = "bridgistic/v1";
export const REQUEST_TIMEOUT_MS = 30_000;

/** A resolved WordPress connection target. The secret never leaves this object. */
export interface Connection {
  alias: string;
  /** Normalised base URL, no trailing slash. */
  siteUrl: string;
  keyId: string;
  secret: string;
}

/** Anything that can resolve a `site` parameter to a signed connection. */
export interface SiteRegistry {
  list(): Array<{ alias: string; siteUrl: string }>;
  resolve(alias?: string): Connection | Promise<Connection>;
}

export interface BridgeOk<T = unknown> {
  ok: true;
  data: T;
}

export interface BridgeError {
  code: string;
  message: string;
  data?: { status?: number };
}

export class BridgeRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "BridgeRequestError";
    this.status = status;
    this.code = code;
  }

  /**
   * INVARIANT 8 (fail closed) depends on telling these apart: "we could not
   * reach the site" is not "the site said no". A transport failure keeps the
   * cached verdict and backs off; a signed 4xx revokes.
   */
  get isTransportFailure(): boolean {
    return this.code === "network" || this.code === "timeout";
  }
}

export type BridgeMethod = "GET" | "POST" | "DELETE";

export interface CallOptions {
  /** Injected in tests. Defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Echoed back on every response so a customer report maps to one log line. */
  requestId?: string;
}

/**
 * Perform a signed request against a site's bridge plugin.
 *
 * @param route Route under the namespace, e.g. "site-info" or "db/query".
 */
export async function callBridge<T = unknown>(
  conn: Connection,
  method: BridgeMethod,
  route: string,
  body?: Record<string, unknown>,
  options: CallOptions = {}
): Promise<T> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const cleanRoute = route.replace(/^\/+/, "");
  // WordPress's $request->get_route() is the path WITHOUT the query string, so
  // the signature covers the path only. Everything sensitive or mutating goes
  // in the signed body — never the query string (INVARIANT 7 of the licensing
  // brief: raw keys never appear in a URL).
  const routePath = cleanRoute.split("?")[0] ?? "";
  const signedPath = `/${WP_NAMESPACE}/${routePath}`;
  const url = `${conn.siteUrl}/wp-json/${WP_NAMESPACE}/${cleanRoute}`;

  const bodyString = method !== "GET" && body ? JSON.stringify(body) : "";
  const signed = await signRequest(method, signedPath, bodyString, conn.keyId, conn.secret);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await doFetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...signed,
        ...(options.requestId ? { "X-Bridgistic-Request-Id": options.requestId } : {}),
      },
      body: method !== "GET" ? bodyString : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    // A caller-supplied `fetchImpl` may itself refuse a response — the hosted
    // transport refuses redirects and oversized bodies that way. Those already
    // carry an accurate classification, and re-labelling them "network" would
    // tell the executor we never reached the site, so a call the site really
    // answered would go unbilled and be reported as an outage.
    if (err instanceof BridgeRequestError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new BridgeRequestError(
        `Request to ${conn.alias} timed out after ${timeoutMs}ms.`,
        408,
        "timeout"
      );
    }
    throw new BridgeRequestError(
      `Could not reach ${conn.siteUrl}. Is the site up and the Bridgistic plugin active?`,
      0,
      "network"
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new BridgeRequestError(
      `Non-JSON response (HTTP ${res.status}) from ${conn.alias}. The endpoint may be blocked by a security plugin or cache.`,
      res.status,
      "bad_response"
    );
  }

  if (!res.ok) {
    const e = parsed as BridgeError;
    const message = e?.message || `HTTP ${res.status}`;
    throw new BridgeRequestError(authHint(e?.code, message), res.status, e?.code || "http_error");
  }

  return (parsed as BridgeOk<T>).data;
}

/** Turn raw auth error codes into guidance the agent can act on. */
function authHint(code: string | undefined, message: string): string {
  switch (code) {
    case "bridgistic_scope_denied":
      return `${message} Mint a key with the needed scope in WordPress admin → Bridgistic.`;
    case "bridgistic_auth_stale":
      return `${message} Check that the server clock is in sync (NTP).`;
    case "bridgistic_auth_signature":
      return `${message} The key secret is likely wrong or was rotated.`;
    case "bridgistic_auth_replay":
      return `${message} Retry the operation; nonces are single-use.`;
    case "bridgistic_auth_ip":
      return `${message} Add this server's IP to the key's allowlist.`;
    default:
      return message;
  }
}
