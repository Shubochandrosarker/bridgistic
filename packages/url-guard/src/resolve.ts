/**
 * BR-005 — DNS pre-resolution.
 *
 * `checkSiteUrl` refuses private and obfuscated address *literals*, which is
 * everything a parser can do. It cannot see DNS, so `https://evil.example`
 * passes the parse and then resolves to `10.0.0.5` at fetch time. Cloudflare
 * Workers have no DNS API, so the engine documented the gap and moved on.
 *
 * DNS-over-HTTPS closes most of it: resolve the name over 1.1.1.1, judge every
 * A and AAAA record, and refuse if any is not globally reachable. Every,
 * not any — a name that resolves to one public and one private address is a
 * rebinding attempt, not a multi-homed site.
 *
 * ## What this does not fix
 *
 * A time-of-check/time-of-use gap remains: the record can change between our
 * lookup and the fetch. That race cannot be won from inside a Worker, and
 * pretending otherwise would be worse than saying so.
 *
 * The control that actually holds is elsewhere and does not depend on DNS at
 * all: every response must carry a valid HMAC signature from the credential
 * stored for that site. An internal service reached by a rebind cannot produce
 * one, so a rebind yields a signature failure, not a disclosure. Pre-resolution
 * is defence in depth on top of that — it turns a silent success into a loud
 * refusal at connection time, which is when a person is watching.
 *
 * See SECURITY_MODEL.md §6.
 */

import { checkAddress } from "./address.ts";

export interface ResolutionCheck {
  readonly ok: boolean;
  /** Addresses the name resolved to. Empty when resolution itself failed. */
  readonly addresses: readonly string[];
  readonly reason?: string;
}

/** Injected in tests; in production this is `fetch`. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ResolveOptions {
  readonly fetchImpl?: FetchLike;
  /** DoH endpoint. Cloudflare's resolver by default. */
  readonly resolver?: string;
  readonly timeoutMs?: number;
}

const DEFAULT_RESOLVER = "https://cloudflare-dns.com/dns-query";
const DEFAULT_TIMEOUT_MS = 3_000;

/** DNS record types we ask for. 1 = A, 28 = AAAA. */
const RECORD_TYPES = [
  { type: 1, label: "A" },
  { type: 28, label: "AAAA" },
] as const;

/**
 * Resolve `hostname` and check every address it maps to.
 *
 * Fails closed. A resolver that is unreachable, slow, or returns something
 * unexpected produces a refusal, not a pass — an SSRF guard that opens when
 * the network is bad is one an attacker can open by making the network bad.
 */
export async function checkResolvesPublic(
  hostname: string,
  options: ResolveOptions = {}
): Promise<ResolutionCheck> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!fetchImpl) {
    return { ok: false, addresses: [], reason: "no fetch implementation available to resolve the hostname" };
  }

  const resolver = options.resolver ?? DEFAULT_RESOLVER;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const addresses: string[] = [];

  for (const record of RECORD_TYPES) {
    let response: Response;
    try {
      response = await withTimeout(
        fetchImpl(`${resolver}?name=${encodeURIComponent(hostname)}&type=${record.type}`, {
          headers: { accept: "application/dns-json" },
        }),
        timeoutMs
      );
    } catch (error) {
      return {
        ok: false,
        addresses,
        reason: `could not resolve ${hostname} (${record.label}): ${describe(error)}`,
      };
    }

    if (!response.ok) {
      return { ok: false, addresses, reason: `resolver returned ${response.status} for ${hostname}` };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, addresses, reason: `resolver returned a non-JSON answer for ${hostname}` };
    }

    for (const answer of answersOf(body)) {
      // A CNAME in the chain is fine; only the address records decide.
      if (answer.type !== record.type) continue;
      addresses.push(answer.data);
    }
  }

  if (addresses.length === 0) {
    return {
      ok: false,
      addresses,
      reason: `${hostname} has no A or AAAA record. Bridgistic cannot reach a site that does not resolve.`,
    };
  }

  for (const address of addresses) {
    const verdict = checkAddress(address);
    if (!verdict.public) {
      // The address is named in the reason on purpose: whoever is connecting
      // the site needs to know their DNS points somewhere unreachable, and
      // this is their own hostname resolving to their own network.
      return {
        ok: false,
        addresses,
        reason: `${hostname} resolves to ${address}, which is ${verdict.reason}.`,
      };
    }
  }

  return { ok: true, addresses };
}

interface DnsAnswer {
  readonly type: number;
  readonly data: string;
}

/** Pull the answer section out of a DoH JSON response, defensively. */
function answersOf(body: unknown): readonly DnsAnswer[] {
  if (typeof body !== "object" || body === null) return [];
  const answer = (body as { Answer?: unknown }).Answer;
  if (!Array.isArray(answer)) return [];
  return answer.flatMap((entry): DnsAnswer[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { type, data } = entry as { type?: unknown; data?: unknown };
    if (typeof type !== "number" || typeof data !== "string") return [];
    return [{ type, data: data.trim() }];
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
