/**
 * The signed WordPress transport, as the executor's `Transport` port.
 *
 * Wraps `packages/wp-client` and adds three controls the security model
 * requires and the bare client did not have: a response-size ceiling, a refusal
 * to follow redirects, and a mapping from the client's error vocabulary to the
 * executor's — which is what lets the executor tell "we never reached the site"
 * from "the site said no", and therefore whether to charge for the call.
 *
 * ## What this is not
 *
 * It is not a proxy. The caller names a site, never a destination: the origin
 * comes from a row the caller's organization owns, and the credential comes
 * from the versioned store. There is no argument through which a caller can
 * influence where the request goes.
 *
 * ## BR-016
 *
 * Responses are NOT authenticated. The plugin verifies request signatures and
 * signs nothing on the way back, so there is nothing to verify. `SECURITY_MODEL.md`
 * §6 has the full statement of what that leaves open; the short version is that
 * this transport authenticates one direction, and closing the other needs a
 * plugin change rather than anything in this file.
 */

import { callBridge, BridgeRequestError } from "@bridgistic/wp-client";
import type { Connection } from "@bridgistic/wp-client";
import { decryptSecret } from "@bridgistic/crypto";
import type { Transport, TransportRequest, TransportResult } from "@bridgistic/executor";
import type { SqlDatabase } from "./db/scope.ts";

/**
 * Largest response body accepted from a site.
 *
 * A WordPress install can be made to return an arbitrarily large body — a
 * `db:read` over a big table, a media listing, or simply a compromised site
 * answering with junk. Without a ceiling that body is buffered in a Worker with
 * a fixed memory budget, and the failure is an OOM that takes out every other
 * tenant sharing the isolate rather than one bad call.
 */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

interface CredentialRow {
  readonly site_url: string;
  readonly key_id: string;
  readonly key_secret_enc: string;
  readonly version: number;
}

export interface WordPressTransportOptions {
  readonly db: SqlDatabase;
  readonly encryptionKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxResponseBytes?: number;
}

export class WordPressTransport implements Transport {
  readonly #db: SqlDatabase;
  readonly #encryptionKey: string;
  readonly #fetch: typeof fetch;
  readonly #maxBytes: number;

  constructor(options: WordPressTransportOptions) {
    this.#db = options.db;
    this.#encryptionKey = options.encryptionKey;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  }

  async call(request: TransportRequest): Promise<TransportResult> {
    const connection = await this.#connectionFor(request.organizationId, request.siteId);
    if (!connection) {
      // No live credential. Reported as unreachable rather than as a site
      // error, because we never got as far as the site — and the executor
      // charges those differently.
      return {
        ok: false,
        kind: "unreachable",
        message: "This site has no live credential. Reconnect or rotate it.",
      };
    }

    const { contract } = request;
    if (contract.route === null || contract.method === null) {
      return { ok: false, kind: "site_error", message: "This tool does not call the site." };
    }

    // The arguments that go to WordPress are the tool's own, minus the platform
    // ones. `idempotency_key` and `approval_id` are consumed by the executor
    // and the gate; forwarding them would have the plugin reject an argument it
    // does not know, and would put a platform concern on the site's wire.
    const body = stripPlatformArgs(request.args);

    try {
      const data = await callBridge(connection, contract.method, contract.route, body, {
        timeoutMs: request.timeoutMs,
        requestId: request.requestId,
        fetchImpl: this.#guardedFetch(),
      });
      return { ok: true, data };
    } catch (error) {
      return toTransportResult(error);
    }
  }

  /**
   * A `fetch` that refuses redirects and caps the body.
   *
   * Redirects are refused outright rather than followed to the same origin.
   * A signed request replayed to wherever a redirect points arrives with valid
   * credentials attached, and "same origin" is not a check that survives an
   * open redirect on the site itself — which WordPress plugins produce
   * routinely. The plugin's REST routes never redirect, so anything that does
   * is either misconfigured or somebody's proxy, and both deserve a refusal.
   */
  #guardedFetch(): typeof fetch {
    const inner = this.#fetch;
    const maxBytes = this.#maxBytes;

    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const response = await inner(input, { ...init, redirect: "manual" });

      // `manual` surfaces a redirect as an opaque response or a 3xx; either
      // way it is refused rather than chased.
      if (response.status >= 300 && response.status < 400) {
        throw new BridgeRequestError(
          "The site redirected the request. Bridgistic does not follow redirects, because a signed " +
            "request must not be replayed to an address the site chose.",
          response.status,
          "redirect_refused"
        );
      }

      // Trust the header when it is present and honest, and verify anyway:
      // a Content-Length can be absent, wrong, or absent under chunked
      // encoding, which is exactly when a body is worth bounding.
      const declared = Number(response.headers.get("content-length") ?? Number.NaN);
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new BridgeRequestError(
          `The site returned ${declared} bytes, over the ${maxBytes}-byte limit.`,
          response.status,
          "response_too_large"
        );
      }

