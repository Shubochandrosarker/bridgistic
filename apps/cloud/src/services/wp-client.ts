import { signRequest } from "./signer.js";
import { WP_NAMESPACE, REQUEST_TIMEOUT_MS } from "../constants.js";
import type { Connection, BridgeOk, BridgeError } from "../types.js";

export class BridgeRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string
  ) {
    super(message);
    this.name = "BridgeRequestError";
  }
}

/**
 * Perform a signed request against a site's bridge plugin.
 *
 * @param conn   Resolved connection (carries the secret; never logged).
 * @param method HTTP method.
 * @param route  Route under the namespace, e.g. "site-info" or "db/query".
 * @param body   Optional JSON body object.
 */
export async function callBridge<T = unknown>(
  conn: Connection,
  method: "GET" | "POST" | "DELETE",
  route: string,
  body?: Record<string, unknown>
): Promise<T> {
  const cleanRoute = route.replace(/^\/+/, "");
  // WordPress's $request->get_route() is the path WITHOUT the query string, so
  // the signature must cover the path only. The query still travels in the URL;
  // its integrity is protected by the required HTTPS transport. All sensitive /
  // mutating params are sent in the (signed) body, never the query.
  const routePath = cleanRoute.split("?")[0];
  const signedPath = `/${WP_NAMESPACE}/${routePath}`;
  const url = `${conn.siteUrl}/wp-json/${WP_NAMESPACE}/${cleanRoute}`;

  const bodyString = method !== "GET" && body ? JSON.stringify(body) : "";

  const sig = signRequest(method, signedPath, bodyString, conn.keyId, conn.secret);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...sig,
      },
      body: method !== "GET" ? bodyString : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError") {
      throw new BridgeRequestError(
        `Request to ${conn.alias} timed out after ${REQUEST_TIMEOUT_MS}ms.`,
        408,
        "timeout"
      );
    }
    throw new BridgeRequestError(
      `Could not reach ${conn.siteUrl}. Is the site up and the Bridgistic plugin active? (${String(err)})`,
      0,
      "network"
    );
  } finally {
    clearTimeout(timeout);
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
    const msg = e?.message || `HTTP ${res.status}`;
    throw new BridgeRequestError(mapAuthHint(e?.code, msg), res.status, e?.code || "http_error");
  }

  return (parsed as BridgeOk<T>).data;
}

/** Turn raw auth error codes into actionable guidance for the agent. */
function mapAuthHint(code: string | undefined, message: string): string {
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
