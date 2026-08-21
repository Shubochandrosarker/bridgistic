/**
 * Validate a WordPress site address supplied by a stranger.
 *
 * Ported from the pinned engine's `cloud/src/url-guard.ts`, with the address
 * logic factored out so the same rules apply to a literal a caller typed and
 * to an address DNS resolved (BR-005, `resolve.ts`).
 *
 * The policy is deliberately narrow: public, https, default port, no
 * credentials, no IP literals at all. A production WordPress install has a
 * hostname; anything reaching for a raw address is either misconfigured or
 * probing, and both deserve the same answer.
 */

import { checkAddress, parseIpv4 } from "./address.ts";

export interface UrlCheck {
  readonly ok: boolean;
  /** Normalised origin (scheme + host, no trailing slash) when ok. */
  readonly origin?: string;
  readonly hostname?: string;
  /** Safe to show the person who typed the address. */
  readonly reason?: string;
}

/** Hostnames that mean "this machine" regardless of what DNS says. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

/** Suffixes that only ever resolve inside a private network. */
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".home.arpa",
  ".localdomain",
];

const PRIVATE_NETWORK =
  "That address points at a private or local network, which Bridgistic cannot reach. Use the site's public address.";
const USE_A_DOMAIN = "Enter the site's domain name rather than a raw IP address.";

/**
 * Decimal, octal and hex forms of an IPv4 address ("2130706433", "0177.0.0.1",
 * "0x7f000001") all reach the same place as the dotted form but sail past a
 * dotted-quad check. They are matched separately and refused as a class: there
 * is no legitimate reason to type one into a "your website address" field.
 */
function isObfuscatedIpv4(host: string): boolean {
  if (/^\d+$/.test(host)) return true; // bare decimal
  if (/^0x[0-9a-f]+$/i.test(host)) return true; // bare hex
  if (/^(0[0-7]*|0x[0-9a-f]+|\d+)(\.(0[0-7]*|0x[0-9a-f]+|\d+)){1,3}$/i.test(host)) {
    // A dotted form with a leading zero or an 0x part is not decimal.
    if (host.split(".").some((part) => /^0[0-7]+$/.test(part) || /^0x/i.test(part))) return true;
    // Fewer than four parts is a short form: "127.1" is 127.0.0.1.
    if (host.split(".").length < 4) return true;
  }
  return false;
}

export interface UrlCheckOptions {
  /**
   * Permit http:// and private hosts. Only ever true in local development,
   * never from request-handling code, and never from a value a client sent.
   */
  readonly allowInsecure?: boolean;
}

export function checkSiteUrl(raw: string, options: UrlCheckOptions = {}): UrlCheck {
  const allowInsecure = options.allowInsecure === true;
  const trimmed = (raw ?? "").trim();

  if (!trimmed) return { ok: false, reason: "Enter your WordPress site address." };
  if (trimmed.length > 2_000) return { ok: false, reason: "That address is too long to be a site URL." };

  // Whitespace or a control character INSIDE the address (leading and
  // trailing were already trimmed, because people paste with spaces) means
  // it was assembled from something that was not meant to be a URL. A bare
  // CR or LF is the classic header-injection payload.
  if (/[\s\x00-\x1f\x7f]/.test(trimmed)) {
    return { ok: false, reason: "That address contains characters a web address cannot have." };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "That is not a valid web address. Include https:// at the start." };
  }

  if (url.protocol !== "https:" && !(allowInsecure && url.protocol === "http:")) {
    return {
      ok: false,
      reason:
        "The site address must start with https:// — Bridgistic will not send signed credentials over an " +
        "unencrypted connection.",
    };
  }

  if (url.username || url.password) {
    return {
      ok: false,
      reason:
        "Remove the username and password from the address. Bridgistic authorises through your WordPress " +
        "admin, not through the URL.",
    };
  }

  // A non-default port is how a proxied internal service is usually reached;
  // a public WordPress install answers on 443.
  if (url.port && url.port !== "443" && !(allowInsecure && url.port === "80")) {
    return { ok: false, reason: "Use the site's normal https address without a custom port." };
  }

  const host = url.hostname.toLowerCase();

  if (allowInsecure) return { ok: true, origin: url.origin, hostname: host };

  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { ok: false, reason: PRIVATE_NETWORK };
  }

  if (host.startsWith("[")) {
    const verdict = checkAddress(host);
    return { ok: false, reason: verdict.public ? USE_A_DOMAIN : PRIVATE_NETWORK };
  }

  if (parseIpv4(host) !== null) {
    const verdict = checkAddress(host);
    return { ok: false, reason: verdict.public ? USE_A_DOMAIN : PRIVATE_NETWORK };
  }

  if (isObfuscatedIpv4(host)) return { ok: false, reason: USE_A_DOMAIN };

  // A hostname with no dot cannot be a public FQDN; it is an intranet name.
  if (!host.includes(".")) {
    return { ok: false, reason: "Enter the site's full public domain, for example https://example.com." };
  }

  if (!/^[a-z0-9.-]+$/.test(host)) {
    return { ok: false, reason: "That domain name is not valid." };
  }

  // Per LABEL, not per hostname. The hyphen rule in RFC 1035 applies to each
  // label, so checking only the ends of the whole name lets "trailing-.example.com"
  // through — which is how this check was written first, and what the test caught.
  // A hostname over 253 octets, or a label over 63, cannot resolve at all.
  if (host.length > 253) return { ok: false, reason: "That domain name is not valid." };
  for (const label of host.split(".")) {
    if (label.length === 0 || label.length > 63 || label.startsWith("-") || label.endsWith("-")) {
      return { ok: false, reason: "That domain name is not valid." };
    }
  }

  return { ok: true, origin: url.origin, hostname: host };
}