      const buffered = await readCapped(response, maxBytes);
      if (buffered === null) {
        throw new BridgeRequestError(
          `The site's response exceeded the ${maxBytes}-byte limit and was discarded.`,
          response.status,
          "response_too_large"
        );
      }

      return new Response(buffered, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
  }

  /**
   * The live credential for a site, decrypted.
   *
   * Scoped by organization as well as by site id. The executor authorises the
   * site before it gets here, so under the current caller this is redundant —
   * which is the point: a credential that decrypts root-equivalent access to
   * somebody's business should not be reachable by a site id alone, on the
   * strength of a check made somewhere else. A site id belonging to another
   * tenant returns nothing, and reads as "no live credential" rather than as a
   * different error, so the transport is not an existence oracle for site ids
   * either.
   */
  async #connectionFor(organizationId: string, siteId: string): Promise<Connection | undefined> {
    const row = await this.#db
      .prepare(
        `SELECT s.site_url, c.key_id, c.key_secret_enc, c.version
           FROM site_credentials c
           JOIN sites s ON s.id = c.site_id
          WHERE c.site_id = ? AND s.organization_id = ? AND c.retired_at IS NULL`
      )
      .bind(siteId, organizationId)
      .first<CredentialRow>();

    if (!row) return undefined;

    try {
      return {
        alias: siteId,
        siteUrl: row.site_url,
        keyId: row.key_id,
        secret: await decryptSecret(row.key_secret_enc, this.#encryptionKey),
      };
    } catch {
      // An undecryptable credential is almost always TENANT_ENC_KEY rotated
      // without the re-encrypt walk. Treated as no credential rather than
      // propagated: the error would otherwise carry key material into a log.
      return undefined;
    }
  }
}

/**
 * Read a body, stopping if it exceeds the cap.
 *
 * Streamed rather than `await response.text()` then checking the length —
 * checking afterwards means the whole body is already in memory, which is the
 * thing the cap exists to prevent.
 */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const body = response.body;
  if (!body) return new Uint8Array(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Platform arguments the executor consumes and the plugin never sees. */
const PLATFORM_ARGS = new Set(["idempotency_key", "approval_id", "site"]);

export function stripPlatformArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([key]) => !PLATFORM_ARGS.has(key)));
}

/**
 * Map the client's error vocabulary onto the executor's.
 *
 * The distinction that matters is `unreachable` versus everything else: the
 * executor releases the reservation for one and charges for the others, so
 * getting this wrong bills customers for calls that never happened, or fails to
 * bill for a loop that did.
 */
export function toTransportResult(error: unknown): TransportResult {
  if (!(error instanceof BridgeRequestError)) {
    return { ok: false, kind: "site_error", message: "The site call failed." };
  }

  switch (error.code) {
    case "timeout":
      return { ok: false, kind: "timeout", message: error.message };
    case "network":
      return { ok: false, kind: "unreachable", message: error.message };
    case "response_too_large":
      return { ok: false, kind: "too_large", message: error.message };
    case "redirect_refused":
      // The site answered — it answered with a redirect — so this is a site
      // error rather than unreachable, and it is charged.
      return { ok: false, kind: "site_error", message: error.message };
    default:
      return {
        ok: false,
        kind: "site_error",
        message: error.message,
        ...(error.status ? { status: error.status } : {}),
      };
  }
}
