/**
 * `@bridgistic/url-guard` — the SSRF boundary.
 *
 * Two layers, used together at site connection:
 *
 *   checkSiteUrl        parse-time: scheme, port, credentials, address literals
 *   checkResolvesPublic DNS-time:   every A/AAAA record the hostname maps to
 *
 * Neither closes the time-of-check/time-of-use race on its own; the control
 * that does is response-signature binding, in the transport. See
 * SECURITY_MODEL.md §6 and the docblock on resolve.ts.
 */

export { checkSiteUrl } from "./url.ts";
export type { UrlCheck, UrlCheckOptions } from "./url.ts";

export { checkResolvesPublic } from "./resolve.ts";
export type { ResolutionCheck, ResolveOptions, FetchLike } from "./resolve.ts";

export { checkAddress, checkIpv4, checkIpv6, parseIpv4, parseIpv6 } from "./address.ts";
export type { AddressVerdict } from "./address.ts";

import { checkSiteUrl } from "./url.ts";
import { checkResolvesPublic } from "./resolve.ts";
import type { UrlCheckOptions } from "./url.ts";
import type { ResolveOptions } from "./resolve.ts";

export interface ConnectionCheck {
  readonly ok: boolean;
  readonly origin?: string;
  readonly hostname?: string;
  readonly addresses?: readonly string[];
  readonly reason?: string;
}

/**
 * The check to run before connecting a site: parse, then resolve.
 *
 * Both, in that order, and both must pass. Parsing first means an obviously
 * bad address is refused without spending a DNS lookup on it — which also
 * means a caller cannot use this endpoint to make us resolve arbitrary names
 * for them.
 */
export async function checkSiteConnection(
  raw: string,
  options: UrlCheckOptions & ResolveOptions = {}
): Promise<ConnectionCheck> {
  const parsed = checkSiteUrl(raw, options);
  if (!parsed.ok || !parsed.hostname) return { ok: false, reason: parsed.reason };

  // Local development talks to localhost by design; resolving it would refuse
  // the very thing the flag exists to allow.
  if (options.allowInsecure === true) {
    return { ok: true, origin: parsed.origin, hostname: parsed.hostname, addresses: [] };
  }

  const resolved = await checkResolvesPublic(parsed.hostname, options);
  if (!resolved.ok) {
    return { ok: false, hostname: parsed.hostname, addresses: resolved.addresses, reason: resolved.reason };
  }

  return { ok: true, origin: parsed.origin, hostname: parsed.hostname, addresses: resolved.addresses };
}
